import { useEffect, useRef, useState } from 'react';
import type { AepBiProvider, BiCatalog, BiVault } from '../../platform/aep/bi';
import { biDashboard, parameterId, reconcileBiDashboard } from '../../platform/aep/biDashboard';
import type { DashboardDocument, VariableValues } from '../../platform/types';

export function BiControls({ provider, board, values, disabled, onBoard, onReconcile, onValue }: { provider: AepBiProvider; board: DashboardDocument; values: VariableValues; disabled: boolean; onBoard: (board: DashboardDocument) => void; onReconcile?: (board: DashboardDocument) => void; onValue: (id: string, value: string | boolean) => void }) {
  const [vaults, setVaults] = useState<BiVault[]>([]), [catalog, setCatalog] = useState<BiCatalog>(), [message, setMessage] = useState('Loading AEP BI…');
  const [reload, setReload] = useState(0), [loading, setLoading] = useState(false);
  const selected = String(values['bi:vault'] ?? board.panels[0]?.query?.vault ?? '');
  const boardCallback = useRef(onBoard); boardCallback.current = onBoard;
  const current = useRef({ board, values, onReconcile }); current.current = { board, values, onReconcile };
  useEffect(() => {
    if (disabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, known: BiCatalog | undefined;
    setCatalog(previous => previous?.vault === selected ? previous : undefined);
    const load = async () => {
      setLoading(true);
      try {
        const health = await provider.health(controller.signal);
        if (controller.signal.aborted) return;
        if (health.state !== 'ready') { setMessage(`AEP BI ${health.state}: ${health.message}`); return; }
        const result = await provider.vaults(controller.signal);
        if (controller.signal.aborted) return;
        if (result.data) setVaults(result.data.vaults);
        if (result.state !== 'ready') { setMessage(`AEP BI ${result.state}: ${result.message}`); return; }
        if (!selected) { setMessage('Choose a published vault.'); return; }
        const published = result.data?.vaults.find(vault => vault.id === selected)?.reads;
        if (!known || !published || published.tag !== known.version.tag || published.commit !== known.version.commit) {
          const next = await provider.analyses(selected, controller.signal);
          if (controller.signal.aborted) return;
          setMessage(next.state === 'ready' ? 'Published analyses · read only' : `AEP BI ${next.state}: ${next.message}`);
          if (next.state !== 'ready' || !next.data) return;
          known = next.data;
          const latest = current.current;
          if (latest.onReconcile) {
            const reconciled = reconcileBiDashboard(latest.board, latest.values, known);
            if (reconciled !== latest.board) latest.onReconcile(reconciled);
          } else if (!latest.board.panels.length) boardCallback.current(biDashboard(known));
          setCatalog(known);
        } else setMessage('Published analyses · read only');
      } catch (ex) { if (!controller.signal.aborted) setMessage(String(ex)); }
      finally {
        if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(() => void load(), 15000); }
      }
    };
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [provider, selected, reload, disabled, board.id]);
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
