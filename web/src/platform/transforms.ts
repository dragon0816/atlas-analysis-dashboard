import { checkAbort, isRecord, MAX_ROWS, normalizeTable, record, rowCap } from "./dataset.ts";
import type { Dataset, DatasetField, Row, TabularDataset, TransformStep, VariableValues } from "./types";
import type { FieldType } from "./types";
export interface TransformContext {
  signal?: AbortSignal; maxRows?: number; variables?: VariableValues;
  transforms?: Record<string, TransformStep[]>; graphMapping?: Record<string, string>;
  getSource?: (id: string, query?: Row) => Promise<Dataset>;
}
export function resolveVariables(value: unknown, variables: VariableValues): unknown {
  if (typeof value === "string" && /^\$[\w.-]+$/.test(value)) { const key = value.slice(1); if (!Object.hasOwn(variables, key)) throw new Error(`Unknown variable: ${key}`); return variables[key]; }
  if (Array.isArray(value)) return value.map(v => resolveVariables(v, variables));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveVariables(v, variables)]));
  return value;
}
const strings = (value: unknown, label: string): string[] => { if (!Array.isArray(value) || value.length > 256 || value.some(v => typeof v !== "string" || !v)) throw new Error(`${label} must be an array of field names`); return value as string[]; };
function needField(data: TabularDataset, name: string): DatasetField { const field = data.fields.find(f => f.name === name); if (!field) throw new Error(`Field unavailable: ${name}`); return field; }
function table(data: Dataset): TabularDataset { if (data.kind !== "table") throw new Error("This transform requires tabular data"); return data; }
function finite(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
export function timeRange(value: unknown): [number | null, number | null] {
  if (typeof value !== "string" || value.split("/").length !== 2) throw new Error("Time range must be ISO_FROM/ISO_TO (either endpoint may be empty)");
  const bounds = value.split("/").map(part => {
    if (!part) return null;
    if (!/^\d{4}-\d{2}-\d{2}(?:T.*(?:Z|[+-]\d{2}:\d{2}))?$/.test(part)) throw new Error("Time range endpoints require ISO dates or timestamps with a timezone");
    const timestamp = Date.parse(part); if (!Number.isFinite(timestamp)) throw new Error("Invalid time range endpoint"); return timestamp;
  }) as [number | null, number | null];
  if (bounds[0] !== null && bounds[1] !== null && bounds[0] > bounds[1]) throw new Error("Time range start must not follow its end");
  return bounds;
}
function compare(actual: unknown, operator: unknown, expected: unknown): boolean {
  if (operator === "time_range") {
    const [from, to] = timeRange(expected);
    if (from === null && to === null) return true;
    const timestamp = typeof actual === "number" ? actual : typeof actual === "string" ? Date.parse(actual) : NaN;
    return Number.isFinite(timestamp) && (from === null || timestamp >= from) && (to === null || timestamp <= to);
  }
  if (operator === "eq" || operator === "=") return actual === expected;
  if (operator === "ne" || operator === "!=") return actual !== expected;
  if (operator === "in" || operator === "not_in") { if (!Array.isArray(expected)) throw new Error("in requires an array value"); return expected.includes(actual) === (operator === "in"); }
  if (operator === "is_null") return actual == null;
  if (operator === "not_null") return actual != null;
  if (operator === "contains") return typeof actual === "string" && typeof expected === "string" && actual.includes(expected);
  if (!["gt", "gte", "lt", "lte"].includes(String(operator))) throw new Error(`Unsupported filter operator: ${operator}`);
  if (actual == null || expected == null || typeof actual !== typeof expected || !["string", "number"].includes(typeof actual)) return false;
  const a = actual as number, b = expected as number;
  return operator === "gt" ? a > b : operator === "gte" ? a >= b : operator === "lt" ? a < b : a <= b;
}
export function filterDataset(data: Dataset, where: Row, skipMissingGraphFields = false, graphMapping: Record<string, string> = {}): Dataset {
  const clauses = Object.entries(where).map(([field, value]) => ({ field, operator: Array.isArray(value) ? "in" : "eq", value }));
  return filterClauses(data, clauses, skipMissingGraphFields, graphMapping);
}
export function filterTimeRangeDataset(data: Dataset, field: string, value: unknown, graphMapping: Record<string, string> = {}): Dataset {
  timeRange(value);
  return filterClauses(data, [{ field, operator: "time_range", value }], data.kind === "graph", graphMapping);
}
function filterClauses(data: Dataset, clauses: Row[], skipMissingGraphFields = false, graphMapping: Record<string, string> = {}): Dataset {
  for (const clause of clauses) {
    if (typeof clause.field !== "string") throw new Error("Filter requires a field");
    if (data.kind === "table") needField(data, clause.field);
    else if (![...data.nodes, ...data.edges].some(r => Object.hasOwn(r, String(clause.field))) && data.nodes.length) throw new Error(`Field unavailable: ${clause.field}`);
    // Validate operators even for empty datasets.
    compare(null, clause.operator ?? "eq", clause.value);
  }
  const match = (row: Row) => clauses.every(c => skipMissingGraphFields && !Object.hasOwn(row, String(c.field)) || (skipMissingGraphFields && Array.isArray(row[String(c.field)]) ? (row[String(c.field)] as unknown[]).some(value => compare(value, c.operator ?? "eq", c.value)) : compare(row[String(c.field)], c.operator ?? "eq", c.value)));
  if (data.kind === "table") return { ...data, rows: data.rows.filter(match) };
  const nodes = data.nodes.filter(match), ids = new Set(nodes.map(n => String(n[graphMapping.nodeId || "id"])));
  return { ...data, nodes, edges: data.edges.filter(e => ids.has(String(e[graphMapping.edgeSource || "source"])) && ids.has(String(e[graphMapping.edgeTarget || "target"])) && match(e)) };
}
function group(data: TabularDataset, step: Row, signal?: AbortSignal): TabularDataset {
  const by = strings(step.by ?? [], "Group by"); by.forEach(k => needField(data, k));
  if (!Array.isArray(step.metrics) || !step.metrics.length || step.metrics.length > 256) throw new Error("Aggregate requires metrics");
  const metricNames = new Set(by);
  const metrics = step.metrics.map(raw => {
    const m = typeof raw === "string" ? { field: "value", function: raw, as: raw } : record(raw, "metric");
    const fn = String(m.function ?? m.op), name = String(m.as ?? `${fn}_${m.field ?? "rows"}`);
    if (!["count", "sum", "mean", "avg", "min", "max", "median", "first", "last", "distinct", "sigma"].includes(fn)) throw new Error(`Unsupported aggregate: ${fn}`);
    if (!name || metricNames.has(name)) throw new Error(`Duplicate aggregate output: ${name}`); metricNames.add(name);
    if (m.field != null) needField(data, String(m.field)); else if (fn !== "count") throw new Error(`${fn} requires a field`);
    if (!["count", "distinct", "first", "last"].includes(fn) && needField(data, String(m.field)).type !== "number" && data.rows.length) throw new Error(`${fn} requires a numeric field`);
    return { fn, name, field: m.field == null ? null : String(m.field) };
  });
  const groups = new Map<string, Row[]>();
  for (let i = 0; i < data.rows.length; i++) { if (!(i % 256)) checkAbort(signal); const row = data.rows[i], key = JSON.stringify(by.map(k => row[k])); const rows = groups.get(key); if (rows) rows.push(row); else groups.set(key, [row]); }
  if (!by.length && !groups.size) groups.set("[]", []);
  const warnings = [...data.meta.warnings];
  const rows = [...groups.values()].map(rows => {
    const out: Row = Object.fromEntries(by.map(k => [k, rows[0]?.[k] ?? null]));
    for (const m of metrics) {
      if (m.field === "value" && rows.some(r => r.unit !== rows[0]?.unit)) throw new Error("Mixed units in aggregate; group by unit or filter one unit");
      const values = m.field === null ? [] : rows.map(r => r[m.field!]);
      const numbers = values.map(finite).filter((v): v is number => v !== null).sort((a, b) => a - b);
      const n = numbers.length, mean = n ? numbers.reduce((a, b) => a + b, 0) / n : null;
      let value: unknown = null;
      switch (m.fn) {
        case "count": value = m.field ? values.filter(v => v != null).length : rows.length; break;
        case "distinct": value = new Set(values.filter(v => v != null).map(v => JSON.stringify(v))).size; break;
        case "first": value = values[0] ?? null; break;
        case "last": value = values.at(-1) ?? null; break;
        case "sum": value = n ? numbers.reduce((a, b) => a + b, 0) : null; break;
        case "mean": case "avg": value = mean; break;
        case "min": value = numbers[0] ?? null; break;
        case "max": value = numbers.at(-1) ?? null; break;
        case "median": value = n ? (numbers[Math.floor((n - 1) / 2)] + numbers[Math.ceil((n - 1) / 2)]) / 2 : null; break;
        case "sigma": value = n > 1 ? Math.sqrt(numbers.reduce((sum, v) => sum + (v - mean!) ** 2, 0) / (n - 1)) : null;
      }
      Object.defineProperty(out, m.name, { value: typeof value === "number" && !Number.isFinite(value) ? null : value, enumerable: true, writable: true, configurable: true });
    }
    return out;
  });
  const fields = [...by.map(k => ({ ...needField(data, k) })), ...metrics.map(m => {
    const source = m.field ? needField(data, m.field) : undefined;
    const type = ["first", "last"].includes(m.fn) ? source?.type ?? "other" : "number";
    const unit = ["count", "distinct"].includes(m.fn) ? null : source?.unit;
    return { name: m.name, type, unit, limits: null } as DatasetField;
  })];
  if (data.fields.some(f => f.limits)) warnings.push("Aggregation clears per-row limits; original measurement limits are not aggregate limits");
  return { kind: "table", fields, rows, meta: { ...data.meta, warnings } };
}
async function join(data: TabularDataset, step: Row, ctx: TransformContext): Promise<TabularDataset> {
  if (!ctx.getSource || typeof step.source !== "string") throw new Error("Join requires a registered source");
  const right = table(await ctx.getSource(step.source, isRecord(step.query) ? step.query : undefined)); checkAbort(ctx.signal);
  const on = typeof step.on === "string" ? { left: step.on, right: step.on } : record(step.on, "join.on");
  const leftKeys = Array.isArray(on.left) ? strings(on.left, "left keys") : [String(on.left)], rightKeys = Array.isArray(on.right) ? strings(on.right, "right keys") : [String(on.right)];
  if (!leftKeys.length || leftKeys.length !== rightKeys.length) throw new Error("Join keys must have equal nonzero lengths");
  leftKeys.forEach(k => needField(data, k)); rightKeys.forEach(k => needField(right, k));
  const how = step.how ?? "left"; if (!["left", "inner"].includes(String(how))) throw new Error("Join supports left and inner");
  const prefix = typeof step.prefix === "string" ? step.prefix : "right.";
  const used = new Set(data.fields.map(f => f.name));
  const mappings = right.fields.map(f => { const name = typeof step.prefix === "string" || used.has(f.name) ? `${prefix}${f.name}` : f.name; if (used.has(name)) throw new Error(`Join output collision: ${name}`); used.add(name); return { from: f.name, field: { ...f, name } }; });
  const key = (row: Row, keys: string[]) => keys.some(k => row[k] == null) ? null : JSON.stringify(keys.map(k => row[k]));
  const index = new Map<string, Row[]>();
  for (const row of right.rows) { const k = key(row, rightKeys); if (k === null) continue; const bucket = index.get(k); if (bucket) bucket.push(row); else index.set(k, [row]); }
  const cap = rowCap(ctx.maxRows), output: Row[] = []; let truncated = false;
  outer: for (let i = 0; i < data.rows.length; i++) {
    if (!(i % 128)) checkAbort(ctx.signal);
    const row = data.rows[i], k = key(row, leftKeys), matches = k === null ? undefined : index.get(k);
    for (const r of matches?.length ? matches : how === "left" ? [null] : []) {
      if (output.length >= cap) { truncated = true; break outer; }
      output.push({ ...row, ...Object.fromEntries(mappings.map(m => [m.field.name, r?.[m.from] ?? null])) });
    }
  }
  const warnings = [...data.meta.warnings, ...right.meta.warnings]; if (truncated) warnings.push(`Join output capped at ${cap} rows before materializing excess matches`);
  return { kind: "table", rows: output, fields: [...data.fields, ...mappings.map(m => m.field)], meta: { ...data.meta, truncated: truncated || data.meta.truncated || right.meta.truncated, warnings } };
}
function calculate(data: TabularDataset, step: Row): TabularDataset {
  if (typeof step.as !== "string" || !step.as) throw new Error("Calculate requires an output field");
  const from = strings(step.from, "Calculate from"), fn = String(step.fn ?? step.function);
  if (!from.length || !["sum", "difference", "ratio", "scale", "coalesce", "sigmaBand"].includes(fn)) throw new Error("Unsupported calculation");
  const sources = from.map(k => needField(data, k));
  for (const key of ["factor", "offset", "k"]) if (step[key] !== undefined && finite(step[key]) === null) throw new Error(`Invalid ${key}`);
  if (fn !== "coalesce" && sources.some(f => f.type !== "number") && data.rows.length) throw new Error("Calculation requires numeric fields");
  if (["sum", "difference", "sigmaBand"].includes(fn) && new Set(sources.map(f => f.unit ?? null)).size > 1) throw new Error("Calculation cannot combine mixed units");
  if (["ratio", "difference", "sigmaBand"].includes(fn) && from.length !== 2) throw new Error(`${fn} requires two fields`);
  if (fn === "scale" && from.length !== 1) throw new Error("scale requires one field");
  const rows = data.rows.map(row => {
    const raw = from.map(k => row[k]); let value: unknown = null;
    if (fn === "coalesce") value = raw.find(v => v != null) ?? null;
    else if (raw.every(v => finite(v) !== null)) {
      const v = raw as number[];
      value = fn === "sum" ? v.reduce((a, b) => a + b, 0) : fn === "difference" ? v[0] - v[1] : fn === "ratio" ? v[1] === 0 ? null : v[0] / v[1] : fn === "scale" ? v[0] * Number(step.factor ?? 1) + Number(step.offset ?? 0) : v[0] + Number(step.k ?? 3) * v[1];
    }
    return { ...row, [String(step.as)]: typeof value === "number" && !Number.isFinite(value) ? null : value };
  });
  const field: DatasetField = { name: step.as, type: fn === "coalesce" ? sources[0].type : "number", unit: fn === "ratio" ? null : sources[0].unit, limits: null };
  return { ...data, rows, fields: [...data.fields.filter(f => f.name !== step.as), field] };
}
export async function executePipeline(input: Dataset, steps: TransformStep[], context: TransformContext = {}, refs: string[] = []): Promise<Dataset> {
  if (!Array.isArray(steps) || steps.length > 64) throw new Error("Pipeline supports at most 64 steps");
  let data = input;
  for (const raw of steps) {
    checkAbort(context.signal);
    const step = record(resolveVariables(raw, context.variables ?? {}), "transform");
    switch (step.op) {
      case "ref": { const id = String(step.id); if (refs.includes(id) || refs.length >= 8) throw new Error("Cyclic or deeply nested transform reference"); const nested = context.transforms?.[id]; if (!nested) throw new Error(`Unknown transform: ${id}`); data = await executePipeline(data, nested, context, [...refs, id]); break; }
      case "filter": {
        if (isRecord(step.where)) data = filterDataset(data, step.where, false, context.graphMapping);
        else if (!(typeof raw.value === "string" && raw.value.startsWith("$") && ["*", "", null].includes(step.value as string | null))) data = filterClauses(data, [step], false, context.graphMapping);
        else if (["is_null", "not_null"].includes(String(step.operator))) data = filterClauses(data, [step], false, context.graphMapping);
        break;
      }
      case "normalize": {
        const current = table(data), types = record(step.fields, "normalize.fields");
        const fields = current.fields.map(f => ({ ...f }));
        for (const [name, type] of Object.entries(types)) { const field = needField(current, name); if (!["number", "string", "boolean", "time", "other"].includes(String(type))) throw new Error(`Invalid type: ${type}`); fields[fields.findIndex(f => f.name === field.name)] = { ...field, type: type as FieldType }; }
        const normalized = normalizeTable(current.rows, { fields, maxRows: context.maxRows });
        data = { ...normalized, meta: { ...current.meta, truncated: current.meta.truncated || normalized.meta.truncated, warnings: [...current.meta.warnings, ...normalized.meta.warnings] } }; break;
      }
      case "join": data = await join(table(data), step, context); break;
      case "group": case "aggregate": data = group(table(data), step, context.signal); break;
      case "calculate": case "derive": data = calculate(table(data), step); break;
      case "sort": {
        const current = table(data), by = typeof step.by === "string" ? [step.by] : strings(step.by, "Sort by"); by.forEach(k => needField(current, k));
        data = { ...current, rows: [...current.rows].sort((a, b) => { for (const field of by) { const av = a[field], bv = b[field]; if (av == null && bv != null) return 1; if (bv == null && av != null) return -1; const order = av === bv ? 0 : typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv)); if (order) return step.desc ? -order : order; } return 0; }) }; break;
      }
      case "limit": { if (!Number.isSafeInteger(step.n) || Number(step.n) < 0 || Number(step.n) > MAX_ROWS) throw new Error("Invalid limit"); const n = Number(step.n); if (data.kind === "table") data = { ...data, rows: data.rows.slice(0, n) }; else { const nodes = data.nodes.slice(0, n), ids = new Set(nodes.map(v => String(v[context.graphMapping?.nodeId || "id"]))); data = { ...data, nodes, edges: data.edges.filter(e => ids.has(String(e[context.graphMapping?.edgeSource || "source"])) && ids.has(String(e[context.graphMapping?.edgeTarget || "target"]))) }; } break; }
      default: throw new Error(`Unsupported transform: ${step.op}`);
    }
  }
  checkAbort(context.signal); return data;
}
