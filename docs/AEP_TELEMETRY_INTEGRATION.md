# AEP Harness telemetry integration

Status (2026-10-10): implementation added; full build and browser acceptance are pending environment prerequisites. Do not treat this as a verified release. See TASKS.md and HANDOFF.md.

## Contract and boundaries

Read-only reference: `C:/Users/Chi_L/Documents/ChatGPT/agentic-engineering-platform/docs/telemetry/AEP_ATLAS_TELEMETRY_CONTRACT.md` (v0.2), `src/host_runtime/telemetry_api.py`, and `src/telemetry/store.py`. No AEP files, configuration or runtime were modified.

The consumer uses `http://127.0.0.1:53583/api/v1/telemetry` directly. This AEP version accepts GET telemetry reads without credentials from loopback browser origins. A request with Origin `http://127.0.0.1:8127` returned HTTP 200 and the matching Access-Control-Allow-Origin. Shell checks are not browser acceptance.

- `/runs`: `{runs, next_cursor}`; cursor is opaque `started_at|run_id`, descending.
- `/runs/{id}/events`: `{events, next_sequence}`; per-run sequence pagination.
- `/events`: `{events, next_ingest_seq}`; host ingestion cursor pagination. A short page does not itself indicate completion; an empty page does.
- `/stream?after_ingest_seq=N`: event JSON with top-level transport `ingest_seq`; reconnect starts after the last successfully processed message.
- `/health`: checked during live mode to detect producer drops and cursor resets.
- Timestamps: timezone-bearing RFC3339. Time bounds are inclusive on the producer. `state` and `parent_span_id` can be null.

The contract's statement that generic REST can directly consume `/runs` is incorrect for Atlas's normalizer. A dedicated custom provider unwraps it; generic providers remain unchanged.

AEP supplies no stream backlog-complete or cursor-expiry marker. Ingest sequence gaps can result from retention or duplicate SQLite inserts and are reported as possible gaps, not definitive loss. Per-run sequence gaps/conflicts are separately detected. A cursor is held with its in-memory data; it is never restored on its own after reload.

## Using the view after a successful build

1. Start the existing dashboard backend and open the dashboard.
2. Expand Dashboards, select **AEP Harness**.
3. Empty time range reads the last 24 hours. **Recent window** offers 15 minutes, 1 hour or 24 hours. Date filters or dashboard time_range values can choose another interval.
4. Click a runs row to set Selected run. Clear that filter to return to the overview.
5. Review canonical events, nested spans, directed transitions, state dwell heatmap and strategy cohort metrics. Data/details preserve event IDs for traceability.
6. **Import JSONL** reads a local file into memory. It disables live mode; nothing is uploaded or saved into application assets. **Reload AEP** returns to server data.
7. Enable **Live updates** after loading a suitably narrow window. It shares one WebSocket across the panels, batches rendering, and reconnects up to three times. Toggle to retry; use Reload AEP after a cursor reset.

Retention is bounded: 8 MiB JSONL/payload/index, 64 KiB event, 10,000 events per session, up to four retained contexts, 2,000 run summaries and 20 event pages. The overview may hit limits in a busy host. Narrow the window when warned; live ingestion stops on capacity rather than silently evicting evidence. Timeline rendering is capped at 2,000 spans and existing graph limits still apply.

## Data and metrics

`web/src/platform/aep/events.ts` validates events, parses JSONL with line errors, deduplicates IDs and reduces events in deterministic run/sequence/ID order. Unknown event types and attributes remain available. Identity conflicts fail explicitly; same-sequence events are retained with warnings.

Model/skill filters first select runs from event metadata and then retain the whole loaded lifecycle. Unloaded runs cannot match those filters and the UI says so. Missing lifecycle/sequence data never creates a successful completed run. Tokens are sums of observed LLM reports; missing values remain null, and coverage is observed reports / reported or observed calls.

`web/src/platform/aep/provider.ts` owns bounded REST reads, pagination, shared cancellation, offline state and live transport. It has no arbitrary endpoint configuration or credential management. Failed refreshes/disconnections keep previously loaded data with stale warnings.

Span timeline uses parent references and one row per span (including parallel siblings), measured source duration, explicit missing parent/start/end flags and point events. Cycles and repeated span boundaries warn. Timeline positions use timestamps; producer duration can differ from timestamp width and is not recomputed from that width.

Transition edges follow adjacent state.entered events within each run. Missing sequences between them suppress an edge. Aggregation preserves source event IDs, failure counts and reasons. Directed path behavior is opt-in; existing graph presets retain their undirected path behavior.

Run latency and dwell metrics use nonnegative producer duration_ms only. Unknown latency is not replaced with zero or a timestamp estimate. p50/p95 use linear interpolation at `(n - 1) * p`. Strategy cohorts group by strategy_id, run_kind and skill_id with completed/incomplete/valid/excluded counts. Failure rate uses complete runs as the denominator. These are observational cohorts, not a controlled benchmark or correctness score.

## Validation

See VALIDATION.md for the actual results and environment blockers. Required final checks remain `npm test`, `npm run build` (includes typecheck), Python 3.13+ Windows server tests, and browser checks for import, run switching, live reconnect, cleanup and legacy applications. Do not weaken Python's ACL/version checks to run on 3.12.
