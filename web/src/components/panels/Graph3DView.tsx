import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { Graph3DOptions, Graph3DController } from './graph3DRenderer';

export type Graph3DHandle = Pick<Graph3DController, 'fit' | 'zoom' | 'focus'>;
export function Graph3DView({ options, api, onUnavailable }: { options: Graph3DOptions; api: MutableRefObject<Graph3DHandle | null>; onUnavailable: (message: string) => void }) {
  const host = useRef<HTMLDivElement>(null), controller = useRef<Graph3DController | null>(null);
  const latest = useRef({ options, onUnavailable }); latest.current = { options, onUnavailable };
  const [ready, setReady] = useState(false), [edgeSelection, setEdgeSelection] = useState("");
  useEffect(() => {
    let cancelled = false;
    // No renderer or Three.js bytes are loaded until the user chooses 3D.
    import('./graph3DRenderer').then(({ createGraph3D }) => {
      if (cancelled || !host.current) return;
      const instance = createGraph3D(host.current, latest.current.options, () => latest.current.onUnavailable('3D graphics became unavailable. Returned to 2D.'));
      controller.current = instance; api.current = instance; setReady(true);
    }).catch(() => { if (!cancelled) latest.current.onUnavailable('3D could not start. It needs WebGL 2 and its graphics files to load. Returned to 2D; you can try again.'); });
    return () => { cancelled = true; controller.current?.dispose(); controller.current = null; api.current = null; };
  }, [api]);
  useEffect(() => { controller.current?.update(options); }, [options]);
  return <div className="absolute inset-0" data-graph-dimension="3d">
    <div ref={host} className="absolute inset-0" />
    {!ready && <p className="absolute inset-x-0 top-4 text-center text-xs text-slate-400" role="status">Loading 3D…</p>}
    <details className="absolute bottom-2 right-2 max-w-[65%] rounded border border-slate-700 bg-slate-950/95 px-2 py-1 text-xs text-slate-300">
      <summary className="cursor-pointer">Keyboard / accessible graph</summary>
      <p className="my-1">Focus canvas: arrows rotate, Shift+arrows pan, +/− zoom, F fits. Drag rotates; right-drag pans; pinch zooms.</p>
      <label className="block">Select node<select aria-label="3D accessible node selection" className="ml-1 max-w-40 bg-slate-900" value={options.selected ?? ''} onChange={e => { const n = options.visible.nodes.find(n => n.id === e.target.value); if (n) { options.onSelectNode(n); api.current?.focus(n.id); } }}><option value="">Choose…</option>{options.visible.nodes.map(n => <option key={n.id} value={n.id}>{n.label}</option>)}</select></label>
      <label className="block">Select edge<select aria-label="3D accessible edge selection" className="ml-1 max-w-40 bg-slate-900" value={options.visible.edges.some(e => e.id === edgeSelection) ? edgeSelection : ""} onChange={e => { setEdgeSelection(e.target.value); const edge = options.visible.edges.find(edge => edge.id === e.target.value); if (edge) options.onSelectEdge(edge); }}><option value="">Choose…</option>{options.visible.edges.map(e => <option key={e.id} value={e.id}>{e.source} → {e.target}: {e.type}{e.state ? ` (${e.state})` : ''}</option>)}</select></label>
    </details>
  </div>;
}
