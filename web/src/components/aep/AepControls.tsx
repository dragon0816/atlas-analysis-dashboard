import { useEffect, useRef, useState } from 'react';
import type { AepProvider } from '../../platform/aep/provider';
export function AepControls({ provider, refresh, setTimeRange }: { provider: AepProvider; refresh: () => void; setTimeRange: (range: string) => void }) {
  const [live, setLive] = useState(false), [offline, setOffline] = useState(false), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, [provider]);
  return <section className="atlas-source-bar" aria-label="AEP telemetry controls">
    <span className="text-xs text-slate-400">{offline ? 'Offline replay' : 'Local AEP · last 24 hours unless a time range is set'}</span>
    <label className="text-xs">Recent window <select className="atlas-control" defaultValue="" disabled={offline || busy} onChange={event => {
      if (!event.target.value) return;
      provider.setLive(false); setLive(false); provider.useServer();
      setTimeRange(`${new Date(Date.now() - Number(event.target.value) * 60000).toISOString()}/`); refresh();
      setMessage('Window changed. Enable Live after history loads.');
    }}><option value="" disabled>Choose…</option><option value="15">15 minutes</option><option value="60">1 hour</option><option value="1440">24 hours</option></select></label>
    <label className="atlas-button">Import JSONL<input className="max-w-48" type="file" accept=".jsonl,.ndjson" disabled={busy} onChange={async event => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (!file) return;
      const current = ++generation.current; setBusy(true);
      try { if (file.size > 8 * 1024 * 1024) throw new Error('File exceeds 8 MiB'); const text = await file.text(); if (current !== generation.current) return; const result = provider.importJSONL(text); setOffline(true); setLive(false); setMessage(`Imported ${result.events} events. ${result.warnings.join('; ')}`); refresh(); }
      catch (ex) { if (current === generation.current) setMessage(String(ex)); }
      finally { if (current === generation.current) setBusy(false); }
    }} /></label>
    <button className="atlas-button" disabled={busy} onClick={() => { provider.useServer(); setOffline(false); setLive(false); setMessage('Loading AEP history…'); refresh(); }}>Reload AEP</button>
    <label className="text-xs"><input type="checkbox" checked={live} disabled={offline || busy} onChange={event => { setLive(event.target.checked); provider.setLive(event.target.checked); }} /> Live updates</label>
    {message && <p role="status" className="max-w-full text-xs text-slate-400">{message}</p>}
  </section>;
}
