import { checkAbort, isRecord, MAX_BYTES, normalizeTable } from '../dataset.ts';
import type { Row, SourceDefinition, TabularDataset } from '../types';
import type { DatasetObserver, SourceProvider } from '../sources.ts';

declare const __AEP_BI_PORT__: string | undefined;
export function biBase(port = '53583') {
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid AEP BI loopback port');
  return `http://127.0.0.1:${Number(port)}/api/v1/bi`;
}
export const BI_BASE = biBase(typeof __AEP_BI_PORT__ === 'undefined' ? undefined : __AEP_BI_PORT__);
export interface BiVersion extends Row { tag: string | null; commit: string }
export interface BiVault extends Row { id: string; dataset: string; title: string; purpose: string; schema: string; reads: BiVersion }
export interface BiParam extends Row { type: 'enum' | 'bool' | 'date' | 'text'; default: string | boolean | number | null; values_from?: string; values?: string[] }
export interface BiAnalysis extends Row {
  slug: string; title: string; question: string; kind: string;
  chart: Row & { type: 'table' | 'bar' | 'line' | 'scatter'; x?: string; y?: string; series?: string };
  params: Record<string, BiParam>; requires: Row; digest: string;
}
export interface BiCatalog extends Row { vault: string; version: BiVersion; order: string[]; analyses: BiAnalysis[] }
export interface BiResult extends Row { slug: string; digest: string; version: BiVersion; params: Row; columns: string[]; rows: unknown[][]; truncated: boolean; computed_at: string }
export type BiState = 'ready' | 'waiting' | 'offline' | 'stale' | 'error';
export interface BiSnapshot<T> { state: BiState; data?: T; message?: string }
class FeedError extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.code = code; } }
function object(value: unknown): Row { if (!isRecord(value)) throw new Error('Invalid BI object'); return value; }
function string(value: unknown): asserts value is string { if (typeof value !== 'string' || value.length > 65536) throw new Error('Invalid BI string'); }
function list(value: unknown, limit: number): unknown[] { if (!Array.isArray(value) || value.length > limit) throw new Error('BI array exceeds its bound or is invalid'); return value; }
function strings(value: unknown, limit: number): string[] { const items = list(value, limit); items.forEach(string); return items as string[]; }
function version(value: unknown) { const v = object(value); if (v.tag !== null) string(v.tag); string(v.commit); }
export function validateHealth(value: unknown): Row { const v = object(value); if (v.format !== 'aep.bi.analysis_feed/v1' || v.ok !== true) throw new Error('Unsupported BI feed'); return v; }
export function validateVaults(value: unknown): Row & { vaults: BiVault[] } {
  const v = object(value), ids = new Set<string>();
  for (const raw of list(v.vaults, 256)) { const vault = object(raw); for (const key of ['id', 'dataset', 'title', 'purpose', 'schema']) string(vault[key]); version(vault.reads); if (!vault.id || ids.has(String(vault.id))) throw new Error('Invalid or duplicate BI vault'); ids.add(String(vault.id)); }
  return v as Row & { vaults: BiVault[] };
}
export function validateCatalog(value: unknown): BiCatalog {
  const v = object(value); string(v.vault); version(v.version); const order = strings(v.order, 128), ids = new Set<string>();
  for (const raw of list(v.analyses, 128)) {
    const a = object(raw); for (const key of ['slug', 'title', 'question', 'kind', 'digest']) string(a[key]);
    if (!a.slug || ids.has(String(a.slug))) throw new Error('Invalid or duplicate BI analysis'); ids.add(String(a.slug));
    const chart = object(a.chart); if (!['table', 'bar', 'line', 'scatter'].includes(String(chart.type))) throw new Error('Unsupported BI chart');
    for (const key of ['x', 'y', 'series']) if (chart[key] !== undefined) string(chart[key]);
    if (chart.type !== 'table' && (!chart.x || !chart.y)) throw new Error('BI chart requires x and y');
    const params = object(a.params); if (Object.keys(params).length > 64) throw new Error('Too many BI parameters');
    for (const p of Object.values(params)) { const param = object(p); if (!['enum', 'bool', 'date', 'text'].includes(String(param.type))) throw new Error('Invalid BI parameter type'); if (!Object.hasOwn(param, 'default') || !(param.default === null || ['string', 'boolean', 'number'].includes(typeof param.default))) throw new Error('Invalid BI parameter default'); if (param.values_from !== undefined) string(param.values_from); if (param.type === 'enum') strings(param.values, 20000); }
    object(a.requires);
  }
  if (new Set(order).size !== order.length || order.some(slug => !ids.has(slug))) throw new Error('Invalid BI analysis order');
  return v as BiCatalog;
}
export function validateResult(value: unknown): BiResult {
  const v = object(value); string(v.slug); string(v.digest); version(v.version); object(v.params); const columns = strings(v.columns, 256);
  if (new Set(columns).size !== columns.length) throw new Error('Duplicate BI columns');
  for (const row of list(v.rows, 20000)) if (list(row, 256).length !== columns.length) throw new Error('BI row width does not match columns');
  if (typeof v.truncated !== 'boolean') throw new Error('Invalid BI truncated flag'); string(v.computed_at); if (!Number.isFinite(Date.parse(v.computed_at))) throw new Error('Invalid BI computed_at');
  return v as BiResult;
}

/** Dedicated read-only feed. Cache identity includes all parameters; never label another query's result as current. */
export class AepBiProvider implements SourceProvider {
  private cache = new Map<string, unknown>();
  private controllers = new Set<AbortController>();
  private subscriptions = new Set<() => void>();
  private disposed = false;
  private deps: { fetch?: typeof fetch; timeoutMs?: number; retryMs?: number };
  constructor(deps: { fetch?: typeof fetch; timeoutMs?: number; retryMs?: number } = {}) { this.deps = deps; }
  private async read<T>(path: string, validate: (value: unknown) => T, signal: AbortSignal): Promise<BiSnapshot<T>> {
    checkAbort(signal); if (this.disposed) throw new Error('BI provider disposed');
    const controller = new AbortController(), abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true }); this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(new Error('BI read timed out')), this.deps.timeoutMs ?? 8000);
    let received = false;
    try {
      const response = await (this.deps.fetch ?? globalThis.fetch)(`${BI_BASE}/${path}`, { method: 'GET', signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store' });
      received = true;
      if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) throw new Error('BI response must be JSON');
      if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('BI payload exceeds 8 MiB');
      let text = '', size = 0;
      if (response.body) {
        const reader = response.body.getReader(), decoder = new TextDecoder();
        try { while (true) { checkAbort(controller.signal); const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > MAX_BYTES) throw new Error('BI payload exceeds 8 MiB'); text += decoder.decode(part.value, { stream: true }); } text += decoder.decode(); }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      } else { text = await response.text(); if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('BI payload exceeds 8 MiB'); }
      checkAbort(controller.signal); const raw: unknown = JSON.parse(text);
      if (!response.ok) { const error = object(raw); if (error.ok !== false) throw new Error('Invalid BI error envelope'); string(error.code); string(error.message); if (response.status === 409 && error.code === 'result_not_ready') return { state: 'waiting', data: this.cache.get(path) as T | undefined, message: error.message }; throw new FeedError(error.code, error.message); }
      const data = validate(raw); checkAbort(controller.signal);
      // LRU plus a total byte bound; results are never persisted into Atlas assets.
      this.cache.delete(path); this.cache.set(path, data);
      while (this.cache.size > 128 || new TextEncoder().encode(JSON.stringify([...this.cache])).length > MAX_BYTES) this.cache.delete(this.cache.keys().next().value!);
      return { state: 'ready', data };
    } catch (ex) {
      checkAbort(signal); if (this.disposed) throw ex;
      const data = this.cache.get(path) as T | undefined;
      return { state: ex instanceof FeedError ? 'error' : data ? 'stale' : !received || controller.signal.aborted ? 'offline' : 'error', data, message: String(ex instanceof Error ? ex.message : ex) };
    } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); this.controllers.delete(controller); }
  }
  health(signal: AbortSignal) { return this.read('health', validateHealth, signal); }
  vaults(signal: AbortSignal) { return this.read('vaults', validateVaults, signal); }
  analyses(vault: string, signal: AbortSignal) { return this.read(`vaults/${encodeURIComponent(vault)}/analyses`, value => { const data = validateCatalog(value); if (data.vault !== vault) throw new Error('Wrong BI vault'); return data; }, signal); }
  result(vault: string, slug: string, params: Row, signal: AbortSignal) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params).sort(([a], [b]) => a.localeCompare(b))) { if (!['string', 'boolean', 'number'].includes(typeof value) && value !== null) throw new Error('Invalid BI parameter'); if (value !== null) search.set(key, String(value)); }
    const suffix = search.size ? `?${search}` : '';
    return this.read(`vaults/${encodeURIComponent(vault)}/analyses/${encodeURIComponent(slug)}/result${suffix}`, value => { const data = validateResult(value); if (data.slug !== slug) throw new Error('Wrong BI analysis'); return data; }, signal);
  }
  async query(_definition: SourceDefinition, query: Row, signal: AbortSignal): Promise<TabularDataset> {
    if (typeof query.vault !== 'string' || typeof query.slug !== 'string') throw new Error('BI result needs a vault and slug');
    const snapshot = await this.result(query.vault, query.slug, object(query.params ?? {}), signal);
    return resultDataset(snapshot);
  }
  subscribe(definition: SourceDefinition, query: Row, observer: DatasetObserver, signal: AbortSignal) {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, waiting = 0;
    const stop = () => { controller.abort(); clearTimeout(timer); signal.removeEventListener('abort', stop); this.subscriptions.delete(stop); };
    const poll = async () => {
      try {
        const data = await this.query(definition, query, controller.signal); if (controller.signal.aborted) return; observer.next(data);
        const isWaiting = data.meta.warnings.some(warning => warning.startsWith('AEP BI waiting:'));
        if (isWaiting && ++waiting >= 3) { stop(); return; }
        if (!isWaiting) waiting = 0;
        timer = setTimeout(() => void poll(), isWaiting ? this.deps.retryMs ?? 1000 : 15000);
      } catch (ex) { if (!controller.signal.aborted) observer.error(ex instanceof Error ? ex : new Error(String(ex))); }
    };
    this.subscriptions.add(stop); signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted || this.disposed) stop(); else timer = setTimeout(() => void poll(), this.deps.retryMs ?? 1000);
    return stop;
  }
  dispose() { this.disposed = true; for (const stop of this.subscriptions) stop(); for (const controller of this.controllers) controller.abort(); this.controllers.clear(); this.cache.clear(); }
}
export function resultDataset(snapshot: BiSnapshot<BiResult>): TabularDataset {
  const result = snapshot.data;
  const rows = result?.rows.map(row => Object.fromEntries(result.columns.map((column, index) => [column, row[index]]))) ?? [];
  return normalizeTable({ rows, meta: { warnings: snapshot.state === 'ready' ? [] : [`AEP BI ${snapshot.state}: ${snapshot.message ?? ''}${result ? ' (last data retained)' : ''}`], truncated: result?.truncated ?? false, sourceRows: rows.length } });
}
