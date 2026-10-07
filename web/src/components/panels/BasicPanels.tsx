import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import type { PanelRendererProps, Row, TabularDataset } from "../../platform/types";
import { buildBoxes, buildHistogram, buildSeries, fieldExists, finite, limitWarnings, numericRows, reduceValues, valueField } from "./BasicModels";
import { ChartBox, CHROME, ellipsis, fmt, linearScale, SERIES_COLORS, ticks, Warnings } from "./PanelUi";

type TableProps = PanelRendererProps & { dataset: TabularDataset };
const keyboard = (event: KeyboardEvent<SVGElement>, activate: () => void) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); } };
const color = (index: number) => SERIES_COLORS[index % SERIES_COLORS.length];
const numericLabel = (value: number | null, display: Row) => value === null ? "—" : finite(display.decimals) !== null ? value.toLocaleString("en-US", { minimumFractionDigits: Math.max(0, Math.min(12, display.decimals as number)), maximumFractionDigits: Math.max(0, Math.min(12, display.decimals as number)) }) : fmt(value);

function PanelContainer({ kind, children, warnings = [], error }: { kind: string; children: ReactNode; warnings?: string[]; error?: string }) {
  return <div className="flex h-full min-h-0 flex-col" data-panel-kind={kind}><Warnings messages={warnings} />{error ? <p role="alert" className="p-3 text-sm text-rose-300">{error}</p> : children}</div>;
}
function YAxis({ scale, width, unit }: { scale: ReturnType<typeof linearScale>; width: number; unit?: string }) {
  return <g aria-hidden="true">{ticks(...scale.domain, 5).map((tick, index) => <g key={index}><line x1={54} x2={width - 16} y1={scale.at(tick)} y2={scale.at(tick)} stroke={CHROME.grid} /><text x={48} y={scale.at(tick) + 3} textAnchor="end" fontSize={10} fill={CHROME.textMuted}>{fmt(tick, 3)}</text></g>)}{unit && <text x={8} y={10} fontSize={9} fill={CHROME.textMuted}>{unit}</text>}</g>;
}
function domain(values: number[], display: Row, zero: boolean): [number, number] {
  const min = values.reduce((a, b) => Math.min(a, b), zero ? 0 : Infinity), max = values.reduce((a, b) => Math.max(a, b), zero ? 0 : -Infinity);
  return [finite(display.yMin) ?? min, finite(display.yMax) ?? max];
}

export function BasicPanel(props: PanelRendererProps) {
  if (props.dataset.kind !== "table") return <p role="alert">This panel requires a tabular dataset.</p>;
  const tableProps = { ...props, dataset: props.dataset };
  switch (props.panel.type) {
    case "line": case "mask": return <LineView {...tableProps} />;
    case "bar": return <BarView {...tableProps} />;
    case "box": return <BoxView {...tableProps} />;
    case "histogram": return <HistogramView {...tableProps} />;
    case "stat": case "gauge": return <MetricView {...tableProps} />;
    case "table": return <TableView {...tableProps} />;
    default: return <p role="alert">Unsupported basic panel type.</p>;
  }
}

function LineView({ dataset, panel, onEvent }: TableProps) {
  const model = useMemo(() => buildSeries(dataset, panel), [dataset, panel]);
  const points = model.series.flatMap(series => series.points), isMask = panel.type === "mask";
  const limits = isMask ? points.flatMap(point => [point.low, point.high].filter((value): value is number => value !== null)) : [];
  const warnings = [...model.warnings];
  if (isMask && points.length && !limits.length) warnings.push("No mask limits are configured. Map lower/upper fields or set display.lower/display.upper.");
  return <PanelContainer kind={panel.type} error={model.error} warnings={warnings}><ChartBox empty={!points.length ? "No numeric points to display." : undefined}>{({ width, height }) => {
    const xs = points.map(point => point.x), ys = points.map(point => point.y);
    const x = linearScale([Math.min(...xs), Math.max(...xs)], [54, Math.max(55, width - 16)]), y = linearScale(domain([...ys, ...limits], panel.display, panel.display.startAtZero === true), [Math.max(20, height - 32), 18]);
    const segmentPath = (seriesPoints: typeof points, role: "y" | "low" | "high") => { let open = false; return seriesPoints.map(point => { const value = point[role]; if (value === null) { open = false; return ""; } const token = `${open ? "L" : "M"}${x.at(point.x)},${y.at(value)}`; open = true; return token; }).join(" "); };
    return <svg width={width} height={height} role="img" aria-label={`${panel.title}: ${panel.type} chart`}>
      <YAxis scale={y} width={width} unit={dataset.fields.find(field => field.name === valueField(panel))?.unit ?? undefined} />
      {model.series.map((series, index) => <g key={series.name}>
        {isMask && <><path d={segmentPath(series.points, "low")} fill="none" stroke={CHROME.limit} strokeDasharray="5 3" strokeWidth={1.5} /><path d={segmentPath(series.points, "high")} fill="none" stroke={CHROME.limit} strokeDasharray="5 3" strokeWidth={1.5} /></>}
        <path d={segmentPath(series.points, "y")} fill="none" stroke={color(index)} strokeWidth={2} />
        {series.points.map((point, pointIndex) => {
          const outside = isMask && ((point.low !== null && point.y < point.low) || (point.high !== null && point.y > point.high));
          const activate = () => onEvent?.({ entity: "mark", values: { ...point.row, x: point.row[panel.mapping.x] ?? point.x, y: point.y, value: point.y } });
          return <circle key={pointIndex} cx={x.at(point.x)} cy={y.at(point.y)} r={outside ? 4 : panel.display.showPoints === false && series.points.length > 1 ? 2 : 3} fill={outside ? CHROME.limit : color(index)} role="button" tabIndex={0} aria-label={`${series.name}, ${point.label}: ${fmt(point.y)}${outside ? ", outside mask" : ""}`} onClick={activate} onKeyDown={event => keyboard(event, activate)} style={{ cursor: "pointer" }}><title>{`${series.name} · ${point.label}: ${fmt(point.y)}${outside ? " · Outside mask" : ""}`}</title></circle>;
        })}
      </g>)}
      {[...new Map(points.map(point => [point.x, point])).values()].sort((a, b) => a.x - b.x).filter((_, index, all) => index === 0 || index === all.length - 1 || index % Math.max(1, Math.ceil(all.length / Math.max(2, width / 100))) === 0).map(point => <text key={point.x} x={x.at(point.x)} y={height - 10} textAnchor="middle" fill={CHROME.textSecondary} fontSize={10}>{ellipsis(point.label, 13)}</text>)}
    </svg>;
  }}</ChartBox>{panel.display.showLegend !== false && <div className="flex max-h-12 flex-wrap gap-x-3 gap-y-1 overflow-auto px-2 pb-1 text-xs text-slate-400">{model.series.map((series, index) => <span key={series.name}><span style={{ color: color(index) }}>● </span>{series.name}</span>)}{isMask && <span style={{ color: CHROME.limit }}>Dashed: limits</span>}</div>}</PanelContainer>;
}

function BarView({ dataset, panel, onEvent }: TableProps) {
  const model = numericRows(dataset, panel), category = panel.mapping.category ?? panel.mapping.x ?? panel.mapping.label;
  const values = model.values.slice(0, 200), warnings = [...model.warnings, ...limitWarnings(model.values.length, 200)];
  const error = model.error || (category && !fieldExists(dataset, category) ? `Category field “${category}” does not exist.` : "");
  return <PanelContainer kind="bar" error={error} warnings={warnings}><ChartBox empty={!values.length ? "No numeric bars to display." : undefined}>{({ width, height }) => {
    const y = linearScale(domain(values.map(item => item.value), panel.display, true), [Math.max(20, height - 40), 16]), space = Math.max(1, width - 70) / values.length;
    const every = Math.max(1, Math.ceil(55 / space));
    return <svg width={width} height={height} role="img" aria-label={`${panel.title}: bar chart`}><YAxis scale={y} width={width} />{values.map((item, index) => {
      const label = category ? String(item.row[category] ?? "Unspecified") : String(index + 1), zero = y.at(0), end = y.at(item.value);
      const activate = () => onEvent?.({ entity: "mark", values: { ...item.row, category: label, x: label, y: item.value, value: item.value } });
      return <g key={index}><rect x={54 + index * space + space * 0.1} y={Math.min(zero, end)} width={Math.max(1, space * 0.8)} height={Math.max(1, Math.abs(zero - end))} fill={color(panel.mapping.series ? [...new Set(values.map(value => String(value.row[panel.mapping.series])))].indexOf(String(item.row[panel.mapping.series])) : 0)} role="button" tabIndex={0} aria-label={`${label}: ${fmt(item.value)}`} onClick={activate} onKeyDown={event => keyboard(event, activate)} style={{ cursor: "pointer" }}><title>{`${label}: ${fmt(item.value)}`}</title></rect>{index % every === 0 && <text x={54 + (index + 0.5) * space} y={height - 12} textAnchor="middle" fill={CHROME.textSecondary} fontSize={10}>{ellipsis(label, Math.max(4, Math.floor(space * every / 7)))}</text>}</g>;
    })}</svg>;
  }}</ChartBox></PanelContainer>;
}

function BoxView({ dataset, panel, onEvent }: TableProps) {
  const model = buildBoxes(dataset, panel), { boxes } = model;
  return <PanelContainer kind="box" error={model.error} warnings={model.warnings}><ChartBox empty={!boxes.length ? "No numeric samples to summarize." : undefined}>{({ width, height }) => {
    const y = linearScale(domain(boxes.flatMap(box => [box.min, box.max]), panel.display, false), [Math.max(20, height - 36), 18]), space = Math.max(1, width - 70) / boxes.length;
    return <svg width={width} height={height} role="img" aria-label={`${panel.title}: box plot, whiskers show sample minimum and maximum`}><YAxis scale={y} width={width} />{boxes.map((box, index) => {
      const center = 54 + space * (index + 0.5), half = Math.min(28, space * 0.3);
      const activate = () => onEvent?.({ entity: "mark", values: { ...box.row, category: box.label, min: box.min, q1: box.q1, median: box.median, q3: box.q3, max: box.max, count: box.count } });
      return <g key={index} role="button" tabIndex={0} aria-label={`${box.label}, median ${fmt(box.median)}, ${box.count === null ? "summary" : `${box.count} samples`}`} onClick={activate} onKeyDown={event => keyboard(event, activate)} style={{ cursor: "pointer" }}><title>{`${box.label}: min ${fmt(box.min)}, Q1 ${fmt(box.q1)}, median ${fmt(box.median)}, Q3 ${fmt(box.q3)}, max ${fmt(box.max)}${box.count === null ? "" : `; n=${box.count}`}`}</title><line x1={center} x2={center} y1={y.at(box.min)} y2={y.at(box.max)} stroke={color(index)} /><path d={`M${center - half / 2},${y.at(box.min)} H${center + half / 2} M${center - half / 2},${y.at(box.max)} H${center + half / 2}`} stroke={color(index)} /><rect x={center - half} y={y.at(box.q3)} width={half * 2} height={Math.max(1, y.at(box.q1) - y.at(box.q3))} fill={color(index)} fillOpacity={0.25} stroke={color(index)} /><line x1={center - half} x2={center + half} y1={y.at(box.median)} y2={y.at(box.median)} stroke={CHROME.textPrimary} strokeWidth={2} />{index % Math.max(1, Math.ceil(50 / space)) === 0 && <text x={center} y={height - 10} fill={CHROME.textSecondary} textAnchor="middle" fontSize={10}>{ellipsis(box.label, Math.max(5, Math.floor(space / 6)))}</text>}</g>;
    })}</svg>;
  }}</ChartBox><p className="px-2 pb-1 text-[11px] text-slate-500">Box: Q1–Q3 · line: median · whiskers: {model.precomputed ? "mapped limits" : "sample min/max"}</p></PanelContainer>;
}

function HistogramView({ dataset, panel, onEvent }: TableProps) {
  const model = numericRows(dataset, panel), bins = buildHistogram(model.values.map(item => item.value), panel.display.bins);
  const error = model.error || (model.values.length && !bins.length ? "Numeric range is too wide. Rescale values before plotting." : "");
  return <PanelContainer kind="histogram" error={error} warnings={model.warnings}><ChartBox empty={!bins.length ? "No numeric values to bin." : undefined}>{({ width, height }) => {
    const y = linearScale([0, Math.max(...bins.map(bin => bin.count))], [Math.max(20, height - 38), 16]), space = Math.max(1, width - 70) / bins.length;
    return <svg width={width} height={height} role="img" aria-label={`${panel.title}: histogram`}><YAxis scale={y} width={width} />{bins.map((bin, index) => {
      const label = `${fmt(bin.min)} to ${fmt(bin.max)}: ${bin.count}`, activate = () => onEvent?.({ entity: "mark", values: { min: bin.min, max: bin.max, count: bin.count, value: bin.count } });
      return <g key={index}><rect x={54 + index * space + 1} y={y.at(bin.count)} width={Math.max(1, space - 2)} height={Math.max(1, y.at(0) - y.at(bin.count))} fill={color(0)} role="button" tabIndex={0} aria-label={label} onClick={activate} onKeyDown={event => keyboard(event, activate)}><title>{label}</title></rect>{index % Math.max(1, Math.ceil(60 / space)) === 0 && <text x={54 + (index + 0.5) * space} y={height - 12} textAnchor="middle" fontSize={10} fill={CHROME.textSecondary}>{fmt(bin.min, 3)}</text>}</g>;
    })}</svg>;
  }}</ChartBox></PanelContainer>;
}

function MetricView({ dataset, panel, onEvent }: TableProps) {
  const model = numericRows(dataset, panel), reducer = panel.display.reducer ?? panel.display.reduce ?? "last";
  const value = reduceValues(model.values.map(item => item.value), reducer), row = reducer === "first" ? model.values[0]?.row : model.values.at(-1)?.row;
  const unit = String(panel.display.unit ?? dataset.fields.find(field => field.name === model.field)?.unit ?? "");
  const min = finite(panel.display.min) ?? (row && panel.mapping.min ? finite(row[panel.mapping.min]) : null) ?? 0, max = finite(panel.display.max) ?? (row && panel.mapping.max ? finite(row[panel.mapping.max]) : null) ?? 100;
  const error = model.error || (panel.type === "gauge" && (max <= min || !Number.isFinite(max - min)) ? "Gauge maximum must be greater than its minimum with a finite range." : "");
  const threshold = finite(panel.display.threshold), failed = value !== null && threshold !== null && (panel.display.thresholdDirection === "below" ? value < threshold : value > threshold);
  const metricColor = failed ? CHROME.limit : typeof panel.display.color === "string" ? panel.display.color : SERIES_COLORS[0];
  const activate = () => { if (row && value !== null) onEvent?.({ entity: "mark", values: { ...row, value, [model.field]: value } }); };
  return <PanelContainer kind={panel.type} error={error} warnings={model.warnings}>{panel.type === "stat" ? <button type="button" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4" onClick={activate} disabled={value === null} aria-label={`${panel.title}: ${numericLabel(value, panel.display)} ${unit}`}><span className="text-4xl font-semibold tabular-nums" style={{ color: metricColor }}>{numericLabel(value, panel.display)}{unit && <small className="ml-2 text-lg text-slate-400">{unit}</small>}</span><span className="text-xs text-slate-400">{value === null ? "No finite numeric value" : `${model.field} · ${String(reducer)}`}</span></button> : <ChartBox>{({ width, height }) => {
    const radius = Math.max(1, Math.min(width * 0.38, height * 0.7)), cx = width / 2, cy = Math.min(height - 42, radius + 18), fraction = value === null ? 0 : Math.max(0, Math.min(1, (value - min) / (max - min)));
    const arc = `M${cx - radius},${cy} A${radius},${radius} 0 0 1 ${cx + radius},${cy}`;
    return <svg width={width} height={height} role="img" aria-label={`${panel.title}: ${numericLabel(value, panel.display)} ${unit}, scale ${min} to ${max}`}><path d={arc} fill="none" stroke={CHROME.grid} strokeWidth={15} strokeLinecap="round" /><path d={arc} fill="none" stroke={metricColor} strokeWidth={15} strokeLinecap="round" pathLength={100} strokeDasharray={`${fraction * 100} 100`} /><g role="button" tabIndex={value === null ? undefined : 0} onClick={activate} onKeyDown={event => keyboard(event, activate)} aria-label={`View ${panel.title} value`}><text x={cx} y={cy - 10} textAnchor="middle" fill={CHROME.textPrimary} fontSize={28}>{numericLabel(value, panel.display)}</text><text x={cx} y={cy + 14} textAnchor="middle" fill={CHROME.textMuted} fontSize={11}>{unit || (value === null ? "No value" : model.field)}</text></g><text x={cx - radius} y={cy + 28} fill={CHROME.textMuted} textAnchor="middle" fontSize={10}>{fmt(min)}</text><text x={cx + radius} y={cy + 28} fill={CHROME.textMuted} textAnchor="middle" fontSize={10}>{fmt(max)}</text></svg>;
  }}</ChartBox>}{panel.type === "gauge" && value !== null && (value < min || value > max) && <Warnings messages={["Value is outside the configured gauge scale."]} />}</PanelContainer>;
}

function TableView({ dataset, panel, onEvent }: TableProps) {
  const [query, setQuery] = useState(""), [sort, setSort] = useState<{ field: string; descending: boolean } | null>(null), [page, setPage] = useState(0);
  const configured = Array.isArray(panel.display.columns) ? panel.display.columns.filter((field): field is string => typeof field === "string") : null;
  const columns = configured ? dataset.fields.filter(field => configured.includes(field.name)).sort((a, b) => configured.indexOf(a.name) - configured.indexOf(b.name)) : dataset.fields;
  const stringify = (value: unknown) => value == null ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value);
  const rows = useMemo(() => {
    const filtered = dataset.rows.slice(0, 5000).filter(row => !query || columns.some(field => stringify(row[field.name]).toLocaleLowerCase().includes(query.toLocaleLowerCase())));
    if (sort) filtered.sort((a, b) => { const left = a[sort.field], right = b[sort.field]; const compared = typeof left === "number" && typeof right === "number" ? left - right : stringify(left).localeCompare(stringify(right)); return sort.descending ? -compared : compared; });
    return filtered;
  }, [dataset.rows, query, sort, columns.map(field => field.name).join("\0")]);
  const pageSize = Math.max(5, Math.min(200, Math.floor(finite(panel.display.pageSize) ?? 25))), pages = Math.max(1, Math.ceil(rows.length / pageSize)), currentPage = Math.min(page, pages - 1);
  return <PanelContainer kind="table" warnings={limitWarnings(dataset.rows.length, 5000)}><div className="flex items-center justify-between gap-2 p-2 text-xs text-slate-400"><input className="min-w-0 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200" aria-label={`Search ${panel.title} rows`} placeholder="Search rows…" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /><span>{rows.length} rows</span></div><div className="min-h-0 flex-1 overflow-auto"><table className="w-full border-collapse text-left text-xs"><thead className="sticky top-0 z-10 bg-slate-900"><tr>{columns.map(field => <th key={field.name} className="border-b border-slate-700 px-2 py-2 font-medium text-slate-300" aria-sort={sort?.field === field.name ? sort.descending ? "descending" : "ascending" : "none"}><button type="button" onClick={() => { setSort(previous => ({ field: field.name, descending: previous?.field === field.name ? !previous.descending : false })); setPage(0); }}>{field.name}{field.unit ? ` (${field.unit})` : ""}{sort?.field === field.name ? sort.descending ? " ↓" : " ↑" : ""}</button></th>)}</tr></thead><tbody>{rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((row, index) => <tr key={index} tabIndex={onEvent ? 0 : undefined} className="cursor-pointer border-b border-slate-800 text-slate-300 hover:bg-slate-800 focus:bg-slate-800" onClick={() => onEvent?.({ entity: "row", values: row })} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onEvent?.({ entity: "row", values: row }); } }}>{columns.map(field => <td key={field.name} className="max-w-64 truncate px-2 py-2" title={stringify(row[field.name])}>{typeof row[field.name] === "number" ? numericLabel(row[field.name] as number, panel.display) : stringify(row[field.name])}</td>)}</tr>)}</tbody></table>{!rows.length && <p role="status" className="p-5 text-center text-xs text-slate-500">No rows match the current search.</p>}{!columns.length && <p role="alert" className="p-3 text-xs text-rose-300">No fields are selected for the table.</p>}</div><div className="flex items-center justify-between p-2 text-xs text-slate-400"><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><span>Page {currentPage + 1} of {pages}</span><button type="button" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>Next</button></div></PanelContainer>;
}
