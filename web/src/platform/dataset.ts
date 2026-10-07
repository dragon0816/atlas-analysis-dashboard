import type { FieldType } from "./types";
import type { Dataset, DatasetField, DatasetMeta, GraphDataset, Row, TabularDataset } from "./types";

export const MAX_ROWS = 20000;
export const MAX_FIELDS = 256;
export const MAX_BYTES = 8 * 1024 * 1024;
export interface NormalizeOptions { fields?: DatasetField[]; format?: "table" | "graph"; maxRows?: number; deferGraphIdentity?: boolean }
export const isRecord = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
export function record(value: unknown, label = "value"): Row {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}
export function rowCap(n = MAX_ROWS): number {
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_ROWS) throw new Error(`maxRows must be between 1 and ${MAX_ROWS}`);
  return n;
}
export function checkAbort(signal?: AbortSignal) { signal?.throwIfAborted(); }
export const emptyMeta = (): DatasetMeta => ({ warnings: [], truncated: false, sourceRows: 0 });
function boundedInput(value: unknown) {
  const stack: [unknown, number][] = [[value, 0]]; let cells = 0, bytes = 0;
  while (stack.length) {
    const [item, depth] = stack.pop()!;
    if (++cells > 250000 || depth > 16 || bytes > MAX_BYTES) throw new Error("Dataset exceeds payload or nesting limit");
    if (typeof item === "string") bytes += item.length * 2;
    else if (Array.isArray(item)) { if (item.length > 100000) throw new Error("Dataset array exceeds payload limit"); for (const child of item) stack.push([child, depth + 1]); }
    else if (isRecord(item)) { const entries = Object.entries(item); if (entries.length > MAX_FIELDS) throw new Error("Dataset object exceeds field limit"); for (const [key, child] of entries) { bytes += key.length * 2; stack.push([child, depth + 1]); } }
    else bytes += 8;
  }
}
function sourceMeta(input: unknown, meta: DatasetMeta): DatasetMeta {
  if (!isRecord(input) || !isRecord(input.meta)) return meta;
  const original = input.meta;
  const warnings = Array.isArray(original.warnings) ? original.warnings.filter((v): v is string => typeof v === "string").slice(0, 100) : [];
  return { ...meta, warnings: [...warnings, ...meta.warnings], truncated: meta.truncated || original.truncated === true, sourceRows: Number.isSafeInteger(original.sourceRows) && Number(original.sourceRows) >= meta.sourceRows ? Number(original.sourceRows) : meta.sourceRows, ...(typeof original.revision === "string" ? { revision: original.revision } : {}) };
}
function safeCell(value: unknown, depth = 0): unknown {
  if (depth > 12) throw new Error("Dataset nesting exceeds 12 levels");
  if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) return null;
  if (value === null || ["string", "boolean", "number"].includes(typeof value)) return value;
  if (Array.isArray(value)) {
    if (value.length > MAX_ROWS) throw new Error("Cell array exceeds row limit");
    return value.map(v => safeCell(v, depth + 1));
  }
  if (isRecord(value)) {
    if (Object.keys(value).length > MAX_FIELDS) throw new Error("Cell object exceeds field limit");
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, safeCell(v, depth + 1)]));
  }
  throw new Error("Dataset cells must contain JSON values");
}
function typeOf(values: unknown[]): FieldType {
  const types = new Set(values.filter(v => v != null).map(v => typeof v));
  return types.size !== 1 ? "other" : types.has("number") ? "number" : types.has("boolean") ? "boolean" : types.has("string") ? "string" : "other";
}
export function convertCell(value: unknown, type: FieldType): unknown {
  if (value === null || value === undefined || value === "") return null;
  if (type === "number") { const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN; return Number.isFinite(n) ? n : null; }
  if (type === "boolean") return value === true || value === "true" || value === 1 ? true : value === false || value === "false" || value === 0 ? false : null;
  if (type === "time") { const time = typeof value === "string" || typeof value === "number" ? new Date(value).valueOf() : NaN; return Number.isFinite(time) ? new Date(time).toISOString() : null; }
  if (type === "string") return typeof value === "object" ? JSON.stringify(value) : String(value);
  return safeCell(value);
}
export function normalizeTable(input: unknown, options: NormalizeOptions = {}): TabularDataset {
  boundedInput(input);
  const raw = Array.isArray(input) ? input : record(input).rows;
  if (!Array.isArray(raw)) throw new Error("Tabular source requires an array of row objects or {rows: []}");
  const cap = rowCap(options.maxRows), warnings: string[] = [];
  const rows = raw.slice(0, cap).map((v, i) => safeCell(record(v, `row ${i}`)) as Row);
  const names = [...new Set(rows.flatMap(r => Object.keys(r)))];
  if (names.length > MAX_FIELDS) throw new Error(`Dataset exceeds ${MAX_FIELDS} fields`);
  const declared = options.fields ?? (isRecord(input) && Array.isArray(input.fields) ? input.fields as DatasetField[] : []);
  if (declared.length > MAX_FIELDS || new Set(declared.map(f => f.name)).size !== declared.length) throw new Error("Invalid or duplicate field declarations");
  for (const field of declared) {
    if (!field || typeof field.name !== "string" || !field.name || !["number", "string", "boolean", "time", "other"].includes(field.type)) throw new Error("Invalid field declaration");
    if (field.unit !== undefined && field.unit !== null && typeof field.unit !== "string") throw new Error("Invalid field unit");
    if (field.limits != null && (!isRecord(field.limits) || [field.limits.lower, field.limits.upper].some(v => v !== null && (typeof v !== "number" || !Number.isFinite(v))))) throw new Error("Invalid field limits");
    if (!names.includes(field.name)) names.push(field.name);
  }
  if (names.length > MAX_FIELDS) throw new Error(`Dataset exceeds ${MAX_FIELDS} fields`);
  let invalid = 0;
  const fields = names.map(name => {
    const explicit = declared.find(f => f.name === name);
    if (explicit) for (const row of rows) { const before = Object.hasOwn(row, name) ? row[name] : undefined; const value = convertCell(before, explicit.type); Object.defineProperty(row, name, { value, writable: true, enumerable: true, configurable: true }); if (before != null && before !== "" && value === null) invalid++; }
    else for (const row of rows) if (!Object.hasOwn(row, name) || row[name] == null) Object.defineProperty(row, name, { value: null, writable: true, enumerable: true, configurable: true });
    return explicit ? { ...explicit } : { name, type: typeOf(rows.map(r => r[name])) };
  });
  if (invalid) warnings.push(`${invalid} values could not be converted to their declared type and became null`);
  const meta = { warnings, truncated: raw.length > cap, sourceRows: raw.length };
  if (meta.truncated) warnings.push(`Source capped at ${cap} rows`);
  return { kind: "table", fields, rows, meta: sourceMeta(input, meta) };
}
export function normalizeGraph(input: unknown, options: NormalizeOptions = {}): GraphDataset {
  boundedInput(input);
  const raw = record(input);
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) throw new Error("Graph source requires nodes and edges arrays");
  const cap = rowCap(options.maxRows), warnings: string[] = [];
  // Source snapshots preserve identity fields until the panel supplies its mapping.
  // Even an apparent canonical id can be metadata while nodeId points at another key.
  if (options.deferGraphIdentity) {
    const nodes = raw.nodes.slice(0, cap).map((v, i) => safeCell(record(v, `node ${i}`)) as Row);
    const edges = raw.edges.slice(0, cap).map((v, i) => safeCell(record(v, `edge ${i}`)) as Row);
    const truncated = raw.nodes.length > cap || raw.edges.length > cap;
    if (truncated) warnings.push(`Graph capped at ${cap} nodes and ${cap} edges`);
    return { kind: "graph", nodes, edges, meta: sourceMeta(input, { warnings, truncated, sourceRows: raw.nodes.length + raw.edges.length }) };
  }
  const seen = new Set<string>();
  const nodes = raw.nodes.slice(0, cap).map((v, i) => {
    const node = safeCell(record(v, `node ${i}`)) as Row;
    if ((typeof node.id !== "string" && typeof node.id !== "number") || String(node.id) === "") throw new Error("Graph nodes require nonempty string/number ids");
    node.id = String(node.id);
    if (seen.has(node.id as string)) throw new Error(`Duplicate graph node id: ${node.id}`);
    seen.add(node.id as string); return node;
  });
  const edgeIds = new Set<string>(); let dangling = 0;
  const edges: Row[] = [];
  for (const value of raw.edges.slice(0, cap)) {
    const edge = safeCell(record(value, "edge")) as Row;
    if (![edge.source, edge.target].every(v => (typeof v === "string" && v.length > 0) || typeof v === "number")) throw new Error("Graph edges require string/number source and target");
    edge.source = String(edge.source); edge.target = String(edge.target);
    if (!seen.has(edge.source as string) || !seen.has(edge.target as string)) { dangling++; continue; }
    if (edge.id != null) { edge.id = String(edge.id); if (edgeIds.has(edge.id as string)) throw new Error(`Duplicate graph edge id: ${edge.id}`); edgeIds.add(edge.id as string); }
    edges.push(edge);
  }
  if (dangling) warnings.push(`${dangling} dangling edges omitted`);
  const truncated = raw.nodes.length > cap || raw.edges.length > cap;
  if (truncated) warnings.push(`Graph capped at ${cap} nodes and ${cap} edges`);
  return { kind: "graph", nodes, edges, meta: sourceMeta(input, { warnings, truncated, sourceRows: raw.nodes.length + raw.edges.length }) };
}
export function normalizeDataset(input: unknown, options: NormalizeOptions = {}): Dataset {
  return options.format === "graph" || (isRecord(input) && (input.kind === "graph" || "nodes" in input)) ? normalizeGraph(input, { ...options, deferGraphIdentity: true }) : normalizeTable(input, options);
}
/** RFC 4180 quotes, CRLF, escaped quotes and embedded newlines; no formula execution. */
export function parseCSV(text: string, maxRows = MAX_ROWS): Row[] {
  if (text.length > MAX_BYTES) throw new Error("CSV payload exceeds size limit");
  const cap = rowCap(maxRows), rows: string[][] = []; let row: string[] = [], cell = "", quoted = false, closed = false;
  const pushCell = () => { row.push(cell); cell = ""; closed = false; if (row.length > MAX_FIELDS) throw new Error("CSV exceeds field limit"); };
  const pushRow = () => { pushCell(); rows.push(row); row = []; if (rows.length > cap + 1) return true; return false; };
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } } else cell += c; continue; }
    if (c === '"' && !cell && !closed) { quoted = true; continue; }
    if (c === ",") { pushCell(); continue; }
    if (c === "\r" || c === "\n") { if (c === "\r" && text[i + 1] === "\n") i++; if (pushRow()) break; continue; }
    if (closed || c === '"') throw new Error("Malformed CSV quoting");
    cell += c;
  }
  if (quoted) throw new Error("Unterminated CSV quoted field");
  if (cell || row.length || closed) pushRow();
  if (!rows.length) return [];
  const headers = rows.shift()!;
  if (headers.some(h => !h) || new Set(headers).size !== headers.length) throw new Error("CSV headers must be nonempty and unique");
  return rows.filter(r => r.length > 1 || r[0] !== "").map((r, i) => { if (r.length !== headers.length) throw new Error(`CSV row ${i + 2} has wrong column count`); return Object.fromEntries(headers.map((h, j) => [h, r[j]])); });
}
