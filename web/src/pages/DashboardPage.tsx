import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applicationPackages } from "../platform/applications";
import { PlatformRuntime } from "../platform/runtime";
import { PANEL_LIBRARY } from "../platform/catalog";
import { nextPanelLayout, settlePanels } from "../platform/layout";
import { actionValues, applyFilterAction, safeLink } from "../platform/actions";
import { loadDashboard, persistDashboard, savedDashboardNames } from "../platform/persistence";
import { DashboardCanvas } from "../components/dashboard/DashboardCanvas";
import { Field, JsonEditor, PanelProperties } from "../components/dashboard/PanelProperties";
import type { DashboardDocument, Dataset, PanelDefinition, PanelEvent, PlatformPanelKind, Row, VariableDefinition, VariableValues } from "../platform/types";
import "../platform/dashboard.css";

const clone = <T,>(value: T): T => structuredClone(value);
const defaults = (board: DashboardDocument) => ({ ...Object.fromEntries(board.variables.map(v => [v.id, v.default ?? ""])), ...board.values });
const uniqueId = () => crypto.randomUUID();
const controlPreferenceKey = "atlas.dashboard.controls.v1";
function readControlPreference(): { dashboards: boolean; filters: boolean } {
  try {
    const saved = JSON.parse(window.localStorage.getItem(controlPreferenceKey) ?? "null");
    return { dashboards: saved?.dashboards === true, filters: saved?.filters === true };
  } catch { return { dashboards: false, filters: false }; }
}
function filterSummary(variable: VariableDefinition, value: VariableValues[string]): string | null {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return null;
  if (variable.type === "time_range") {
    const [from = "", to = ""] = String(value).split("/");
    return from || to ? `${from.slice(0, 10) || "Any start"} – ${to.slice(0, 10) || "Any end"}` : null;
  }
  return Array.isArray(value) ? value.join(", ") : String(value);
}
const resourceOwners = new WeakMap<object, number>();
function retain(resource: { dispose: () => void } | null) {
  if (!resource) return () => {};
  resourceOwners.set(resource, (resourceOwners.get(resource) ?? 0) + 1);
  return () => {
    resourceOwners.set(resource, Math.max(0, (resourceOwners.get(resource) ?? 1) - 1));
    queueMicrotask(() => { if (resourceOwners.get(resource) === 0) resource.dispose(); });
  };
}
export function DashboardPage({ onDirtyChange, onBusyChange }: { onDirtyChange?: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void } = {}) {
  const applications = applicationPackages.applications;
  const [appId, setAppId] = useState(applications.find(app => app.default)?.id ?? applications[0]?.id ?? "");
  const application = applications.find(a => a.id === appId) ?? applications[0];
  const [board, setBoard] = useState<DashboardDocument | null>(() => application ? clone(application.dashboards[0]) : null);
  const boardRef = useRef(board); boardRef.current = board;
  const [values, setValues] = useState<VariableValues>(() => board ? defaults(board) : {});
  const [editing, setEditing] = useState(false);
  const [controls, setControls] = useState(readControlPreference);
  useEffect(() => {
    try { window.localStorage.setItem(controlPreferenceKey, JSON.stringify(controls)); } catch { /* Optional UI preference; storage may be unavailable. */ }
  }, [controls]);
  const [checkpoint, setCheckpoint] = useState<DashboardDocument | null>(null);
  const [checkpointValues, setCheckpointValues] = useState<VariableValues>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [datasets, setDatasets] = useState<Record<string, Dataset>>({});
  const [savedName, setSavedName] = useState("");
  const [revision, setRevision] = useState<string | null>(null);
  const [names, setNames] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  const mutationInFlight = useRef(false);
  const openGeneration = useRef(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [details, setDetails] = useState<{ title: string; values: Row; match: Row; kind: string } | null>(null);
  const [newOrigin, setNewOrigin] = useState<{ board: DashboardDocument; values: VariableValues; name: string; revision: string | null } | null>(null);
  const [saveAs, setSaveAs] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [settings, setSettings] = useState(false);
  const [highlight, setHighlight] = useState<string[]>([]);
  const runtime = useMemo(() => application ? new PlatformRuntime(application, { variableDefinitions: () => boardRef.current?.variables ?? [] }) : null, [application]);
  useEffect(() => retain(runtime), [runtime]);
  const dirty = editing && (!!newOrigin || (!!checkpoint && (JSON.stringify(board) !== JSON.stringify(checkpoint) || JSON.stringify(values) !== JSON.stringify(checkpointValues))));
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    const prevent = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", prevent); return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  const refreshNames = useCallback(() => { void savedDashboardNames().then(setNames).catch(ex => setStatus(`Could not list saved dashboards: ${String(ex)}`)); }, []);
  useEffect(refreshNames, [refreshNames]);
  const showDocument = (next: DashboardDocument, name = "", etag: string | null = null) => {
    setBoard(clone(next)); setValues(defaults(next)); setSavedName(name); setRevision(etag); setEditing(false); setCheckpoint(null); setSelected(null); setDatasets({}); setDetails(null); setHighlight([]); setStatus(""); setSettings(false); setNewOrigin(null);
  };
  const mayDiscard = () => !mutationInFlight.current && (!dirty || confirm("Discard unsaved dashboard changes?"));
  const chooseApp = (id: string) => { if (!mayDiscard()) return; const next = applications.find(a => a.id === id); if (next) { openGeneration.current++; setAppId(id); showDocument(next.dashboards[0]); } };
  const choosePreset = (id: string) => { if (!application || !mayDiscard()) return; const next = application.dashboards.find(d => d.id === id); if (next) { openGeneration.current++; showDocument(next); } };
  const openSaved = async (name: string) => {
    if (!name || !mayDiscard()) return;
    const generation = ++openGeneration.current;
    setBusy(true);
    try { const loaded = await loadDashboard(name); if (generation !== openGeneration.current) return; if (!applications.some(a => a.id === loaded.document.applicationId)) throw new Error(`Application '${loaded.document.applicationId}' is not installed.`); setAppId(loaded.document.applicationId); showDocument(loaded.document, name, loaded.revision); }
    catch (ex) { if (generation === openGeneration.current) setStatus(`Could not open dashboard: ${String(ex)}`); }
    finally { if (generation === openGeneration.current) setBusy(false); }
  };
  const beginEditing = () => { if (!board) return; setCheckpoint(clone(board)); setCheckpointValues(clone(values)); setEditing(true); setSelected(board.panels[0]?.id ?? null); };
  const cancel = () => {
    if (newOrigin) { const origin = newOrigin; showDocument(origin.board, origin.name, origin.revision); setValues(clone(origin.values)); setStatus("New dashboard canceled. Your previous dashboard is unchanged."); return; }
    if (checkpoint) { setBoard(clone(checkpoint)); setValues(clone(checkpointValues)); } setEditing(false); setSelected(null); setSettings(false); setStatus("Changes canceled."); };
  const save = async (name: string, create: boolean) => {
    if (!board || !name.trim() || mutationInFlight.current) return;
    mutationInFlight.current = true;
    setBusy(true);
    try {
      const doc = { ...board, title: newOrigin && board.title === "Untitled dashboard" ? name.trim() : board.title, id: create ? uniqueId() : board.id, values };
      const etag = await persistDashboard(name.trim(), doc, revision, create);
      setNewOrigin(null); setCheckpoint(null); setCheckpointValues({}); setBoard(doc); setSavedName(name.trim()); setRevision(etag); setEditing(false); setSelected(null); setSaveAs(false); setSettings(false); setStatus(`Saved “${name.trim()}”. Preview mode.`); refreshNames();
    } catch (ex) { setStatus(`Save failed: ${String(ex)}`); } finally { mutationInFlight.current = false; setBusy(false); }
  };
  const askSaveAs = () => { setStatus(""); setSaveName(savedName ? `${savedName} copy` : board?.title ?? "Dashboard"); setSaveAs(true); };
  const create = () => {
    if (!application || !board || !mayDiscard()) return;
    // Cancel new returns to the previous saved/view baseline, even after an
    // explicitly discarded edit. Repeated New does not lose that destination.
    const origin = newOrigin ?? { board: clone(editing && checkpoint ? checkpoint : board), values: clone(editing && checkpoint ? checkpointValues : values), name: savedName, revision };
    const next: DashboardDocument = { schemaVersion: 2, id: uniqueId(), title: "Untitled dashboard", applicationId: application.id, variables: clone(application.dashboards[0]?.variables ?? []), panels: [] };
    openGeneration.current++; showDocument(next); setCheckpoint(clone(next)); setCheckpointValues(defaults(next)); setNewOrigin(origin); setEditing(true); setStatus("New blank dashboard. Add panels, then Save to name it. Cancel returns to your previous dashboard.");
  };
  const restoreDefault = () => {
    if (!board || !application) return;
    const preset = application.dashboards.find(d => d.id === board.presetId || d.id === board.id) ?? application.dashboards[0];
    if (!confirm(`Restore “${preset.title}” into this editing session? Save will be required.`)) return;
    if (!editing) { setCheckpoint(clone(board)); setCheckpointValues(clone(values)); setEditing(true); }
    setBoard({ ...clone(preset), id: board.id, presetId: preset.id }); setValues(defaults(preset)); setSelected(null); setStatus("Default restored in the draft. Save to keep it or Cancel to undo.");
  };
  const updatePanel = (panel: PanelDefinition) => setBoard(prev => prev ? { ...prev, panels: settlePanels(prev.panels.map(p => p.id === panel.id ? panel : p), panel.id) } : prev);
  const addPanel = (type: PlatformPanelKind) => {
    if (!board || !application) return;
    const source = Object.entries(application.sources).find(([, s]) => type === "network" ? s.format === "graph" : s.format !== "graph")?.[0] ?? Object.keys(application.sources)[0];
    if (!source) { setStatus("This application has no data sources."); return; }
    const panel: PanelDefinition = { id: uniqueId(), title: PANEL_LIBRARY.find(p => p.type === type)?.label ?? type, type, datasource: { id: source }, transform: [], mapping: type === "network" ? { nodeId: "id", nodeLabel: "label", nodeGroup: "group", nodeSize: "size", nodeColor: "group", edgeSource: "source", edgeTarget: "target", edgeType: "type", edgeWeight: "weight", edgeState: "state" } : {}, display: type === "text" ? { text: "## Notes\nAdd context for your dashboard." } : { color_scale: "blue", show_values: true }, layout: nextPanelLayout(board.panels, 6, type === "network" ? 10 : 7) };
    setBoard({ ...board, panels: [...board.panels, panel] }); setSelected(panel.id); setSettings(false);
  };
  const removePanel = (id: string) => {
    if (!editing || mutationInFlight.current) return;
    const current = boardRef.current;
    const panel = current?.panels.find(p => p.id === id);
    if (!current || !panel) return;
    const remaining = current.panels.filter(p => p.id !== id);
    const next = { ...current, panels: remaining };
    boardRef.current = next;
    setBoard(next);
    setSelected(selected => selected === id ? remaining[Math.min(current.panels.indexOf(panel), remaining.length - 1)]?.id ?? null : selected);
    setDatasets(previous => { const next = { ...previous }; delete next[id]; return next; });
    setDetails(null);
    setStatus(`Removed “${panel.title}” from the draft. Save to keep it or Cancel to restore it.`);
  };
  const onData = useCallback((id: string, dataset: Dataset) => {
    if (boardRef.current?.panels.some(panel => panel.id === id)) setDatasets(prev => ({ ...prev, [id]: dataset }));
  }, []);
  const onEvent = (panel: PanelDefinition, event: PanelEvent) => {
    if (!board) return;
    const actions = panel.interaction?.on_click;
    if (!actions) return;
    try {
      let nextValues = values;
      for (const action of Array.isArray(actions) ? actions : [actions]) {
        const payload = { ...event.values, ...actionValues(action, event) };
        if (action.action === "set_filter") nextValues = applyFilterAction(nextValues, action, event, board.variables.map(v => v.id));
        else if (action.action === "open_details" || action.action === "drill_down") setDetails({ title: action.target || panel.title, values: payload, match: actionValues(action, event), kind: action.action });
        else if (action.action === "highlight") setHighlight(Array.isArray(payload.path) ? payload.path.map(String) : [String(payload.id ?? payload.source ?? "")].filter(Boolean));
        else if (action.action === "navigate") {
          const target = application?.dashboards.find(d => d.id === action.target);
          if (!target) throw new Error(`Unknown dashboard target: ${action.target}`);
          if (mayDiscard()) { showDocument(target); nextValues = { ...defaults(target), ...actionValues(action, event) } as VariableValues; }
        } else if (action.action === "open_link") {
          const template = action.url ?? action.target ?? "";
          const link = safeLink(template.replace(/\$([a-zA-Z0-9_]+)/g, (_, key: string) => encodeURIComponent(String(event.values[key] ?? ""))), window.location.href);
          window.open(link, "_blank", "noopener,noreferrer");
        }
      }
      setValues(nextValues);
    } catch (ex) { setStatus(`Interaction failed: ${String(ex)}`); }
  };
  const activeFilters = board?.variables.flatMap(variable => {
    const summary = filterSummary(variable, values[variable.id]);
    return summary === null ? [] : [{ id: variable.id, label: variable.label ?? variable.id, summary }];
  }) ?? [];
  const activePanel = board?.panels.find(p => p.id === selected);
  const canvasPanels = useMemo(() => board?.panels.map(p => p.type === "network" && highlight.length ? { ...p, display: { ...p.display, highlightPath: highlight } } : p) ?? [], [board?.panels, highlight]);
  if (!application || !board || !runtime) return <div className="atlas-platform p-8"><h1 className="text-xl">Dashboard applications</h1><p>No valid application packages are available.</p>{applicationPackages.errors.map(error => <p role="alert" key={error}>{error}</p>)}</div>;
  return <div className="atlas-platform"><header className="atlas-workspace-header">
      <div className="atlas-workspace-title"><h1>{board.title}</h1><span className={`atlas-mode ${editing ? "is-editing" : ""}`}>{editing ? "EDIT MODE" : "PREVIEW"}</span>{dirty && <span className="text-xs text-amber-300">Unsaved</span>}{application.demo && <span className="atlas-demo-label">Synthetic data</span>}</div>
      <div className="atlas-toolbar"><button type="button" className="atlas-button" disabled={busy} onClick={create}>+ New dashboard</button>{!editing ? <button className="atlas-button primary" disabled={busy} onClick={beginEditing}>Edit Dashboard</button> : <><button className="atlas-button primary" disabled={busy} title="Save changes and return to Preview mode" onClick={() => savedName ? void save(savedName, false) : askSaveAs()}>Save</button><button className="atlas-button" disabled={busy} onClick={cancel}>Cancel</button><button className={`atlas-button ${settings ? "active" : ""}`} onClick={() => setSettings(s => !s)}>Dashboard settings</button></>}<button className="atlas-button" disabled={busy} onClick={askSaveAs}>Save As</button><button className="atlas-button" onClick={() => setRefreshKey(k => k + 1)}>↻ Refresh</button></div>
    </header>
    <div className="atlas-control-strip">
      <button className={`atlas-button atlas-disclosure ${controls.dashboards ? "active" : ""}`} aria-expanded={controls.dashboards} aria-controls="atlas-dashboard-controls" onClick={() => setControls(prev => ({ ...prev, dashboards: !prev.dashboards }))}><span aria-hidden="true">{controls.dashboards ? "▾" : "▸"}</span> Dashboards</button>
      <button className={`atlas-button atlas-disclosure ${controls.filters ? "active" : ""}`} aria-expanded={controls.filters} aria-controls="atlas-filter-controls" onClick={() => setControls(prev => ({ ...prev, filters: !prev.filters }))}><span aria-hidden="true">{controls.filters ? "▾" : "▸"}</span> Filters <span className="atlas-filter-count">{activeFilters.length}</span></button>
      <div className="atlas-filter-summary" aria-label="Active filters" aria-live="polite">{activeFilters.length ? activeFilters.map(filter => <span className="atlas-filter-chip" key={filter.id} title={`${filter.label}: ${filter.summary}`}>{filter.label}: {filter.summary}</span>) : <span className="atlas-filter-empty">All data</span>}</div>
      <button className="atlas-button subtle atlas-reset-filters" disabled={busy} onClick={() => { setValues(defaults(board)); setHighlight([]); }}>Reset filters</button>
    </div>
    <div id="atlas-dashboard-controls" className="atlas-source-bar" hidden={!controls.dashboards} role="region" aria-label="Dashboard selection"><Field label="Application"><select className="atlas-control" disabled={busy} value={appId} onChange={e => chooseApp(e.target.value)}>{applications.map(app => <option key={app.id} value={app.id}>{app.name}</option>)}</select></Field><Field label="Default preset"><select className="atlas-control" disabled={busy} value={application.dashboards.some(d => d.id === board.id) ? board.id : ""} onChange={e => choosePreset(e.target.value)}><option value="" disabled>User dashboard</option>{application.dashboards.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}</select></Field><Field label="Saved dashboard"><select className="atlas-control" disabled={busy} value={savedName} onChange={e => void openSaved(e.target.value)}><option value="">Open a saved view…</option>{names.map(name => <option key={name}>{name}</option>)}</select></Field><button className="atlas-button" disabled={busy} onClick={restoreDefault}>Restore default</button></div>
    <div id="atlas-filter-controls" className="atlas-variables" hidden={!controls.filters} inert={busy} role="region" aria-label="Dashboard filters">{board.variables.map(variable => <VariableControl key={variable.id} variable={variable} value={values[variable.id] ?? ""} onChange={value => setValues(prev => ({ ...prev, [variable.id]: value }))} />)}</div>
    {status && <div className="atlas-status" role="status"><span>{status}</span><button aria-label="Dismiss status" onClick={() => setStatus("")}>×</button></div>}{applicationPackages.errors.length > 0 && <div className="atlas-status">Some application packages could not load: {applicationPackages.errors.join("; ")}</div>}
    <div className={`atlas-workspace-body ${editing ? "is-editing" : ""}`} inert={busy}>{editing && <aside className="atlas-panel-library"><div className="atlas-side-heading">Panel library</div><p>Click to add a panel</p>{PANEL_LIBRARY.map(p => <button key={p.type} onClick={() => addPanel(p.type)}><span>{p.icon}</span>{p.label}</button>)}</aside>}
      <DashboardCanvas panels={canvasPanels} variables={values} runtime={runtime} editing={editing} selected={selected} refreshKey={refreshKey} onSelect={id => { setSelected(id); setSettings(false); }} onRemove={removePanel} onPanels={panels => setBoard(prev => prev ? { ...prev, panels } : prev)} onEvent={onEvent} onData={onData} />
      {editing && settings ? <aside className="atlas-properties"><div className="atlas-side-heading">Dashboard settings</div><div className="space-y-4 p-4"><Field label="Title"><input className="atlas-control" value={board.title} onChange={e => setBoard({ ...board, title: e.target.value })} /></Field><Field label="Description"><textarea className="atlas-control" value={board.description ?? ""} onChange={e => setBoard({ ...board, description: e.target.value })} /></Field><JsonEditor label="Global variables" value={board.variables} onApply={v => { if (!Array.isArray(v) || v.some(x => !x || typeof x.id !== "string") || new Set(v.map(x => x.id)).size !== v.length) throw new Error("Expected variables with unique ids"); setBoard({ ...board, variables: v }); }} /><p className="text-xs text-slate-400">Source bindings map variable names to fields. Each variable updates every panel that uses a bound source.</p></div></aside> : editing && activePanel ? <PanelProperties key={activePanel.id} panel={activePanel} application={application} dataset={datasets[activePanel.id]} onChange={updatePanel} onDuplicate={() => { const copy = { ...clone(activePanel), id: uniqueId(), title: `${activePanel.title} copy`, layout: nextPanelLayout(board.panels, activePanel.layout.w, activePanel.layout.h) }; setBoard({ ...board, panels: [...board.panels, copy] }); setSelected(copy.id); }} onRemove={() => removePanel(activePanel.id)} /> : editing ? <aside className="atlas-properties"><div className="atlas-side-heading">Properties</div><p className="p-4 text-sm text-slate-400">Select a panel to configure its source, transforms, mapping and interactions.</p></aside> : null}
    </div>
    {saveAs && <div className="atlas-modal-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget && !busy) setSaveAs(false); }}><section className="atlas-modal" role="dialog" aria-modal="true" aria-label="Save dashboard as"><h2>{newOrigin ? "Save new dashboard" : "Save As"}</h2><p>Name this dashboard, then save to return to Preview mode. Existing names are protected from overwrite.</p>{status.startsWith("Save failed:") && <p role="alert" className="text-rose-300">{status}</p>}<form onSubmit={e => { e.preventDefault(); void save(saveName, true); }}><Field label="Dashboard name"><input className="atlas-control" autoFocus value={saveName} onChange={e => setSaveName(e.target.value)} onKeyDown={e => { if (e.key === "Escape" && !busy) setSaveAs(false); }} maxLength={120} required /></Field><div className="mt-5 flex justify-end gap-2"><button type="button" className="atlas-button" disabled={busy} onClick={() => setSaveAs(false)}>Cancel</button><button className="atlas-button primary" disabled={busy || !saveName.trim()}>Save and preview</button></div></form></section></div>}
    {details && <DetailsDialog details={details} datasets={datasets} onClose={() => setDetails(null)} />}
  </div>;
}
function VariableControl({ variable, value, onChange }: { variable: VariableDefinition; value: VariableValues[string]; onChange: (value: VariableValues[string]) => void }) {
  if (variable.type === "time_range") {
    const [from = "", to = ""] = String(value ?? "").split("/");
    return <Field label={variable.label ?? variable.id}><div className="flex gap-1"><input aria-label={`${variable.label ?? variable.id} from`} className="atlas-control" type="date" value={from.slice(0,10)} onChange={e => onChange(`${e.target.value ? e.target.value + "T00:00:00.000Z" : ""}/${to}`)} /><input aria-label={`${variable.label ?? variable.id} to`} className="atlas-control" type="date" value={to.slice(0,10)} onChange={e => onChange(`${from}/${e.target.value ? e.target.value + "T23:59:59.999Z" : ""}`)} /></div></Field>;
  }
  return <Field label={variable.label ?? variable.id}>{variable.options ? <select className="atlas-control" value={String(value ?? "")} onChange={e => onChange(variable.options?.find(option => String(option) === e.target.value) ?? "")}><option value="">All</option>{variable.options.map(option => <option key={String(option)} value={String(option)}>{option}</option>)}</select> : variable.type === "boolean" ? <select className="atlas-control" value={String(value ?? "")} onChange={e => onChange(e.target.value === "" ? "" : e.target.value === "true")}><option value="">All</option><option value="true">True</option><option value="false">False</option></select> : <input className="atlas-control" type={variable.type === "number" ? "number" : "text"} placeholder="All" value={String(value ?? "")} onChange={e => onChange(variable.type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value)} />}</Field>;
}
function DetailsDialog({ details, datasets, onClose }: { details: { title: string; values: Row; match: Row; kind: string }; datasets: Record<string, Dataset>; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); return () => { ref.current?.close(); }; }, []);
  const queryKeys = Object.entries(details.match).filter(([, value]) => value !== null && value !== "");
  const related = Object.entries(datasets).flatMap(([panel, dataset]) => dataset.kind !== "table" ? [] : dataset.rows.filter(row => queryKeys.length > 0 && queryKeys.every(([key, value]) => row[key] === value)).slice(0, 20).map(row => ({ panel, ...row })));
  return <dialog ref={ref} className="atlas-details-dialog" onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }}><div className="atlas-details-inner"><header><div><span className="atlas-eyebrow">{details.kind.replace("_", " ")}</span><h2>{details.title}</h2></div><button className="atlas-icon-button" aria-label="Close details" onClick={onClose}>×</button></header><h3>Selected item</h3><dl>{Object.entries(details.values).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === "object" ? JSON.stringify(value) : String(value ?? "—")}</dd></div>)}</dl><h3>Related evidence and actions</h3>{related.length ? related.map((row, i) => <dl key={i}>{Object.entries(row).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === "object" ? JSON.stringify(value) : String(value ?? "—")}</dd></div>)}</dl>) : <p>No matching rows in the currently loaded datasets. Refine the filters or configure a target-specific data source.</p>}</div></dialog>;
}
