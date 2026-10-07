import { checkAbort, isRecord, MAX_BYTES, normalizeDataset, parseCSV, rowCap } from "./dataset.ts";
import type { ApplicationDefinition, Dataset, DatasetField, Row, SourceDefinition, VariableDefinition } from "./types";
export interface DatasetObserver { next: (value: Dataset) => void; error: (error: Error) => void; complete?: () => void }
export interface SourceProvider {
  describe?: (definition: SourceDefinition, signal?: AbortSignal) => Promise<{ fields?: DatasetField[]; live?: boolean }>;
  query: (definition: SourceDefinition, query: Row, signal: AbortSignal) => Promise<unknown>;
  subscribe?: (definition: SourceDefinition, query: Row, observer: DatasetObserver, signal: AbortSignal) => () => void;
  dispose?: () => void;
}
export interface RuntimeDependencies {
  fetch?: typeof fetch;
  websocket?: (url: string) => WebSocket;
  providers?: Record<string, SourceProvider>;
  variableDefinitions?: VariableDefinition[] | (() => VariableDefinition[]);
  timeoutMs?: number;
  maxBytes?: number;
}
interface CacheEntry { promise: Promise<Dataset>; controller: AbortController; consumers: number; value?: Dataset; at: number }
interface LiveEntry { observers: Set<DatasetObserver>; stop: () => void; latest?: Dataset }
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, ex => { signal.removeEventListener("abort", abort); reject(ex); });
    if (signal.aborted) abort();
  });
}
function error(ex: unknown): Error { return ex instanceof Error ? ex : new Error(String(ex)); }
function queryKey(id: string, definition: SourceDefinition, query: Row): string {
  // File/REST providers return a shared raw snapshot; their filters are local.
  // Trusted custom providers can execute distinct server-side queries.
  return `${id}:${definition.type === "custom" ? stable(query) : "snapshot"}`;
}
function stable(value: unknown): string { return JSON.stringify(value, (_k, v) => isRecord(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v); }
export function sourceURL(value: string, websocket = false): string {
  const url = new URL(value, typeof location !== "undefined" ? location.href : "http://localhost/");
  if (!(websocket ? ["ws:", "wss:"] : ["http:", "https:"]).includes(url.protocol)) throw new Error("Unsupported source URL protocol");
  if (url.username || url.password) throw new Error("Source URLs cannot contain credentials");
  if ([...url.searchParams.keys()].some(k => /^(token|api[_-]?key|password|secret|authorization)$/i.test(k))) throw new Error("Source URLs cannot contain secrets");
  return url.href;
}
async function boundedText(response: Response, limit: number, signal: AbortSignal): Promise<string> {
  if (!response.ok) throw new Error(`Source request failed (${response.status})`);
  const size = Number(response.headers.get("content-length")); if (size > limit) throw new Error("Source payload exceeds size limit");
  if (!response.body) { const text = await response.text(); if (new TextEncoder().encode(text).length > limit) throw new Error("Source payload exceeds size limit"); return text; }
  const reader = response.body.getReader(), decoder = new TextDecoder(); let count = 0, text = "";
  try { while (true) { checkAbort(signal); const chunk = await reader.read(); if (chunk.done) break; count += chunk.value.byteLength; if (count > limit) throw new Error("Source payload exceeds size limit"); text += decoder.decode(chunk.value, { stream: true }); } return text + decoder.decode(); }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
/** Application-scoped providers with bounded snapshots and shared live connections. */
export class SourceRegistry {
  private app: ApplicationDefinition;
  private deps: RuntimeDependencies;
  private cache = new Map<string, CacheEntry>();
  private live = new Map<string, LiveEntry>();
  private providers = new Map<string, SourceProvider>();
  private disposed = false;
  constructor(app: ApplicationDefinition, deps: RuntimeDependencies = {}) { this.app = app; this.deps = deps; for (const [id, provider] of Object.entries(deps.providers ?? {})) this.registerProvider(id, provider); }
  registerProvider(id: string, provider: SourceProvider) { if (!id || this.providers.has(id)) throw new Error(`Provider already registered or invalid: ${id}`); this.providers.set(id, provider); }
  definition(id: string): SourceDefinition {
    if (this.disposed) throw new Error("Runtime was disposed");
    const definition = this.app.sources[id]; if (!definition) throw new Error(`Unknown data source: ${id}`);
    if (!["json", "csv", "rest", "websocket", "custom"].includes(definition.type)) throw new Error(`Unsupported source type: ${definition.type}`);
    if (definition.format !== undefined && !["table", "graph"].includes(definition.format)) throw new Error("Invalid source dataset format");
    if (definition.refresh !== undefined && (!Number.isFinite(definition.refresh) || definition.refresh < 0)) throw new Error("Invalid source refresh interval");
    if (definition.bindings !== undefined && (!isRecord(definition.bindings) || Object.values(definition.bindings).some(v => typeof v !== "string" || !v))) throw new Error("Source bindings must map fields to variable names");
    rowCap(definition.maxRows); return definition;
  }
  async describe(id: string, signal?: AbortSignal) {
    const definition = this.definition(id); checkAbort(signal);
    if (definition.type === "custom") { const provider = this.providers.get(definition.provider ?? ""); if (!provider) throw new Error(`Unknown custom provider: ${definition.provider}`); return provider.describe?.(definition, signal) ?? { fields: definition.fields, live: !!provider.subscribe }; }
    return { fields: definition.fields, live: definition.type === "websocket" || !!definition.refresh };
  }
  invalidate(id?: string) {
    // Refreshes evict settled snapshots, never abort another panel's in-flight request.
    // Concurrent refreshes of the same key share the new request already in progress.
    for (const [key, entry] of this.cache) if ((!id || key.startsWith(`${id}:`)) && entry.value) this.cache.delete(key);
  }
  async query(id: string, query: Row = {}, signal?: AbortSignal): Promise<Dataset> {
    const definition = this.definition(id); checkAbort(signal);
    if (definition.type === "websocket") return this.socketQuery(id, query, signal);
    const merged = { ...(definition.query ?? {}), ...query }, key = queryKey(id, definition, merged);
    let entry = this.cache.get(key);
    if (entry?.controller.signal.aborted) { this.cache.delete(key); entry = undefined; }
    const ttl = definition.refresh ? Math.max(100, definition.refresh * 1000) : 30000;
    if (entry?.value && Date.now() - entry.at > ttl) { this.cache.delete(key); entry = undefined; }
    if (!entry) {
      if (this.cache.size >= 64) {
        const oldest = [...this.cache].find(([, cached]) => cached.consumers === 0);
        if (!oldest) throw new Error("Too many concurrent source queries (maximum 64)");
        oldest[1].controller.abort(); this.cache.delete(oldest[0]);
      }
      const controller = new AbortController();
      const created: CacheEntry = { controller, consumers: 0, at: Date.now(), promise: Promise.resolve(null as unknown as Dataset) };
      created.promise = this.load(definition, merged, controller.signal).then(value => { created.value = value; created.at = Date.now(); return value; }).catch(ex => { if (this.cache.get(key) === created) this.cache.delete(key); throw ex; });
      this.cache.set(key, created); entry = created;
      if (this.cache.size > 64) { const oldest = [...this.cache].find(([k, e]) => k !== key && e.consumers === 0); if (oldest) { oldest[1].controller.abort(); this.cache.delete(oldest[0]); } }
    }
    return this.consume(entry, signal);
  }
  private consume(entry: CacheEntry, signal?: AbortSignal): Promise<Dataset> {
    entry.consumers++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => { if (done) return; done = true; signal?.removeEventListener("abort", abort); entry.consumers--; if (!entry.consumers && !entry.value) entry.controller.abort(); fn(); };
      const abort = () => finish(() => reject(signal?.reason ?? new DOMException("Aborted", "AbortError")));
      signal?.addEventListener("abort", abort, { once: true });
      entry.promise.then(value => finish(() => resolve(value)), ex => finish(() => reject(ex)));
      if (signal?.aborted) abort();
    });
  }
  private async load(definition: SourceDefinition, query: Row, signal: AbortSignal): Promise<Dataset> {
    const controller = new AbortController(), abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    const timeout = setTimeout(() => controller.abort(new Error("Source request timed out")), this.deps.timeoutMs ?? 10000);
    try {
      checkAbort(controller.signal);
      if (definition.type === "custom") {
        const provider = this.providers.get(definition.provider ?? ""); if (!provider) throw new Error(`Unknown custom provider: ${definition.provider}`);
        const raw = await abortable(provider.query(definition, query, controller.signal), controller.signal); checkAbort(controller.signal); return normalizeDataset(raw, definition);
      }
      let raw = definition.data;
      if (raw === undefined) {
        const url = definition.url ?? definition.path; if (!url) throw new Error("Source has no inline data or URL");
        const response = await abortable((this.deps.fetch ?? globalThis.fetch)(sourceURL(url), { signal: controller.signal, credentials: "same-origin", redirect: "error" }), controller.signal);
        const text = await abortable(boundedText(response, Math.min(this.deps.maxBytes ?? MAX_BYTES, MAX_BYTES), controller.signal), controller.signal);
        raw = definition.type === "csv" ? parseCSV(text, definition.maxRows) : JSON.parse(text);
      } else if (definition.type === "csv") { if (typeof raw !== "string") throw new Error("CSV data must be text"); raw = parseCSV(raw, definition.maxRows); }
      checkAbort(controller.signal); return normalizeDataset(raw, definition);
    } finally { clearTimeout(timeout); signal.removeEventListener("abort", abort); }
  }
  private socketQuery(id: string, query: Row, signal?: AbortSignal): Promise<Dataset> {
    return new Promise((resolve, reject) => {
      let stop: (() => void) | undefined, done = false;
      const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timeout); signal?.removeEventListener("abort", abort); fn(); queueMicrotask(() => stop?.()); };
      const timeout = setTimeout(() => finish(() => reject(new Error("WebSocket did not produce a snapshot before timeout"))), this.deps.timeoutMs ?? 10000);
      const abort = () => finish(() => reject(signal?.reason ?? new DOMException("Aborted", "AbortError")));
      signal?.addEventListener("abort", abort, { once: true });
      try { stop = this.subscribe(id, query, { next: value => finish(() => resolve(value)), error: ex => finish(() => reject(ex)) }); }
      catch (ex) { finish(() => reject(ex)); }
      if (signal?.aborted) abort();
    });
  }
  subscribe(id: string, query: Row, observer: DatasetObserver, signal?: AbortSignal): () => void {
    const definition = this.definition(id); checkAbort(signal);
    const merged = { ...(definition.query ?? {}), ...query }, key = definition.type === "websocket" ? `${id}:socket` : queryKey(id, definition, merged);
    let entry = this.live.get(key);
    if (!entry) {
      entry = { observers: new Set(), stop: () => {} }; this.live.set(key, entry);
      const current = entry, controller = new AbortController();
      const emit: DatasetObserver = { next: data => { current.latest = data; for (const o of [...current.observers]) o.next(data); }, error: ex => { for (const o of [...current.observers]) o.error(ex); }, complete: () => { for (const o of [...current.observers]) o.complete?.(); } };
      let cleanup = () => {};
      try {
        if (definition.type === "websocket") cleanup = this.openSocket(definition, emit, controller.signal);
        else if (definition.type === "custom" && this.providers.get(definition.provider ?? "")?.subscribe) {
          cleanup = this.providers.get(definition.provider!)!.subscribe!(definition, merged, { ...emit, next: data => emit.next(normalizeDataset(data, definition)) }, controller.signal);
        } else if (definition.refresh) {
          let timer: ReturnType<typeof setTimeout>;
          const poll = async () => { try { this.invalidate(id); emit.next(await this.query(id, query, controller.signal)); } catch (ex) { if (!controller.signal.aborted) emit.error(error(ex)); } finally { if (!controller.signal.aborted) timer = setTimeout(poll, Math.max(250, definition.refresh! * 1000)); } };
          timer = setTimeout(poll, Math.max(250, definition.refresh * 1000)); cleanup = () => clearTimeout(timer);
        }
      } catch (ex) { this.live.delete(key); controller.abort(); throw ex; }
      entry.stop = () => { controller.abort(); cleanup(); };
    }
    entry.observers.add(observer); if (entry.latest) queueMicrotask(() => { if (entry!.observers.has(observer)) observer.next(entry!.latest!); });
    let stopped = false;
    const stop = () => { if (stopped) return; stopped = true; signal?.removeEventListener("abort", stop); entry!.observers.delete(observer); if (!entry!.observers.size) {
      // Allow query() -> subscribe() to reuse the first socket snapshot.
      setTimeout(() => { if (!entry!.observers.size && this.live.get(key) === entry) { entry!.stop(); this.live.delete(key); } }, 100);
    } };
    signal?.addEventListener("abort", stop, { once: true }); return stop;
  }
  private openSocket(definition: SourceDefinition, observer: DatasetObserver, signal: AbortSignal): () => void {
    if (!definition.url) throw new Error("WebSocket source requires url");
    const url = sourceURL(definition.url, true); let socket: WebSocket | undefined, timer: ReturnType<typeof setTimeout> | undefined, attempts = 0, stopped = false;
    const connect = () => {
      if (stopped || signal.aborted) return;
      try { socket = this.deps.websocket ? this.deps.websocket(url) : new WebSocket(url); }
      catch (ex) { observer.error(error(ex)); return; }
      socket.onmessage = event => {
        if (stopped) return;
        try { if (typeof event.data !== "string" || new TextEncoder().encode(event.data).length > Math.min(this.deps.maxBytes ?? MAX_BYTES, MAX_BYTES)) throw new Error("WebSocket message must be bounded JSON text"); observer.next(normalizeDataset(JSON.parse(event.data), definition)); }
        catch (ex) { observer.error(error(ex)); }
      };
      socket.onerror = () => { if (!stopped) observer.error(new Error("WebSocket connection error")); };
      socket.onclose = () => { if (stopped || signal.aborted) return; if (attempts >= 3) { observer.error(new Error("WebSocket reconnect limit reached")); return; } timer = setTimeout(connect, 250 * 2 ** attempts++); };
    };
    const stop = () => { if (stopped) return; stopped = true; clearTimeout(timer); signal.removeEventListener("abort", stop); if (socket) { socket.onclose = null; socket.onerror = null; socket.onmessage = null; socket.close(); } };
    signal.addEventListener("abort", stop, { once: true }); connect(); return stop;
  }
  dispose() { if (this.disposed) return; this.disposed = true; for (const entry of this.cache.values()) entry.controller.abort(); for (const entry of this.live.values()) entry.stop(); for (const provider of this.providers.values()) provider.dispose?.(); this.cache.clear(); this.live.clear(); }
}
