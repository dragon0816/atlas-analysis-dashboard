import type { PanelDefinition, Row, TabularDataset } from "../../platform/types";

export const MAX_CHART_ROWS = 2000;
export const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
export function fieldExists(dataset: TabularDataset, field: string | undefined): field is string { return !!field && dataset.fields.some(item => item.name === field); }
export function valueField(panel: PanelDefinition) { return panel.mapping.value ?? panel.mapping.y ?? "value"; }
export function numericRows(dataset: TabularDataset, panel: PanelDefinition) {
  const field = valueField(panel), values: { value: number; row: Row }[] = [];
  if (!fieldExists(dataset, field)) return { field, values, warnings: [], error: `Choose an existing numeric value field (currently “${field}”).` };
  let invalid = 0;
  for (const row of dataset.rows.slice(0, MAX_CHART_ROWS)) { const value = finite(row[field]); if (value === null) invalid++; else values.push({ value, row }); }
  const warnings = limitWarnings(dataset.rows.length);
  if (invalid) warnings.push(`${invalid} rows without a finite numeric value were omitted.`);
  return { field, values, warnings, error: "" };
}
export function limitWarnings(length: number, maximum = MAX_CHART_ROWS) { return length > maximum ? [`Showing the first ${maximum.toLocaleString("en-US")} of ${length.toLocaleString("en-US")} rows.`] : []; }

export function quantile(sorted: number[], proportion: number): number | null {
  if (!sorted.length) return null;
  const position = Math.max(0, Math.min(1, proportion)) * (sorted.length - 1), left = Math.floor(position), weight = position - left;
  return sorted[left] * (1 - weight) + sorted[Math.min(sorted.length - 1, left + 1)] * weight;
}
export function reduceValues(values: number[], reducer: unknown): number | null {
  if (!values.length) return null;
  let result: number;
  switch (reducer) {
    case "count": return values.length;
    case "sum": result = values.reduce((sum, value) => sum + value, 0); break;
    case "mean": case "avg": result = values.reduce((sum, value) => sum + value / values.length, 0); break;
    case "min": result = values.reduce((best, value) => Math.min(best, value), Infinity); break;
    case "max": result = values.reduce((best, value) => Math.max(best, value), -Infinity); break;
    case "first": return values[0];
    default: return values.at(-1)!;
  }
  return Number.isFinite(result) ? result : null;
}
export function buildHistogram(values: number[], requestedBins: unknown) {
  if (!values.length) return [];
  const min = values.reduce((a, b) => Math.min(a, b), Infinity), max = values.reduce((a, b) => Math.max(a, b), -Infinity);
  if (!Number.isFinite(max - min)) return [];
  const count = min === max ? 1 : Math.max(1, Math.min(64, Math.floor(finite(requestedBins) ?? Math.sqrt(values.length))));
  const bins = Array.from({ length: count }, (_, index) => ({ min: min + (max - min) * index / count, max: min + (max - min) * (index + 1) / count, count: 0 }));
  for (const value of values) bins[Math.min(count - 1, Math.max(0, Math.floor((value - min) / (max - min || 1) * count)))].count++;
  return bins;
}

export interface SeriesPoint { x: number; y: number; label: string; row: Row; low: number | null; high: number | null }
export interface Series { name: string; points: SeriesPoint[] }
export function buildSeries(dataset: TabularDataset, panel: PanelDefinition) {
  const xField = panel.mapping.x, yField = valueField(panel), seriesField = panel.mapping.series ?? panel.mapping.color;
  const warnings = limitWarnings(dataset.rows.length), series = new Map<string, Series>();
  if (!fieldExists(dataset, yField)) return { series: [], warnings, error: `Choose an existing y/value field (currently “${yField}”).` };
  if (xField && !fieldExists(dataset, xField)) return { series: [], warnings, error: `X field “${xField}” does not exist.` };
  const xType = dataset.fields.find(field => field.name === xField)?.type;
  const categoryIndexes = new Map<string, number>();
  let omitted = 0;
  for (const [index, row] of dataset.rows.slice(0, MAX_CHART_ROWS).entries()) {
    const raw = xField ? row[xField] : index;
    let x: number | null;
    if (!xField || xType === "number") x = finite(raw);
    else if (xType === "time") { const parsed = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Date.parse(raw) : NaN; x = Number.isFinite(parsed) ? parsed : null; }
    else { const key = raw == null ? "" : String(raw); if (!categoryIndexes.has(key)) categoryIndexes.set(key, categoryIndexes.size); x = raw == null ? null : categoryIndexes.get(key)!; }
    const y = finite(row[yField]);
    if (x === null || y === null) { omitted++; continue; }
    const name = seriesField ? String(row[seriesField] ?? "Unspecified") : yField;
    if (!series.has(name)) series.set(name, { name, points: [] });
    const lowField = panel.mapping.lower ?? panel.mapping.low ?? panel.mapping.min;
    const highField = panel.mapping.upper ?? panel.mapping.high ?? panel.mapping.max;
    const fieldLimits = dataset.fields.find(field => field.name === yField)?.limits;
    const low = lowField ? finite(row[lowField]) : finite(panel.display.lower) ?? finite(fieldLimits?.lower), high = highField ? finite(row[highField]) : finite(panel.display.upper) ?? finite(fieldLimits?.upper);
    series.get(name)!.points.push({ x, y, label: String(raw ?? index), row, low, high });
  }
  if (omitted) warnings.push(`${omitted} rows with missing or invalid coordinates were omitted.`);
  for (const item of series.values()) item.points.sort((a, b) => a.x - b.x);
  return { series: [...series.values()], warnings, error: "" };
}

export interface BoxSummary { label: string; row: Row; count: number | null; min: number; q1: number; median: number; q3: number; max: number }
export function buildBoxes(dataset: TabularDataset, panel: PanelDefinition) {
  const category = panel.mapping.category ?? panel.mapping.x, warnings = limitWarnings(dataset.rows.length), boxes: BoxSummary[] = [];
  if (category && !fieldExists(dataset, category)) return { boxes, warnings, error: `Category field “${category}” does not exist.`, precomputed: false };
  const precomputed = ["q1", "median", "q3"].some(role => !!panel.mapping[role]);
  if (precomputed) {
    for (const role of ["q1", "median", "q3"]) if (!fieldExists(dataset, panel.mapping[role])) return { boxes, warnings, error: `Box summaries require an existing ${role} field.`, precomputed };
    const lowField = panel.mapping.low ?? panel.mapping.lower ?? panel.mapping.min, highField = panel.mapping.high ?? panel.mapping.upper ?? panel.mapping.max;
    for (const field of [lowField, highField]) if (field && !fieldExists(dataset, field)) return { boxes, warnings, error: `Box limit field “${field}” does not exist.`, precomputed };
    let omitted = 0;
    for (const [index, row] of dataset.rows.slice(0, MAX_CHART_ROWS).entries()) {
      const q1 = finite(row[panel.mapping.q1]), median = finite(row[panel.mapping.median]), q3 = finite(row[panel.mapping.q3]);
      const min = lowField ? finite(row[lowField]) : q1, max = highField ? finite(row[highField]) : q3;
      if (q1 === null || median === null || q3 === null || min === null || max === null || min > q1 || q1 > median || median > q3 || q3 > max) { omitted++; continue; }
      boxes.push({ label: category ? String(row[category] ?? "Unspecified") : String(index + 1), row, min, q1, median, q3, max, count: panel.mapping.count ? finite(row[panel.mapping.count]) : null });
    }
    if (omitted) warnings.push(`${omitted} invalid box summaries were omitted; limits and quartiles must be ordered.`);
  } else {
    const model = numericRows(dataset, panel);
    if (model.error) return { boxes, warnings, error: model.error, precomputed };
    const grouped = new Map<string, { values: number[]; row: Row; label: string }>();
    for (const item of model.values) { const raw = category ? item.row[category] : model.field, key = JSON.stringify([typeof raw, raw]); if (!grouped.has(key)) grouped.set(key, { values: [], row: item.row, label: String(raw ?? "Unspecified") }); grouped.get(key)!.values.push(item.value); }
    for (const group of grouped.values()) { const sorted = group.values.sort((a, b) => a - b); boxes.push({ label: group.label, row: group.row, count: sorted.length, min: sorted[0], max: sorted.at(-1)!, q1: quantile(sorted, 0.25)!, median: quantile(sorted, 0.5)!, q3: quantile(sorted, 0.75)! }); }
    warnings.push(...model.warnings.filter(message => !warnings.includes(message)));
  }
  warnings.push(...limitWarnings(boxes.length, 100));
  return { boxes: boxes.slice(0, 100), warnings, error: "", precomputed };
}
