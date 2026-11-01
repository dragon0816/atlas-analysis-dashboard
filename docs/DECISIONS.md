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

## 2026-11-01 — AEP BI consumer boundary and prerequisite gate

Use a separate application-scoped `AepBiProvider` and `applications/aep_bi`.
Keep the telemetry provider and dashboard schemaVersion 2 unchanged. GET-only
loopback reads use the existing Agent Web port, no credentials, no redirects,
an 8 MiB streamed limit and 8-second timeout. Cache exact parameterized requests
in memory only (128 entries and 8 MiB total); preserve stale data on disconnect.
Retry waiting results at most three times per subscription, then require refresh.
Reuse the Atlas canvas/editor and dashboard storage for personal layouts.
Rejected: generic REST envelope changes, AEP writes, a backend proxy, new packages,
or storing result data in personal dashboard JSON.

F1 is absent from the inspected AEP checkout and main. Synthetic consumer examples
may support preliminary implementation but never substitute for producer golden
fixtures. Enum choices remain disabled until AEP defines their wire format; do
not invent a `values`/`options` key. F1 vendoring and a passing drift check are
required before A1/A2 completion. I1 remains gated on the owner's F3 notification.

## 2026-11-01 — AEP BI enum wire format

The coordinator confirmed that every enum parameter in GET /vaults/{id}/analyses
includes params.<name>.values, an array of choice strings resolved by AEP, alongside
values_from. Validate values as a bounded string array (20,000 entries under the
existing 8 MiB response limit); retain values_from and additive metadata unchanged.
Render exactly values in a labeled native select, initially selecting the default
and honoring saved/current values and the dashboard disabled state. Changes use
the existing namespaced variable and result-query path.

Rejected: resolving values_from in Atlas, inventing an options key, adding choices
from defaults, or retaining the disabled placeholder. AEP owns choice resolution.
This supersedes the earlier enum prerequisite in the BI boundary decision above.
The clarification is pending AEP main merge (b6a139c5), on AEP branch
bi-analysis-dashboard-f1-f3, as confirmed by the coordinator.
Golden vendoring and I1 remain deferred until the coordinator's F1–F3 notification.

## 2026-11-01 — Producer goldens and headless BI integration

AEP F1–F3 and the enum supplement are merged on AEP main at
b6a139c5cfae4b21ac42c27f471e9b028e3679b1. Vendor every golden JSON byte-for-byte,
including requests.json; record provenance in the adjacent README. The manifest
must cover all responses, and tests validate provider states plus rendered controls,
all table cells and numeric chart marks. Rejected: Atlas-authored substitute
fixtures or normalizing producer data to satisfy tests.

I1 uses the real AEP fixture process, Atlas Vite and an isolated headless browser.
Use Node's built-in WebSocket/CDP support; no browser dependency or desktop GUI
automation is added. VITE_AEP_BI_PORT sets only a validated loopback port at build
or dev-server startup (default 53583, I1 53611). The host, GET-only behavior,
credential omission and redirect rejection remain fixed. Rejected: intercepting
or fabricating browser feed responses, arbitrary host configuration or a backend
proxy. Evidence belongs in ignored .scratch/aep-bi-i1; stop all owned processes.
