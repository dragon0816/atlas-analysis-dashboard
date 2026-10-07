import { isRecord, record } from "./dataset.ts";
import type { DashboardDocument, Row } from "./types";
const PANELS = new Set(["line", "mask", "bar", "box", "histogram", "stat", "gauge", "table", "heatmap", "network", "area", "pie", "donut", "scatter", "text", "status", "progress", "timeline"]);
const OPS = new Set(["filter", "normalize", "join", "group", "aggregate", "calculate", "derive", "sort", "limit", "ref"]);
const ACTIONS = new Set(["set_filter", "open_details", "navigate", "drill_down", "highlight", "open_link"]);
function text(value: unknown, label: string, nonempty = false, max = 4096): asserts value is string { if (typeof value !== "string" || value.length > max || (nonempty && !value.trim())) throw new Error(`${label} must be ${nonempty ? "a nonempty" : "a"} string`); }
function keys(value: Row, allowed: string[], label: string) { const unknown = Object.keys(value).find(k => !allowed.includes(k)); if (unknown) throw new Error(`Unknown ${label} option: ${unknown}`); }
function array(value: unknown, label: string, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be an array of at most ${max} items`); return value; }
function finiteJSON(raw: unknown) {
  const pending: [unknown, number][] = [[raw, 0]]; let values = 0;
  while (pending.length) {
    const [value, depth] = pending.pop()!; if (depth > 64 || ++values > 100000) throw new Error("Dashboard JSON exceeds its depth or value limit");
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("Dashboard numbers must be finite"); }
    else if (Array.isArray(value)) pending.push(...value.map(v => [v, depth + 1] as [unknown, number]));
    else if (isRecord(value)) pending.push(...Object.values(value).map(v => [v, depth + 1] as [unknown, number]));
    else throw new Error("Dashboard must contain JSON values");
  }
  if (new TextEncoder().encode(JSON.stringify(raw)).length > 2_000_000) throw new Error("Dashboard exceeds 2 MB");
}
function boundedObject(value: unknown, label: string, max = 512): Row { const object = record(value, label); if (Object.keys(object).length > max) throw new Error(`${label} has too many keys`); return object; }
function variableValue(value: unknown) { if (value === null || ["string", "number", "boolean"].includes(typeof value)) return; if (Array.isArray(value) && value.length <= 1024 && value.every(v => typeof v === "string")) return; throw new Error("Invalid variable value"); }
function validateAction(raw: unknown) {
  const action = boundedObject(raw, "action"); keys(action, ["action", "target", "url", "values"], "action");
  if (typeof action.action !== "string" || !ACTIONS.has(action.action)) throw new Error("Unsupported panel action");
  if (action.target !== undefined) text(action.target, "action.target", true, 256);
  if (action.url !== undefined) text(action.url, "action.url", true);
  if (action.values !== undefined) boundedObject(action.values, "action.values");
}
/** Validate recognized structure while retaining extra document metadata verbatim. */
export function validateDashboardDocument(input: unknown): asserts input is DashboardDocument {
  finiteJSON(input); const raw = boundedObject(input, "dashboard");
  if (raw.schemaVersion !== 2) throw new Error("Unsupported dashboard schemaVersion");
  text(raw.id, "id", true, 256); text(raw.applicationId, "applicationId", true, 256); text(raw.title, "title");
  if (raw.description !== undefined) text(raw.description, "description"); if (raw.presetId !== undefined) text(raw.presetId, "presetId", true, 256);
  const variables = array(raw.variables, "variables", 128), variableIds = new Set<string>();
  for (const item of variables) {
    const variable = boundedObject(item, "variable"); keys(variable, ["id", "label", "type", "default", "options"], "variable"); text(variable.id, "variable.id", true, 256);
    if (variableIds.has(variable.id)) throw new Error("Variable ids must be unique"); variableIds.add(variable.id);
    if (variable.label !== undefined) text(variable.label, "variable.label");
    if (variable.type !== undefined && !["string", "number", "boolean", "time_range"].includes(String(variable.type))) throw new Error("Invalid variable type");
    if (variable.default !== undefined) variableValue(variable.default);
    if (variable.options !== undefined && array(variable.options, "variable.options", 1024).some(v => typeof v !== "string" && typeof v !== "number")) throw new Error("Invalid variable options");
  }
  if (raw.values !== undefined) for (const value of Object.values(boundedObject(raw.values, "values", 128))) variableValue(value);
  const ids = new Set<string>();
  for (const item of array(raw.panels, "panels", 128)) {
    const panel = boundedObject(item, "panel"); keys(panel, ["id", "title", "type", "datasource", "query", "transform", "mapping", "display", "interaction", "layout", "refresh"], "panel");
    text(panel.id, "panel.id", true, 256); text(panel.title, "panel.title"); if (ids.has(panel.id)) throw new Error("Panel ids must be unique"); ids.add(panel.id);
    if ((typeof panel.type !== "string" || !PANELS.has(panel.type))) throw new Error(`Unsupported panel: ${panel.type}`);
    const source = boundedObject(panel.datasource, "datasource"); keys(source, ["id"], "datasource"); text(source.id, "datasource.id", true, 256);
    if (panel.query !== undefined) boundedObject(panel.query, "query");
    for (const raw of array(panel.transform, "transform", 64)) { const step = boundedObject(raw, "transform step", 128); if ((typeof step.op !== "string" || !OPS.has(step.op))) throw new Error(`Unsupported transform: ${step.op}`); }
    const mapping = boundedObject(panel.mapping, "mapping", 128); for (const value of Object.values(mapping)) text(value, "mapping field");
    boundedObject(panel.display, "display");
    if (panel.interaction !== undefined) { const interaction = boundedObject(panel.interaction, "interaction"); keys(interaction, ["on_click"], "interaction"); if (interaction.on_click !== undefined) { if (Array.isArray(interaction.on_click)) array(interaction.on_click, "on_click", 64).forEach(validateAction); else validateAction(interaction.on_click); } }
    const layout = boundedObject(panel.layout, "layout"); keys(layout, ["x", "y", "w", "h", "minW", "minH"], "layout");
    for (const key of ["x", "y", "w", "h", "minW", "minH"]) { if ((key === "minW" || key === "minH") && layout[key] === undefined) continue; const value = layout[key]; if (!Number.isSafeInteger(value) || Number(value) < (key === "x" || key === "y" ? 0 : 1) || Number(value) > 100000) throw new Error(`Invalid layout.${key}`); }
    if ((layout.minW !== undefined && Number(layout.minW) > Number(layout.w)) || (layout.minH !== undefined && Number(layout.minH) > Number(layout.h))) throw new Error("Layout minimum exceeds its size");
    if (panel.refresh !== undefined && (typeof panel.refresh !== "number" || panel.refresh < 0)) throw new Error("Invalid refresh interval");
  }
}
export function parseDashboardDocument(input: unknown): DashboardDocument {
  const document = typeof input === "string" ? JSON.parse(input) : input;
  validateDashboardDocument(document);
  return structuredClone(document);
}
