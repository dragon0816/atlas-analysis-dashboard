import type { GraphDataset, Row } from "./types";

export interface GraphNode { id: string; label: string; group: string; type: string; community: string; color: string; size: number; row: Row }
export interface GraphEdge { id: string; source: string; target: string; type: string; state: string; weight: number; row: Row }
export interface GraphModel { nodes: GraphNode[]; edges: GraphEdge[]; warnings: string[] }
export interface GraphPoint { x: number; y: number }
export interface GraphFilters { nodeType?: string; edgeType?: string; community?: string }
export const GRAPH_DEFAULT_MAPPING = {
  nodeId: "id", nodeLabel: "label", nodeGroup: "group", nodeSize: "size", nodeColor: "group",
  edgeSource: "source", edgeTarget: "target", edgeType: "type", edgeWeight: "weight", edgeState: "state",
};
const finite = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const identifier = (value: unknown): string | null => (typeof value === "string" && value.length > 0) || (typeof value === "number" && Number.isFinite(value)) ? String(value) : null;
const label = (value: unknown, fallback: string) => value == null ? fallback : String(value);

/** Validate identity and bound the render graph before allocating simulation state. */
export function buildGraphModel(dataset: GraphDataset, mapping: Record<string, string> = {}, display: Row = {}): GraphModel {
  const map = { ...GRAPH_DEFAULT_MAPPING, ...Object.fromEntries(Object.entries(mapping).filter(([, value]) => value.trim())) };
  const nodeLimit = Math.max(1, Math.min(1000, Math.floor(finite(display.maxNodes, 350))));
  const edgeLimit = Math.max(0, Math.min(3000, Math.floor(finite(display.maxEdges, 1200))));
  const nodes: GraphNode[] = [], edges: GraphEdge[] = [], warnings: string[] = [];
  const allIds = new Set<string>(), renderedIds = new Set<string>();
  let invalid = 0, duplicate = 0, cappedNodes = 0, dangling = 0, cappedEdges = 0;
  for (const row of dataset.nodes) {
    const id = identifier(row[map.nodeId]);
    if (id === null) { invalid++; continue; }
    if (allIds.has(id)) { duplicate++; continue; }
    allIds.add(id);
    if (nodes.length >= nodeLimit) { cappedNodes++; continue; }
    renderedIds.add(id);
    const group = label(row[map.nodeGroup], "Ungrouped");
    nodes.push({ id, label: label(row[map.nodeLabel], id), group,
      type: label(row[mapping.nodeType ?? "type"], group), community: label(row[mapping.nodeCommunity ?? "community"], "Unassigned"),
      color: label(row[map.nodeColor], group), size: Math.max(0, finite(row[map.nodeSize], 1)), row });
  }
  const edgeIds = new Set<string>();
  for (const [index, row] of dataset.edges.entries()) {
    const source = identifier(row[map.edgeSource]), target = identifier(row[map.edgeTarget]);
    if (source === null || target === null || !allIds.has(source) || !allIds.has(target)) { dangling++; continue; }
    if (!renderedIds.has(source) || !renderedIds.has(target) || edges.length >= edgeLimit) { cappedEdges++; continue; }
    const rawId = identifier(row[mapping.edgeId ?? "id"]) ?? `edge:${index}`;
    let id = rawId;
    while (edgeIds.has(id)) id = `${id}:${index}`;
    edgeIds.add(id);
    edges.push({ id, source, target, type: label(row[map.edgeType], "Related"), state: label(row[map.edgeState], ""), weight: Math.max(0, finite(row[map.edgeWeight], 1)), row });
  }
  if (invalid) warnings.push(`${invalid} nodes without a valid ID were omitted.`);
  if (duplicate) warnings.push(`${duplicate} duplicate node IDs were omitted; the first node wins.`);
  if (dangling) warnings.push(`${dangling} dangling or invalid edges were omitted.`);
  if (cappedNodes || cappedEdges) warnings.push(`Render limit: showing ${nodes.length}/${allIds.size} nodes and ${edges.length}/${dataset.edges.length} edges (limits ${nodeLimit}/${edgeLimit}). Narrow the query to see omitted data.`);
  if (nodes.length > 200) warnings.push("Large graph: sampled repulsion and fewer simulation steps keep interaction responsive; labels are initially hidden.");
  return { nodes, edges, warnings };
}

export function filterGraph(model: GraphModel, filters: GraphFilters): GraphModel {
  const nodes = model.nodes.filter(node => (!filters.nodeType || node.type === filters.nodeType) && (!filters.community || node.community === filters.community));
  const ids = new Set(nodes.map(node => node.id));
  return { nodes, edges: model.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target) && (!filters.edgeType || edge.type === filters.edgeType)), warnings: model.warnings };
}

/** Deterministic, bounded spring layout. Large graphs sample repulsion rather than allocate an N² matrix. */
export function forceLayout(model: GraphModel, width = 720, height = 440): Map<string, GraphPoint> {
  const count = model.nodes.length;
  const points = model.nodes.map((_, i) => {
    const angle = i * Math.PI * (3 - Math.sqrt(5));
    const radius = Math.sqrt((i + 0.5) / Math.max(1, count)) * Math.min(width, height) * 0.39;
    return { x: width / 2 + Math.cos(angle) * radius, y: height / 2 + Math.sin(angle) * radius, vx: 0, vy: 0 };
  });
  const index = new Map(model.nodes.map((node, i) => [node.id, i]));
  const links = model.edges.map(edge => ({ a: index.get(edge.source)!, b: index.get(edge.target)!, weight: Math.min(3, Math.sqrt(edge.weight || 0.25)) }));
  const stride = Math.max(1, Math.ceil(count / 180)), steps = count > 200 ? 45 : 85;
  for (let tick = 0; tick < steps; tick++) {
    const alpha = 1 - tick / steps;
    for (let i = 0; i < count; i++) {
      for (let j = i + 1 + (tick % stride); j < count; j += stride) {
        const a = points[i], b = points[j], dx = a.x - b.x, dy = a.y - b.y;
        const d2 = Math.max(25, dx * dx + dy * dy), force = Math.min(4, (750 * stride * alpha) / d2);
        a.vx += dx * force / Math.sqrt(d2); a.vy += dy * force / Math.sqrt(d2);
        b.vx -= dx * force / Math.sqrt(d2); b.vy -= dy * force / Math.sqrt(d2);
      }
    }
    for (const { a, b, weight } of links) {
      if (a === b) continue;
      const dx = points[b].x - points[a].x, dy = points[b].y - points[a].y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const force = (distance - 75) * 0.012 * weight * alpha;
      points[a].vx += dx / distance * force; points[a].vy += dy / distance * force;
      points[b].vx -= dx / distance * force; points[b].vy -= dy / distance * force;
    }
    for (const point of points) {
      point.vx = (point.vx + (width / 2 - point.x) * 0.006 * alpha) * 0.75;
      point.vy = (point.vy + (height / 2 - point.y) * 0.006 * alpha) * 0.75;
      point.x = Math.max(24, Math.min(width - 24, point.x + point.vx));
      point.y = Math.max(24, Math.min(height - 24, point.y + point.vy));
    }
  }
  return new Map(model.nodes.map((node, i) => [node.id, { x: points[i].x, y: points[i].y }]));
}

export function graphNeighborhood(model: GraphModel, id: string): Set<string> {
  const nodes = new Set([id]);
  for (const edge of model.edges) {
    if (edge.source === id) nodes.add(edge.target);
    if (edge.target === id) nodes.add(edge.source);
  }
  return nodes;
}

/** Paths follow adjacency in either direction, matching the undirected neighborhood view. */
export function shortestGraphPath(model: GraphModel, from: string, to: string): string[] {
  const adjacency = new Map(model.nodes.map(node => [node.id, [] as string[]]));
  if (!adjacency.has(from) || !adjacency.has(to)) return [];
  for (const edge of model.edges) { adjacency.get(edge.source)?.push(edge.target); adjacency.get(edge.target)?.push(edge.source); }
  const previous = new Map<string, string | null>([[from, null]]), queue = [from];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (id === to) {
      const path: string[] = []; let step: string | null = to;
      while (step !== null) { path.push(step); step = previous.get(step)!; }
      return path.reverse();
    }
    for (const next of adjacency.get(id) ?? []) if (!previous.has(next)) { previous.set(next, id); queue.push(next); }
  }
  return [];
}

export function graphPathEdges(model: GraphModel, path: readonly string[]): Set<string> {
  const pairs = new Set(path.slice(1).flatMap((id, i) => [JSON.stringify([path[i], id]), JSON.stringify([id, path[i]])]));
  return new Set(model.edges.filter(edge => pairs.has(JSON.stringify([edge.source, edge.target]))).map(edge => edge.id));
}
export function graphNodeValues(node: GraphNode): Row { return { ...node.row, id: node.id, label: node.label, group: node.group, type: node.type, community: node.community }; }
export function graphEdgeValues(edge: GraphEdge): Row { return { ...edge.row, id: edge.id, source: edge.source, target: edge.target, type: edge.type, state: edge.state, weight: edge.weight }; }
