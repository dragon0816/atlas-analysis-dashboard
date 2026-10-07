import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from "react";
import type { PanelRendererProps } from "../../platform/types";
import { buildGraphModel, filterGraph, forceLayout, graphEdgeValues, graphNeighborhood, graphNodeValues, graphPathEdges, shortestGraphPath, type GraphEdge, type GraphNode, type GraphPoint } from "../../platform/graphModel";
import { CHROME, SERIES_COLORS, ellipsis, fmt } from "./PanelUi";

const WIDTH = 720, HEIGHT = 440;
const control = "rounded border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-300 focus-visible:outline focus-visible:outline-sky-400";
type View = { x: number; y: number; scale: number };
type Drag = { pointerId: number; kind: "node" | "pan"; id?: string; start: GraphPoint; origin: GraphPoint; moved: boolean };

export function NetworkGraphPanel(props: PanelRendererProps) {
  if (props.dataset.kind !== "graph") return <p role="alert">Network graph requires a graph dataset.</p>;
  return <GraphView {...props} />;
}

function GraphView({ dataset, panel, onEvent }: PanelRendererProps) {
  const model = useMemo(() => dataset.kind === "graph" ? buildGraphModel(dataset, panel.mapping, panel.display) : { nodes: [], edges: [], warnings: [] }, [dataset, panel.mapping, panel.display]);
  const [nodeType, setNodeType] = useState(""), [edgeType, setEdgeType] = useState(""), [community, setCommunity] = useState("");
  const [search, setSearch] = useState(""), [selected, setSelected] = useState<string | null>(null), [pathTarget, setPathTarget] = useState("");
  const [labels, setLabels] = useState<boolean | null>(null), [neighborhood, setNeighborhood] = useState(true);
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const [overrides, setOverrides] = useState<{ model: typeof model; points: Map<string, GraphPoint> }>({ model, points: new Map() });
  const [hover, setHover] = useState<{ kind: "node"; item: GraphNode } | { kind: "edge"; item: GraphEdge } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null), drag = useRef<Drag | null>(null), suppressClick = useRef(false);
  const markerId = `graph-arrow-${useId().replace(/:/g, "")}`;
  const visible = useMemo(() => filterGraph(model, { nodeType, edgeType, community }), [model, nodeType, edgeType, community]);
  const layout = useMemo(() => forceLayout(model, WIDTH, HEIGHT), [model]);
  const point = (id: string) => (overrides.model === model ? overrides.points.get(id) : undefined) ?? layout.get(id)!;
  const nodeById = useMemo(() => new Map(model.nodes.map(node => [node.id, node])), [model]);
  const nodeTypes = [...new Set(model.nodes.map(node => node.type))].sort(), edgeTypes = [...new Set(model.edges.map(edge => edge.type))].sort(), communities = [...new Set(model.nodes.map(node => node.community))].sort();
  const edgeStates = [...new Set(model.edges.map(edge => edge.state).filter(Boolean))].sort();
  const edgeDash = (state: string) => state ? ["5 3", "2 3", "8 3 2 3", "12 4"][edgeStates.indexOf(state) % 4] : undefined;
  const edgeColor = (type: string) => SERIES_COLORS[edgeTypes.indexOf(type)] ?? "#94a3b8";
  const colors = [...new Set(model.nodes.map(node => node.color))].sort();
  const colorOf = (category: string) => SERIES_COLORS[colors.indexOf(category)] ?? "#94a3b8";
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const matches = normalizedSearch ? visible.nodes.filter(node => `${node.id} ${node.label}`.toLocaleLowerCase().includes(normalizedSearch)) : [];
  const matchIds = new Set(matches.map(node => node.id));
  const selectedNode = visible.nodes.find(node => node.id === selected);
  const computedPath = useMemo(() => selected && pathTarget ? shortestGraphPath(visible, selected, pathTarget) : [], [visible, selected, pathTarget]);
  const configuredPath = Array.isArray(panel.display.highlightPath) ? panel.display.highlightPath.map(String) : [];
  const path = pathTarget ? computedPath : configuredPath;
  const pathNodes = new Set(path), pathEdges = graphPathEdges(visible, path);
  const neighbors = selectedNode && neighborhood ? graphNeighborhood(visible, selectedNode.id) : new Set<string>();
  const showLabels = labels ?? (panel.display.showLabels !== false && model.nodes.length <= 200);
  const maxSize = Math.max(1, ...model.nodes.map(node => node.size));
  const radius = (node: GraphNode) => 5 + Math.sqrt(node.size / maxSize) * 12;

  const screenPoint = (clientX: number, clientY: number): GraphPoint => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const matrix = typeof svg.getScreenCTM === "function" ? svg.getScreenCTM() : null;
    if (matrix && typeof DOMPoint !== "undefined") { const p = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse()); return { x: p.x, y: p.y }; }
    const bounds = svg.getBoundingClientRect(), scale = Math.min(bounds.width / WIDTH, bounds.height / HEIGHT);
    if (!(scale > 0)) return { x: 0, y: 0 };
    return { x: (clientX - bounds.left - (bounds.width - WIDTH * scale) / 2) / scale, y: (clientY - bounds.top - (bounds.height - HEIGHT * scale) / 2) / scale };
  };
  const fit = () => {
    if (!visible.nodes.length) { setView({ x: 0, y: 0, scale: 1 }); return; }
    const points = visible.nodes.map(node => point(node.id));
    const x0 = Math.min(...points.map(p => p.x)) - 40, x1 = Math.max(...points.map(p => p.x)) + 40;
    const y0 = Math.min(...points.map(p => p.y)) - 40, y1 = Math.max(...points.map(p => p.y)) + 40;
    const scale = Math.min(4, Math.max(0.2, Math.min(WIDTH / (x1 - x0), HEIGHT / (y1 - y0)) * 0.9));
    setView({ scale, x: WIDTH / 2 - (x0 + x1) / 2 * scale, y: HEIGHT / 2 - (y0 + y1) / 2 * scale });
  };
  const zoom = (factor: number, center: GraphPoint = { x: WIDTH / 2, y: HEIGHT / 2 }) => setView(current => {
    const scale = Math.max(0.15, Math.min(8, current.scale * factor));
    return { scale, x: center.x - (center.x - current.x) * scale / current.scale, y: center.y - (center.y - current.y) * scale / current.scale };
  });
  const selectNode = (node: GraphNode) => { setSelected(node.id); onEvent?.({ entity: "node", values: graphNodeValues(node) }); };
  const selectEdge = (edge: GraphEdge) => { setSelected(edge.source); onEvent?.({ entity: "edge", values: graphEdgeValues(edge) }); };
  const startDrag = (event: PointerEvent<SVGElement>, node?: GraphNode) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const start = screenPoint(event.clientX, event.clientY);
    drag.current = { pointerId: event.pointerId, kind: node ? "node" : "pan", id: node?.id, start, origin: node ? point(node.id) : { x: view.x, y: view.y }, moved: false };
    suppressClick.current = false;
    svgRef.current?.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: PointerEvent<SVGSVGElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const now = screenPoint(event.clientX, event.clientY), dx = now.x - state.start.x, dy = now.y - state.start.y;
    if (Math.hypot(dx, dy) > 3) state.moved = true;
    if (state.kind === "pan") setView(current => ({ ...current, x: state.origin.x + dx, y: state.origin.y + dy }));
    else setOverrides(current => { const points = new Map(current.model === model ? current.points : []); points.set(state.id!, { x: state.origin.x + dx / view.scale, y: state.origin.y + dy / view.scale }); return { model, points }; });
  };
  const finishDrag = (event: PointerEvent<SVGSVGElement>, cancelled = false) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    suppressClick.current = true;
    if (!state.moved && !cancelled && state.kind === "node") { const node = nodeById.get(state.id!); if (node) selectNode(node); }
    if (cancelled) {
      if (state.kind === "pan") setView(current => ({ ...current, ...state.origin }));
      else setOverrides(current => { const points = new Map(current.model === model ? current.points : []); points.set(state.id!, state.origin); return { model, points }; });
    }
    if (svgRef.current?.hasPointerCapture(event.pointerId)) svgRef.current.releasePointerCapture(event.pointerId);
    drag.current = null;
  };

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const wheel = (event: WheelEvent) => { event.preventDefault(); event.stopPropagation(); zoom(Math.exp(-event.deltaY * 0.0015), screenPoint(event.clientX, event.clientY)); };
    svg.addEventListener("wheel", wheel, { passive: false });
    return () => svg.removeEventListener("wheel", wheel);
  }, [visible.nodes.length]);

  return <div className="flex h-full min-h-0 flex-col gap-1" data-panel-kind="network" onPointerDown={event => event.stopPropagation()}>
    <div className="flex flex-wrap items-center gap-1 px-1">
      <input aria-label="Search nodes" placeholder="Search nodes…" className={`${control} w-32`} value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && matches[0]) { selectNode(matches[0]); const p = point(matches[0].id); setView({ scale: 2, x: WIDTH / 2 - p.x * 2, y: HEIGHT / 2 - p.y * 2 }); } }} />
      <select aria-label="Node type filter" className={`${control} max-w-32`} value={nodeType} onChange={event => setNodeType(event.target.value)}><option value="">All node types</option>{nodeTypes.map(type => <option key={type}>{type}</option>)}</select>
      <select aria-label="Edge type filter" className={`${control} max-w-32`} value={edgeType} onChange={event => setEdgeType(event.target.value)}><option value="">All edge types</option>{edgeTypes.map(type => <option key={type}>{type}</option>)}</select>
      <select aria-label="Community filter" className={`${control} max-w-32`} value={community} onChange={event => setCommunity(event.target.value)}><option value="">All communities</option>{communities.map(value => <option key={value}>{value}</option>)}</select>
      <button type="button" className={control} onClick={fit}>Fit</button><button type="button" aria-label="Zoom in" className={control} onClick={() => zoom(1.3)}>+</button><button type="button" aria-label="Zoom out" className={control} onClick={() => zoom(1 / 1.3)}>−</button>
      <label className="inline-flex items-center gap-1 px-1 text-[11px] text-slate-400"><input type="checkbox" checked={showLabels} onChange={event => setLabels(event.target.checked)} />Labels</label>
      <label className="inline-flex items-center gap-1 px-1 text-[11px] text-slate-400"><input type="checkbox" checked={neighborhood} onChange={event => setNeighborhood(event.target.checked)} />Neighbors</label>
    </div>
    {model.warnings.map(warning => <p key={warning} role="status" className="px-2 text-[11px] text-amber-300">{warning}</p>)}
    <div className="flex items-center justify-between gap-2 px-2 text-[11px] text-slate-500"><span>{visible.nodes.length} nodes · {visible.edges.length} edges{normalizedSearch ? ` · ${matches.length} search matches (Enter to focus)` : " · drag nodes or background, scroll to zoom"}</span>{selectedNode && <button type="button" className="text-sky-300" onClick={() => { setSelected(null); setPathTarget(""); }}>Clear selection</button>}</div>
    <div className="relative min-h-0 flex-1 overflow-hidden rounded bg-slate-950/40">
      {!visible.nodes.length ? <p className="p-6 text-center text-xs text-slate-500">No nodes match the current filters.</p> : <svg ref={svgRef} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" height="100%" aria-label={`${panel.title}: interactive network graph`} role="img" style={{ touchAction: "none", minHeight: 100 }}
        onPointerDown={event => startDrag(event)} onPointerMove={moveDrag} onPointerUp={event => finishDrag(event)} onPointerCancel={event => finishDrag(event, true)} onPointerLeave={() => { if (!drag.current) setHover(null); }}>
        <defs><marker id={markerId} viewBox="0 -4 8 8" refX="8" refY="0" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,-4 L8,0 L0,4" fill="#64748b" /></marker></defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          {visible.edges.map(edge => {
            const a = point(edge.source), b = point(edge.target), pathHit = pathEdges.has(edge.id);
            const adjacent = !selectedNode || !neighborhood || edge.source === selected || edge.target === selected;
            const opacity = path.length ? pathHit ? 1 : 0.12 : adjacent ? 0.7 : 0.1;
            const sourceNode = nodeById.get(edge.source)!, targetNode = nodeById.get(edge.target)!;
            const distance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
            const sx = a.x + (b.x - a.x) / distance * radius(sourceNode), sy = a.y + (b.y - a.y) / distance * radius(sourceNode);
            const tx = b.x - (b.x - a.x) / distance * (radius(targetNode) + 3), ty = b.y - (b.y - a.y) / distance * (radius(targetNode) + 3);
            const d = edge.source === edge.target ? `M${a.x - 5},${a.y - 8} C${a.x - 40},${a.y - 55} ${a.x + 40},${a.y - 55} ${a.x + 5},${a.y - 8}` : `M${sx},${sy} L${tx},${ty}`;
            return <g key={edge.id} opacity={opacity} onPointerDown={event => event.stopPropagation()} onPointerEnter={() => setHover({ kind: "edge", item: edge })} onPointerLeave={() => setHover(null)} onClick={event => { event.stopPropagation(); selectEdge(edge); }}>
              <path d={d} fill="none" stroke={pathHit ? "#f8fafc" : edgeColor(edge.type)} strokeWidth={Math.min(6, 0.75 + Math.sqrt(edge.weight))} strokeDasharray={edgeDash(edge.state)} markerEnd={panel.display.directed === false ? undefined : `url(#${markerId})`} />
              <path d={d} fill="none" stroke="transparent" strokeWidth={14} role="button" tabIndex={0} aria-label={`${edge.source} to ${edge.target}, ${edge.type}${edge.state ? `, ${edge.state}` : ""}`} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectEdge(edge); } }}><title>{`${edge.type}: ${edge.source} → ${edge.target} · weight ${fmt(edge.weight)}${edge.state ? ` · ${edge.state}` : ""}`}</title></path>
            </g>;
          })}
          {visible.nodes.map(node => {
            const p = point(node.id), searchHit = !!normalizedSearch && matchIds.has(node.id);
            const emphasized = path.length ? pathNodes.has(node.id) : selectedNode && neighborhood ? neighbors.has(node.id) : true;
            return <g key={node.id} transform={`translate(${p.x} ${p.y})`} opacity={emphasized ? 1 : 0.18} style={{ cursor: "grab" }} role="button" tabIndex={0} aria-label={`${node.label}, ${node.type}, ${node.community}`} className="outline-none focus:stroke-white"
              onPointerDown={event => startDrag(event, node)} onPointerEnter={() => setHover({ kind: "node", item: node })} onPointerLeave={() => setHover(null)}
              onClick={event => { event.stopPropagation(); if (!suppressClick.current) selectNode(node); suppressClick.current = false; }} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectNode(node); } }}>
              <title>{`${node.label} (${node.id}) · ${node.type} · ${node.community}`}</title>
              {(searchHit || selected === node.id || pathNodes.has(node.id)) && <circle r={radius(node) + 5} fill="none" stroke={searchHit ? "#facc15" : "#f8fafc"} strokeWidth={2} />}
              <circle r={radius(node)} fill={colorOf(node.color)} stroke="#0f172a" strokeWidth={1.5} />
              {(showLabels || searchHit || selected === node.id) && <text x={radius(node) + 5} y={4} fontSize={11} fill={CHROME.textPrimary} stroke="#020617" strokeWidth={3} paintOrder="stroke" pointerEvents="none">{ellipsis(node.label, 30)}</text>}
            </g>;
          })}
        </g>
      </svg>}
      {hover && <div className="pointer-events-none absolute bottom-2 left-2 max-w-[90%] rounded border border-slate-700 bg-slate-950/95 px-2 py-1 text-xs text-slate-300" role="status">{hover.kind === "node" ? <><strong>{hover.item.label}</strong> · {hover.item.type} · {hover.item.community}<br /><span className="text-slate-500">{hover.item.id} · size {fmt(hover.item.size)}</span></> : <><strong>{hover.item.type}</strong> · {hover.item.source} → {hover.item.target}<br /><span className="text-slate-500">weight {fmt(hover.item.weight)}{hover.item.state ? ` · ${hover.item.state}` : ""}</span></>}</div>}
    </div>
    {selectedNode && <div className="flex flex-wrap items-center gap-2 px-2 text-[11px] text-slate-400"><span>Selected: {selectedNode.label}</span><select className={`${control} max-w-48`} aria-label="Highlight path to node" value={pathTarget} onChange={event => setPathTarget(event.target.value)}><option value="">Highlight path to…</option>{visible.nodes.filter(node => node.id !== selected).map(node => <option key={node.id} value={node.id}>{node.label}</option>)}</select>{pathTarget && <span>{computedPath.length ? `${computedPath.length - 1} hops (undirected)` : "No path in current view"}</span>}</div>}
    <div className="flex max-h-14 flex-wrap gap-x-3 gap-y-1 overflow-y-auto px-2 pb-1 text-[11px] text-slate-400" aria-label="Node color legend">{colors.map(color => <span key={color} className="inline-flex items-center gap-1"><i className="h-2 w-2 rounded-full" style={{ background: colorOf(color) }} />{color}</span>)}{colors.length > SERIES_COLORS.length && <span>Additional groups use gray; hover for identity.</span>}{edgeTypes.map(type => <span key={`edge:${type}`} className="inline-flex items-center gap-1"><i className="h-0.5 w-3" style={{ background: edgeColor(type) }} />Edge: {type}</span>)}<span>Node size: {panel.mapping.nodeSize ?? "size"} · edge width: {panel.mapping.edgeWeight ?? "weight"} · dashed: {edgeStates.join(", ") || "no edge states"}</span></div>
  </div>;
}
