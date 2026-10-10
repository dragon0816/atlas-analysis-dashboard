# Technical decisions

## 2026-10-10 — AEP telemetry integration

Use a dedicated application-scoped custom provider and a bounded event index shared by JSONL, REST and WebSocket. Keep generic snapshot providers and dashboard schemaVersion 2 unchanged. AEP source remains read-only.

Read AEP directly from the browser at the fixed loopback endpoint http://127.0.0.1:53583/api/v1/telemetry. Its v0.2 API explicitly permits local browser origins without credentials; no backend proxy or new dependency is needed. Rejected: arbitrary URL proxy and changing generic REST envelope semantics.

Canonical events use aep.telemetry.v1; state and parent_span_id may be null. Transport ingest_seq is separate from per-run sequence. Store cursors only alongside retained events in memory, never resume from a durable cursor without its corresponding history. AEP provides no backlog-complete marker or cursor-expiry contract; expose possible gaps rather than claiming complete history. SQLite AUTOINCREMENT may skip values after duplicate inserts, so a gap is a warning, not proof of data loss.

Use producer duration_ms only for comparable latency metrics; retain timestamp positions for timelines. Quantiles use linear interpolation at (n - 1) * p. Compare observational cohorts by strategy, run kind and skill; do not label these benchmark accuracy. Missing tokens stay null and token coverage is explicit.

## 2026-10-10 — Bounded AEP history and metrics

Default REST history is the last 24 hours; recent-window controls allow 15 minutes or one hour when a busy host reaches the 10,000-event bound. Truncation remains explicit and live ingestion stops on capacity. Rejected: silently evicting history and continuing to display aggregates as complete. Restricting the window is preferable until a separately designed retention-aware rolling window is available.

AEP health is polled every 15 seconds in live mode to detect store cursor resets and producer drops. Failed reads and stream errors preserve prior datasets with stale warnings. There is no durable event cache, arbitrary proxy, new npm package or backend security change.

## 2026-10-10 — AEP benchmark views (Claude Code)

Benchmark views load benchmark runs by kind and then each run's events, instead of filtering the host-wide event window. Reason: the 24-hour Harness window already reaches the 10,000-event bound on the owner's host, which would silently drop benchmark events. Verdicts and coverage are shown exactly as AEP's benchmark and grader produced them; Atlas computes only counts, rates and means. A case links to its AEP runs through `aep_trace_ids` and `GET /runs?trace_id=`. Rejected: a separate Atlas application (it would duplicate the AEP provider registration and change the application count tests), and a server-side Atlas proxy (AEP already serves loopback reads).
