# AEP integration tasks

## AEP BI (2026-11-01)

- [x] Read owner brief, AEP design §5–6 and Atlas requirements/architecture/decisions/handoff.
- [x] Fast-forward this Atlas worktree to existing Atlas baseline 8267f66.
- [x] Preliminary A1: read-only bounded provider, cancellation, exact-query stale cache, 409 waiting and bounded retry; synthetic consumer tests.
- [x] Preliminary A2: application/vault controls, ordered panels, table/bar/line/scatter mapping, bool/date/text parameters, level counts, existing personal layout editor/storage, drift command.
- [x] Enum checkpoint: npm test 123/123 and Python server tests 35 OK (7 platform skips). TypeScript/Vite build passed (173 modules); git diff --check passed. See VALIDATION.md.
- [ ] A1: vendor and test F1 golden JSON. Blocked: producer golden directory absent in checkout and main on inspection.
- [x] A2 enum controls: require params.<name>.values as a string array, render exactly those choices with the default selected, and test selection/disabled state and parameter mapping (2026-11-01 coordinator contract).
- [ ] A1/A2 completion: producer drift check, golden-based consumer tests and final acceptance. Synthetic tests do not satisfy this.
- [ ] I1: do not start until owner says F3 is on AEP main.

Implementation is a preliminary working draft, not A1/A2 completion. See HANDOFF.md
and VALIDATION.md for validation and next actions. AEP remains read-only; no push.

User authorized implementation on 2026-10-10. AEP checkout is read-only.

- [x] Read AEP v0.2 contract, API and store implementation.
- [x] Add bounded JSONL validation, event index and deterministic derived datasets with tests.
- [x] Add custom REST provider, pagination, cancellation, AEP preset and JSONL import controls.
- [x] Add nested/open span timeline, directed paths and coverage-aware metrics (UI validation pending).
- [x] Add shared WebSocket ingestion, reconnect/backfill, health checks and cleanup tests.
- [x] Run available AEP tests and read-only real API/provider checks.
- [x] Restore npm dependency installation (184 packages installed).
- [ ] Obtain Windows Python 3.13+.
- [x] Pass full frontend suite (112 tests including benchmarks) and typecheck/build.
- [ ] Pass Python server tests on Windows Python 3.13+.
- [ ] Run browser checks: AEP import, run selection, recent window, live/reconnect, stale messages, application switching and legacy applications.
- [x] Update contract/architecture/validation documentation and handoff.

Overall status: implemented but NOT done under the project's definition of done; full validation is blocked by the environment. The user authorized a local commit of the combined integration; browser/backend acceptance remains pending. No push.


## AEP benchmark telemetry (Claude Code, 2026-10-10)

- [x] Benchmark derivation (`benchmarks.ts`), benchmark and trace loading in `AepProvider`, live routing for benchmark runs.
- [x] "AEP Benchmarks" dashboard preset and five data sources.
- [x] Tests: `web/tests/aep-benchmarks.test.mjs` (6); full suite 112 passed; build passed.
- [x] Live shell check against AEP `d29ac63` with a one-question benchmark and its grading.
- [ ] Browser acceptance of the Benchmarks dashboard, including Live during a running benchmark.
- [x] User approved committing Codex's integration and Claude Code's benchmark additions together.
- [x] Windows backend tests on Python 3.13.15: 35 tests OK, 7 platform skips (Claude Code, 2026-10-10).
