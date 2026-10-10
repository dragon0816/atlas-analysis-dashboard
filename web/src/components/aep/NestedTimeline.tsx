import type { PanelRendererProps, TabularDataset } from '../../platform/types';
export function NestedTimeline({ dataset, onEvent }: PanelRendererProps & { dataset: TabularDataset }) {
  const rows = dataset.rows.slice(0, 2000), starts = rows.map(r => Date.parse(String(r.start))).filter(Number.isFinite);
  const ends = rows.map(r => Date.parse(String(r.end))).filter(Number.isFinite);
  const min = Math.min(...starts), max = Math.max(...starts, ...ends), range = Math.max(1, max - min);
  return <div className="h-full overflow-auto p-2" data-panel-kind="nested-timeline">
    {dataset.rows.length > rows.length && <p role="status">Timeline capped at 2,000 spans.</p>}
    {!rows.length && <p>No spans in the selected view.</p>}
    {rows.map((row, i) => {
      const start = Date.parse(String(row.start)), end = row.end == null ? null : Date.parse(String(row.end));
      const valid = Number.isFinite(start), closed = end !== null && Number.isFinite(end) && end >= start;
      const label = `${row.label}${row.open ? ' · open' : ''}${row.missing_start ? ' · missing start' : ''}${row.missing_parent ? ' · missing parent' : ''}${row.duration_ms == null ? ' · duration unknown' : ` · ${row.duration_ms} ms`}`;
      return <button key={`${row.run_id}:${row.span_id}:${i}`} className="grid w-full grid-cols-[minmax(100px,45%)_1fr] gap-2 rounded py-2 text-left text-xs hover:bg-slate-800" title={`${label}\n${row.start ?? 'unknown start'} → ${row.end ?? 'unknown end'}`} onClick={() => onEvent?.({ entity: 'mark', values: row })}>
        <span className="truncate" style={{ paddingLeft: `${Math.min(12, Number(row.depth) || 0) * 12}px` }}>{label}</span>
        <span className="relative h-4 border-l border-slate-700">{valid && <span className={`absolute h-3 min-w-1 rounded ${row.open ? 'border border-dashed border-amber-400' : 'bg-sky-500'}`} style={{ left: `${(start - min) / range * 90}%`, width: closed ? `${Math.max(.8, (end! - start) / range * 90)}%` : '6px' }} />}</span>
      </button>;
    })}
  </div>;
}
