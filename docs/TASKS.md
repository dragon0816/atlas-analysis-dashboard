# AEP integration tasks

## AEP BI (2026-11-01)

- [x] Read owner brief, AEP design §5–6 and Atlas requirements/architecture/decisions/handoff.
- [x] Fast-forward this Atlas worktree to existing Atlas baseline 8267f66.
- [x] Preliminary A1: read-only bounded provider, cancellation, exact-query stale cache, 409 waiting and bounded retry; synthetic consumer tests.
- [x] Preliminary A2: application/vault controls, ordered panels, table/bar/line/scatter mapping, bool/date/text parameters, level counts, existing personal layout editor/storage, drift command.
- [x] Enum checkpoint: npm test 123/123 and Python server tests 35 OK (7 platform skips). TypeScript/Vite build passed (173 modules); git diff --check passed. See VALIDATION.md.
- [x] A1: vendor all 17 F1 JSON files verbatim from merged AEP main b6a139c5; golden consumer validation/rendering tests 17/17 and drift check pass.
- [x] A2 enum controls: require params.<name>.values as a string array, render exactly those choices with the default selected, and test selection/disabled state and parameter mapping (2026-11-01 coordinator contract).
- [x] A1/A2 fixture acceptance: golden-based consumer tests, all six I1 cases, npm test 141/141, TypeScript/Vite build, Python 35 tests OK (7 skipped), and drift check 17 files pass.
- [x] I2 rehearsal fix: reconcile published catalog changes by slug/digest using 15-second vault-version polling and manual Reload; preserve layouts/current valid params; unit coverage for changed/unchanged/added/removed/invalid enum and empty saved-board identity cases.
- [x] Extend I1 with an Atlas-only two-version HTTP stub: automatic bar→line/title/question/mapping/enum fallback, manual Reload line→bar, stable geometry; actual browser acceptance passed.
- [x] Republish fix final checks: npm test 147/147; TypeScript/Vite build (173 modules); Python 35 tests OK (7 skipped); drift 17 files match; I1 six fixture cases + republish stub pass; git diff --check passes.
- [ ] I2: owner-present real-vault publish/edit/publish acceptance (design §6.5); separate from completed fixture acceptance.
- [x] I1: all six design §6.4 cases passed against merged AEP main b6a139c5 in isolated headless Edge; runner exit 0 and owned servers stopped. See HANDOFF.md and VALIDATION.md.

Producer golden and I1 acceptance are implemented. See HANDOFF.md
and VALIDATION.md for validation and next actions. AEP remains read-only; no push.

## Atlas dashboard read producer for AEP (2026-11-01)

- [x] Confirm existing source/vault/slug identity and flat stored geometry; no schema change.
- [x] Confirm no-Origin loopback reads and cross-site refusal without changing HTTP policy.
- [x] Document read routes/statuses, fields, geometry order and coordinator-approved first-occurrence duplicate rule in AEP_DASHBOARD_READ_CONTRACT.md.
- [x] Produce three exact response-body goldens, generation script and isolated HTTP tests (5/5), including a later duplicate and legacy dashboard; frontend contract tests 3/3.
- [x] Final validation: npm test 150/150; TypeScript/Vite build (173 modules); Python 40 tests OK (7 skipped); upstream feed drift 17 files match; git diff --check passes. Commit the producer contract on the current branch, without push/PR.
- [ ] AEP consumer vendors the committed producer files and implements import preview/order/hidden (AEP-owned follow-up; no AEP changes here).

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


## Read-only embeds for AEP's chat (2026-11-02)

- [x] Record the owner decisions, amending the 2026-11-01 "no embed" position.
- [x] Server: `/embed/*` headers, configurable ancestors, `_check_origin` for framed documents.
- [x] Contract docs/AEP_EMBED_CONTRACT.md and goldens atlas_embed_golden/ with tests.
- [x] Embed pages for both routes; loading, offline, waiting, unknown and invalid states.
- [x] Correct the limit key in the read-contract golden; AEP re-vendors it.
- [x] Decide the three open states from existing behaviour and write them into the contract.
- [x] Headless embed I1 12/12 and BI I1 regression; npm test 190/190, build, Python 53 OK (7 skips), drift.
- [ ] AEP vendors the final contract commit and renders the iframe (AEP-owned).
- [ ] Check framing from real Agent Web once AEP's side lands.
- [ ] Rerun test_cross_process_compare_and_swap on a quiet machine (see VALIDATION.md).

## Saved dashboards and dashboard files (2026-11-02)

- [x] Saved boards update and remove but do not gain analyses, in the app and in embeds; live boards unchanged.
- [x] "Add analysis" select through the existing editor.
- [x] Import a dashboard file: schema and size checks, clear refusals, no silent overwrite, explicit replace.
- [x] Export a dashboard file: the GET document, unwrapped; stated in AEP_DASHBOARD_READ_CONTRACT.md.
- [x] Unit tests and embed I1 for both; contract docs updated; goldens unchanged since c7f9468.
- [x] Browser check that a saved board gains nothing on a real republish: embed I1 22/22, with a live-board control.

## Atlas 模擬儀器 P1（2026-11-04）

- [x] 專用 mux scalar provider、sequence/time/unit/checked verdict、共享連線、100ms bounded snapshots。
- [x] 模擬 application / line-stat-table、pass denominator、sample sigma / Cpk、partial/stale coverage。
- [x] 5 項 adapter/preset 測試；全套 web 213、build；既有 server 53（7 skip）通過。
- [x] 真 Atlas HTTP 輸出餵 production adapter：12 samples/report parity、replay、error abort、Stop；與 Python 統計相同。
- [x] 瀏覽器 Atlas GUI→21/21 sweep→Dashboard live line/stat/table。
- [ ] 原始波形、durable identity、production hosting adapter、多 runner、長跑與離線驗收。
- [ ] Stop 後可靠保存需要 Atlas host journal；現有 worker 強制停止會留下 null JSON，已明確記錄。

操作、契約、具體限制與重跑指令見 [ATLAS_SIMULATION](ATLAS_SIMULATION.md)。


## Atlas 第二階段（2026-11-04）

- [x] durable UUID/event_sequence、只讀 restore/replay、亂序前綴、衝突/舊 run 拒絕、斷線 STALE。
- [x] bounded 自動 recovery/retry/cleanup；web 221/build；8 項 durable tests。
- [x] 真 host archive 對照、GUI Stop/Reload 三筆 UUID 一致、fixture resume 磁碟恢復。
- [ ] 原始 waveform adapter、production proxy、多 runner、長跑/掉電與真機仍待驗。

P1 上述兩項 durable identity/Stop 保存待辦已由本階段的 opt-in host journal 與 provider 完成；
legacy worker JSON 可能 null，消費端須使用 host acquisition JSON。


## 2026-11-04 雲端接續 portable exporter

- [x] 固定 `033d67b2` 基準，Library 第三階段 21 檔 manifest 還原；保留原始交接包，核對後正規化 LF。
- [x] portable exporter action 放回現有 toolbar。
- [x] 最後 tree 前端 225 項通過、TypeScript／Vite build 通過。
- [x] 實際 exporter／Atlas consumer 合成互通：line／stat／table、transform closure、runtime／stored report 值、live 更新及清理、digest／capability／權限拒絕。
- [ ] 真實 AEP Session、static／streaming processing 的完整語意移植、第二 host 瀏覽器 import／bind／視覺驗收、CI。
- [ ] 僅 draft PR；兩條 E2E 與 CI 全過前不 merge；approval 需 Leo 針對當次 PR 明確確認。
