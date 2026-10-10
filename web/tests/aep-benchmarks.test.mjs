import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventIndex } from '../src/platform/aep/events.ts';
import { deriveBenchmarks } from '../src/platform/aep/benchmarks.ts';
import { AepProvider } from '../src/platform/aep/provider.ts';

// AEP telemetry contract v0.3 §3a: benchmark_run and benchmark_grading runs.
let counter = 0;
const ev = (run_id, sequence, event_type, attributes = {}, extra = {}) => ({
  schema_version: 'aep.telemetry.v1', event_id: `e${++counter}`, run_id, trace_id: `trace-${run_id}`, span_id: `span-${run_id}`,
  parent_span_id: null, sequence, timestamp: `2026-10-10T01:00:${String(sequence).padStart(2, '0')}Z`, event_type,
  state: 'benchmark_run', status: event_type === 'run.started' || event_type.endsWith('case_started') ? 'started' : 'succeeded', attributes, ...extra });
const benchmark = (run = 'bench-k-core-1', label = 'core-1', strategy = 'st-a') => [
  ev(run, 0, 'run.started', { run_kind: 'benchmark_run', suite: 'knowledge_v1', label, cases: 3, strategy_id: strategy }),
  ev(run, 1, 'benchmark.case_started', { case_id: 'Q1' }),
  ev(run, 2, 'benchmark.case_completed', { case_id: 'Q1', verdict: 'FAIL', aep_trace_ids: ['trace-old'] }),
  ev(run, 3, 'benchmark.case_completed', { case_id: 'Q1', verdict: 'PASS', aep_trace_ids: ['trace-q1'] }),
  ev(run, 4, 'benchmark.case_started', { case_id: 'Q2' }),
  ev(run, 5, 'benchmark.case_completed', { case_id: 'Q2', verdict: 'INSUFFICIENT_KNOWLEDGE', aep_trace_ids: [] }),
  ev(run, 6, 'benchmark.case_started', { case_id: 'Q3' }),
];
const grading = (parent = 'bench-k-core-1') => [
  ev('grade-1', 0, 'run.started', { run_kind: 'benchmark_grading', parent_run_id: parent, suite: 'knowledge_v1', label: 'core-1' }),
  ev('grade-1', 1, 'benchmark.case_graded', { case_id: 'Q1', verdict: 'GRADED', coverage: 0.5, points_contradicted: 1, invented_count: 0 }),
  ev('grade-1', 2, 'benchmark.case_graded', { case_id: 'Q2', verdict: 'GRADED', coverage: 0.25 }),
  ev('grade-1', 3, 'run.completed', { cases: 2 }),
];
const indexOf = events => { const index = new EventIndex(); events.forEach(e => index.add(e)); return index; };

test('benchmark runs report progress, verdict counts and mean coverage', () => {
  const { runs, cases } = deriveBenchmarks(indexOf([...benchmark(), ...grading()]));
  assert.equal(runs.length, 1);
  const [run] = runs;
  assert.equal(run.status, 'running'); assert.equal(run.cases_done, 2); assert.equal(run.progress, 2 / 3);
  assert.equal(run.in_progress, 'Q3'); assert.equal(run.pass_n, 1); assert.equal(run.pass_rate, 0.5);
  assert.equal(run.mean_coverage, 0.375); assert.deepEqual(run.verdicts, { PASS: 1, INSUFFICIENT_KNOWLEDGE: 1 });
  const q1 = cases.find(c => c.case_id === 'Q1');
  assert.equal(q1.verdict, 'PASS'); assert.equal(q1.aep_trace_id, 'trace-q1'); // the last completion wins
  assert.equal(q1.coverage, 0.5); assert.equal(q1.points_contradicted, 1); assert.equal(q1.score, 1);
  assert.equal(cases.find(c => c.case_id === 'Q2').score, 0.5);
});

test('a finished run with missing cases warns, and filters narrow cases', () => {
  const events = [...benchmark(), ev('bench-k-core-1', 7, 'run.completed', { cases: 2 })];
  const derived = deriveBenchmarks(indexOf(events));
  assert.equal(derived.runs[0].status, 'completed'); assert.match(derived.warnings.join(' '), /1 planned cases have no result/);
  assert.deepEqual(deriveBenchmarks(indexOf(events), { verdict: 'PASS' }).cases.map(c => c.case_id), ['Q1']);
  assert.equal(deriveBenchmarks(indexOf(events), { suite: 'coding_v1' }).runs.length, 0);
});

test('the matrix compares the same cases across benchmark runs', () => {
  const two = [...benchmark('bench-a', 'core-a', 'st-a'), ...benchmark('bench-b', 'core-b', 'st-b')];
  const { matrix, runs } = deriveBenchmarks(indexOf(two));
  assert.equal(runs.length, 2);
  assert.deepEqual([...new Set(matrix.map(m => m.run_label))].sort(), ['core-a', 'core-b']);
  assert.ok(matrix.every(m => typeof m.score === 'number'));
  assert.equal(deriveBenchmarks(indexOf(two), { strategy: 'st-b' }).runs.length, 1);
});

const response = value => new Response(JSON.stringify(value));
const definition = { type: 'custom', provider: 'aep' };
const transport = events => events.map((e, i) => ({ ...e, ingest_seq: i + 1 }));

test('benchmark views load runs by kind and then each run, not the busy event window', async () => {
  const requests = [], stored = transport([...benchmark(), ...grading()]);
  const provider = new AepProvider({ fetch: async url => {
    const parsed = new URL(url); requests.push(parsed);
    if (parsed.pathname.endsWith('/runs')) {
      const kind = parsed.searchParams.get('kind');
      const runs = kind === 'benchmark_run' ? [{ run_id: 'bench-k-core-1', run_kind: 'benchmark_run', complete: false }]
        : kind === 'benchmark_grading' ? [{ run_id: 'grade-1', run_kind: 'benchmark_grading', complete: true }]
          : [{ run_id: 'conv-1', run_kind: 'conversation_turn', complete: true }];
      return response({ runs, next_cursor: null });
    }
    const match = parsed.pathname.match(/runs\/([^/]+)\/events$/);
    if (match) { const id = decodeURIComponent(match[1]), after = Number(parsed.searchParams.get('after_sequence')); return response({ events: stored.filter(e => e.run_id === id && e.sequence > after), next_sequence: null }); }
    throw Error(`unexpected route ${parsed.pathname}`);
  } });
  const data = await provider.query(definition, { view: 'benchmark_runs' }, new AbortController().signal);
  assert.equal(data.rows.length, 1); assert.equal(data.rows[0].mean_coverage, 0.375);
  assert.ok(!requests.some(u => u.pathname.endsWith('/telemetry/events')), 'benchmark views do not page the host event window');
  assert.ok(requests.some(u => u.searchParams.get('kind') === 'benchmark_grading'));
  const cases = await provider.query(definition, { view: 'benchmark_cases' }, new AbortController().signal);
  assert.equal(cases.rows.length, 2); provider.dispose();
});

class Socket { onmessage = null; onerror = null; onclose = null; constructor(url) { this.url = url; } close() {} send(value) { this.onmessage?.({ data: JSON.stringify(value) }); } }

test('live updates add benchmark events and ignore other runs', async () => {
  const sockets = [], stored = transport(benchmark());
  const provider = new AepProvider({
    fetch: async url => { const parsed = new URL(url);
      if (parsed.pathname.endsWith('/health')) return response({ last_ingest_seq: 7, dropped: 0 });
      if (parsed.pathname.endsWith('/runs')) return response({ runs: parsed.searchParams.get('kind') === 'benchmark_run' ? [{ run_id: 'bench-k-core-1', run_kind: 'benchmark_run', complete: false }] : [], next_cursor: null });
      return response({ events: stored.filter(e => e.sequence > Number(parsed.searchParams.get('after_sequence'))), next_sequence: null }); },
    websocket: url => { const s = new Socket(url); sockets.push(s); return s; } });
  const query = { view: 'benchmark_runs' };
  await provider.query(definition, query, new AbortController().signal);
  const received = []; provider.subscribe(definition, query, { next: d => received.push(d), error: () => {} }, new AbortController().signal);
  provider.setLive(true); assert.equal(sockets.length, 1);
  sockets[0].send({ ...ev('conv-9', 0, 'run.started', { run_kind: 'conversation_turn' }), ingest_seq: 8 });
  sockets[0].send({ ...ev('bench-k-core-1', 7, 'benchmark.case_completed', { case_id: 'Q3', verdict: 'PASS' }), ingest_seq: 9 });
  sockets[0].send({ ...ev('bench-new', 0, 'run.started', { run_kind: 'benchmark_run', suite: 'coding_v1', label: 'r2', cases: 1 }), ingest_seq: 10 });
  await new Promise(r => setTimeout(r, 260));
  const rows = received.at(-1).rows;
  assert.equal(rows.find(r => r.benchmark_run_id === 'bench-k-core-1').cases_done, 3);
  assert.ok(rows.some(r => r.benchmark_run_id === 'bench-new'));
  provider.dispose();
});

test('a case trace loads the AEP runs that answered it', async () => {
  const requests = [];
  const run = [ev('conv-1', 0, 'run.started', { run_kind: 'conversation_turn' }, { trace_id: 'trace-q1' }), ev('conv-1', 1, 'run.completed', { duration_ms: 5 }, { trace_id: 'trace-q1' })];
  const provider = new AepProvider({ fetch: async url => { const parsed = new URL(url); requests.push(parsed);
    if (parsed.pathname.endsWith('/runs')) return response({ runs: [{ run_id: 'conv-1', trace_id: 'trace-q1', complete: true, status: 'succeeded' }, { run_id: 'other', trace_id: 'trace-x', complete: true }], next_cursor: null });
    return response({ events: transport(run), next_sequence: null }); } });
  const data = await provider.query(definition, { view: 'runs', trace: 'trace-q1' }, new AbortController().signal);
  assert.deepEqual(data.rows.map(r => r.run_id), ['conv-1']); // an older Agent Web that ignores trace_id is filtered here
  assert.equal(requests[0].searchParams.get('trace_id'), 'trace-q1');
  provider.dispose();
});
