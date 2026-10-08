import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from "react";
import type { PanelRendererProps } from "../../platform/types";
import { buildGraphModel, filterGraph, forceLayout, groupGraph, graphBoundaries, graphNodeRadius, type GraphGroupingMode, graphEdgeValues, graphNeighborhood, graphNodeValues, graphPathEdges, shortestGraphPath, type GraphEdge, type GraphNode, type GraphPoint } from "../../platform/graphModel";
import { Graph3DView, type Graph3DHandle } from "./Graph3DView";
import { CHROME, SERIES_COLORS, ellipsis, fmt } from "./PanelUi";

const WIDTH = 720, HEIGHT = 440;
const REGION_COLORS = ["#a78bfa", "#818cf8", "#c084fc", "#8b9dfa", "#b4a4ef", "#9694cc"];
const numeric = (value: unknown, fallback: number, min: number, max: number) => typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
const control = "rounded border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-300 focus-visible:outline focus-visible:outline-sky-400";
type View = { x: number; y: number; scale: number };
type Drag = { pointerId: number; kind: "node" | "pan"; id?: string; start: GraphPoint; origin: GraphPoint; moved: boolean };

export function NetworkGraphPanel(props: PanelRendererProps) {
  if (props.dataset.kind !== "graph") return <p role="alert">Network graph requires a graph dataset.</p>;
  return <GraphView {...props} />;
}

function GraphView({ dataset, panel, onEvent }: PanelRendererProps) {
  const comparison = dataset.meta?.revision === "synthetic-comparison-v1";
  const [scenario, setScenario] = useState("connected");
  const [layoutOverride, setLayoutMode] = useState<"topology" | "grouped" | null>(null);
  const layoutMode = layoutOverride ?? (comparison && scenario === "connected" ? "topology" : "grouped");
  const scenarioData = useMemo(() => dataset.kind === "graph" && comparison ? { ...dataset, nodes: dataset.nodes.filter(n => n.scenario === scenario), edges: dataset.edges.filter(e => e.scenario === scenario) } : dataset, [dataset, comparison, scenario]);
  const model = useMemo(() => scenarioData.kind === "graph" ? buildGraphModel(scenarioData, panel.mapping, panel.display) : { nodes: [], edges: [], warnings: [] }, [scenarioData, panel.mapping, panel.display]);
  const [dimensionOverride, setDimension] = useState<"2d" | "3d" | null>(null);
  const dimension = dimensionOverride ?? (panel.display.graphDimension === "3d" ? "3d" : "2d");
  const [graphicsMessage, setGraphicsMessage] = useState("");
  const threeApi = useRef<Graph3DHandle | null>(null);
  const [nodeType, setNodeType] = useState(""), [edgeType, setEdgeType] = useState(""), [community, setCommunity] = useState("");
  const [search, setSearch] = useState(""), [selected, setSelected] = useState<string | null>(null), [pathTarget, setPathTarget] = useState("");
  const [labels, setLabels] = useState<string | null>(null), [neighborhood, setNeighborhood] = useState(true);
  const [regions, setRegions] = useState<boolean | null>(null), [groupMode, setGroupMode] = useState<GraphGroupingMode | null>(null), [regionFilter, setRegionFilter] = useState("");
  const [nodeScaleOverride, setNodeScale] = useState<number | null>(null), [labelSizeOverride, setLabelSize] = useState<number | null>(null);
  const labelMode = labels ?? String(panel.display.labelMode ?? "focus");
  const showRegions = regions ?? panel.display.showBoundaries !== false;
  const groupingMode = groupMode ?? (["community", "group", "components"].includes(String(panel.display.boundaryBy)) ? panel.display.boundaryBy as GraphGroupingMode : "auto");
  const nodeScale = nodeScaleOverride ?? numeric(panel.display.nodeScale, 1, 0.5, 2);
  const labelSize = labelSizeOverride ?? numeric(panel.display.labelSize, 12, 10, 18);
  const grouping = useMemo(() => groupGraph(model, groupingMode), [model, groupingMode]);
  const layout = useMemo(() => forceLayout(model, WIDTH, HEIGHT, groupingMode, nodeScale, layoutMode), [model, groupingMode, nodeScale, layoutMode]);
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const [overrides, setOverrides] = useState<{ layout: typeof layout; points: Map<string, GraphPoint> }>({ layout, points: new Map() });
  const [hover, setHover] = useState<{ kind: "node"; item: GraphNode } | { kind: "edge"; item: GraphEdge } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null), drag = useRef<Drag | null>(null), suppressClick = useRef(false);
  const markerId = `graph-arrow-${useId().replace(/:/g, "")}`;
  const visible = useMemo(() => {
    const filtered = filterGraph(model, { nodeType, edgeType, community });
    if (!regionFilter) return filtered;
    const nodes = filtered.nodes.filter(node => grouping.membership.get(node.id) === regionFilter), ids = new Set(nodes.map(n => n.id));
    return { ...filtered, nodes, edges: filtered.edges.filter(e => ids.has(e.source) && ids.has(e.target)) };
  }, [model, nodeType, edgeType, community, regionFilter, grouping]);
  const point = (id: string) => (overrides.layout === layout ? overrides.points.get(id) : undefined) ?? layout.get(id)!;
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
  const maxSize = Math.max(1, ...model.nodes.map(node => node.size));
  const radius = (node: GraphNode) => graphNodeRadius(node, maxSize, nodeScale);
  const boundaries = graphBoundaries(grouping, new Set(visible.nodes.map(n => n.id)), point, 17 + 6 * nodeScale);
  const regionColor = (id: string) => REGION_COLORS[grouping.groups.findIndex(g => g.id === id) % REGION_COLORS.length];
  const regionSource = grouping.source === "components" ? "undirected connected components" : `dataset field: ${panel.mapping[grouping.source === "community" ? "nodeCommunity" : "nodeGroup"] || grouping.source}`;
  const hoveredNode = hover?.kind === "node" ? hover.item.id : null;
  // Only focus labels by default; zoom labels are collision-checked and bounded.
  const labelIds = new Set<string>();
  const labelBoxes: { x: number; y: number; w: number; h: number }[] = [];
  const fontSize = labelSize / Math.min(2, Math.max(0.8, view.scale));
  const orderedLabels = [...visible.nodes].sort((a, b) => Number(b.id === hoveredNode || b.id === selected) - Number(a.id === hoveredNode || a.id === selected));
  for (const node of orderedLabels) {
    const focused = node.id === selected || node.id === hoveredNode;
    if (!(focused || matchIds.has(node.id) || labelMode === "all" || labelMode === "zoom" && view.scale >= 1.8)) continue;
    const p = point(node.id), box = { x: p.x + radius(node) + 5, y: p.y - fontSize / 2, w: Math.min(30, node.label.length) * fontSize * 0.58, h: fontSize + 4 };
    if (!focused && labelMode !== "all" && (labelIds.size >= 24 || labelBoxes.some(b => box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y))) continue;
    labelIds.add(node.id); labelBoxes.push(box);
  }

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
    const x0 = Math.min(...points.map(p => p.x), ...(showRegions ? boundaries.map(b => b.bounds.x0) : [])) - 24, x1 = Math.max(...points.map(p => p.x), ...(showRegions ? boundaries.map(b => b.bounds.x1) : [])) + 24;
    const y0 = Math.min(...points.map(p => p.y), ...(showRegions ? boundaries.map(b => b.bounds.y0) : [])) - 24, y1 = Math.max(...points.map(p => p.y), ...(showRegions ? boundaries.map(b => b.bounds.y1) : [])) + 24;
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
    else setOverrides(current => { const points = new Map(current.layout === layout ? current.points : []); points.set(state.id!, { x: state.origin.x + dx / view.scale, y: state.origin.y + dy / view.scale }); return { layout, points }; });
  };
  const finishDrag = (event: PointerEvent<SVGSVGElement>, cancelled = false) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    suppressClick.current = true;
    if (!state.moved && !cancelled && state.kind === "node") { const node = nodeById.get(state.id!); if (node) selectNode(node); }
    if (cancelled) {
      if (state.kind === "pan") setView(current => ({ ...current, ...state.origin }));
      else setOverrides(current => { const points = new Map(current.layout === layout ? current.points : []); points.set(state.id!, state.origin); return { layout, points }; });
    }
    if (svgRef.current?.hasPointerCapture(event.pointerId)) svgRef.current.releasePointerCapture(event.pointerId);
    drag.current = null;
  };

  useEffect(() => { setView({ x: 0, y: 0, scale: 1 }); setHover(null); }, [layout]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const wheel = (event: WheelEvent) => { event.preventDefault(); event.stopPropagation(); zoom(Math.exp(-event.deltaY * 0.0015), screenPoint(event.clientX, event.clientY)); };
    svg.addEventListener("wheel", wheel, { passive: false });
    return () => svg.removeEventListener("wheel", wheel);
  }, [visible.nodes.length, dimension]);

  return <div className="flex h-full min-h-0 flex-col gap-1" data-panel-kind="network" onPointerDown={event => event.stopPropagation()}>
    <div className="relative flex flex-wrap items-center gap-1 px-1">
      {comparison && <select aria-label="Synthetic graph scenario" className={control} value={scenario} onChange={e => { setScenario(e.target.value); setSelected(null); setPathTarget(""); setSearch(""); setNodeType(""); setEdgeType(""); setCommunity(""); setRegionFilter(""); setHover(null); setLayoutMode(null); }}><option value="connected">Synthetic · Interconnected</option><option value="sparse">Synthetic · Original sparse</option></select>}
      <select aria-label="Graph layout" className={control} value={layoutMode} onChange={e => setLayoutMode(e.target.value as "topology" | "grouped")}><option value="topology">Layout · By connections</option><option value="grouped">Layout · Separated groups</option></select>
      <input aria-label="Search nodes" placeholder="Search nodes…" className={`${control} w-32`} value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && matches[0]) { selectNode(matches[0]); if (dimension === "3d") threeApi.current?.focus(matches[0].id); else { const p = point(matches[0].id); setView({ scale: 2, x: WIDTH / 2 - p.x * 2, y: HEIGHT / 2 - p.y * 2 }); } } }} />
      <select aria-label="Node type filter" className={`${control} max-w-32`} value={nodeType} onChange={event => setNodeType(event.target.value)}><option value="">All node types</option>{nodeTypes.map(type => <option key={type}>{type}</option>)}</select>
      <select aria-label="Edge type filter" className={`${control} max-w-32`} value={edgeType} onChange={event => setEdgeType(event.target.value)}><option value="">All edge types</option>{edgeTypes.map(type => <option key={type}>{type}</option>)}</select>
      <select aria-label="Community filter" className={`${control} max-w-32`} value={community} onChange={event => setCommunity(event.target.value)}><option value="">All communities</option>{communities.map(value => <option key={value}>{value}</option>)}</select>
      <span className="inline-flex" role="group" aria-label="Graph dimensions">{(["2d", "3d"] as const).map(value => <button key={value} type="button" className={`${control} ${dimension === value ? "border-sky-500 text-sky-200" : ""}`} aria-pressed={dimension === value} onClick={() => { setDimension(value); setHover(null); setGraphicsMessage(""); }}>{value.toUpperCase()}</button>)}</span>
      <button type="button" className={control} onClick={() => dimension === "3d" ? threeApi.current?.fit() : fit()}>Fit</button><button type="button" aria-label="Zoom in" className={control} onClick={() => dimension === "3d" ? threeApi.current?.zoom(1.3) : zoom(1.3)}>+</button><button type="button" aria-label="Zoom out" className={control} onClick={() => dimension === "3d" ? threeApi.current?.zoom(1 / 1.3) : zoom(1 / 1.3)}>−</button>
      <details onKeyDown={event => { if (event.key === "Escape") event.currentTarget.open = false; }}>
        <summary className={`${control} cursor-pointer select-none`}>View</summary>
        <div className="absolute right-0 top-full z-30 mt-1 flex w-64 flex-col gap-3 rounded-lg border border-slate-700 bg-slate-950 p-3 text-xs text-slate-300 shadow-xl" aria-label="Graph display controls">
          <label className="flex items-center justify-between gap-2">Labels<select aria-label="Node label visibility" className={control} value={labelMode} onChange={e => setLabels(e.target.value)}><option value="focus">On focus</option><option value="zoom">When zoomed in</option><option value="all">All labels</option></select></label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={showRegions} onChange={e => setRegions(e.target.checked)} />Group boundaries</label>
          <label className="flex items-center justify-between gap-2">Group by<select aria-label="Boundary grouping" className={`${control} max-w-36`} value={groupingMode} onChange={e => { setGroupMode(e.target.value as GraphGroupingMode); setRegionFilter(""); }}><option value="auto">Auto (data fields)</option><option value="community">Community field</option><option value="group">Group field</option><option value="components">Connected components</option></select></label>
          <label className="flex items-center justify-between gap-2">Region<select aria-label="Region filter" className={`${control} max-w-36`} value={regionFilter} onChange={e => setRegionFilter(e.target.value)}><option value="">All regions</option>{grouping.groups.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}</select></label>
          <label className="flex flex-col gap-1">Node size · {nodeScale.toFixed(1)}×<input aria-label="Node size" type="range" min="0.5" max="2" step="0.1" value={nodeScale} onChange={e => setNodeScale(Number(e.target.value))} /></label>
          <label className="flex flex-col gap-1">Label size · {labelSize}px<input aria-label="Label size" type="range" min="10" max="18" step="1" value={labelSize} onChange={e => setLabelSize(Number(e.target.value))} /></label>
          <span className="text-slate-400">On focus shows names on hover, keyboard focus, selection and search. Regions follow {regionSource}.</span>
        </div>
      </details>
      <label className="inline-flex items-center gap-1 px-1 text-[11px] text-slate-400"><input type="checkbox" checked={neighborhood} onChange={event => setNeighborhood(event.target.checked)} />Neighbors</label>
    </div>
    {graphicsMessage && <p role="status" className="px-2 text-xs text-amber-300">{graphicsMessage}</p>}
    {model.warnings.map(warning => <p key={warning} role="status" className="px-2 text-[11px] text-amber-300">{warning}</p>)}
    <div className="flex items-center justify-between gap-2 px-2 text-[11px] text-slate-500"><span>{visible.nodes.length} nodes · {visible.edges.length} edges · {visible.edges.filter(e => grouping.membership.get(e.source) !== grouping.membership.get(e.target)).length} cross-region{normalizedSearch ? ` · ${matches.length} search matches (Enter to focus)` : dimension === "3d" ? " · drag to rotate, right-drag to pan, scroll to zoom" : " · drag nodes or background, scroll to zoom"}</span>{selectedNode && <button type="button" className="text-sky-300" onClick={() => { setSelected(null); setPathTarget(""); }}>Clear selection</button>}</div>
    <div className="relative min-h-0 flex-1 overflow-hidden rounded bg-slate-950/40">
      {!visible.nodes.length ? <p className="p-6 text-center text-xs text-slate-500">No nodes match the current filters.</p> : dimension === "3d" ? <Graph3DView api={threeApi} onUnavailable={message => { setGraphicsMessage(message); setDimension("2d"); setHover(null); }} options={{ model, visible, grouping, layoutMode, selected, neighborhood, neighbors, matches: matchIds, pathNodes, pathEdges, labelMode, labelSize, nodeScale, showRegions, directed: panel.display.directed !== false, colorOf, edgeColor, regionColor, onSelectNode: selectNode, onSelectEdge: selectEdge, onHover: setHover }} /> : <svg ref={svgRef} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" height="100%" aria-label={`${panel.title}: interactive network graph`} role="group" style={{ touchAction: "none", minHeight: 100 }}
        onPointerDown={event => startDrag(event)} onPointerMove={moveDrag} onPointerUp={event => finishDrag(event)} onPointerCancel={event => finishDrag(event, true)} onPointerLeave={() => { if (!drag.current) setHover(null); }}>
        <defs><marker id={markerId} viewBox="0 -4 8 8" refX="8" refY="0" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,-4 L8,0 L0,4" fill="#64748b" /></marker></defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          {showRegions && <g data-graph-boundaries="true" pointerEvents="none" aria-hidden="true">{boundaries.map(boundary => <g key={boundary.id} data-region-id={boundary.id}>
            <path d={boundary.path} fill={regionColor(boundary.id)} fillOpacity={0.12} stroke={regionColor(boundary.id)} strokeOpacity={0.28} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            {(boundary.count > 1 || boundaries.length <= 12) && boundaries.length <= 30 && <text x={boundary.x} y={boundary.y} textAnchor="middle" fill={regionColor(boundary.id)} fontSize={11} fontWeight={500}>{ellipsis(boundary.label, 25)}</text>}
          </g>)}</g>}
          {visible.edges.map(edge => {
            const a = point(edge.source), b = point(edge.target), pathHit = pathEdges.has(edge.id);
            const adjacent = !selectedNode || !neighborhood || edge.source === selected || edge.target === selected;
            const activeEdge = hover?.kind === "edge" && hover.item.id === edge.id;
            const opacity = activeEdge ? 1 : path.length ? pathHit ? 0.95 : 0.07 : selectedNode && neighborhood ? adjacent ? 0.75 : 0.07 : 0.23;
            const sourceNode = nodeById.get(edge.source)!, targetNode = nodeById.get(edge.target)!;
            const distance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
            const sx = a.x + (b.x - a.x) / distance * radius(sourceNode), sy = a.y + (b.y - a.y) / distance * radius(sourceNode);
            const tx = b.x - (b.x - a.x) / distance * (radius(targetNode) + 3), ty = b.y - (b.y - a.y) / distance * (radius(targetNode) + 3);
            const d = edge.source === edge.target ? `M${a.x - 5},${a.y - 8} C${a.x - 40},${a.y - 55} ${a.x + 40},${a.y - 55} ${a.x + 5},${a.y - 8}` : `M${sx},${sy} L${tx},${ty}`;
            return <g key={edge.id} opacity={opacity} onPointerDown={event => event.stopPropagation()} onPointerEnter={() => setHover({ kind: "edge", item: edge })} onPointerLeave={() => setHover(null)} onClick={event => { event.stopPropagation(); selectEdge(edge); }}>
              <path d={d} fill="none" stroke={pathHit || activeEdge ? "#f8fafc" : selectedNode && adjacent ? edgeColor(edge.type) : "#94a3b8"} strokeWidth={pathHit || activeEdge ? 1.7 : Math.min(1.5, 0.45 + Math.sqrt(edge.weight) * 0.2)} vectorEffect="non-scaling-stroke" strokeDasharray={edgeDash(edge.state)} markerEnd={panel.display.directed === false ? undefined : `url(#${markerId})`} />
              <path d={d} fill="none" stroke="#ffffff" strokeOpacity={0} pointerEvents="stroke" strokeWidth={8} className="focus:stroke-sky-400 focus:stroke-opacity-50 focus:outline-none" role="button" tabIndex={0} aria-label={`${edge.source} to ${edge.target}, ${edge.type}${edge.state ? `, ${edge.state}` : ""}`} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectEdge(edge); } }}><title>{`${edge.type}: ${edge.source} → ${edge.target} · weight ${fmt(edge.weight)}${edge.state ? ` · ${edge.state}` : ""}`}</title></path>
            </g>;
          })}
          {visible.nodes.map(node => {
            const p = point(node.id), searchHit = !!normalizedSearch && matchIds.has(node.id);
            const emphasized = searchHit || selected === node.id || hoveredNode === node.id || (path.length ? pathNodes.has(node.id) : selectedNode && neighborhood ? neighbors.has(node.id) : true);
            return <g key={node.id} data-node-id={node.id} transform={`translate(${p.x} ${p.y})`} opacity={emphasized ? 1 : 0.18} style={{ cursor: "grab" }} role="button" tabIndex={0} aria-label={`${node.label}, ${node.type}, ${node.community}`} className="outline-none focus:stroke-white"
              onFocus={() => setHover({ kind: "node", item: node })} onBlur={() => setHover(null)} onPointerDown={event => startDrag(event, node)} onPointerEnter={() => setHover({ kind: "node", item: node })} onPointerLeave={() => setHover(null)}
              onClick={event => { event.stopPropagation(); if (!suppressClick.current) selectNode(node); suppressClick.current = false; }} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectNode(node); } }}>
              <title>{`${node.label} (${node.id}) · ${node.type} · ${node.community}`}</title>
              <circle r={Math.max(10, radius(node) + 3)} fill="#ffffff" fillOpacity={0} stroke="none" pointerEvents="all" />
              {(searchHit || selected === node.id || hoveredNode === node.id || pathNodes.has(node.id)) && <circle r={radius(node) + 3} fill="none" stroke={searchHit ? "#facc15" : "#f8fafc"} strokeWidth={1.4} />}
              <circle r={radius(node)} data-node-dot="true" fill={colorOf(node.color)} stroke="#0f172a" strokeWidth={0.7} />
            </g>;
          })}
          <g data-graph-labels="true" pointerEvents="none" aria-hidden="true">{visible.nodes.filter(node => labelIds.has(node.id)).map(node => {
            const p = point(node.id);
            return <text key={node.id} data-node-label="true" x={p.x + radius(node) + 5} y={p.y + fontSize * 0.35} fontSize={fontSize} fill={CHROME.textPrimary} stroke="#020617" strokeWidth={3} paintOrder="stroke">{ellipsis(node.label, 30)}</text>;
          })}</g>
        </g>
      </svg>}
      {hover && <div className="pointer-events-none absolute bottom-2 left-2 max-w-[90%] rounded border border-slate-700 bg-slate-950/95 px-2 py-1 text-xs text-slate-300" role="status">{hover.kind === "node" ? <><strong>{hover.item.label}</strong> · {hover.item.type} · {hover.item.community}<br /><span className="text-slate-500">{hover.item.id} · size {fmt(hover.item.size)}</span></> : <><strong>{hover.item.type}</strong> · {hover.item.source} → {hover.item.target}<br /><span className="text-slate-500">weight {fmt(hover.item.weight)}{hover.item.state ? ` · ${hover.item.state}` : ""}</span></>}</div>}
    </div>
    {selectedNode && <div className="flex flex-wrap items-center gap-2 px-2 text-[11px] text-slate-400"><span>Selected: {selectedNode.label}{Array.isArray(selectedNode.row.domain_memberships) ? ` · Domains: ${selectedNode.row.domain_memberships.join(", ")}` : ""}</span><select className={`${control} max-w-48`} aria-label="Highlight path to node" value={pathTarget} onChange={event => setPathTarget(event.target.value)}><option value="">Highlight path to…</option>{visible.nodes.filter(node => node.id !== selected).map(node => <option key={node.id} value={node.id}>{node.label}</option>)}</select>{pathTarget && <span>{computedPath.length ? `${computedPath.length - 1} hops (undirected)` : "No path in current view"}</span>}</div>}
    <details className="px-2 pb-1 text-[11px] text-slate-400">
      <summary className="cursor-pointer">Legend · {showRegions ? `${boundaries.length} regions · ${regionSource}` : "boundaries hidden"}</summary>
      <div className="mt-1 flex max-h-20 flex-wrap gap-x-3 gap-y-1 overflow-y-auto" aria-label="Node color legend">
        {colors.map(color => <span key={color} className="inline-flex items-center gap-1"><i className="h-2 w-2 rounded-full" style={{ background: colorOf(color) }} />{color}</span>)}
        {colors.length > SERIES_COLORS.length && <span>Additional node colors use gray; hover for identity.</span>}
        {showRegions && boundaries.map(b => <span key={`region:${b.id}`} className="inline-flex items-center gap-1"><i className="h-2 w-3 rounded-sm border" style={{ background: `${regionColor(b.id)}30`, borderColor: regionColor(b.id) }} />Region: {b.label} ({b.count})</span>)}
        {edgeTypes.map(type => <span key={`edge:${type}`} className="inline-flex items-center gap-1"><i className="h-0.5 w-3" style={{ background: edgeColor(type) }} />Edge: {type}</span>)}
        <span>{comparison && "Synthetic comparison only; no real product specifications. Shared nodes have one ID and list their domain memberships on selection. Community regions are exclusive primary assignments (including Shared foundations), not overlapping memberships. Dashboard market filters include shared memberships; community filters use primary assignment. Other panels retain their original demo data. "}{layoutMode === "topology" ? "Connection layout uses weighted springs across all communities, without group anchors. Regions can overlap spatially or enclose unrelated nodes: shading is an envelope, not membership. " : "Separated groups intentionally use group anchors; cross-links have limited influence. "}Coordinates and boundary area are layout only, not knowledge scores. {dimension === "3d" && "3D positions, depth and envelopes are layout-generated; they do not encode evidence strength. Labels remain screen-facing and are collision-limited. "}Node size: {panel.mapping.nodeSize ?? "size"} · {dimension === "3d" ? "edge weight (inspect)" : "edge width"}: {panel.mapping.edgeWeight ?? "weight"} · dashed: {edgeStates.join(", ") || "no edge states"}. Regions enclose visible members of {regionSource}; they are not inferred topics. Edge types use color when selected.</span>
      </div>
    </details>
  </div>;
}
