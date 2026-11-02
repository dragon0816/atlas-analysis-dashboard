import { useState } from "react";
import { Field } from "./PanelProperties";
import { storeImportedDashboard } from "../../platform/dashboardFile";
import type { DashboardDocument } from "../../platform/types";

/** Names an imported file. An existing name is only ever replaced by the explicit button. */
export function ImportDashboardDialog({ document, initialName, onImported, onCancel }: { document: DashboardDocument; initialName: string; onImported: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(initialName), [taken, setTaken] = useState(false), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const store = async (replace: boolean) => {
    const target = name.trim();
    if (!target || busy) return;
    setBusy(true); setError("");
    try { await storeImportedDashboard(target, document, replace); onImported(target); }
    catch (ex) {
      if (!replace && (ex as { status?: number }).status === 412) setTaken(true);
      else { setTaken(false); setError(`Import failed: ${ex instanceof Error ? ex.message : String(ex)}`); }
    } finally { setBusy(false); }
  };
  return <div className="atlas-modal-backdrop" role="presentation"><section className="atlas-modal" role="dialog" aria-modal="true" aria-label="Import dashboard"><h2>Import dashboard</h2><p>“{document.title}” will be saved as a personal dashboard.</p>
    {taken && <p role="alert" className="text-amber-300">A dashboard named “{name.trim()}” already exists. Choose another name, or replace it.</p>}
    {error && <p role="alert" className="text-rose-300">{error}</p>}
    <form onSubmit={event => { event.preventDefault(); void store(false); }}><Field label="Dashboard name"><input className="atlas-control" autoFocus value={name} maxLength={120} required onChange={event => { setName(event.target.value); setTaken(false); }} onKeyDown={event => { if (event.key === "Escape" && !busy) onCancel(); }} /></Field>
      <div className="mt-5 flex justify-end gap-2"><button type="button" className="atlas-button" disabled={busy} onClick={onCancel}>Cancel</button>{taken && <button type="button" className="atlas-button" disabled={busy} onClick={() => void store(true)}>Replace existing</button>}<button className="atlas-button primary" disabled={busy || !name.trim() || taken}>Import</button></div></form></section></div>;
}
