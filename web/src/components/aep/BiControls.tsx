import { useEffect, useRef, useState } from 'react';
import type { AepBiProvider, BiCatalog, BiVault } from '../../platform/aep/bi';
import { biDashboard, parameterId } from '../../platform/aep/biDashboard';
import type { DashboardDocument, VariableValues } from '../../platform/types';

export function BiControls({ provider, board, values, disabled, onBoard, onValue }: { provider: AepBiProvider; board: DashboardDocument; values: VariableValues; disabled: boolean; onBoard: (board: DashboardDocument) => void; onValue: (id: string, value: string | boolean) => void }) {
  const [vaults, setVaults] = useState<BiVault[]>([]), [catalog, setCatalog] = useState<BiCatalog>(), [message, setMessage] = useState('Loading AEP BI…');
  const [reload, setReload] = useState(0), [loading, setLoading] = useState(false);
  const selected = String(values['bi:vault'] ?? board.panels[0]?.query?.vault ?? '');
  const boardCallback = useRef(onBoard); boardCallback.current = onBoard;
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setLoading(true);
      try {
        const health = await provider.health(controller.signal);
        if (health.state !== 'ready') { setMessage(`AEP BI ${health.state}: ${health.message}`); return; }
        const result = await provider.vaults(controller.signal); setVaults(result.data?.vaults ?? []);
        if (!selected) { setMessage(result.state === 'ready' ? 'Choose a published vault.' : `AEP BI ${result.state}: ${result.message}`); return; }
        const next = await provider.analyses(selected, controller.signal); setCatalog(next.data);
        setMessage(next.state === 'ready' ? 'Published analyses · read only' : `AEP BI ${next.state}: ${next.message}`);
        // A saved personal dashboard owns its panels and layout. Explicit selection generates a new view.
        if (next.data && !board.panels.length) boardCallback.current(biDashboard(next.data));
      } catch (ex) { if (!controller.signal.aborted) setMessage(String(ex)); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    };
    void load(); return () => controller.abort();
  }, [provider, selected, reload]);
  return <section className="atlas-source-bar" aria-label="AEP BI controls">
    <label>Vault <select className="atlas-control" value={selected} disabled={disabled || loading} onChange={event => {
      const vault = event.target.value;
      boardCallback.current({ schemaVersion: 2, id: `aep-bi-${vault}`, title: 'AEP BI', applicationId: 'aep_bi', variables: [], values: { 'bi:vault': vault }, panels: [] });
    }}><option value="">Choose a vault…</option>{vaults.map(vault => <option key={vault.id} value={vault.id}>{vault.title}</option>)}</select></label>
    <button className="atlas-button" disabled={loading || disabled} onClick={() => setReload(value => value + 1)}>Reload vaults</button>
    <span role="status">{message}</span>
    {catalog?.order.flatMap(slug => {
      const analysis = catalog.analyses.find(item => item.slug === slug)!;
      return Object.entries(analysis.params).map(([name, param]) => {
        const id = parameterId(slug, name), value = values[id] ?? param.default;
        return <label key={id}>{analysis.title} · {name} {param.type === 'bool' ? <input type="checkbox" disabled={disabled} checked={value === true} onChange={event => onValue(id, event.target.checked)} /> : param.type === 'enum' ? <select className="atlas-control" disabled={disabled} value={String(value ?? '')} onChange={event => onValue(id, event.target.value)}>{param.values!.map((choice, index) => <option key={index} value={choice}>{choice}</option>)}</select> : <input className="atlas-control" disabled={disabled} type={param.type === 'date' ? 'date' : 'text'} value={String(value ?? '')} onChange={event => onValue(id, event.target.value)} />}</label>;
      });
    })}
  </section>;
}
