import type { Row, TabularDataset } from "./types";

export type HeatmapAggregate = "mean" | "sum" | "min" | "max" | "count" | "last";
export interface HeatmapCategory { key: string; label: string; value: unknown }
export interface HeatmapCell {
  key: string; x: HeatmapCategory; y: HeatmapCategory; value: number | null;
  count: number; row: Row; missing: boolean;
}
export interface HeatmapModel {
  x: HeatmapCategory[]; y: HeatmapCategory[]; cells: HeatmapCell[];
  min: number; max: number; warnings: string[]; errors: string[]; aggregate: HeatmapAggregate;
}
const numeric = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const categoryKey = (value: unknown) => JSON.stringify([typeof value, value]);
const validCategory = (value: unknown) => value != null && ["string", "number", "boolean"].includes(typeof value) && (typeof value !== "number" || Number.isFinite(value));

/** Aggregate repeated coordinates before rendering. Empty cells and numeric zero stay distinct. */
export function buildHeatmapModel(dataset: TabularDataset, mapping: Record<string, string>, display: Row = {}): HeatmapModel {
  const aggregate: HeatmapAggregate = ["mean", "sum", "min", "max", "count", "last"].includes(String(display.aggregate)) ? display.aggregate as HeatmapAggregate : "mean";
  const model: HeatmapModel = { x: [], y: [], cells: [], min: 0, max: 1, warnings: [], errors: [], aggregate };
  const xField = mapping.x, yField = mapping.y, valueField = mapping.value;
  for (const [role, field] of [["x", xField], ["y", yField], ["value", valueField]]) {
    if (!field || !dataset.fields.some(item => item.name === field)) model.errors.push(`Heatmap needs an existing field for "${role}".`);
  }
  if (model.errors.length) return model;
  if (dataset.fields.find(field => field.name === valueField)?.type !== "number") {
    model.errors.push(`Heatmap value field "${valueField}" must be numeric.`);
    return model;
  }
  const maxCells = numeric(display.maxCells) ? Math.max(1, Math.min(10000, Math.floor(display.maxCells))) : 3600;
  const maxCategories = numeric(display.maxCategories) ? Math.max(1, Math.min(200, Math.floor(display.maxCategories))) : 100;
  const xs = new Map<string, HeatmapCategory>(), ys = new Map<string, HeatmapCategory>();
  const groups = new Map<string, { sum: number; mean: number; min: number; max: number; last: number; count: number; row: Row }>();
  let invalidCategories = 0, invalidValues = 0, omitted = 0;
  for (const row of dataset.rows) {
    const xv = row[xField], yv = row[yField];
    if (!validCategory(xv) || !validCategory(yv)) { invalidCategories++; continue; }
    const xk = categoryKey(xv), yk = categoryKey(yv);
    const nextX = xs.size + (xs.has(xk) ? 0 : 1), nextY = ys.size + (ys.has(yk) ? 0 : 1);
    if (nextX > maxCategories || nextY > maxCategories || nextX * nextY > maxCells) { omitted++; continue; }
    if (!xs.has(xk)) xs.set(xk, { key: xk, label: String(xv), value: xv });
    if (!ys.has(yk)) ys.set(yk, { key: yk, label: String(yv), value: yv });
    const key = JSON.stringify([xk, yk]);
    const value = row[valueField];
    if (!numeric(value)) { if (value != null) invalidValues++; continue; }
    const group = groups.get(key);
    if (group) {
      group.sum += value; group.min = Math.min(group.min, value); group.max = Math.max(group.max, value);
      group.last = value; group.count++; group.mean = group.mean * (1 - 1 / group.count) + value / group.count; group.row = row;
    } else groups.set(key, { sum: value, mean: value, min: value, max: value, last: value, count: 1, row });
  }
  model.x = [...xs.values()]; model.y = [...ys.values()];
  for (const y of model.y) for (const x of model.x) {
    const key = JSON.stringify([x.key, y.key]), group = groups.get(key);
    const computed = group ? group[aggregate] : null;
    const value = computed !== null && Number.isFinite(computed) ? computed : null;
    if (computed !== null && value === null) model.warnings.push(`Cell ${x.label} / ${y.label} exceeds numeric range and is shown as missing.`);
    model.cells.push({ key, x, y, value, count: group?.count ?? 0, row: group?.row ?? {}, missing: value === null });
  }
  const values = model.cells.flatMap(cell => cell.value === null ? [] : [cell.value]);
  model.min = numeric(display.min) ? display.min : values.length ? Math.min(...values) : 0;
  model.max = numeric(display.max) ? display.max : values.length ? Math.max(...values) : 1;
  if (model.min > model.max) model.errors.push("Heatmap minimum must not exceed its maximum.");
  if (omitted) model.warnings.push(`${omitted} rows omitted: heatmap is limited to ${maxCells} cells and ${maxCategories} categories per axis. Narrow the query to see more.`);
  if (invalidCategories) model.warnings.push(`${invalidCategories} rows have missing or invalid categories.`);
  if (invalidValues) model.warnings.push(`${invalidValues} nonnumeric values are shown as missing.`);
  return model;
}

export function heatmapFraction(value: number, min: number, max: number): number {
  if (min === max) return 0.5;
  const clamped = Math.max(min, Math.min(max, value)), range = max - min;
  return Number.isFinite(range) ? (clamped - min) / range : (clamped / 2 - min / 2) / (max / 2 - min / 2);
}

/** The same sequential ramp is used by cells and their numeric legend. */
export function heatmapColor(value: number | null, min: number, max: number, palette = "blue"): string {
  if (value === null) return "#182235";
  const t = heatmapFraction(value, min, max);
  const ramps: Record<string, [number[], number[]]> = { blue: [[224,242,254],[3,75,148]], green: [[220,252,231],[6,95,70]], purple: [[243,232,255],[88,28,135]], gray: [[241,245,249],[30,41,59]] };
  const [low, high] = ramps[palette] ?? ramps.blue;
  return `rgb(${low.map((channel, i) => Math.round(channel + (high[i] - channel) * t)).join(", ")})`;
}

export function heatmapCellValues(cell: HeatmapCell): Row {
  return { ...cell.row, x: cell.x.value, y: cell.y.value, value: cell.value, count: cell.count };
}
