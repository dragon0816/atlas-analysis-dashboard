import { useId, useMemo, useState } from "react";
import type { PanelRendererProps } from "../../platform/types";
import { buildHeatmapModel, heatmapCellValues, type HeatmapCell } from "../../platform/heatmapModel";
import { CHROME, ellipsis, fmt } from "./PanelUi";
import { ChartBox, Tooltip } from "./PanelUi";
import { colorWithOpacity, heatmapAppearance, heatmapTextColor } from "./panelAppearance";

export function HeatmapPanel({ dataset, panel, onEvent }: PanelRendererProps) {
  const patternId = `heatmap-missing-${useId().replace(/:/g, "")}`;
  const [hover, setHover] = useState<{ cell: HeatmapCell; x: number; y: number } | null>(null);
  const model = useMemo(() => dataset.kind === "table" ? buildHeatmapModel(dataset, panel.mapping, panel.display) : null, [dataset, panel.mapping, panel.display]);
  if (!model) return <p role="alert">Heatmap requires a tabular dataset.</p>;
  if (model.errors.length) return <p role="alert" className="p-3 text-sm text-rose-300">{model.errors.join(" ")}</p>;
  const appearance = heatmapAppearance(panel.display), { color } = appearance;
  const threshold = typeof panel.display.threshold === "number" ? panel.display.threshold : null;
  const thresholdAbove = panel.display.thresholdDirection === "above";
  const thresholdHit = (value: number | null) => threshold !== null && value !== null && (thresholdAbove ? value > threshold : value < threshold);
  const activate = (cell: HeatmapCell) => { if (!cell.missing) onEvent?.({ entity: "cell", values: heatmapCellValues(cell) }); };
  return <div className="flex h-full min-h-0 flex-col gap-1 text-xs" data-panel-kind="heatmap">
    {model.warnings.map(warning => <p key={warning} role="status" className="px-2 text-amber-300">{warning}</p>)}
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-slate-400">
      <span>{model.x.length} × {model.y.length} categories · {model.aggregate}</span>
      <span className="inline-flex items-center gap-1"><span className="h-2 w-2 border border-slate-500 bg-slate-800" />Missing</span>
      {threshold !== null && <span>Outlined: {thresholdAbove ? ">" : "<"} {fmt(threshold)}</span>}
    </div>
    <ChartBox empty={!model.cells.length ? "No category pairs to display." : undefined}>{({ width, height }) => {
      const left = Math.max(40, Math.min(110, width * 0.23));
      const bottom = height < 180 ? 35 : 50;
      const plotWidth = Math.max(1, width - left - 12), plotHeight = Math.max(1, height - bottom - 12);
      const cellWidth = plotWidth / model.x.length, cellHeight = plotHeight / model.y.length;
      const xStep = Math.max(1, Math.ceil(48 / cellWidth)), yStep = Math.max(1, Math.ceil(16 / cellHeight));
      const showValues = panel.display.showValues !== false && panel.display.show_values !== false && cellWidth >= 32 && cellHeight >= 20;
      const xIndex = new Map(model.x.map((category, i) => [category.key, i]));
      const yIndex = new Map(model.y.map((category, i) => [category.key, i]));
      return <>
        <svg width={width} height={height} role="img" aria-label={`${panel.title}: ${model.x.length} by ${model.y.length} heatmap`} onPointerLeave={() => setHover(null)}>
          <defs><pattern id={patternId} width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill={color(null, 0, 1)} /><path d="M0,6 L6,0" stroke="#334155" strokeWidth="1" /></pattern></defs>
          {model.cells.map(cell => {
            const x = left + xIndex.get(cell.x.key)! * cellWidth, y = 8 + yIndex.get(cell.y.key)! * cellHeight;
            const label = `${cell.x.label}, ${cell.y.label}: ${cell.value === null ? "Missing" : fmt(cell.value)}${cell.count > 1 ? ` (${cell.count} values, ${model.aggregate})` : ""}`;
            const fill = color(cell.value, model.min, model.max);
            return <g key={cell.key}>
              <rect x={x} y={y} width={Math.max(0.5, cellWidth - 1)} height={Math.max(0.5, cellHeight - 1)} fill={cell.missing ? `url(#${patternId})` : fill} fillOpacity={cell.missing ? 1 : appearance.opacity}
                stroke={thresholdHit(cell.value) ? CHROME.limit : "transparent"} strokeWidth={thresholdHit(cell.value) ? 2 : 0}
                tabIndex={cell.missing ? undefined : 0} role={cell.missing ? undefined : "button"} aria-label={label}
                className="outline-none focus:stroke-white" style={{ cursor: cell.missing ? "default" : "pointer" }}
                onClick={() => activate(cell)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(cell); } }}
                onPointerMove={() => setHover({ cell, x: x + cellWidth / 2, y })}>
                <title>{label}</title>
              </rect>
              {showValues && <text x={x + cellWidth / 2} y={y + cellHeight / 2 + 4} textAnchor="middle" fontSize={11} fill={cell.missing ? CHROME.textMuted : heatmapTextColor(fill, appearance.opacity, CHROME.surface)} pointerEvents="none">{cell.value === null ? "—" : fmt(cell.value, 3)}</text>}
            </g>;
          })}
          {model.x.filter((_, i) => i % xStep === 0).map(category => <text key={category.key} x={left + (xIndex.get(category.key)! + 0.5) * cellWidth} y={plotHeight + 23} textAnchor="middle" fontSize={10} fill={CHROME.textSecondary}><title>{category.label}</title>{ellipsis(category.label, Math.max(4, Math.floor(cellWidth * xStep / 6)))}</text>)}
          {model.y.filter((_, i) => i % yStep === 0).map(category => <text key={category.key} x={left - 7} y={8 + (yIndex.get(category.key)! + 0.5) * cellHeight + 3} textAnchor="end" fontSize={10} fill={CHROME.textSecondary}><title>{category.label}</title>{ellipsis(category.label, Math.max(4, Math.floor((left - 12) / 6)))}</text>)}
        </svg>
        {hover && <Tooltip x={hover.x} y={hover.y} width={width} title={`${hover.cell.x.label} / ${hover.cell.y.label}`} rows={[{ label: panel.mapping.value, value: hover.cell.value === null ? "Missing" : fmt(hover.cell.value) }, { label: "Aggregation", value: `${model.aggregate} · ${hover.cell.count} numeric rows` }]} />}
      </>;
    }}</ChartBox>
    <div className="flex items-center gap-2 px-3 pb-1 tabular-nums text-slate-400" aria-label={`Color scale ${model.min} to ${model.max}`}>
      <span>{fmt(model.min)}</span><span className="h-2 max-w-48 flex-1 rounded-sm" style={{ background: `linear-gradient(to right, ${colorWithOpacity(color(model.min, model.min, model.max), appearance.opacity)}, ${colorWithOpacity(color(model.max, model.min, model.max), appearance.opacity)})` }} /><span>{fmt(model.max)}</span>
      <span className="truncate">{panel.mapping.value}</span>
    </div>
  </div>;
}
