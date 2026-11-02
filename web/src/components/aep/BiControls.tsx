import { useEffect, useRef, useState } from 'react';
import type { AepBiProvider, BiCatalog, BiVault } from '../../platform/aep/bi';
import { biDashboard, parameterId, reconcileBiDashboard } from '../../platform/aep/biDashboard';
import { feedStatus, narrowCatalog, type EmbedFeedStatus } from '../../platform/aep/biEmbed';
import type { DashboardDocument, VariableValues } from '../../platform/types';

/** Embed mode: no vault picker or reload, optionally one analysis, and structured status. */
export interface BiEmbedOptions { slug?: string; prepare?: (catalog: BiCatalog) => VariableValues | null; onStatus: (status: EmbedFeedStatus) => void }
export function BiControls({ provider, board, values, disabled, onBoard, onReconcile, onValue, embed }: { provider: AepBiProvider; board: DashboardDocument; values: VariableValues; disabled: boolean; onBoard: (board: DashboardDocument) => void; onReconcile?: (board: DashboardDocument) => void; onValue: (id: string, value: string | boolean) => void; embed?: BiEmbedOptions }) {
  const [vaults, setVaults] = useState<BiVault[]>([]), [catalog, setCatalog] = useState<BiCatalog>(), [message, setMessage] = useState('Loading AEP BI…');
  const [reload, setReload] = useState(0), [loading, setLoading] = useState(false);
  const selected = String(values['bi:vault'] ?? board.panels[0]?.query?.vault ?? '');
  const boardCallback = useRef(onBoard); boardCallback.current = onBoard;
  const current = useRef({ board, values, onReconcile, embed }); current.current = { board, values, onReconcile, embed };
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
        if (health.state !== 'ready') { setMessage(`AEP BI ${health.state}: ${health.message}`); current.current.embed?.onStatus(feedStatus(health)); return; }
        const result = await provider.vaults(controller.signal);
        if (controller.signal.aborted) return;
        if (result.data) setVaults(result.data.vaults);
        if (result.state !== 'ready') { setMessage(`AEP BI ${result.state}: ${result.message}`); current.current.embed?.onStatus(feedStatus(result)); return; }
        if (!selected) { setMessage(current.current.embed ? '' : 'Choose a published vault.'); current.current.embed?.onStatus({ state: 'ready' }); return; }
        const published = result.data?.vaults.find(vault => vault.id === selected)?.reads;
        if (!known || !published || published.tag !== known.version.tag || published.commit !== known.version.commit) {
          const next = await provider.analyses(selected, controller.signal);
          if (controller.signal.aborted) return;
          setMessage(next.state === 'ready' ? 'Published analyses · read only' : `AEP BI ${next.state}: ${next.message}`);
          current.current.embed?.onStatus(feedStatus(next));
          if (next.state !== 'ready' || !next.data) return;
          const latest = current.current;
          known = latest.embed?.slug ? narrowCatalog(next.data, latest.embed.slug) : next.data;
          const seed = latest.embed?.prepare ? latest.embed.prepare(known) : {};
          if (!seed) { setCatalog(undefined); return; }
          if (latest.onReconcile) {
            const reconciled = reconcileBiDashboard(latest.board, { ...seed, ...latest.values }, known);
            if (reconciled !== latest.board) latest.onReconcile(reconciled);
          } else if (!latest.board.panels.length) boardCallback.current(biDashboard(known));
          setCatalog(known);
        } else { setMessage('Published analyses · read only'); current.current.embed?.onStatus({ state: 'ready' }); }
      } catch (ex) { if (!controller.signal.aborted) { setMessage(String(ex)); current.current.embed?.onStatus({ state: 'error', message: String(ex) }); } }
      finally {
        if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(() => void load(), 15000); }
      }
    };
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [provider, selected, reload, disabled, board.id]);
  return <section className="atlas-source-bar" aria-label="AEP BI controls">
    {!embed && <><label>Vault <select className="atlas-control" value={selected} disabled={disabled || loading} onChange={event => {
      const vault = event.target.value;
      boardCallback.current({ schemaVersion: 2, id: `aep-bi-${vault}`, title: 'AEP BI', applicationId: 'aep_bi', variables: [], values: { 'bi:vault': vault }, panels: [] });
    }}><option value="">Choose a vault…</option>{vaults.map(vault => <option key={vault.id} value={vault.id}>{vault.title}</option>)}</select></label>
    <button className="atlas-button" disabled={loading || disabled} onClick={() => setReload(value => value + 1)}>Reload vaults</button></>}
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
