import { useEffect, useId, useState } from "react";
import type { Row } from "../../platform/types";
import { CHROME, SERIES_COLORS } from "./PanelUi";
import { colorWithOpacity, heatmapAppearance, heatmapTextColor, normalizeHexColor, panelFillOpacity } from "./panelAppearance";

export interface PanelAppearanceControlsProps {
  type: "heatmap" | "bar";
  display: Row;
  onChange: (patch: Row) => void;
}

function ColorControl({ label, color, onChange }: { label: string; color: string; onChange: (value: string) => void }) {
  const id = useId();
  const [text, setText] = useState(color);
  useEffect(() => setText(previous => normalizeHexColor(previous) === color ? previous : color), [color]);
  const invalid = normalizeHexColor(text) === undefined;
  return <div className="atlas-field">
    <label htmlFor={`${id}-picker`}>{label}</label>
    <div className="flex items-center gap-2">
      <input id={`${id}-picker`} aria-label={label} type="color" value={color} className="h-9 w-12 shrink-0 cursor-pointer rounded border border-slate-600 bg-slate-900 p-1" onChange={event => { setText(event.target.value); onChange(event.target.value); }} />
      <input aria-label={`${label} hex`} aria-describedby={invalid ? `${id}-help` : undefined} aria-invalid={invalid} className="atlas-control min-w-0 font-mono" value={text} maxLength={7} spellCheck={false} onChange={event => {
        setText(event.target.value);
        const value = normalizeHexColor(event.target.value);
        if (value) onChange(value);
      }} onBlur={() => setText(color)} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setText(color); } }} />
    </div>
    {invalid && <span id={`${id}-help`} className="text-[11px] text-amber-300">Use #RGB or #RRGGBB. The last valid color stays in the chart.</span>}
  </div>;
}

/** Controlled display patches participate in the dashboard's existing draft/save/cancel flow. */
export function PanelAppearanceControls({ type, display, onChange }: PanelAppearanceControlsProps) {
  const opacity = panelFillOpacity(display), percent = Math.round(opacity * 100);
  const heatmap = heatmapAppearance(display), barColor = normalizeHexColor(display.fillColor) ?? SERIES_COLORS[0];
  const id = useId();
  return <div className="space-y-3" data-panel-appearance={type}>
    <ColorControl label={type === "heatmap" ? "Heatmap base color" : "Bar fill color"} color={type === "heatmap" ? heatmap.baseColor : barColor} onChange={color => onChange(type === "heatmap" ? { heatmapBaseColor: color } : { fillColor: color })} />
    <div className="atlas-field">
      <label htmlFor={`${id}-opacity`} className="flex items-center justify-between gap-2"><span>Fill opacity</span><output htmlFor={`${id}-opacity`} className="tabular-nums">{percent}%</output></label>
      <input id={`${id}-opacity`} aria-label="Fill opacity" aria-valuetext={`${percent}%`} type="range" min={0} max={100} step={1} value={percent} className="w-full accent-sky-400" onChange={event => onChange({ fillOpacity: Number(event.target.value) / 100 })} />
      <div className="flex justify-between text-[11px] text-slate-400"><span>Transparent</span><span>Solid</span></div>
    </div>
    <div className="rounded border border-slate-700 p-2" style={{ background: CHROME.surface }}>
      <p className="mb-2 text-[11px] text-slate-400">Live appearance preview</p>
      {type === "heatmap" ? <>
        <div className="flex h-8" role="img" aria-label={`Heatmap preview: low to high values, ${percent}% fill opacity`}>
          {[0, 25, 50, 75, 100].map(value => { const fill = heatmap.color(value, 0, 100); return <span key={value} className="flex flex-1 items-center justify-center text-[11px]" style={{ background: colorWithOpacity(fill, opacity), color: heatmapTextColor(fill, opacity, CHROME.surface) }}>{value}</span>; })}
        </div>
        <p className="mt-2 text-[11px] text-slate-400">Low values stay light; high values stay dark. Missing cells and threshold outlines keep their own styling.</p>
      </> : <>
        <svg viewBox="0 0 200 52" className="h-14 w-full" role="img" aria-label={`Bar preview, ${percent}% fill opacity`}>
          <path d="M4,4 V48 H196" fill="none" stroke={CHROME.textMuted} />
          {[22, 36, 44].map((height, index) => <rect key={height} x={24 + index * 56} y={48 - height} width={32} height={height} fill={barColor} fillOpacity={opacity} />)}
        </svg>
        <p className="mt-2 text-[11px] text-slate-400">Pick a color for every bar; reset restores series colors. Axes and labels stay fully visible.</p>
      </>}
    </div>
    {opacity === 0 && <p className="text-[11px] text-amber-300">0% hides the fills. Labels and outlines remain visible.</p>}
    <button type="button" className="atlas-button" onClick={() => onChange(type === "heatmap" ? { heatmapBaseColor: undefined, fillOpacity: undefined } : { fillColor: undefined, fillOpacity: undefined })}>Reset appearance</button>
  </div>;
}
