import { checkAbort, isRecord, MAX_BYTES, normalizeTable, normalizeGraph } from '../dataset.ts';
import type { Dataset, Row, SourceDefinition } from '../types';
import type { DatasetObserver, SourceProvider } from '../sources.ts';
import { derive, EventIndex, parseJSONL, validateEvent, EVENT_BYTES, type TelemetryEvent } from './events.ts';
import { BENCHMARK_KINDS, deriveBenchmarks, isBenchmarkStart } from './benchmarks.ts';
export const AEP_BASE = 'http://127.0.0.1:53583/api/v1/telemetry';
export interface AepDependencies { fetch?: typeof fetch; websocket?: (url: string) => WebSocket; retryMs?: number }
interface Session { index: EventIndex; runs: Row[]; loaded: number; promise?: Promise<void>; controller?: AbortController; users: number; benchmarkRuns?: Set<string> }
// Benchmark views (contract v0.3 §3a) load benchmark runs by kind and then each
// run's events, so a busy Harness window cannot crowd them out of the index.
const BENCHMARKS = '@benchmarks';
const isBenchmarkView = (query: Row) => String(query.view ?? '').startsWith('benchmark');
interface Listener { definition: SourceDefinition; query: Row; observer: DatasetObserver }
/** A live event belongs to the benchmark session when its run is a known
 * benchmark run or the event starts one. */
function acceptBenchmark(session: Session, event: TelemetryEvent): boolean {
  const known = session.benchmarkRuns ?? (session.benchmarkRuns = new Set());
  if (isBenchmarkStart(event)) known.add(event.run_id);
  return known.has(event.run_id);
}
export class AepProvider implements SourceProvider {
  private deps: AepDependencies;
  private sessions = new Map<string, Session>();
  private listeners = new Set<Listener>();
  private imported?: EventIndex;
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private emitTimer?: ReturnType<typeof setTimeout>;
  private healthTimer?: ReturnType<typeof setTimeout>;
  private healthController?: AbortController;
  private live = false;
  private disposed = false;
  private cursor = 0;
  private connectionWarning = '';
  private attempts = 0;
  private generation = 0;
  constructor(deps: AepDependencies = {}) { this.deps = deps; }
  describe = async () => ({ live: true });
  private key(query: Row) { return isBenchmarkView(query) ? JSON.stringify([BENCHMARKS, query.time_range || '']) : JSON.stringify([query.run_id || '', query.time_range || '', query.trace || '']); }
  private session(query: Row): Session {
    const key = this.key(query); let session = this.sessions.get(key);
    if (!session) {
      if (this.sessions.size >= 4) { const candidate = [...this.sessions].find(([k, s]) => !s.users && ![...this.listeners].some(l => this.key(l.query) === k)); if (!candidate) throw new Error('Too many active AEP views'); candidate[1].controller?.abort(); this.sessions.delete(candidate[0]); }
      session = { index: new EventIndex(), runs: [], loaded: 0, users: 0 }; this.sessions.set(key, session);
    }
    return session;
  }
  private async get(path: string, signal: AbortSignal): Promise<Row> {
    const response = await (this.deps.fetch ?? globalThis.fetch)(`${AEP_BASE}/${path}`, { signal, credentials: 'omit', redirect: 'error', cache: 'no-store' });
    if (!response.ok) throw new Error(`AEP HTTP ${response.status}; retained data is stale`);
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('AEP payload exceeds 8 MiB');
    let text = '', length = 0;
    if (response.body) {
      const reader = response.body.getReader(), decoder = new TextDecoder();
      try { while (true) { checkAbort(signal); const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength; if (length > MAX_BYTES) throw new Error('AEP payload exceeds 8 MiB'); text += decoder.decode(chunk.value, { stream: true }); } text += decoder.decode(); }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } else { text = await response.text(); if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('AEP payload exceeds 8 MiB'); }
    const payload: unknown = JSON.parse(text); if (!isRecord(payload)) throw new Error('Invalid AEP response envelope'); return payload;
  }
  /** Benchmark and grading runs in the window (default 7 days), then each run's events. */
  private async loadBenchmarks(session: Session, query: Row, signal: AbortSignal) {
    const index = new EventIndex(), runs: Row[] = [], known = new Set<string>();
    const range = typeof query.time_range === 'string' && query.time_range.includes('/') ? query.time_range.split('/') : [];
    const since = range[0] || (range[1] ? '' : new Date(Date.now() - 7 * 86400000).toISOString()), until = range[1];
    for (const kind of BENCHMARK_KINDS) {
      const params = new URLSearchParams({ limit: '100', kind }); if (since) params.set('since', since); if (until) params.set('until', until);
      const payload = await this.get(`runs?${params}`, signal);
      if (!Array.isArray(payload.runs)) throw new Error('Invalid runs envelope');
      // Older Agent Web builds ignore `kind`; keep only benchmark runs.
      for (const row of payload.runs) if (isRecord(row) && typeof row.run_id === 'string' && row.run_kind === kind && !known.has(row.run_id)) { known.add(row.run_id); runs.push(row); }
      if (payload.next_cursor) index.warn(`More than 100 ${kind} runs in the window; showing the newest`);
    }
    for (const run of runs) {
      let after = -1;
      for (let page = 0; page < 20; page++) {
        const payload = await this.get(`runs/${encodeURIComponent(String(run.run_id))}/events?after_sequence=${after}&limit=500`, signal);
        if (!Array.isArray(payload.events)) throw new Error('Invalid events envelope');
        for (const raw of payload.events) {
          const event = validateEvent(raw);
          try { index.add(event); } catch (ex) { if (!index.truncated) throw ex; index.warn(String(ex)); break; }
          index.cursor = Math.max(index.cursor, event.ingest_seq ?? 0); after = event.sequence;
        }
        if (index.truncated || payload.next_sequence === null || !payload.events.length) break;
      }
      if (index.truncated) break;
    }
    checkAbort(signal);
    if (this.live) for (const event of session.index.events.values()) if ((event.ingest_seq ?? 0) > index.cursor) { try { index.add(event); } catch (ex) { index.warn(String(ex)); } }
    session.index = index; session.runs = runs; session.benchmarkRuns = known; session.loaded = Date.now();
  }
  /** AEP runs of one trace (a benchmark case's `aep_trace_id`) and their events. */
  private async loadTrace(session: Session, trace: string, signal: AbortSignal) {
    const index = new EventIndex();
    const payload = await this.get(`runs?${new URLSearchParams({ limit: '50', trace_id: trace })}`, signal);
    if (!Array.isArray(payload.runs)) throw new Error('Invalid runs envelope');
    // Older Agent Web builds ignore `trace_id`; filter here as well.
    const runs = payload.runs.filter((row): row is Row => isRecord(row) && row.trace_id === trace && typeof row.run_id === 'string');
    if (!runs.length) index.warn('No AEP run for this trace in the store (retention may have removed it)');
    for (const run of runs) {
      let after = -1;
      for (let page = 0; page < 20; page++) {
        const events = await this.get(`runs/${encodeURIComponent(String(run.run_id))}/events?after_sequence=${after}&limit=500`, signal);
        if (!Array.isArray(events.events)) throw new Error('Invalid events envelope');
        for (const raw of events.events) { const event = validateEvent(raw); index.add(event); index.cursor = Math.max(index.cursor, event.ingest_seq ?? 0); after = event.sequence; }
        if (events.next_sequence === null || !events.events.length) break;
      }
    }
    checkAbort(signal);
    session.index = index; session.runs = runs; session.loaded = Date.now();
  }
  private async load(session: Session, query: Row, signal: AbortSignal) {
    if (isBenchmarkView(query)) return this.loadBenchmarks(session, query, signal);
    if (typeof query.trace === 'string' && query.trace && !query.run_id) return this.loadTrace(session, query.trace, signal);
    const index = new EventIndex(), runs: Row[] = [], seen = new Set<string>();
    let cursor: string | null = null;
    const range = typeof query.time_range === 'string' ? query.time_range.split('/') : [];
    if (range.length && (range.length !== 2 || range.some(v => v && !Number.isFinite(Date.parse(v))))) throw new Error('Invalid AEP time range');
    if (range[0] && range[1] && Date.parse(range[0]) > Date.parse(range[1])) throw new Error('Time range start must precede end');
    // A bounded recent window avoids loading years of history before the newest events.
    const since = range[0] || (range[1] ? '' : new Date(Date.now() - 86400000).toISOString()), until = range[1];
    for (let page = 0; page < 10; page++) {
      const params = new URLSearchParams({ limit: '200' }); if (cursor) params.set('cursor', cursor);
      if (since) params.set('since', since); if (until) params.set('until', until);
      const payload = await this.get(`runs?${params}`, signal);
      if (!Array.isArray(payload.runs) || !(payload.next_cursor === null || typeof payload.next_cursor === 'string')) throw new Error('Invalid runs/next_cursor envelope');
      for (const row of payload.runs) { if (!isRecord(row) || typeof row.run_id !== 'string' || typeof row.complete !== 'boolean') throw new Error('Invalid AEP run summary'); if (!runs.some(r => r.run_id === row.run_id)) runs.push(row); }
      cursor = payload.next_cursor as string | null; if (!cursor) break;
      if (seen.has(cursor)) throw new Error('AEP runs cursor did not advance'); seen.add(cursor);
      if (page === 9) { index.truncated = true; index.warn('Run list capped at 2,000; narrow the time range'); }
    }
    let after = query.run_id ? -1 : 0;
    for (let page = 0; page < 20; page++) {
      const params = new URLSearchParams({ limit: '500' });
      const specific = typeof query.run_id === 'string' && query.run_id !== '';
      params.set(specific ? 'after_sequence' : 'after_ingest_seq', String(after));
      if (!specific) { if (since) params.set('since', since); if (until) params.set('until', until); }
      const payload = await this.get(`${specific ? `runs/${encodeURIComponent(String(query.run_id))}/events` : 'events'}?${params}`, signal);
      if (!Array.isArray(payload.events)) throw new Error('Invalid events envelope');
      const next = payload[specific ? 'next_sequence' : 'next_ingest_seq'];
      if (!(specific && next === null) && (!Number.isSafeInteger(next) || Number(next) < 0)) throw new Error('Invalid event cursor');
      let previousPosition = after;
      for (const raw of payload.events) {
        const event = validateEvent(raw); if (event.ingest_seq === undefined) throw new Error('REST event missing ingest_seq');
        const position = specific ? event.sequence : event.ingest_seq;
        if (position <= previousPosition) throw new Error('AEP events are not ordered after the requested cursor');
        previousPosition = position;
        if (specific && event.run_id !== query.run_id) throw new Error('AEP returned an event for the wrong run');
        try { index.add(event); } catch (ex) { if (!index.truncated) throw ex; index.warn(String(ex)); break; }
        index.cursor = Math.max(index.cursor, event.ingest_seq);
      }
      if (index.truncated) break;
      if (payload.events.length && next !== null && Number(next) !== previousPosition) throw new Error('AEP cursor does not match the returned events');
      if (!payload.events.length || (specific && next === null)) break;
      if (Number(next) <= after) throw new Error('AEP event cursor did not advance'); after = Number(next);
      if (page === 19) { index.truncated = true; index.warn('Event page limit reached; narrow the time range'); }
    }
    index.warn(query.run_id ? 'Selected run history; missing events are not reconstructed' : `History window: ${since} to ${until || 'now'}; retention and producer drops may leave gaps`);
    checkAbort(signal);
    // Keep events arriving during refresh; the index remains bounded.
    if (this.live) for (const event of session.index.events.values()) if ((event.ingest_seq ?? 0) > index.cursor) { try { index.add(event); } catch (ex) { index.warn(String(ex)); } }
    session.index = index; session.runs = runs; session.loaded = Date.now();
  }
  private view(session: Session, definition: SourceDefinition, query: Row): Dataset {
    const index = this.imported ?? session.index, view = String(query.view ?? 'runs');
    if (isBenchmarkView(query)) {
      const bench = deriveBenchmarks(index, query);
      const warnings = this.connectionWarning ? [this.connectionWarning, ...bench.warnings] : [...bench.warnings];
      if (this.imported) warnings.unshift('Offline JSONL replay; live connection disabled');
      const rows = view === 'benchmark_cases' ? bench.cases : view === 'benchmark_matrix' ? bench.matrix : bench.runs;
      return normalizeTable({ rows, meta: { warnings, truncated: index.truncated, sourceRows: index.events.size } }, { fields: definition.fields });
    }
    const derived = derive(index, query);
    const warnings = this.connectionWarning ? [this.connectionWarning, ...derived.warnings] : [...derived.warnings];
    if (this.imported) warnings.unshift('Offline JSONL replay; live connection disabled');
    const meta = { warnings, truncated: index.truncated, sourceRows: index.events.size };
    if (view === 'transitions') return normalizeGraph({ nodes: derived.nodes, edges: derived.transitions, meta });
    let rows: Row[] = view === 'events' ? derived.events : view === 'spans' ? derived.spans : view === 'state_metrics' ? derived.state_metrics : view === 'strategy_metrics' ? derived.strategy_metrics : derived.runs;
    if (view === 'runs' && !this.imported) {
      const derivedById = new Map(derived.runs.map(r => [r.run_id, r]));
      const hasEventFilter = !!query.model || !!query.skill;
      rows = session.runs.filter(row => (!query.run_id || row.run_id === query.run_id) && (!query.trace || row.trace_id === query.trace) && (!query.strategy || row.strategy_id === query.strategy) && (!query.status || row.status === query.status) && (!query.kind || row.run_kind === query.kind) && (!hasEventFilter || derivedById.has(row.run_id))).map(row => ({ ...row, ...(derivedById.get(row.run_id) ?? {}), events_loaded: index.events.size > 0 && derivedById.has(row.run_id) }));
      for (const row of derived.runs) if (!rows.some(r => r.run_id === row.run_id)) rows.push({ ...row, events_loaded: true });
      if (hasEventFilter) warnings.push('Model/skill filters use loaded events and preserve each matching run; unloaded runs cannot match');
    }
    return normalizeTable({ rows, meta }, { fields: definition.fields });
  }
  query = async (definition: SourceDefinition, query: Row, signal: AbortSignal): Promise<Dataset> => {
    if (this.disposed) throw new Error('AEP provider disposed'); checkAbort(signal);
    const session = this.session(query);
    if (!this.imported && Date.now() - session.loaded > 3000) {
      if (!session.promise || session.controller?.signal.aborted) {
        const controller = new AbortController(); session.controller = controller;
        const timer = setTimeout(() => controller.abort(new Error('AEP request timed out')), 9000);
        const promise = this.load(session, query, controller.signal).finally(() => { clearTimeout(timer); if (session.promise === promise) session.promise = undefined; }); session.promise = promise;
      }
      session.users++;
      try {
        await new Promise<void>((resolve, reject) => {
          const abort = () => { cleanup(); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
          const cleanup = () => signal.removeEventListener('abort', abort);
          signal.addEventListener('abort', abort, { once: true });
          session.promise!.then(() => { cleanup(); resolve(); }, ex => { cleanup(); reject(ex); }); if (signal.aborted) abort();
        });
      } catch (ex) {
        if (signal.aborted || !session.loaded) throw ex;
        const stale = this.view(session, definition, query);
        stale.meta.warnings.unshift('AEP refresh failed; retained data is stale: ' + String(ex));
        return stale;
      } finally { session.users--; if (!session.users) session.controller?.abort(); }
    }
    checkAbort(signal); return this.view(session, definition, query);
  };
  subscribe = (definition: SourceDefinition, query: Row, observer: DatasetObserver, signal: AbortSignal) => {
    const listener = { definition, query, observer }; this.listeners.add(listener);
    const stop = () => { this.listeners.delete(listener); signal.removeEventListener('abort', stop); if (!this.listeners.size) this.stopSocket(); };
    signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop(); else if (this.live && !this.socket) { this.connect(); this.monitorHealth(); }
    return stop;
  };
  private emit() {
    for (const listener of this.listeners) {
      try { listener.observer.next(this.view(this.session(listener.query), listener.definition, listener.query)); }
      catch (ex) { listener.observer.error(ex instanceof Error ? ex : new Error(String(ex))); }
    }
  }
  private error(message: string) {
    this.connectionWarning = message;
    for (const listener of this.listeners) {
      const session = this.session(listener.query);
      if (!session.loaded && !this.imported) { listener.observer.error(new Error(message)); continue; }
      try { const data = this.view(session, listener.definition, listener.query); data.meta.warnings.unshift(message); listener.observer.next(data); }
      catch { listener.observer.error(new Error(message)); }
    }
  }
  private monitorHealth() {
    if (!this.live || this.disposed || this.imported || !this.listeners.size) return;
    const generation = this.generation, controller = new AbortController(); this.healthController = controller;
    const timeout = setTimeout(() => controller.abort(), 5000);
    void this.get('health', controller.signal).then(health => {
      if (generation !== this.generation) return;
      if (!Number.isSafeInteger(health.last_ingest_seq) || Number(health.last_ingest_seq) < 0) throw new Error('Invalid AEP health cursor');
      if (Number(health.last_ingest_seq) < this.cursor) { this.error('AEP history cursor reset; retained data is stale. Reload AEP before resuming live updates.'); this.stopSocket(); return; }
      if (Number(health.dropped) > 0) {
        for (const session of this.sessions.values()) session.index.warn(`AEP producer reports ${health.dropped} dropped events; history may be incomplete`);
        this.emit();
      }
    }).catch(ex => { if (generation === this.generation) this.error(`AEP health unavailable; retained data is stale: ${String(ex)}`); }).finally(() => {
      clearTimeout(timeout);
      if (generation === this.generation && this.live) this.healthTimer = setTimeout(() => this.monitorHealth(), 15000);
    });
  }
  private stopSocket() {
    this.generation++; clearTimeout(this.healthTimer); this.healthController?.abort(); clearTimeout(this.timer); clearTimeout(this.emitTimer); this.emitTimer = undefined;
    if (this.socket) { this.socket.onmessage = null; this.socket.onerror = null; this.socket.onclose = null; this.socket.close(); this.socket = undefined; }
  }
  private connect() {
    if (!this.live || this.imported || this.disposed || !this.listeners.size) return;
    const generation = this.generation;
    // Resume from the oldest retained session, so every view gets its backfill.
    if (!this.cursor) this.cursor = Math.min(...[...this.sessions.values()].map(s => s.index.cursor));
    try { this.socket = this.deps.websocket ? this.deps.websocket(`${AEP_BASE.replace('http:', 'ws:')}/stream?after_ingest_seq=${this.cursor}`) : new WebSocket(`${AEP_BASE.replace('http:', 'ws:')}/stream?after_ingest_seq=${this.cursor}`); }
    catch (ex) { this.error(`AEP stream unavailable: ${String(ex)}`); return; }
    this.socket.onmessage = message => {
      if (generation !== this.generation || this.disposed) return;
      try {
        if (typeof message.data !== 'string' || new TextEncoder().encode(message.data).length > EVENT_BYTES) throw new Error('Invalid stream payload');
        const event = validateEvent(JSON.parse(message.data)); if (event.ingest_seq === undefined) throw new Error('Stream event missing ingest_seq');
        if (event.ingest_seq < this.cursor) throw new Error('AEP cursor moved backwards; reconnect with a fresh history');
        const gap = event.ingest_seq > this.cursor + 1;
        for (const [key, session] of this.sessions) {
          const [runId, range, trace] = JSON.parse(key) as string[];
          if (gap) session.index.warn('Noncontiguous ingest cursor: retention, dropped events or duplicate inserts may explain gaps');
          if (runId === BENCHMARKS) { if (!acceptBenchmark(session, event)) continue; }
          else if (runId && event.run_id !== runId) continue;
          if (trace && event.trace_id !== trace) continue;
          const [from, to] = range.split('/'); const stamp = Date.parse(event.timestamp);
          if ((from && stamp < Date.parse(from)) || (to && stamp > Date.parse(to))) continue;
          session.index.add(event); session.index.cursor = event.ingest_seq;
        }
        this.cursor = event.ingest_seq; this.connectionWarning = '';
        if (!this.emitTimer) this.emitTimer = setTimeout(() => { this.emitTimer = undefined; this.emit(); }, 200);
      } catch (ex) { this.error(`AEP stream stopped; retained data is stale: ${String(ex)}`); this.stopSocket(); }
    };
    this.socket.onerror = () => this.error('AEP stream disconnected; retained data is stale');
    this.socket.onclose = () => {
      this.socket = undefined; if (generation !== this.generation || !this.live) return;
      if (this.attempts >= 3) { this.error('AEP reconnect limit reached; toggle Live to retry'); return; }
      this.error('AEP stream disconnected; reconnecting from last processed cursor');
      this.timer = setTimeout(() => this.connect(), (this.deps.retryMs ?? 500) * 2 ** this.attempts++);
    };
  }
  setLive(enabled: boolean) { this.stopSocket(); this.live = enabled; this.connectionWarning = ''; this.attempts = 0; if (enabled) { this.connect(); this.monitorHealth(); } }
  importJSONL(text: string) { const index = parseJSONL(text); if (!index.events.size) throw new Error([...index.warnings].join('; ') || 'No valid telemetry events'); this.stopSocket(); this.live = false; this.connectionWarning = ''; this.imported = index; for (const session of this.sessions.values()) session.controller?.abort(); this.emit(); return { events: index.events.size, warnings: [...index.warnings] }; }
  useServer() { this.stopSocket(); this.live = false; this.connectionWarning = ''; this.imported = undefined; this.cursor = 0; for (const session of this.sessions.values()) { session.controller?.abort(); session.loaded = 0; session.index = new EventIndex(); session.runs = []; } }
  dispose() { this.disposed = true; this.stopSocket(); for (const session of this.sessions.values()) session.controller?.abort(); this.listeners.clear(); this.sessions.clear(); }
}
