import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { GraphModel, GraphNode, GraphEdge, GraphGrouping } from '../../platform/graphModel';
import { graphNodeRadius } from '../../platform/graphModel';
import { cameraFit3D, envelopes3D, layoutGraph3D, orderedFocusNodes, type Point3D } from '../../platform/graph3DModel';

export interface Graph3DOptions {
  model: GraphModel; visible: GraphModel; grouping: GraphGrouping;
  selected: string | null; neighborhood: boolean; neighbors: Set<string>; matches: Set<string>;
  pathNodes: Set<string>; pathEdges: Set<string>; labelMode: string; labelSize: number;
  layoutMode?: "topology" | "grouped"; nodeScale: number; showRegions: boolean; directed: boolean;
  colorOf: (category: string) => string; edgeColor: (type: string) => string; regionColor: (id: string) => string;
  onSelectNode: (node: GraphNode) => void; onSelectEdge: (edge: GraphEdge) => void;
  onHover: (value: { kind: 'node'; item: GraphNode } | { kind: 'edge'; item: GraphEdge } | null) => void;
}
export interface Graph3DController { update: (options: Graph3DOptions) => void; fit: () => void; zoom: (factor: number) => void; focus: (id: string) => void; dispose: () => void }

/** Three is isolated in this lazy chunk. Rendering is on demand: no idle animation loop. */
export function createGraph3D(host: HTMLDivElement, initial: Graph3DOptions, unavailable: () => void): Graph3DController {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x020617, 0);
  const canvas = renderer.domElement;
  canvas.tabIndex = 0; canvas.setAttribute('role', 'group'); canvas.setAttribute('aria-label', 'Interactive 3D network. Arrow keys rotate, Shift plus arrows pan, plus and minus zoom, F fits.');
  canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline-offset:-3px';
  const labels = document.createElement('div'); labels.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden'; labels.setAttribute('aria-hidden', 'true');
  host.append(canvas, labels);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false; controls.autoRotate = false; controls.minDistance = 15; controls.maxDistance = 30000;
  const raycaster = new THREE.Raycaster(); raycaster.params.Line = { threshold: 2 };
  let options = initial, points = layoutGraph3D(initial.grouping, initial.nodeScale, initial.model, initial.layoutMode), disposed = false, frame = 0;
  let hovered: { kind: 'node'; item: GraphNode } | { kind: 'edge'; item: GraphEdge } | null = null;
  let fittedDistance = 300, width = 1, height = 1;
  let root = new THREE.Group(); scene.add(root);
  const nodeMeshes = new Map<string, THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>>();
  const edgeObjects = new Map<string, THREE.Group>();
  const pickNodes: THREE.Object3D[] = [], pickEdges: THREE.Object3D[] = [];
  const vector = (p: Point3D) => new THREE.Vector3(p.x, p.y, p.z);
  const resources = new Set<{ dispose: () => void }>();
  function own<T extends { dispose: () => void }>(resource: T): T { resources.add(resource); return resource; }
  function releaseScene() { for (const resource of resources) resource.dispose(); resources.clear(); root.clear(); nodeMeshes.clear(); edgeObjects.clear(); pickNodes.length = 0; pickEdges.length = 0; }
  const position = (id: string) => vector(points.get(id)!);
  function schedule() { if (!disposed && !frame) frame = requestAnimationFrame(render); }
  function render() {
    frame = 0; if (disposed) return;
    try { renderer.render(scene, camera); renderLabels(); } catch { unavailable(); }
  }
  function renderLabels() {
    labels.replaceChildren();
    const boxes: { x: number; y: number; w: number; h: number }[] = [];
    const hId = hovered?.kind === 'node' ? hovered.item.id : null;
    const zoomed = camera.position.distanceTo(controls.target) < fittedDistance / 1.8;
    function addLabel(text: string, p: Point3D, color: string, focused: boolean, fontSize: number) {
      const world = vector(p), projected = world.clone().project(camera);
      if (world.clone().sub(camera.position).dot(camera.getWorldDirection(new THREE.Vector3())) <= 0 || projected.z < -1 || projected.z > 1) return;
      const x = (projected.x * 0.5 + 0.5) * width + 7, y = (-projected.y * 0.5 + 0.5) * height;
      const w = Math.min(width - 10, Math.min(text.length, 36) * fontSize * 0.62 + 8), h = fontSize + 5;
      const box = { x: Math.max(2, Math.min(width - w - 2, x)), y: Math.max(2, Math.min(height - h - 2, y)), w, h };
      if (x < -w || x > width + w || y < -h || y > height + h) return;
      if (!focused && (boxes.length >= (options.labelMode === 'all' ? 120 : 30) || boxes.some(b => box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y))) return;
      boxes.push(box);
      const el = document.createElement('span'); el.textContent = text.length > 36 ? `${text.slice(0, 35)}…` : text;
      el.style.cssText = `position:absolute;left:${box.x}px;top:${box.y}px;max-width:${w}px;font-size:${fontSize}px;line-height:${h}px;color:${color};background:rgba(2,6,23,.88);padding:0 3px;border-radius:3px;white-space:nowrap;overflow:hidden`;
      labels.append(el);
    }
    for (const node of orderedFocusNodes(options.visible.nodes, options.selected, hId)) {
      const focus = node.id === options.selected || node.id === hId;
      if (focus || options.matches.has(node.id) || options.labelMode === 'all' || options.labelMode === 'zoom' && zoomed) addLabel(node.label, points.get(node.id)!, '#f8fafc', focus, options.labelSize);
    }
    if (options.showRegions) for (const envelope of envelopes3D(options.grouping, new Set(options.visible.nodes.map(n => n.id)), points, 14 + 4 * options.nodeScale)) {
      addLabel(envelope.label, { ...envelope.center, y: envelope.center.y + envelope.radius }, options.regionColor(envelope.id), false, 11);
    }
  }
  function style() {
    const selectedVisible = options.visible.nodes.some(n => n.id === options.selected);
    const hId = hovered?.kind === 'node' ? hovered.item.id : null;
    for (const node of options.visible.nodes) {
      const mesh = nodeMeshes.get(node.id); if (!mesh) continue;
      const focus = node.id === options.selected || node.id === hId || options.matches.has(node.id) || options.pathNodes.has(node.id);
      const emphasized = focus || (options.pathNodes.size ? options.pathNodes.has(node.id) : selectedVisible && options.neighborhood ? options.neighbors.has(node.id) : true);
      mesh.material.opacity = emphasized ? 1 : 0.16;
      mesh.material.color.set(options.colorOf(node.color));
      const ring = mesh.children[0] as THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
      ring.visible = focus; ring.material.color.set(options.matches.has(node.id) ? '#facc15' : '#f8fafc');
    }
    for (const edge of options.visible.edges) {
      const active = hovered?.kind === 'edge' && hovered.item.id === edge.id, path = options.pathEdges.has(edge.id);
      const adjacent = edge.source === options.selected || edge.target === options.selected;
      const opacity = active ? 1 : options.pathNodes.size ? path ? 0.95 : 0.07 : selectedVisible && options.neighborhood ? adjacent ? 0.8 : 0.07 : 0.28;
      const color = active || path ? '#f8fafc' : selectedVisible && adjacent ? options.edgeColor(edge.type) : '#94a3b8';
      edgeObjects.get(edge.id)?.traverse(object => { const material = (object as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined; if (material && !Array.isArray(material)) { material.opacity = opacity; material.color.set(color); } });
    }
    schedule();
  }
  function rebuild() {
    releaseScene();
    const max = Math.max(1, ...options.model.nodes.map(n => n.size));
    const sphere = own(new THREE.SphereGeometry(1, 12, 8));
    for (const node of options.visible.nodes) {
      // Per-node geometry keeps a real world-space size without object-scale selection destroying it.
      const geometry = own(sphere.clone()); geometry.scale(graphNodeRadius(node, max, options.nodeScale), graphNodeRadius(node, max, options.nodeScale), graphNodeRadius(node, max, options.nodeScale));
      const mesh = new THREE.Mesh(geometry, own(new THREE.MeshBasicMaterial({ color: options.colorOf(node.color), transparent: true })));
      const outline = new THREE.Mesh(geometry, own(new THREE.MeshBasicMaterial({ color: '#f8fafc', wireframe: true, transparent: true, opacity: 0.8 }))); outline.scale.setScalar(1.5); mesh.add(outline);
      mesh.position.copy(position(node.id)); mesh.userData.node = node; root.add(mesh); nodeMeshes.set(node.id, mesh); pickNodes.push(mesh);
    }
    for (const edge of options.visible.edges) {
      const a = position(edge.source), b = position(edge.target), group = new THREE.Group();
      let vertices: THREE.Vector3[];
      if (edge.source === edge.target) vertices = Array.from({ length: 33 }, (_, i) => { const angle = i / 32 * Math.PI * 2; return a.clone().add(new THREE.Vector3(14 * Math.cos(angle), 14 + 14 * Math.sin(angle), 0)); });
      else vertices = [a, b];
      const material = edge.state ? new THREE.LineDashedMaterial({ color: '#94a3b8', transparent: true, dashSize: 5, gapSize: 3 }) : new THREE.LineBasicMaterial({ color: '#94a3b8', transparent: true });
      const line = new THREE.Line(own(new THREE.BufferGeometry().setFromPoints(vertices)), own(material)); line.computeLineDistances(); line.userData.edge = edge; group.add(line); pickEdges.push(line);
      if (options.directed && edge.source !== edge.target) {
        const direction = b.clone().sub(a).normalize(), target = options.visible.nodes.find(n => n.id === edge.target)!;
        const cone = new THREE.Mesh(own(new THREE.ConeGeometry(2, 6, 6)), own(new THREE.MeshBasicMaterial({ color: '#94a3b8', transparent: true })));
        cone.position.copy(b.clone().addScaledVector(direction, -graphNodeRadius(target, max, options.nodeScale) - 4));
        cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction); group.add(cone);
      }
      root.add(group); edgeObjects.set(edge.id, group);
    }
    if (options.showRegions) {
      const envelopes = envelopes3D(options.grouping, new Set(options.visible.nodes.map(n => n.id)), points, 14 + 4 * options.nodeScale);
      const regionSphere = own(new THREE.SphereGeometry(1, 20, 14));
      for (const envelope of envelopes) {
        const region = new THREE.Mesh(regionSphere, own(new THREE.MeshBasicMaterial({ color: options.regionColor(envelope.id), transparent: true, opacity: 0.085, depthWrite: false, side: THREE.FrontSide })));
        region.position.copy(vector(envelope.center)); region.scale.setScalar(envelope.radius); region.userData.members = envelope.members; root.add(region);
        const wire = new THREE.LineSegments(own(new THREE.WireframeGeometry(own(new THREE.SphereGeometry(envelope.radius, 12, 6)))), own(new THREE.LineBasicMaterial({ color: options.regionColor(envelope.id), transparent: true, opacity: 0.12, depthWrite: false })));
        wire.position.copy(region.position); root.add(wire);
      }
    }
    style();
  }
  function fit() {
    const all = options.visible.nodes.map(n => points.get(n.id)!);
    if (options.showRegions) for (const e of envelopes3D(options.grouping, new Set(options.visible.nodes.map(n => n.id)), points, 14 + 4 * options.nodeScale)) {
      for (const axis of ['x', 'y', 'z'] as const) for (const direction of [-1, 1]) all.push({ ...e.center, [axis]: e.center[axis] + e.radius * direction });
    }
    const fit = cameraFit3D(all, width / height); fittedDistance = fit.distance;
    controls.target.copy(vector(fit.center)); camera.position.copy(controls.target).add(new THREE.Vector3(0.22, 0.15, 1).normalize().multiplyScalar(fit.distance)); camera.near = Math.max(0.1, fit.distance / 10000); camera.far = Math.max(100000, fit.distance * 10); camera.updateProjectionMatrix(); controls.update(); schedule();
  }
  function zoom(factor: number) { const offset = camera.position.clone().sub(controls.target); offset.setLength(Math.max(controls.minDistance, Math.min(controls.maxDistance, offset.length() / factor))); camera.position.copy(controls.target).add(offset); controls.update(); schedule(); }
  function focus(id: string) { const p = points.get(id); if (!p) return; const offset = camera.position.clone().sub(controls.target); controls.target.copy(vector(p)); camera.position.copy(controls.target).add(offset); controls.update(); schedule(); }
  function resize() { if (disposed) return; width = Math.max(1, host.clientWidth); height = Math.max(1, host.clientHeight); camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height, false); schedule(); }
  function hit(event: PointerEvent) {
    const rect = canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return null;
    raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
    const node = raycaster.intersectObjects(pickNodes, false)[0]?.object.userData.node as GraphNode | undefined;
    if (node) return { kind: 'node' as const, item: node };
    const edge = raycaster.intersectObjects(pickEdges, false)[0]?.object.userData.edge as GraphEdge | undefined;
    return edge ? { kind: 'edge' as const, item: edge } : null;
  }
  let down: { x: number; y: number; id: number } | null = null;
  function move(event: PointerEvent) { if (down) return; const next = hit(event); if (next?.kind !== hovered?.kind || next?.item.id !== hovered?.item.id) { hovered = next; options.onHover(next); style(); } canvas.style.cursor = next ? 'pointer' : 'grab'; }
  function pointerDown(event: PointerEvent) { if (event.button === 0) down = { x: event.clientX, y: event.clientY, id: event.pointerId }; }
  function pointerUp(event: PointerEvent) { if (down?.id === event.pointerId && Math.hypot(event.clientX - down.x, event.clientY - down.y) < 4) { const selected = hit(event); if (selected?.kind === 'node') options.onSelectNode(selected.item); else if (selected?.kind === 'edge') options.onSelectEdge(selected.item); } down = null; }
  function cancel() { down = null; }
  function leave() { hovered = null; options.onHover(null); style(); }
  function key(event: KeyboardEvent) {
    if (event.key === '+' || event.key === '=') zoom(1.3);
    else if (event.key === '-') zoom(1 / 1.3);
    else if (event.key.toLowerCase() === 'f') fit();
    else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      const dx = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0, dy = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0;
      if (event.shiftKey) { const distance = camera.position.distanceTo(controls.target) * 0.04; const shift = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0).multiplyScalar(dx * distance).add(new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1).multiplyScalar(dy * distance)); camera.position.add(shift); controls.target.add(shift); }
      else { const spherical = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target)); spherical.theta += dx * 0.12; spherical.phi = Math.max(0.03, Math.min(Math.PI - 0.03, spherical.phi - dy * 0.12)); camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical)); }
      controls.update(); schedule();
    } else return;
    event.preventDefault(); event.stopPropagation();
  }
  function contextLost(event: Event) { event.preventDefault(); if (!disposed) unavailable(); }
  const listeners: [string, EventListener][] = [['pointermove', move as EventListener], ['pointerdown', pointerDown as EventListener], ['pointerup', pointerUp as EventListener], ['pointercancel', cancel], ['pointerleave', leave], ['keydown', key as EventListener], ['webglcontextlost', contextLost]];
  for (const [name, listener] of listeners) canvas.addEventListener(name, listener);
  controls.addEventListener('change', schedule);
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize); observer?.observe(host);
  window.addEventListener('resize', resize);
  function dispose() {
    if (disposed) return; disposed = true; if (frame) cancelAnimationFrame(frame); frame = 0;
    observer?.disconnect(); window.removeEventListener('resize', resize);
    for (const [name, listener] of listeners) canvas.removeEventListener(name, listener);
    controls.removeEventListener('change', schedule); controls.dispose(); releaseScene(); scene.clear(); renderer.dispose(); renderer.forceContextLoss(); canvas.remove(); labels.remove();
  }
  try { resize(); rebuild(); fit(); } catch (error) { dispose(); throw error; }
  return { fit, zoom, focus, dispose, update(next) {
    if (disposed) return;
    const changedLayout = options.grouping !== next.grouping || options.nodeScale !== next.nodeScale || options.model !== next.model || options.layoutMode !== next.layoutMode;
    const changedGraph = changedLayout || options.visible !== next.visible || options.showRegions !== next.showRegions || options.directed !== next.directed || options.model !== next.model;
    options = next;
    if (changedLayout) points = layoutGraph3D(options.grouping, options.nodeScale, options.model, options.layoutMode);
    if (hovered && !(hovered.kind === 'node' ? options.visible.nodes : options.visible.edges).some(item => item.id === hovered!.item.id)) { hovered = null; options.onHover(null); }
    if (changedGraph) { rebuild(); if (changedLayout) fit(); } else style();
  } };
}
