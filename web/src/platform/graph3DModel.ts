import { topologyLayout, type LayoutMode } from "./topologyLayout.ts";
import type { GraphGrouping, GraphNode, GraphModel } from './graphModel';

export interface Point3D { x: number; y: number; z: number }
export interface Envelope3D { id: string; label: string; members: string[]; center: Point3D; radius: number }
const distance = (a: Point3D, b: Point3D) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Deterministic, packed 3D groups. Coordinates encode layout only, never evidence/weight. */
export function layoutGraph3D(grouping: GraphGrouping, nodeScale = 1, model?: GraphModel, layoutMode: LayoutMode = "grouped"): Map<string, Point3D> {
  if (model && layoutMode === "topology") return topologyLayout(model, 3, nodeScale);
  const points = new Map<string, Point3D>();
  const widths = grouping.groups.map(g => 22 + Math.cbrt(g.nodes.length) * 18 * nodeScale);
  const spacing = Math.max(70, ...widths.map(r => r * 2 + 36));
  const columns = Math.max(1, Math.ceil(Math.sqrt(grouping.groups.length)));
  const rows = Math.ceil(grouping.groups.length / columns);
  grouping.groups.forEach((group, index) => {
    const center = { x: (index % columns - (columns - 1) / 2) * spacing, y: (Math.floor(index / columns) - (rows - 1) / 2) * spacing, z: (index % 2 ? 1 : -1) * spacing * 0.22 };
    group.nodes.forEach((node, i) => {
      const n = group.nodes.length;
      const y = n === 1 ? 0 : 1 - 2 * (i + 0.5) / n, angle = i * Math.PI * (3 - Math.sqrt(5));
      const ring = Math.sqrt(1 - y * y), r = n === 1 ? 0 : widths[index] * (0.65 + 0.35 * ((i * 13 % n) / Math.max(1, n - 1)));
      points.set(node.id, { x: center.x + r * ring * Math.cos(angle), y: center.y + r * y, z: center.z + r * ring * Math.sin(angle) });
    });
  });
  return points;
}

/** A sphere encloses only the supplied group's visible members, including singleton groups. */
export function envelopes3D(grouping: GraphGrouping, visible: Set<string>, points: Map<string, Point3D>, padding = 14): Envelope3D[] {
  return grouping.groups.flatMap(group => {
    const members = group.nodes.filter(n => visible.has(n.id) && points.has(n.id)).map(n => n.id);
    if (!members.length) return [];
    const positions = members.map(id => points.get(id)!);
    const center = { x: 0, y: 0, z: 0 };
    for (const p of positions) { center.x += p.x / positions.length; center.y += p.y / positions.length; center.z += p.z / positions.length; }
    return [{ id: group.id, label: group.label, members, center, radius: Math.max(0, ...positions.map(p => distance(p, center))) + padding }];
  });
}

export function cameraFit3D(points: Point3D[], aspect = 1, fov = 45, padding = 22) {
  if (!points.length) return { center: { x: 0, y: 0, z: 0 }, distance: 300, radius: 100 };
  const center = { x: 0, y: 0, z: 0 };
  for (const axis of ['x', 'y', 'z'] as const) center[axis] = (Math.min(...points.map(p => p[axis])) + Math.max(...points.map(p => p[axis]))) / 2;
  const radius = Math.max(1, ...points.map(p => distance(p, center))) + padding;
  const halfVertical = fov * Math.PI / 360, halfHorizontal = Math.atan(Math.tan(halfVertical) * Math.max(0.05, aspect));
  return { center, radius, distance: radius / Math.sin(Math.min(halfVertical, halfHorizontal)) * 1.08 };
}

export function orderedFocusNodes(nodes: GraphNode[], selected: string | null, hover: string | null) {
  return [...nodes].sort((a, b) => Number(b.id === selected || b.id === hover) - Number(a.id === selected || a.id === hover));
}
