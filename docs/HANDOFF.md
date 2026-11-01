# Handoff — AEP BI published catalog reconciliation (2026-11-01)

## Goal and scope

Fix the I2 rehearsal regression: after AEP publishes an edited analysis, Atlas
must update its chart/title/question/parameter controls as well as rows, without
requiring vault reselection or losing personal layout and valid current values.
The coordinator will rerun the real Agent Web rehearsal against this branch.
AEP is read-only. No push, PR, producer source or golden edits are authorized.

## Implemented

- Verified root cause: BiControls only loaded analyses on selection/Reload and
  applied panels only to an empty board; the provider polled only result rows.
- BiControls now polls health + /vaults every 15 seconds and compares selected
  reads {tag, commit} with the loaded catalog version. A difference triggers
  /analyses and reconciliation. Reload, board load and returning from edit/save
  also fetch/reconcile. Timers and in-flight reads abort on switch/unmount.
- biDashboard.ts reconciles by vault/slug and stored query.digest. Changed digests
  update type, mapping, title, question and parameter definitions. Panel IDs,
  layout, transforms and appearance survive. Current valid parameter values
  survive; invalid values use the new default. Removed params/slugs lose their
  associated variables/values. New slugs append in feed order below existing
  panels. Unchanged digests preserve the existing panel object references.
- Query digest is Atlas metadata, not an HTTP parameter. Including it in runtime
  query identity causes a refetch when an analysis changes. Question metadata is
  shown in the panel-header tooltip. No dashboard schema change or autosave.
- DashboardPage uses a reconciliation callback that preserves saved name/revision
  and preview state. Empty saved boards also retain identity/title and use the
  normal initial layout; explicit vault selection still creates a fresh view.
- Added six reconciliation unit cases: changed digest, unchanged digest, added,
  removed, invalid enum/current params, empty saved-board identity.
- Extended scripts/test-aep-bi-i1.mjs: after all real fixture cases, an Atlas-only
  local HTTP stub publishes v2 (bar→line, new title/question/mapping/enum choices),
  then v3 via Reload (line→bar). Assertions check actual rendered marks, controls,
  fallback value and unchanged geometry. AEP and golden files remain untouched.

## Decisions

See DECISIONS.md, 2026-11-01 published analysis reconciliation. The coordinator
allows vault-version or result-version detection; vault polling also detects
added/removed analyses without any live result subscriptions. Reconciliation is
paused during editing/saving to protect local edits and resumes with a fresh load.

## Verification and evidence

- npm test: 147 passed, 0 failed/cancelled/skipped; 132252.8646 ms.
- npm run build: TypeScript/Vite passed, 173 modules, 14.21 s; existing chunk-size warnings.
- Python server tests: 35 tests, OK (skipped=7), 14.967 s.
- Drift check: all 17 files match. git diff --check passed.
- Final I1 exit 0: six real fixture cases plus published-version stub passed;
  ports 53611/5179 confirmed stopped.
Commands and evidence details are recorded in VALIDATION.md and TASKS.md. All golden JSON remains producer-owned and byte-exact.
The first I1 attempt timed out in CDP Page.navigate before any acceptance case;
a separate run after build completed passed without relaxing test conditions.
Ignored .scratch/aep-bi-i1 contains screenshots, observed requests and report.json.
No Agent Web or desktop GUI tests were run by this Atlas worker.

## Next steps

1. Coordinator reruns the real Agent Web throwaway-vault publish rehearsal, using
   VITE_AEP_BI_PORT=53621 (or its chosen loopback port) when starting Atlas.
2. Confirm a real v2 publish updates chart/title/params without vault reselection,
   with personal geometry and valid values retained. Owner-present §6.5/I2 remains
   pending until that rehearsal/acceptance is confirmed; the local stub does not
   replace it.
3. Record any new findings and final I2 acceptance in TASKS.md/VALIDATION.md.
The earlier Harness/Benchmarks browser acceptance remains independent and pending.
Prior checkpoints: 81c86e1 (BI), ef20cd0 (goldens), bc8efda (original I1 runner).
