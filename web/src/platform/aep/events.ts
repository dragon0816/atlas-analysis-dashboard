import { isRecord, MAX_BYTES } from '../dataset.ts';
import type { Row } from '../types';
export const EVENT_LIMIT = 10000;
export const EVENT_BYTES = 65536;
export interface TelemetryEvent extends Row {
  schema_version: 'aep.telemetry.v1'; event_id: string; run_id: string; trace_id: string;
  span_id: string; parent_span_id: string | null; sequence: number; timestamp: string;
  event_type: string; state: string | null; status: string; attributes: Row; ingest_seq?: number;
}
const bytes = (value: string) => new TextEncoder().encode(value).length;
export function validateEvent(value: unknown): TelemetryEvent {
  if (!isRecord(value) || value.schema_version !== 'aep.telemetry.v1') throw new Error('Unsupported telemetry schema_version');
  if (bytes(JSON.stringify(value)) > EVENT_BYTES) throw new Error('Event exceeds 64 KiB');
  for (const key of ['event_id', 'run_id', 'trace_id', 'span_id', 'timestamp', 'event_type']) {
    if (typeof value[key] !== 'string' || !value[key] || (value[key] as string).length > 512) throw new Error(`Invalid ${key}`);
  }
  if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0) throw new Error('Invalid sequence');
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(String(value.timestamp)) || !Number.isFinite(Date.parse(String(value.timestamp)))) throw new Error('Invalid timestamp with timezone');
  for (const key of ['parent_span_id', 'state']) if (value[key] !== null && (typeof value[key] !== 'string' || (value[key] as string).length > 512)) throw new Error(`Invalid ${key}`);
  if (!['started', 'succeeded', 'failed', 'skipped', 'cancelled'].includes(String(value.status))) throw new Error('Invalid status');
  if (!isRecord(value.attributes)) throw new Error('Invalid attributes');
  if (value.ingest_seq !== undefined && (!Number.isSafeInteger(value.ingest_seq) || Number(value.ingest_seq) < 1)) throw new Error('Invalid ingest_seq');
  const visit = (item: unknown, depth = 0): void => {
    if (depth > 8) throw new Error('Event nesting exceeds limit');
    if (Array.isArray(item)) { if (item.length > 256) throw new Error('Attribute array exceeds limit'); item.forEach(v => visit(v, depth + 1)); }
    else if (isRecord(item)) { if (Object.keys(item).length > 256) throw new Error('Attribute fields exceed limit'); Object.values(item).forEach(v => visit(v, depth + 1)); }
    else if (item !== null && !['number', 'string', 'boolean'].includes(typeof item)) throw new Error('Invalid attribute value');
    else if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Invalid attribute number');
  };
  visit(value);
  return value as TelemetryEvent;
}
const canonical = (event: TelemetryEvent) => JSON.stringify(event, (key, value) => key === 'ingest_seq' ? undefined : isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value);
export class EventIndex {
  readonly events = new Map<string, TelemetryEvent>();
  readonly warnings = new Set<string>();
  truncated = false;
  sizeBytes = 0;
  cursor = 0;
  warn(message: string) { if (this.warnings.size < 80) this.warnings.add(message); }
  add(raw: unknown): boolean {
    const event = validateEvent(raw), previous = this.events.get(event.event_id);
    if (previous) {
      if (canonical(previous) !== canonical(event)) throw new Error(`Conflicting event_id ${event.event_id}`);
      return false;
    }
    const size = bytes(JSON.stringify(event));
    if (this.events.size >= EVENT_LIMIT || this.sizeBytes + size > MAX_BYTES) { this.truncated = true; throw new Error('Telemetry retention limit reached; narrow the time range or import a smaller file'); }
    this.events.set(event.event_id, structuredClone(event)); this.sizeBytes += size;
    return true;
  }
  ordered() { return [...this.events.values()].sort((a, b) => a.run_id.localeCompare(b.run_id) || a.sequence - b.sequence || a.event_id.localeCompare(b.event_id)); }
}
export function parseJSONL(text: string): EventIndex {
  if (bytes(text) > MAX_BYTES) throw new Error('JSONL exceeds 8 MiB');
  const index = new EventIndex(); let invalid = 0;
  text.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try { if (bytes(line) > EVENT_BYTES) throw new Error('Line exceeds 64 KiB'); index.add(JSON.parse(line)); }
    catch (ex) { invalid++; index.warn(`Line ${i + 1}: ${ex instanceof Error ? ex.message : 'Invalid JSON'}`); }
  });
  if (invalid) index.warn(`${invalid} invalid lines excluded; imported data is partial`);
  return index;
}
export const numeric = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function quantile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), at = (sorted.length - 1) * p, low = Math.floor(at);
  return sorted[low] + (sorted[Math.ceil(at)] - sorted[low]) * (at - low);
}
export interface Derived { runs: Row[]; spans: Row[]; events: Row[]; transitions: Row[]; nodes: Row[]; state_metrics: Row[]; strategy_metrics: Row[]; warnings: string[] }
export function derive(index: EventIndex, filters: Row = {}): Derived {
  const result: Derived = { runs: [], spans: [], events: [], transitions: [], nodes: [], state_metrics: [], strategy_metrics: [], warnings: [...index.warnings] };
  const warn = (s: string) => { if (result.warnings.length < 100 && !result.warnings.includes(s)) result.warnings.push(s); };
  const groups = new Map<string, TelemetryEvent[]>();
  for (const event of index.ordered()) { const group = groups.get(event.run_id) ?? []; group.push(event); groups.set(event.run_id, group); }
  const nodeIds = new Set<string>(), edges = new Map<string, Row>(), cells = new Map<string, Row>();
  for (const [runId, events] of groups) {
    const starts = events.filter(e => e.event_type === 'run.started'), ends = events.filter(e => e.event_type === 'run.completed');
    const start = starts[0], end = ends.at(-1), attrs = start?.attributes ?? {};
    const models = [...new Set(events.map(e => e.attributes.model_alias).filter(v => typeof v === 'string'))];
    const skills = [...new Set(events.flatMap(e => [e.attributes.skill_id, ...(Array.isArray(e.attributes.skill_ids) ? e.attributes.skill_ids : [])]).filter(v => typeof v === 'string'))];
    const status = end?.status ?? 'started', strategy = String(attrs.strategy_id ?? 'unknown');
    const match = (key: string, values: unknown[]) => filters[key] == null || filters[key] === '' || filters[key] === '*' || values.includes(filters[key]);
    if (!match('run_id', [runId]) || !match('strategy', [strategy]) || !match('status', [status]) || !match('model', models) || !match('skill', skills) || !match('kind', [attrs.run_kind])) continue;
    if (typeof filters.time_range === 'string' && filters.time_range.includes('/')) {
      const [from, to] = filters.time_range.split('/'), stamp = Date.parse(start?.timestamp ?? events[0].timestamp);
      if ((from && stamp < Date.parse(from)) || (to && stamp > Date.parse(to))) continue;
    }
    let contiguous = events[0].sequence === 0;
    for (let i = 1; i < events.length; i++) if (events[i].sequence !== events[i - 1].sequence + 1) contiguous = false;
    if (!contiguous) warn(`Run ${runId}: sequence gap or conflicting sequence; metrics may be partial`);
    if (starts.length !== 1 || ends.length > 1) warn(`Run ${runId}: missing or repeated lifecycle events`);
    const complete = !!start && !!end && contiguous && starts.length === 1 && ends.length === 1;
    const calls = events.filter(e => e.event_type === 'llm.completed'), reports = calls.filter(e => numeric(e.attributes.input_tokens) !== null);
    const sumTokens = (key: string) => { const values = calls.map(e => numeric(e.attributes[key])).filter((n): n is number => n !== null); return values.length ? values.reduce((a, b) => a + b, 0) : null; };
    const llmCalls = numeric(end?.attributes.llm_calls) ?? calls.length;
    const tokenReports = reports.length; if (numeric(end?.attributes.token_reports) !== null && end?.attributes.token_reports !== tokenReports) warn(`Run ${runId}: token report coverage differs from producer summary`);
    result.runs.push({ run_id: runId, run_kind: attrs.run_kind ?? null, strategy_id: strategy, skill_id: attrs.skill_id ?? null, model_alias: attrs.model_alias ?? null, models, skills, status, complete, started_at: start?.timestamp ?? null, ended_at: end?.timestamp ?? null, duration_ms: complete ? numeric(end?.attributes.duration_ms) : null, input_tokens: sumTokens('input_tokens'), output_tokens: sumTokens('output_tokens'), llm_calls: llmCalls, token_reports: tokenReports, token_coverage: llmCalls ? Math.min(1, tokenReports / llmCalls) : null, retry_count: events.filter(e => e.event_type === 'retry.scheduled').length, loop_count: Math.max(0, ...events.map(e => numeric(e.attributes.loop_index) ?? 0)) });
    result.events.push(...events);
    const spans = new Map<string, TelemetryEvent[]>();
    for (const event of events) { const group = spans.get(event.span_id) ?? []; group.push(event); spans.set(event.span_id, group); }
    const runSpans: Row[] = [];
    for (const [spanId, group] of spans) {
      const opened = group.filter(e => ['run.started', 'state.entered'].includes(e.event_type));
      const closed = group.filter(e => ['run.completed', 'state.exited', 'tool.completed'].includes(e.event_type));
      const first = opened[0] ?? group[0], last = closed.at(-1);
      const point = !opened.length && !closed.length;
      let depth = 0, parent = first.parent_span_id; const seen = new Set([spanId]); let missingParent = false;
      while (parent) { if (seen.has(parent)) { warn(`Run ${runId}: cyclic span parent`); break; } seen.add(parent); const ancestor = spans.get(parent)?.[0]; if (!ancestor) { missingParent = true; warn(`Run ${runId}: missing span parent`); break; } depth++; parent = ancestor.parent_span_id; }
      if (opened.length > 1 || closed.length > 1) warn(`Run ${runId}: repeated span start/end`);
      if (!point && !opened.length) warn(`Run ${runId}: missing span start`);
      const row: Row = { run_id: runId, span_id: spanId, parent_span_id: first.parent_span_id, depth, missing_parent: missingParent, label: first.state ?? first.event_type, state: first.state, missing_start: !point && !opened.length, start: !point && !opened.length ? null : first.timestamp, end: point ? first.timestamp : last?.timestamp ?? null, open: !point && !last, point, duration_ms: opened.length > 1 || closed.length > 1 ? null : numeric((last ?? (point ? first : undefined))?.attributes.duration_ms), status: (last ?? first).status, event_ids: group.map(e => e.event_id), strategy_id: strategy };
      runSpans.push(row);
    }
    // Preorder gives each parallel span a separate row while preserving its parent tree.
    const children = new Map<string, Row[]>();
    for (const row of runSpans) { const parent = spans.has(String(row.parent_span_id)) ? String(row.parent_span_id) : ''; const list = children.get(parent) ?? []; list.push(row); children.set(parent, list); }
    const visited = new Set<string>();
    const walk = (row: Row) => { const id = String(row.span_id); if (visited.has(id)) return; visited.add(id); result.spans.push(row); for (const child of children.get(id) ?? []) walk(child); };
    for (const row of children.get('') ?? []) walk(row); for (const row of runSpans) walk(row);
    const entered = events.filter(e => e.event_type === 'state.entered' && e.state !== null);
    for (const event of entered) nodeIds.add(event.state!);
    for (let i = 1; i < entered.length; i++) {
      const a = entered[i - 1], b = entered[i];
      // Missing intermediate events cannot justify a transition.
      const interval = events.filter(e => e.sequence >= a.sequence && e.sequence <= b.sequence);
      if (interval.some((e, j) => j > 0 && e.sequence !== interval[j - 1].sequence + 1)) continue;
      const key = JSON.stringify([runId, a.state, b.state]);
      const edge = edges.get(key) ?? { id: key, run_id: runId, source: a.state, target: b.state, weight: 0, failures: 0, failure_reasons: [], event_ids: [] };
      edge.weight = Number(edge.weight) + 1;
      const closing = spans.get(a.span_id)?.find(e => ['state.exited', 'tool.completed'].includes(e.event_type));
      if (closing?.status === 'failed') { edge.failures = Number(edge.failures) + 1; if (closing.attributes.failure_code) (edge.failure_reasons as unknown[]).push(closing.attributes.failure_code); }
      (edge.event_ids as string[]).push(a.event_id, b.event_id); edges.set(key, edge);
    }
    for (const event of entered) {
      const key = JSON.stringify([strategy, event.state]), cell = cells.get(key) ?? { strategy_id: strategy, state: event.state, dwell_ms: null, sample_n: 0, missing_n: 0, retry_count: 0, loop_count: 0 };
      const span = runSpans.find(s => s.span_id === event.span_id), duration = numeric(span?.duration_ms);
      if (duration === null || span?.open) cell.missing_n = Number(cell.missing_n) + 1;
      else { cell.dwell_ms = Number(cell.dwell_ms ?? 0) + duration; cell.sample_n = Number(cell.sample_n) + 1; }
      cell.loop_count = Math.max(Number(cell.loop_count), numeric(event.attributes.loop_index) ?? 0);
      cells.set(key, cell);
    }
    for (const event of events.filter(e => e.event_type === 'retry.scheduled')) { const cell = cells.get(JSON.stringify([strategy, event.state])); if (cell) cell.retry_count = Number(cell.retry_count) + 1; }
  }
  result.nodes = [...nodeIds].sort().map(id => ({ id, label: id })); result.transitions = [...edges.values()]; result.state_metrics = [...cells.values()];
  const cohorts = new Map<string, Row[]>();
  for (const run of result.runs) { const key = JSON.stringify([run.strategy_id, run.run_kind, run.skill_id]); const list = cohorts.get(key) ?? []; list.push(run); cohorts.set(key, list); }
  for (const runs of cohorts.values()) {
    const completed = runs.filter(r => r.complete), durations = completed.map(r => numeric(r.duration_ms)).filter((n): n is number => n !== null);
    result.strategy_metrics.push({ strategy_id: runs[0].strategy_id, run_kind: runs[0].run_kind, skill_id: runs[0].skill_id, completed_n: completed.length, incomplete_n: runs.length - completed.length, sample_n: durations.length, excluded_n: runs.length - durations.length, p50_ms: quantile(durations, .5), p95_ms: quantile(durations, .95), failure_rate: completed.length ? completed.filter(r => r.status === 'failed').length / completed.length : null });
  }
  return result;
}
