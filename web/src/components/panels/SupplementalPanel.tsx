import { useMemo } from "react";
import type { PanelRendererProps, Row, TabularDataset } from "../../platform/types";
import { chartMarks, chartSlices, timelineEvents } from "../../platform/simpleChartModel";
import { CHROME, SERIES_COLORS, ellipsis, fmt, linearScale, ticks } from "./PanelUi";
import { ChartBox } from "./PanelUi";
import { MarkdownText } from "./MarkdownText";

export function SupplementalPanel(props: PanelRendererProps) {
  if (props.dataset.kind !== "table") return <p role="alert">This panel requires a tabular dataset.</p>;
  return <TableSupplement {...props} dataset={props.dataset} />;
}
function TableSupplement({ dataset, panel, onEvent }: PanelRendererProps & { dataset: TabularDataset }) {
  const activate = (row: Row, values: Row = {}) => onEvent?.({ entity: "mark", values: { ...row, ...values } });
  if (panel.type === "text") {
    const text = typeof panel.display.text === "string" ? panel.display.text : dataset.rows.map(row => String(row[panel.mapping.text ?? panel.mapping.value ?? "text"] ?? "")).join("\n\n");
    return <div className="h-full overflow-auto whitespace-pre-wrap p-3 text-sm leading-relaxed text-slate-300" data-panel-kind="text">{text ? <MarkdownText text={text} /> : "No text to display."}</div>;
  }
  if (panel.type === "status" || panel.type === "progress") {
    const row = dataset.rows.at(-1), value = row?.[panel.mapping.value ?? "value"];
    const label = row?.[panel.mapping.label ?? "label"];
    if (panel.type === "status") return <div className="flex h-full flex-col items-center justify-center gap-2 p-3" data-panel-kind="status"><button type="button" className="rounded-full border border-slate-600 bg-slate-800 px-5 py-2 text-xl text-slate-100" onClick={() => row && activate(row)}>{value == null ? "No status" : String(value)}</button>{label != null && <p className="text-xs text-slate-400">{String(label)}</p>}</div>;
    const min = typeof panel.display.min === "number" ? panel.display.min : 0, max = typeof panel.display.max === "number" ? panel.display.max : 100;
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min || !Number.isFinite(max - min)) return <p role="alert">Progress maximum must be greater than its minimum.</p>;
    const numeric = typeof value === "number" && Number.isFinite(value) ? value : null, progress = numeric === null ? 0 : Math.max(0, Math.min(100, (numeric - min) / (max - min) * 100));
    return <div className="flex h-full flex-col justify-center gap-3 p-5" data-panel-kind="progress"><div className="flex justify-between text-sm text-slate-300"><span>{label == null ? panel.mapping.value ?? "Progress" : String(label)}</span><span>{numeric === null ? "No value" : `${fmt(numeric)} / ${fmt(max)}`}</span></div><div role="progressbar" aria-label={String(label ?? panel.title)} aria-valuemin={min} aria-valuemax={max} aria-valuenow={numeric === null ? undefined : Math.max(min, Math.min(max, numeric))} aria-valuetext={numeric === null ? "No value" : String(numeric)} className="h-4 overflow-hidden rounded-full bg-slate-800"><div className="h-full rounded-full bg-sky-500" style={{ width: `${progress}%` }} /></div>{numeric !== null && (numeric < min || numeric > max) && <p className="text-xs text-amber-300">Value is outside the configured scale.</p>}</div>;
  }
  if (panel.type === "pie" || panel.type === "donut") return <PieView dataset={dataset} panel={panel} onEvent={onEvent} />;
  if (panel.type === "timeline") return <TimelineView dataset={dataset} panel={panel} onEvent={onEvent} />;
  return <CartesianView dataset={dataset} panel={panel} onEvent={onEvent} />;
}
function Warnings({ warnings, errors }: { warnings: string[]; errors: string[] }) { return <>{errors.length > 0 && <p role="alert" className="p-2 text-xs text-rose-300">{errors.join(" ")}</p>}{warnings.map(warning => <p key={warning} role="status" className="px-2 text-[11px] text-amber-300">{warning}</p>)}</>; }

function CartesianView({ dataset, panel, onEvent }: PanelRendererProps & { dataset: TabularDataset }) {
  const kind = panel.type === "area" ? "area" : "scatter";
  const model = useMemo(() => chartMarks(dataset, panel.mapping, kind), [dataset, panel.mapping, kind]);
  return <div className="flex h-full min-h-0 flex-col" data-panel-kind={kind}><Warnings {...model} /><ChartBox empty={model.errors.length ? "Correct field mappings to display the chart." : !model.marks.length ? "No numeric marks to display." : undefined}>{({ width, height }) => {
    const { marks } = model;
    const xs = marks.map(mark => mark.x), ys = marks.map(mark => mark.y);
    const x = linearScale([Math.min(...xs), Math.max(...xs)], [48, Math.max(49, width - 18)]);
    const y = linearScale([Math.min(0, ...ys), Math.max(0, ...ys)], [Math.max(18, height - 28), 12]);
    const stroke = SERIES_COLORS[0];
    const path = marks.map((mark, i) => `${i ? "L" : "M"}${x.at(mark.x)},${y.at(mark.y)}`).join(" ");
    return <svg width={width} height={height} role="img" aria-label={`${panel.title}: ${kind}`}>
      {ticks(y.domain[0], y.domain[1], 4).map(value => <g key={value}><line x1={48} x2={width - 18} y1={y.at(value)} y2={y.at(value)} stroke={CHROME.grid} /><text x={42} y={y.at(value) + 3} textAnchor="end" fontSize={10} fill={CHROME.textMuted}>{fmt(value, 3)}</text></g>)}
      {kind === "area" && <path d={`${path} L${x.at(marks.at(-1)!.x)},${y.at(0)} L${x.at(marks[0].x)},${y.at(0)} Z`} fill={stroke} fillOpacity={0.3} stroke={stroke} strokeWidth={1.5} />}
      {marks.map((mark, i) => <circle key={i} cx={x.at(mark.x)} cy={y.at(mark.y)} r={kind === "scatter" ? 4 : 3} fill={stroke} className="cursor-pointer focus:stroke-white" role="button" tabIndex={0} aria-label={`${mark.label}: ${fmt(mark.y)}`} onClick={() => onEvent?.({ entity: "mark", values: { ...mark.row, x: mark.x, y: mark.y, value: mark.y } })} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onEvent?.({ entity: "mark", values: { ...mark.row, x: mark.x, y: mark.y, value: mark.y } }); } }}><title>{`${mark.label}: ${fmt(mark.y)}`}</title></circle>)}
      {[0, marks.length - 1].filter((v, i, arr) => arr.indexOf(v) === i).map(index => <text key={index} x={x.at(marks[index].x)} y={height - 8} textAnchor={index === 0 ? "start" : "end"} fontSize={10} fill={CHROME.textSecondary}>{ellipsis(marks[index].label, Math.max(8, Math.floor(width / 14)))}</text>)}
    </svg>;
  }}</ChartBox></div>;
}
function PieView({ dataset, panel, onEvent }: PanelRendererProps & { dataset: TabularDataset }) {
  const model = useMemo(() => chartSlices(dataset, panel.mapping), [dataset, panel.mapping]);
  const total = model.slices.reduce((sum, slice) => sum + slice.value, 0);
  const shown = model.slices.slice(0, 8), remainder = model.slices.slice(8).reduce((sum, slice) => sum + slice.value, 0);
  if (remainder > 0) shown.push({ label: "Other categories", value: remainder, row: {} });
  return <div className="flex h-full min-h-0 flex-col" data-panel-kind={panel.type}><Warnings {...model} />{remainder > 0 && <p className="px-2 text-[11px] text-slate-400">Categories after the first 8 are combined into Other.</p>}<ChartBox empty={model.errors.length ? "Correct field mappings to display the chart." : total <= 0 ? "No positive values to display." : undefined}>{({ width, height }) => {
    const radius = Math.max(1, Math.min(width, height) / 2 - 15), cx = width / 2, cy = height / 2;
    let angle = -Math.PI / 2;
    return <svg width={width} height={height} role="img" aria-label={`${panel.title}: ${panel.type}`}>
      {shown.map((slice, i) => {
        const start = angle, sweep = slice.value / total * Math.PI * 2; angle += sweep;
        const end = angle, color = SERIES_COLORS[i] ?? "#94a3b8";
        const activate = () => onEvent?.({ entity: "mark", values: { ...slice.row, category: slice.label, value: slice.value } });
        const d = sweep >= Math.PI * 2 - 1e-8 ? `M${cx},${cy - radius} A${radius},${radius} 0 1,1 ${cx},${cy + radius} A${radius},${radius} 0 1,1 ${cx},${cy - radius} Z` : `M${cx},${cy} L${cx + Math.cos(start) * radius},${cy + Math.sin(start) * radius} A${radius},${radius} 0 ${sweep > Math.PI ? 1 : 0},1 ${cx + Math.cos(end) * radius},${cy + Math.sin(end) * radius} Z`;
        return <path key={i} d={d} fill={color} stroke="#0f172a" strokeWidth={2} role="button" tabIndex={0} aria-label={`${slice.label}: ${fmt(slice.value)}`} onClick={activate} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); } }} className="cursor-pointer focus:stroke-white"><title>{`${slice.label}: ${fmt(slice.value)} (${fmt(slice.value / total * 100, 3)}%)`}</title></path>;
      })}
      {panel.type === "donut" && <><circle cx={cx} cy={cy} r={radius * 0.62} fill={CHROME.surface} /><text x={cx} y={cy + 5} textAnchor="middle" fill={CHROME.textPrimary} fontSize={18}>{fmt(total)}</text></>}
    </svg>;
  }}</ChartBox><div className="flex max-h-16 flex-wrap gap-x-3 overflow-y-auto px-2 text-[11px] text-slate-400">{shown.map((slice, i) => <span key={i} className="inline-flex items-center gap-1"><i className="h-2 w-2" style={{ background: SERIES_COLORS[i] ?? "#94a3b8" }} />{slice.label}: {fmt(slice.value)}</span>)}</div></div>;
}
function TimelineView({ dataset, panel, onEvent }: PanelRendererProps & { dataset: TabularDataset }) {
  const model = useMemo(() => timelineEvents(dataset, panel.mapping), [dataset, panel.mapping]);
  const min = Math.min(...model.events.map(event => event.start)), max = Math.max(...model.events.map(event => event.end));
  const span = Math.max(1, max - min);
  return <div className="h-full overflow-auto p-2" data-panel-kind="timeline"><Warnings {...model} />{!model.events.length && <p className="p-4 text-center text-xs text-slate-500">No events to display.</p>}{model.events.map((event, i) => <button key={i} type="button" className="grid w-full grid-cols-[minmax(60px,30%)_1fr] items-center gap-2 rounded py-2 text-left hover:bg-slate-800" title={`${event.label}: ${new Date(event.start).toISOString()} – ${new Date(event.end).toISOString()}`} onClick={() => onEvent?.({ entity: "mark", values: { ...event.row, start: event.start, end: event.end, label: event.label } })}><span className="truncate text-xs text-slate-300">{event.label}</span><span className="relative h-5 border-l border-slate-700"><span className="absolute top-1 h-3 min-w-1 rounded bg-sky-500" style={{ left: `${(event.start - min) / span * 95}%`, width: `${Math.max(0.8, (event.end - event.start) / span * 95)}%` }} /></span></button>)}</div>;
}
