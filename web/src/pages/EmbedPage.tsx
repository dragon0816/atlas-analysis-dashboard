import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applicationPackages } from '../platform/applications';
import { AepProvider } from '../platform/aep/provider';
import { AepBiProvider, type BiCatalog } from '../platform/aep/bi';
import { BiControls } from '../components/aep/BiControls';
import { embedTargetOrigin, panelFeedState, panelValues, type EmbedFeedStatus, type EmbedState } from '../platform/aep/biEmbed';
import { PlatformRuntime } from '../platform/runtime';
import { actionValues, applyFilterAction } from '../platform/actions';
import { retain } from '../platform/retain';
import { loadDashboard } from '../platform/persistence';
import { DashboardCanvas } from '../components/dashboard/DashboardCanvas';
import { GRID_GAP, GRID_ROW } from '../platform/layout';
import type { EmbedInvalidReason, EmbedRoute } from '../platform/embedRoute';
import type { ApplicationDefinition, Dataset, DashboardDocument, PanelDefinition, PanelEvent, VariableValues } from '../platform/types';
import '../platform/dashboard.css';

const INVALID_LINK: Record<EmbedInvalidReason, string> = {
  unknown_route: 'This embed address is not recognised.',
  missing_name: 'This embed address does not name a dashboard.',
  malformed_name: 'The dashboard name in this embed address is not valid.',
  missing_vault: 'This embed address does not name a vault.',
  missing_slug: 'This embed address does not name an analysis.',
  duplicate_param: 'This embed address repeats a parameter.',
};
const PANEL_ROWS = 8;
const defaults = (board: DashboardDocument): VariableValues => ({ ...Object.fromEntries(board.variables.map(v => [v.id, v.default ?? ''])), ...board.values });
const biApplication = () => applicationPackages.applications.find(application => application.id === 'aep_bi');

function preferredHeight(root: HTMLElement, panel: boolean) {
  const top = root.getBoundingClientRect().top, scroll = root.querySelector<HTMLElement>('.atlas-canvas-scroll');
  const message = root.querySelector<HTMLElement>('.atlas-embed-message');
  if (message || !scroll) return message ? message.getBoundingClientRect().bottom - top : 0;
  const style = getComputedStyle(scroll), padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom), start = scroll.getBoundingClientRect().top;
  // Both forms ignore the frame's height, so a parent that follows this value cannot loop.
  if (panel) return start - top + padding + PANEL_ROWS * GRID_ROW + (PANEL_ROWS - 1) * GRID_GAP;
  const canvas = scroll.querySelector<HTMLElement>('.atlas-canvas'), cards = [...root.querySelectorAll<HTMLElement>('[data-panel-id]')];
  return canvas && cards.length ? start - top + padding + Math.max(...cards.map(card => card.getBoundingClientRect().bottom)) - canvas.getBoundingClientRect().top : start - top;
}
function useParentSize(root: React.RefObject<HTMLElement | null>, panel: boolean) {
  useEffect(() => {
    const element = root.current;
    if (!element || window.parent === window) return;
    const target = embedTargetOrigin(window.location, document.referrer);
    if (!target) return;
    let last = 0;
    const post = () => {
      const height = Math.ceil(preferredHeight(element, panel));
      if (height > 0 && height !== last) { last = height; window.parent.postMessage({ type: 'atlas-embed-size', height }, target); }
    };
    const resized = new ResizeObserver(post), changed = new MutationObserver(post);
    resized.observe(element); changed.observe(element, { childList: true, subtree: true });
    post();
    return () => { resized.disconnect(); changed.disconnect(); };
  }, [root, panel]);
}
function EmbedShell({ state, panel = false, children }: { state: EmbedState; panel?: boolean; children: React.ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useParentSize(root, panel);
  return <div ref={root} className={`atlas-platform atlas-embed ${panel ? 'atlas-embed-panel' : ''}`} data-embed-state={state}>{children}</div>;
}
function Message({ alert, children }: { alert?: boolean; children: React.ReactNode }) {
  return <p className="atlas-embed-message" role={alert ? 'alert' : 'status'}>{children}</p>;
}
/** Read-only canvas shared by both routes. It never calls a write API, and all its state is in memory. */
function EmbedBoard({ application, initial, panel, fatal, prepare }: { application: ApplicationDefinition; initial: DashboardDocument; panel?: { slug: string }; fatal?: { state: EmbedState; message: string }; prepare?: (catalog: BiCatalog) => VariableValues | null }) {
  const [board, setBoard] = useState(initial), [values, setValues] = useState(() => defaults(initial));
  const [warnings, setWarnings] = useState<Record<string, string[]>>({}), [feed, setFeed] = useState<EmbedFeedStatus>();
  const [filtered, setFiltered] = useState(false), [highlight, setHighlight] = useState<string[]>([]);
  const boardRef = useRef(board); boardRef.current = board;
  const aepProvider = useMemo(() => application.id === 'aep_harness' ? new AepProvider() : null, [application]);
  const biProvider = useMemo(() => application.id === 'aep_bi' ? new AepBiProvider() : null, [application]);
  const runtime = useMemo(() => new PlatformRuntime(application, { providers: aepProvider ? { aep: aepProvider } : biProvider ? { aep_bi: biProvider } : {}, variableDefinitions: () => boardRef.current.variables }), [application, aepProvider, biProvider]);
  useEffect(() => retain(runtime), [runtime]);
  const onData = useCallback((id: string, dataset: Dataset) => setWarnings(previous => ({ ...previous, [id]: dataset.meta.warnings })), []);
  const onPanelError = useCallback((id: string, message: string) => setWarnings(previous => ({ ...previous, [id]: [`AEP BI error: ${message}`] })), []);
  const onEvent = (source: PanelDefinition, event: PanelEvent) => {
    const actions = source.interaction?.on_click;
    if (!actions) return;
    for (const action of Array.isArray(actions) ? actions : [actions]) {
      if (action.action === 'set_filter') {
        // A saved action naming an unknown variable is ignored; there is no editor here to report it to.
        try { setValues(applyFilterAction(values, action, event, board.variables.map(v => v.id))); setFiltered(true); } catch { /* See above. */ }
      } else if (action.action === 'highlight') { const payload = { ...event.values, ...actionValues(action, event) }; setHighlight(Array.isArray(payload.path) ? payload.path.map(String) : [String(payload.id ?? payload.source ?? '')].filter(Boolean)); }
    }
  };
  const resetFilters = () => {
    const saved = defaults(board);
    setValues(previous => ({ ...previous, ...Object.fromEntries(board.variables.filter(v => !v.id.startsWith('bi.')).map(v => [v.id, saved[v.id]])) }));
    setHighlight([]); setFiltered(false);
  };
  const canvasPanels = useMemo(() => board.panels.map(p => p.type === 'network' && highlight.length ? { ...p, display: { ...p.display, highlightPath: highlight } } : p), [board.panels, highlight]);
  const shown = board.panels.flatMap(p => warnings[p.id] ? [warnings[p.id]] : []);
  const blocking = fatal ?? (feed?.state === 'unknown_vault' && panel ? { state: 'unknown_vault' as const, message: feed.message ?? `Vault “${String(initial.values?.['bi:vault'] ?? '')}” is not published.` } : undefined);
  const feedState: EmbedState = feed?.state === 'offline' ? 'offline' : feed?.state === 'error' || feed?.state === 'unknown_vault' ? 'error' : 'ready';
  const panelsState = panelFeedState(shown);
  const pending = biProvider && (!feed || board.panels.some(p => p.datasource.id === 'aep.bi.result' && !warnings[p.id]));
  const state: EmbedState = blocking?.state ?? (feedState !== 'ready' ? feedState : panelsState !== 'ready' ? panelsState : pending ? 'loading' : 'ready');
  return <EmbedShell state={state} panel={!!panel}>
    {biProvider && <BiControls provider={biProvider} board={board} values={values} disabled={false} onBoard={() => {}} onReconcile={next => { setBoard(next); setValues(next.values ?? {}); }} onValue={(id, value) => setValues(previous => ({ ...previous, [id]: value }))} saved={!panel} embed={{ slug: panel?.slug, prepare, onStatus: setFeed }} />}
    {filtered && <div className="atlas-status"><button className="atlas-button subtle" onClick={resetFilters}>Reset filters</button></div>}
    {blocking ? <Message alert>{blocking.message}</Message>
      : !board.panels.length ? <Message alert={state === 'offline' || state === 'error'}>{state === 'loading' ? 'Loading…' : state === 'offline' ? 'AEP is offline. Retrying…' : state === 'error' ? feed?.message ?? 'Could not read AEP.' : 'This dashboard has no panels.'}</Message>
      : null}
    {!blocking && !!board.panels.length && <div className="atlas-workspace-body"><DashboardCanvas panels={canvasPanels} variables={values} runtime={runtime} editing={false} selected={null} refreshKey={0} onSelect={() => {}} onRemove={() => {}} onPanels={() => {}} onEvent={onEvent} onData={onData} onPanelError={onPanelError} /></div>}
  </EmbedShell>;
}
function EmbedPanel({ vault, slug, params }: { vault: string; slug: string; params: Record<string, string> }) {
  const application = biApplication();
  const [fatal, setFatal] = useState<{ state: EmbedState; message: string }>();
  const accepted = useRef(false);
  // The URL's values only seed the first board; a later republish follows the reconcile rule.
  const prepare = useCallback((catalog: BiCatalog) => {
    const analysis = catalog.analyses.find(item => item.slug === slug);
    if (!analysis) { setFatal({ state: 'unknown_analysis', message: `Vault “${vault}” has no published analysis “${slug}”.` }); return null; }
    if (accepted.current) { setFatal(undefined); return {}; }
    const checked = panelValues(analysis, params);
    if ('problem' in checked) { setFatal({ state: 'invalid_link', message: checked.problem }); return null; }
    accepted.current = true; setFatal(undefined);
    return checked.values;
  }, [vault, slug, params]);
  const initial = useMemo<DashboardDocument>(() => ({ schemaVersion: 2, id: 'embed-panel', title: slug, applicationId: 'aep_bi', variables: [], values: { 'bi:vault': vault }, panels: [] }), [vault, slug]);
  if (!application) return <EmbedShell state="error"><Message alert>The AEP BI application is not installed.</Message></EmbedShell>;
  return <EmbedBoard application={application} initial={initial} panel={{ slug }} fatal={fatal} prepare={prepare} />;
}
function EmbedDashboard({ name }: { name: string }) {
  const [loaded, setLoaded] = useState<{ board: DashboardDocument; application: ApplicationDefinition }>();
  const [failure, setFailure] = useState<{ state: EmbedState; message: string }>();
  useEffect(() => {
    const controller = new AbortController();
    loadDashboard(name, controller.signal).then(({ document: board }) => {
      const application = applicationPackages.applications.find(item => item.id === board.applicationId);
      if (application) setLoaded({ board, application });
      else setFailure({ state: 'error', message: `Application “${board.applicationId}” is not installed.` });
    }).catch((ex: Error & { status?: number }) => {
      if (controller.signal.aborted) return;
      setFailure(ex.status === 404 ? { state: 'unknown_dashboard', message: `There is no saved dashboard named “${name}”.` } : { state: 'error', message: `Could not open dashboard “${name}”: ${ex.message}` });
    });
    return () => controller.abort();
  }, [name]);
  if (failure) return <EmbedShell state={failure.state}><Message alert>{failure.message}</Message></EmbedShell>;
  if (!loaded) return <EmbedShell state="loading"><Message>Loading…</Message></EmbedShell>;
  return <EmbedBoard application={loaded.application} initial={loaded.board} />;
}
export function EmbedPage({ route }: { route: EmbedRoute }) {
  if (route.kind === 'invalid') return <EmbedShell state="invalid_link"><Message alert>{INVALID_LINK[route.reason]}</Message></EmbedShell>;
  return route.kind === 'dashboard' ? <EmbedDashboard name={route.name} /> : <EmbedPanel vault={route.vault} slug={route.slug} params={route.params} />;
}
