import { topologyLayout, type LayoutMode } from "./topologyLayout.ts";
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

export type GraphGroupingMode = "auto" | "community" | "group" | "components";
export interface GraphGrouping { source: Exclude<GraphGroupingMode, "auto">; groups: { id: string; label: string; nodes: GraphNode[] }[]; membership: Map<string, string> }

/** Regions represent supplied field values or undirected connected components, never inferred topics. */
export function groupGraph(model: GraphModel, mode: GraphGroupingMode = "auto"): GraphGrouping {
  const source = mode === "auto" ? model.nodes.some(n => n.community !== "Unassigned" && n.community.trim()) ? "community" : model.nodes.some(n => n.group !== "Ungrouped" && n.group.trim()) ? "group" : "components" : mode;
  const membership = new Map<string, string>();
  const sorted = [...model.nodes].sort((a, b) => a.id.localeCompare(b.id));
  if (source === "components") {
    const adjacent = new Map(sorted.map(n => [n.id, [] as string[]]));
    for (const edge of model.edges) { adjacent.get(edge.source)?.push(edge.target); adjacent.get(edge.target)?.push(edge.source); }
    for (const node of sorted) if (!membership.has(node.id)) {
      const id = `component:${node.id}`, queue = [node.id]; membership.set(node.id, id);
      for (let i = 0; i < queue.length; i++) for (const next of adjacent.get(queue[i]) ?? []) if (!membership.has(next)) { membership.set(next, id); queue.push(next); }
    }
  } else for (const node of sorted) membership.set(node.id, node[source]);
  const buckets = new Map<string, GraphNode[]>();
  for (const node of sorted) { const key = membership.get(node.id)!; if (!buckets.has(key)) buckets.set(key, []); buckets.get(key)!.push(node); }
  const groups = [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([id, nodes], i) => ({ id, label: source === "components" ? nodes.length === 1 ? `Isolated: ${nodes[0].label}` : `Component ${i + 1}` : id, nodes }));
  return { source, groups, membership };
}

export function graphNodeRadius(node: GraphNode, maxSize: number, scale = 1): number {
  return (2 + 2 * Math.sqrt(node.size / Math.max(1, maxSize))) * Math.max(0.5, Math.min(2, scale));
}

/** Packed group anchors, local springs and sampled repulsion. Positions are deterministic and never clamped into a viewport-edge pile. */
export function forceLayout(model: GraphModel, width = 720, height = 440, mode: GraphGroupingMode = "auto", nodeScale = 1, layoutMode: LayoutMode = "grouped"): Map<string, GraphPoint> {
  if (!model.nodes.length) return new Map();
  if (layoutMode === "topology") {
    const points = topologyLayout(model, 2, nodeScale), values = [...points.values()];
    const x0 = Math.min(...values.map(p => p.x)), x1 = Math.max(...values.map(p => p.x)), y0 = Math.min(...values.map(p => p.y)), y1 = Math.max(...values.map(p => p.y));
    const scale = Math.min((width - 110) / Math.max(100, x1 - x0), (height - 110) / Math.max(100, y1 - y0));
    return new Map([...points].map(([id,p]) => [id, {x: width / 2 + (p.x - (x0 + x1) / 2) * scale, y: height / 2 + (p.y - (y0 + y1) / 2) * scale}]));
  }
  const grouping = groupGraph(model, mode), count = model.nodes.length;
  const ordered = [...grouping.groups].sort((a, b) => b.nodes.length - a.nodes.length || a.id.localeCompare(b.id));
  const spacing = 15;
  const groupGap = 28 + Math.max(0, nodeScale - 1) * 95;
  const disks = ordered.map(group => ({ group, r: Math.max(24, Math.sqrt(group.nodes.length) * spacing + 16) }));
  const rowWidth = Math.max(...disks.map(d => d.r * 2), Math.sqrt(disks.reduce((sum, d) => sum + (d.r * 2 + groupGap + 2) ** 2, 0) * width / height));
  const anchors = new Map<string, GraphPoint & { r: number }>();
  let x = 0, y = 0, rowHeight = 0;
  for (const { group, r } of disks) {
    if (x && x + 2 * r > rowWidth) { x = 0; y += rowHeight + groupGap; rowHeight = 0; }
    anchors.set(group.id, { x: x + r, y: y + r, r }); x += 2 * r + groupGap; rowHeight = Math.max(rowHeight, 2 * r);
  }
  const initial = new Map<string, GraphPoint>();
  for (const group of grouping.groups) {
    const anchor = anchors.get(group.id)!;
    group.nodes.forEach((node, i) => {
      const angle = i * Math.PI * (3 - Math.sqrt(5)), r = group.nodes.length === 1 ? 0 : Math.sqrt((i + 0.5) / group.nodes.length) * (anchor.r - 18);
      initial.set(node.id, { x: anchor.x + Math.cos(angle) * r, y: anchor.y + Math.sin(angle) * r });
    });
  }
  const nodes = [...model.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const points = nodes.map(node => ({ ...initial.get(node.id)!, vx: 0, vy: 0, anchor: anchors.get(grouping.membership.get(node.id)!)! }));
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const links = [...model.edges].sort((a, b) => a.id.localeCompare(b.id)).map(edge => ({ a: index.get(edge.source)!, b: index.get(edge.target)!, weight: Math.min(2, Math.sqrt(edge.weight || 0.25)) }));
  const stride = Math.max(1, Math.ceil(count / 180)), steps = count > 200 ? 55 : 100;
  for (let tick = 0; tick < steps; tick++) {
    const alpha = 1 - tick / steps;
    for (let i = 0; i < count; i++) for (let j = i + 1 + tick % stride; j < count; j += stride) {
      const a = points[i], b = points[j], dx = a.x - b.x || 0.01, dy = a.y - b.y || 0.01;
      const d2 = Math.max(16, dx * dx + dy * dy), distance = Math.sqrt(d2);
      const force = Math.min(5, 450 * stride * alpha / d2);
      a.vx += dx / distance * force; a.vy += dy / distance * force;
      b.vx -= dx / distance * force; b.vy -= dy / distance * force;
    }
    for (const { a, b, weight } of links) {
      if (a === b) continue;
      const pa = points[a], pb = points[b], dx = pb.x - pa.x, dy = pb.y - pa.y, distance = Math.max(1, Math.hypot(dx, dy));
      const same = pa.anchor === pb.anchor;
      const force = (distance - (same ? 34 : 140)) * (same ? 0.015 : 0.0007) * weight * alpha;
      pa.vx += dx / distance * force; pa.vy += dy / distance * force; pb.vx -= dx / distance * force; pb.vy -= dy / distance * force;
    }
    for (const p of points) {
      p.vx = (p.vx + (p.anchor.x - p.x) * 0.01 * alpha) * 0.72;
      p.vy = (p.vy + (p.anchor.y - p.y) * 0.01 * alpha) * 0.72;
      p.x += p.vx; p.y += p.vy;
      const dx = p.x - p.anchor.x, dy = p.y - p.anchor.y, distance = Math.hypot(dx, dy), limit = p.anchor.r - 16;
      if (distance > limit) { p.x = p.anchor.x + dx / distance * limit; p.y = p.anchor.y + dy / distance * limit; }
    }
  }
  // Uniform normalization leaves room for shaded hulls; collision relaxation uses a spatial grid.
  const minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x));
  const minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y));
  const scale = Math.min((width - 110) / Math.max(100, maxX - minX), (height - 110) / Math.max(100, maxY - minY));
  for (const p of points) { p.x = width / 2 + (p.x - (minX + maxX) / 2) * scale; p.y = height / 2 + (p.y - (minY + maxY) / 2) * scale; }
  const maxSize = Math.max(1, ...nodes.map(n => n.size)), radii = nodes.map(n => graphNodeRadius(n, maxSize, nodeScale));
  for (let pass = 0; pass < 10; pass++) {
    const grid = new Map<string, number[]>(), cell = 30;
    for (let i = 0; i < points.length; i++) {
      const a = points[i], gx = Math.floor(a.x / cell), gy = Math.floor(a.y / cell);
      for (let xx = gx - 1; xx <= gx + 1; xx++) for (let yy = gy - 1; yy <= gy + 1; yy++) for (const j of grid.get(`${xx}:${yy}`) ?? []) {
        const b = points[j], dx = a.x - b.x || 0.01, dy = a.y - b.y || 0.01, distance = Math.max(0.01, Math.hypot(dx, dy)), minimum = radii[i] + radii[j] + 5;
        if (distance < minimum) { const move = (minimum - distance) * 0.5; a.x += dx / distance * move; a.y += dy / distance * move; b.x -= dx / distance * move; b.y -= dy / distance * move; }
      }
      const key = `${gx}:${gy}`; if (!grid.has(key)) grid.set(key, []); grid.get(key)!.push(i);
    }
  }
  return new Map(nodes.map((node, i) => [node.id, { x: points[i].x, y: points[i].y }]));
}

export interface GraphBoundary { id: string; label: string; count: number; path: string; x: number; y: number; bounds: { x0: number; y0: number; x1: number; y1: number } }
/** Padded convex envelopes handle singleton, paired, collinear and dragged nodes uniformly. */
export function graphBoundaries(grouping: GraphGrouping, visibleIds: Set<string>, point: (id: string) => GraphPoint, padding = 23): GraphBoundary[] {
  return grouping.groups.flatMap(group => {
    const members = group.nodes.filter(node => visibleIds.has(node.id)).map(node => point(node.id)).filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
    if (!members.length) return [];
    const cloud = members.flatMap(p => Array.from({ length: 12 }, (_, i) => ({ x: p.x + Math.cos(i * Math.PI / 6) * padding, y: p.y + Math.sin(i * Math.PI / 6) * padding })));
    cloud.sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (a: GraphPoint, b: GraphPoint, c: GraphPoint) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const half = (values: GraphPoint[]) => { const hull: GraphPoint[] = []; for (const p of values) { while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop(); hull.push(p); } return hull; };
    const lower = half(cloud), upper = half([...cloud].reverse());
    const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
    const mid = (a: GraphPoint, b: GraphPoint) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const first = mid(hull[hull.length - 1], hull[0]);
    const path = `M${first.x},${first.y} ` + hull.map((p, i) => { const end = mid(p, hull[(i + 1) % hull.length]); return `Q${p.x},${p.y} ${end.x},${end.y}`; }).join(" ") + " Z";
    const bounds = { x0: cloud[0].x, x1: cloud[cloud.length - 1].x, y0: Math.min(...cloud.map(p => p.y)), y1: Math.max(...cloud.map(p => p.y)) };
    return [{ id: group.id, label: group.label, count: members.length, path, x: (bounds.x0 + bounds.x1) / 2, y: bounds.y0 + 12, bounds }];
  });
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
