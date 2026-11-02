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

## 2026-11-01 — Reconcile republished BI analyses without resetting personal layouts

The I2 rehearsal exposed that result polling refreshed rows while a non-empty
board kept its old catalog chart/title. BiControls now polls health and /vaults
serially every 15 seconds, compares the selected vault's reads tag/commit with the
last loaded catalog version, and refetches /analyses when different. Initial load,
board/vault changes and Reload vaults also fetch and reconcile the catalog. The
coordinator permits either vault-version or result-version detection; use vault
polling so additions/removals are detected even without a result subscription.
Abort in-flight reads and clear the timer on switching/unmount. Pause reconciliation
while editing or saving, then load the current catalog when preview resumes.

Reconcile producer panels by query.vault + query.slug. Store the analysis digest
in query.digest (consumer metadata, never a feed query parameter) so a changed
digest both updates the panel and invalidates its runtime query identity. Update
type/mapping/title/question and parameter definitions only for changed digests.
Keep panel identity, position/size, transforms, appearance and unrelated panels.
Keep current parameter values when valid under the new type/choices, otherwise
use the new default. Remove obsolete variables/values with their analysis/params.
Append missing published slugs in feed order below existing panels; unchanged
digests preserve the original panel references. Questions are kept in display
metadata and the panel header tooltip. No dashboard schema version change.

Use a separate reconciliation callback in DashboardPage to update board/values
without resetting its saved name/revision, layout or other preview state. Do not
autosave to Atlas or write to AEP. Legacy saved panels without a digest refresh
on their first catalog load. Rejected: regenerating the whole board on every
poll, relying only on result polling, requiring vault reselection, or editing
producer fixtures. I1 adds a temporary Atlas-only HTTP stub after the real fixture
cases to verify automatic and manual republish updates in the actual browser.

Empty saved boards use the same reconciliation callback and retain dashboard
identity/title and saved revision. When no panels exist, initial placement uses
the normal generated layout; additions to non-empty boards append below them.

## 2026-11-01 — Atlas dashboard read contract for AEP import

Expose the existing schemaVersion 2 read API as the producer contract for AEP's
Knowledge-page import. Existing BI panel identity already consists of
panels[].datasource.id = aep.bi.result, query.vault and query.slug; do not add a
second identity structure or require query.digest/display flags. Legacy documents
remain loadable. GET /dashboards is a bare names array and GET /dashboards/{name}
is the stored document. The current loopback Host/Origin checks already permit
server-side reads without Origin while refusing unapproved cross-site requests;
no HTTP policy or API/schema change is required.

The owner specified stored geometry order (layout.y, layout.x, panel.id). The
recognized panel model is flat, with no tabs/groups. Duplicate panel preserves
its analysis identity, so the coordinator explicitly decided: sort first, then
keep each (vault, slug)'s FIRST occurrence and let AEP list ignored duplicates in
its import preview. Atlas keeps its existing Duplicate functionality. Ignore
non-AEP and foreign-vault panels. AEP computes hidden from its own vault analyses;
Atlas defines no hidden field for this contract; positions/sizes/transforms are not imported into AEP.

Freeze three producer-owned response-body goldens at
web/tests/fixtures/atlas_dashboard_golden/. Use the real Atlas canonical encoder
and fictional fixtures only; test real HTTP responses byte-for-byte in isolated
temporary private stores. Include misleading non-AEP fields, another vault,
array/geometry order differences, an ID tie and a later duplicate. Preserve JSON
bytes with Git attributes; AEP vendors these files from the committed producer.
Rejected: modifying security headers, reading personal stores, a new schema or
export endpoint, relying on array order, or resolving duplicates arbitrarily.

## 2026-11-02 — Embed read-only Atlas pages in AEP's chat (amends 2026-11-01 "no embed")

Owner decisions, relayed by the BI orchestrator. These amend the 2026-11-01 position
that AEP's chat shows its own self-contained chart and never an Atlas link or frame
(AEP `BI_CHAT_CHARTS_AND_DASHBOARD_SOURCES.md` §1(a), and every security header here
having been DENY); that record stays as history.

1. A general AEP AI chat embeds REAL Atlas panels or dashboards in the conversation by
   iframe. When Atlas is not running, AEP falls back to its own chart; that is AEP's work.
2. Atlas layouts stay personal. AEP never writes Atlas dashboards (no PUT from AEP).

Choices made to implement them; the contract is AEP_EMBED_CONTRACT.md:

- `/embed/*` is a server route, not the static fallback, because a valid dashboard name
  may contain a dot, which the static route treats as a missing file. It matches the raw
  path prefix, so a `/%65mbed/` request cannot get framable headers while the page, which
  reads the same raw pathname, would start the full editor.
- Frame ancestors are a separate setting (`--allow-frame-ancestor`, replacing the Agent Web
  defaults) from `--allow-origin`. Reusing the latter would have given every framing parent
  write access to `/dashboards`. Rejected for that reason.
- A framed GET carries no Origin, so a cross-site parent (`localhost` framing `127.0.0.1`)
  is identified by the Referer's origin; a missing Referer is refused. Agent Web sends
  `Referrer-Policy: no-referrer`, so the contract requires `referrerpolicy="origin"` on the
  iframe. Rejected: passing every cross-site iframe and relying on `frame-ancestors` alone.
  It would also be safe in a browser, because the body is a static page, but the coordinator
  asked that cross-site stay refused, and failing closed costs AEP one attribute.
- postMessage's target is the parent's own origin (`location.ancestorOrigins`, else the
  `document.referrer` origin), which `frame-ancestors` has already limited. It never posts to
  `*`. Rejected: having the server inject the allowed list into the page, which adds a moving
  part to a static file for no extra guarantee.
- An unknown or invalid panel URL parameter is refused with a clear state instead of falling
  back to the default, so a link in a conversation cannot silently show other data than the
  AI said. The reconcile fallback still applies after a republish, as in the app.

Later the same day, from building the embed pages and running their headless check:

- Three states the owner decisions did not cover were settled by the orchestrator as
  "decide from the existing behaviour", and are in the contract. A failing panel stays
  in its own card and sets the root to `error`. A dashboard whose vault is gone is `error`
  with its layout kept, because the stored layout is still real; `unknown_vault` is panel-only.
  Waiting keeps the 2026-11-01 rule (three retries, then Refresh): the embed does not get its
  own policy, so a slow script result can rest on `waiting`, and AEP is told not to fall back
  on it. Rejected: unbounded polling, which would change that earlier decision for the app too.
- The root's `ready` waits for every BI panel to answer, because the first version reported it
  before results arrived. PanelCard failures now reach the root through an optional
  `onPanelError`; without it a failed panel left the state on `loading` for good.
- The read-contract golden `dashboard-mixed.json` carried `{"op":"limit","count":5}`, which the
  runtime refuses (`n` is the key), so those fixture panels could not render. The generator
  now writes `n`, on the orchestrator's instruction. This changes the file's bytes, so AEP
  re-vendors it. The read contract itself is unchanged: AEP ignores transforms.
