import type { Row } from '../types';
import { numeric, type EventIndex, type TelemetryEvent } from './events.ts';

// AEP telemetry contract v0.3 §3a (2026-10-10): benchmark runners emit
// `benchmark_run` runs with benchmark.case_started / case_completed events, and
// grading passes emit `benchmark_grading` runs (parent_run_id = the graded run)
// with benchmark.case_graded events. Verdicts are the benchmark's own; Atlas
// only reports them.
export const BENCHMARK_KINDS = ['benchmark_run', 'benchmark_grading'] as const;
const SCORE: Row = { PASS: 1, INSUFFICIENT_KNOWLEDGE: 0.5, NEEDS_HUMAN_REVIEW: 0.5 };

export interface BenchmarkDerived { runs: Row[]; cases: Row[]; matrix: Row[]; warnings: string[] }

/** True for the run.started event of a benchmark or grading run. */
export const isBenchmarkStart = (event: TelemetryEvent) =>
  event.event_type === 'run.started' && (BENCHMARK_KINDS as readonly string[]).includes(String(event.attributes.run_kind));

export function deriveBenchmarks(index: EventIndex, filters: Row = {}): BenchmarkDerived {
  const result: BenchmarkDerived = { runs: [], cases: [], matrix: [], warnings: [...index.warnings] };
  const byRun = new Map<string, TelemetryEvent[]>();
  for (const event of index.ordered()) { const list = byRun.get(event.run_id) ?? []; list.push(event); byRun.set(event.run_id, list); }
  const starts = new Map<string, TelemetryEvent>();
  for (const [runId, events] of byRun) { const start = events.find(isBenchmarkStart); if (start) starts.set(runId, start); }
  // Grading results keyed by graded run and case; the latest grading wins.
  const graded = new Map<string, Row>();
  for (const [runId, start] of starts) {
    if (start.attributes.run_kind !== 'benchmark_grading') continue;
    const parent = String(start.attributes.parent_run_id ?? '');
    for (const event of byRun.get(runId) ?? []) {
      if (event.event_type !== 'benchmark.case_graded') continue;
      graded.set(JSON.stringify([parent, event.attributes.case_id]), { ...event.attributes, graded_at: event.timestamp, grading_run_id: runId });
    }
  }
  const match = (key: string, value: unknown) => filters[key] == null || filters[key] === '' || filters[key] === '*' || filters[key] === value;
  for (const [runId, start] of starts) {
    if (start.attributes.run_kind !== 'benchmark_run') continue;
    const attrs = start.attributes, suite = String(attrs.suite ?? 'unknown'), label = String(attrs.label ?? runId);
    if (!match('suite', suite) || !match('strategy', attrs.strategy_id ?? 'unknown') || !match('benchmark_run', runId)) continue;
    const events = byRun.get(runId) ?? [], end = events.find(e => e.event_type === 'run.completed');
    // One row per case: the last completion wins (a case may be re-asked).
    const latest = new Map<string, TelemetryEvent>(), started = new Set<string>();
    for (const event of events) {
      const id = String(event.attributes.case_id ?? '');
      if (event.event_type === 'benchmark.case_started') started.add(id);
      if (event.event_type === 'benchmark.case_completed') latest.set(id, event);
    }
    const counts: Row = {}; const coverages: number[] = [];
    for (const [caseId, event] of latest) {
      const verdict = String(event.attributes.verdict ?? 'UNKNOWN'); counts[verdict] = Number(counts[verdict] ?? 0) + 1;
      const grade = graded.get(JSON.stringify([runId, caseId])) ?? {};
      const coverage = numeric(grade.coverage); if (coverage !== null) coverages.push(coverage);
      const traces = Array.isArray(event.attributes.aep_trace_ids) ? event.attributes.aep_trace_ids.filter(t => typeof t === 'string') : [];
      if (!match('verdict', verdict)) continue;
      result.cases.push({
        benchmark_run_id: runId, suite, label, strategy_id: attrs.strategy_id ?? null, case_id: caseId, verdict,
        score: typeof SCORE[verdict] === 'number' ? SCORE[verdict] : 0, completed_at: event.timestamp,
        ...event.attributes, aep_trace_ids: traces, aep_trace_id: traces[0] ?? null,
        coverage, points_contradicted: grade.points_contradicted ?? null, invented_count: grade.invented_count ?? null,
        reference_sufficient: grade.reference_sufficient ?? null, grading_run_id: grade.grading_run_id ?? null,
      });
    }
    const planned = numeric(attrs.cases), done = latest.size;
    const running = [...started].filter(id => !latest.has(id));
    result.runs.push({
      benchmark_run_id: runId, suite, label, strategy_id: attrs.strategy_id ?? null, aep_build: attrs.aep_build ?? null,
      skills_digest: attrs.skills_digest ?? null, started_at: start.timestamp, ended_at: end?.timestamp ?? null,
      status: end ? 'completed' : 'running', cases_planned: planned, cases_done: done,
      progress: planned ? Math.min(1, done / planned) : null, in_progress: running.join(', ') || null,
      pass_n: Number(counts.PASS ?? 0), fail_n: Number(counts.FAIL ?? 0), other_n: done - Number(counts.PASS ?? 0) - Number(counts.FAIL ?? 0),
      pass_rate: done ? Number(counts.PASS ?? 0) / done : null, verdicts: counts,
      mean_coverage: coverages.length ? coverages.reduce((a, b) => a + b, 0) / coverages.length : null, graded_n: coverages.length,
      duration_ms: numeric(end?.attributes.duration_ms),
    });
    if (end && planned !== null && done < planned) result.warnings.push(`${label}: ${planned - done} planned cases have no result`);
  }
  result.runs.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
  // Case x run matrix for comparing strategies over the same cases.
  const startedAt = new Map(result.runs.map(run => [run.benchmark_run_id, String(run.started_at)]));
  result.matrix = result.cases.map(row => ({ case_id: row.case_id, run: `${row.label} · ${(startedAt.get(row.benchmark_run_id) ?? '').slice(5, 16)}`, run_label: row.label, benchmark_run_id: row.benchmark_run_id, score: row.score, verdict: row.verdict, coverage: row.coverage }));
  return result;
}
