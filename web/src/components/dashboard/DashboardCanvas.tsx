import { useEffect, useMemo, useRef, useState } from "react";
import { DatasetPanel } from "./DatasetPanel";
import { GRID_COLUMNS, GRID_GAP, GRID_ROW, responsivePanels, settlePanels } from "../../platform/layout";
import type { PlatformRuntime } from "../../platform/runtime";
import type { Dataset, PanelDefinition, PanelEvent, Row, VariableValues } from "../../platform/types";

export function DashboardCanvas({ panels, variables, runtime, editing, selected, refreshKey, onSelect, onPanels, onEvent, onData }: {
  panels: PanelDefinition[]; variables: VariableValues; runtime: PlatformRuntime; editing: boolean; selected: string | null; refreshKey: number;
  onSelect: (id: string) => void; onPanels: (panels: PanelDefinition[]) => void; onEvent: (panel: PanelDefinition, event: PanelEvent) => void; onData: (id: string, dataset: Dataset) => void;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  const [moving, setMoving] = useState<string | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(entries[0]?.contentRect.width ?? 1000));
    if (grid.current) observer.observe(grid.current);
    return () => { observer.disconnect(); cleanup.current?.(); };
  }, []);
  const columns = editing ? GRID_COLUMNS : width < 480 ? 1 : width < 850 ? 6 : GRID_COLUMNS;
  const view = useMemo(() => responsivePanels(panels, columns), [panels, columns]);
  const start = (panel: PanelDefinition, mode: "move" | "resize", event: React.PointerEvent) => {
    if (!editing || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); onSelect(panel.id);
    cleanup.current?.();
    const initial = panels;
    const original = panel.layout;
    const from = { x: event.clientX, y: event.clientY };
    const unitX = ((grid.current?.getBoundingClientRect().width ?? width) + GRID_GAP) / columns;
    const unitY = GRID_ROW + GRID_GAP;
    setMoving(panel.id);
    const move = (ev: PointerEvent) => {
      const dx = Math.round((ev.clientX - from.x) / unitX), dy = Math.round((ev.clientY - from.y) / unitY);
      const layout = mode === "move" ? { ...original, x: original.x + dx, y: original.y + dy } : { ...original, w: original.w + dx, h: original.h + dy };
      onPanels(settlePanels(initial.map(p => p.id === panel.id ? { ...p, layout } : p), panel.id));
    };
    const finish = (cancel = false) => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", cancelPointer); window.removeEventListener("keydown", key); cleanup.current = null; setMoving(null); if (cancel) onPanels(initial); };
    const up = () => finish();
    const cancelPointer = () => finish(true);
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.preventDefault(); finish(true); } };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", cancelPointer); window.addEventListener("keydown", key);
    cleanup.current = () => finish();
  };
  return <div className="atlas-canvas-scroll"><div ref={grid} className={`atlas-canvas ${editing ? "is-editing" : ""}`} style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridAutoRows: GRID_ROW, gap: GRID_GAP }}>
    {!panels.length && <div className="atlas-empty-board"><span className="text-4xl text-sky-400">▦</span><h2>Your dashboard starts here</h2><p>Choose a visualization from the panel library, then connect a data source.</p></div>}
    {view.map(panel => <div data-panel-id={panel.id} key={panel.id} className={`atlas-panel ${selected === panel.id && editing ? "is-selected" : ""} ${moving === panel.id ? "is-moving" : ""}`} style={{ gridColumn: `${panel.layout.x + 1} / span ${panel.layout.w}`, gridRow: `${panel.layout.y + 1} / span ${panel.layout.h}` }} onClick={() => editing && onSelect(panel.id)}>
      <PanelCard panel={panel} variables={variables} runtime={runtime} editing={editing} refreshKey={refreshKey} onEvent={event => onEvent(panel, event)} onData={onData} onMove={event => start(panels.find(p => p.id === panel.id)!, "move", event)} />
      {editing && <button type="button" className="atlas-resize" aria-label={`Resize ${panel.title}`} title="Drag to resize. Use Layout properties for keyboard control." onPointerDown={event => start(panels.find(p => p.id === panel.id)!, "resize", event)}>◢</button>}
    </div>)}
  </div></div>;
}
function PanelCard({ panel, variables, runtime, editing, refreshKey, onEvent, onData, onMove }: { panel: PanelDefinition; variables: VariableValues; runtime: PlatformRuntime; editing: boolean; refreshKey: number; onEvent: (event: PanelEvent) => void; onData: (id: string, dataset: Dataset) => void; onMove: (event: React.PointerEvent) => void }) {
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [showData, setShowData] = useState(false);
  const [localRefresh, setLocalRefresh] = useState(0);
  const card = useRef<HTMLDivElement>(null);
  const dataCallback = useRef(onData); dataCallback.current = onData;
  const queryKey = JSON.stringify([panel.datasource, panel.query, panel.transform, variables, panel.refresh, panel.type === "network" ? [panel.mapping.nodeId, panel.mapping.edgeSource, panel.mapping.edgeTarget] : null]);
  useEffect(() => {
    const controller = new AbortController();
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const receive = (data: Dataset) => { if (!controller.signal.aborted) { setDataset(data); setError(""); setLoading(false); dataCallback.current(panel.id, data); } };
    const fail = (ex: unknown) => { if (!controller.signal.aborted) { setError(String(ex instanceof Error ? ex.message : ex)); setLoading(false); } };
    const query = (refresh = false) => { if (refresh) runtime.invalidate(panel.datasource.id); return runtime.query(panel, variables, controller.signal).then(receive).catch(fail); };
    setLoading(true); setError("");
    void query(refreshKey > 0 || localRefresh > 0).then(() => {
      if (controller.signal.aborted) return;
      try { unsubscribe = runtime.subscribe(panel, variables, { next: receive, error: fail }, controller.signal); } catch (ex) { fail(ex); }
      if ((panel.refresh ?? 0) > 0) timer = setInterval(() => void query(true), Math.max(1, panel.refresh!) * 1000);
    });
    return () => { controller.abort(); unsubscribe?.(); if (timer) clearInterval(timer); };
    // Display, layout, title and action edits do not refetch source data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, queryKey, refreshKey, localRefresh, panel.id]);
  const rows: Row[] = dataset?.kind === "table" ? dataset.rows : dataset ? [...dataset.nodes.map(n => ({ entity: "node", ...n })), ...dataset.edges.map(e => ({ entity: "edge", ...e }))] : [];
  const columns = [...new Set(rows.slice(0, 100).flatMap(Object.keys))];
  const fullscreen = () => { const target = card.current?.parentElement; if (document.fullscreenElement) void document.exitFullscreen(); else if (target?.requestFullscreen) void target.requestFullscreen().catch(ex => setError(`Fullscreen: ${String(ex)}`)); };
  return <div ref={card} className="atlas-panel-inner"><header className="atlas-panel-header">
    {editing && <button type="button" className="atlas-drag" onPointerDown={onMove} title="Drag panel. Use Layout properties for keyboard control." aria-label={`Move ${panel.title}`}>⠿</button>}
    <h2 title={panel.title}>{panel.title}</h2><span className="atlas-panel-type">{panel.type === "network" ? "GRAPH" : panel.type.toUpperCase()}</span>
    <button type="button" className="atlas-icon-button" title="Refresh panel" aria-label={`Refresh ${panel.title}`} onClick={() => setLocalRefresh(k => k + 1)}>↻</button>
    <button type="button" className={`atlas-icon-button ${showData ? "text-sky-300" : ""}`} title="Inspect dataset" aria-label={`Data for ${panel.title}`} onClick={() => setShowData(v => !v)}>▤</button>
    <button type="button" className="atlas-icon-button" title="Fullscreen" aria-label={`Fullscreen ${panel.title}`} onClick={fullscreen}>⛶</button>
  </header><div className="atlas-panel-body">
    {loading && <div className="atlas-panel-loading" role="status">Loading data…</div>}
    {error ? <div role="alert" className="atlas-panel-error"><strong>Could not render this panel</strong><span>{error}</span><button className="atlas-button" onClick={() => setLocalRefresh(k => k + 1)}>Retry</button></div> : dataset && (showData ? <div className="atlas-data-view"><table><thead><tr>{columns.map(c => <th key={c}>{c}</th>)}</tr></thead><tbody>{rows.slice(0, 200).map((row, i) => <tr key={i} onClick={() => onEvent({ entity: "row", values: row })}>{columns.map(c => <td key={c}>{typeof row[c] === "object" ? JSON.stringify(row[c]) : String(row[c] ?? "—")}</td>)}</tr>)}</tbody></table>{rows.length > 200 && <p>Showing the first 200 of {rows.length} rows.</p>}</div> : <DatasetPanel dataset={dataset} panel={panel} onEvent={onEvent} />)}
  </div>{dataset && (dataset.meta.warnings.length > 0 || dataset.meta.truncated) && <div className="atlas-panel-warning" title={dataset.meta.warnings.join("\n")}>{dataset.meta.truncated ? "Data capped. " : ""}{dataset.meta.warnings.slice(0, 2).join(" · ")}</div>}</div>;
}
