import type { Row, TabularDataset } from "./types";

export interface ChartMark { x: number; y: number; label: string; row: Row }
export interface ChartSlice { label: string; value: number; row: Row }
export interface TimelineEvent { label: string; start: number; end: number; row: Row }
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const timestamp = (value: unknown): number | null => {
  const numeric = number(value);
  if (numeric !== null) return Math.abs(numeric) <= 8640000000000000 ? numeric : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null;
};

export function chartMarks(dataset: TabularDataset, mapping: Record<string, string>, kind: "area" | "scatter") {
  const warnings: string[] = [], errors: string[] = [];
  const xField = mapping.x, yField = mapping.y ?? mapping.value;
  for (const [role, field] of [["x", xField], ["y", yField]]) if (!field || !dataset.fields.some(item => item.name === field)) errors.push(`${kind} needs an existing field for "${role}".`);
  const xType = dataset.fields.find(field => field.name === xField)?.type;
  if (kind === "scatter" && xType !== "number" && xType !== "time") errors.push("Scatter x must be numeric or time.");
  if (dataset.fields.find(field => field.name === yField)?.type !== "number") errors.push(`${kind} y must be numeric.`);
  const marks: ChartMark[] = [];
  let omitted = 0;
  for (const [index, row] of dataset.rows.entries()) {
    const x = xType === "time" ? timestamp(row[xField]) : xType === "number" ? number(row[xField]) : index;
    const y = number(row[yField]);
    if (x === null || y === null) { omitted++; continue; }
    if (marks.length >= 1000) { omitted++; continue; }
    marks.push({ x, y, label: String(row[mapping.label ?? xField] ?? ""), row });
  }
  if (omitted) warnings.push(`${omitted} invalid or excess rows omitted (1,000 mark limit).`);
  if (marks.length && (!Number.isFinite(Math.max(...marks.map(mark => mark.x)) - Math.min(...marks.map(mark => mark.x))) || !Number.isFinite(Math.max(0, ...marks.map(mark => mark.y)) - Math.min(0, ...marks.map(mark => mark.y))))) errors.push("Chart range exceeds numeric precision; rescale the data first.");
  if (kind === "area") marks.sort((a, b) => a.x - b.x);
  return { marks, warnings, errors, xType };
}

export function chartSlices(dataset: TabularDataset, mapping: Record<string, string>) {
  const slices = new Map<string, ChartSlice>(), warnings: string[] = [], errors: string[] = [];
  const category = mapping.category ?? mapping.label ?? mapping.x, value = mapping.value ?? mapping.y;
  if (!category || !dataset.fields.some(field => field.name === category)) errors.push("Pie needs an existing category field.");
  if (!value || dataset.fields.find(field => field.name === value)?.type !== "number") errors.push("Pie needs a numeric value field.");
  let omitted = 0;
  for (const row of dataset.rows) {
    const numeric = number(row[value]);
    if (numeric === null || numeric < 0 || row[category] == null) { omitted++; continue; }
    const key = JSON.stringify([typeof row[category], row[category]]), current = slices.get(key);
    if (current) current.value += numeric;
    else slices.set(key, { label: String(row[category]), value: numeric, row });
  }
  if (omitted) warnings.push(`${omitted} missing or negative values omitted; pie charts require nonnegative values.`);
  const result = [...slices.values()].filter(slice => slice.value > 0);
  if (!Number.isFinite(result.reduce((sum, slice) => sum + slice.value, 0))) errors.push("Pie total exceeds numeric range; rescale the data first.");
  return { slices: result, warnings, errors };
}

export function timelineEvents(dataset: TabularDataset, mapping: Record<string, string>) {
  const events: TimelineEvent[] = [], warnings: string[] = [], errors: string[] = [];
  const startField = mapping.start ?? mapping.time ?? mapping.x ?? "start", endField = mapping.end ?? "end";
  if (!dataset.fields.some(field => field.name === startField)) errors.push("Timeline needs an existing start field.");
  let omitted = 0;
  for (const row of dataset.rows) {
    const start = timestamp(row[startField]), rawEnd = row[endField], end = rawEnd == null ? start : timestamp(rawEnd);
    if (start === null || end === null || end < start || events.length >= 200) { omitted++; continue; }
    events.push({ label: String(row[mapping.label ?? "label"] ?? row[startField]), start, end, row });
  }
  events.sort((a, b) => a.start - b.start);
  if (omitted) warnings.push(`${omitted} invalid or excess events omitted (200 event limit).`);
  return { events, warnings, errors };
}
