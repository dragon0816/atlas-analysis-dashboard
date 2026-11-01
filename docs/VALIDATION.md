# 驗證紀錄

## 2026-11-01 — AEP BI preliminary A1/A2

- Final `npm test`: 121 passed, 0 failed, 0 skipped (Node 24.11.1). This includes existing workspace persistence/drag/resize regression tests and the new synthetic BI checks.
- `npm run build`: TypeScript and Vite pass (173 modules); existing chunk-size warnings remain.
- Python 3.13 `-B -m unittest discover -s tests -p 'server*.py'`: 35 tests OK, 7 platform skips.
- New consumer tests cover bounded/validated responses, additive keys, exact-parameter stale retention, GET-only credentials omission, cancellation, waiting retry limits/disposal, chart/parameter mapping and byte-level drift checking.
- UI/SSR tests cover saved layout preservation, bool/date controls, waiting without chart errors, level counts and scatter series. They use synthetic consumer examples, not AEP golden files.
- `npm run check:aep-bi -- --aep C:/Users/Chi_L/Documents/ChatGPT/agentic-engineering-platform`: FAIL, upstream `tests/fixtures/bi_feed/golden` absent (ENOENT). This remains a prerequisite, not an accepted skip.
- Enum choice wire contract is unresolved; enum controls show only their disabled default. Golden-based acceptance and real browser acceptance are pending. A1/A2 are not complete.
- I1 has not been implemented or run. Owner explicitly requires notification that F3 is on AEP main before starting I1. No fixture server was launched and no AEP files were modified.
- Sandbox esbuild failures were retried with approved execution outside the sandbox. No test conditions were relaxed: the existing application-count assertions were updated from 3 to 4 for the added application, retaining path-isolation checks.

日期：2026-10-08。

本檔記錄 standalone 版本此次同步的驗證；component DOM／renderer double 不等於實際 GPU 或完整瀏覽器驗收。

## 本機文件交接複查

- 2026-10-08 文件更新：新增 [本機操作指南](LOCAL_DEVELOPMENT.md) 與 [AEP 整合交接](AEP_TELEMETRY_INTEGRATION.md)，只改文件，未新增 telemetry 功能。
- Linux、Node 24.19.0、Python 3.12.14 重跑：前端 79／79、TypeScript／Vite build 通過；後端 35 項中 34 通過、1 項 Windows-only 略過。沿用既有 lockfile 對應依賴，本次沒有重新完成乾淨 npm ci。
- 文件相對連結／code fences 已檢查；隔離資料目錄的 loopback smoke 驗證首頁 GET／HEAD、index 連結的 JS／CSS、CSP 與空白 `/dashboards` 均正常。PowerShell 指令與 macOS 原生環境未在本次 Linux 環境執行。
- 基準 commit `ffe3db1212293a84a3adf4b82feb51da33500974` 的 [GitHub Actions run 37773749357](https://github.com/dragon0816/atlas-analysis-dashboard/actions/runs/37773749357) 已確認 Ubuntu／Windows job 成功，包含 npm ci、tests、build 與 Python tests。這不等於 Windows 互動式瀏覽器／GPU 或 macOS 原生驗收；後續 commit 需另看其 CI。
- 本次沒有執行本機 AEP API、export CLI 或 WebSocket 聯調；文件中的 AEP 新介面是未獨立驗證的外部回報。JSONL／reducer／巢狀 timeline／有向 transition path／p95 仍待實作。

## 本次自動驗證

- Node.js 24.19.0：前端完整 79／79 tests 通過，無略過。
- TypeScript noEmit 與 Vite production build 通過；不產生 source maps。
- Python 後端共35項：34通過，1項 Windows-only test 在 Linux 略過。後端程式、HTTP 安全 headers、Windows ACL／locking 與 CI 設定未變更。
- 新增的 Three.js runtime 為按需載入、本機 bundle，沒有 CDN。Three.js chunk 約543 kB、application chunk 約656 kB（未 gzip），Vite 提示超過500 kB；這是建置警告，不是測試失敗。
- 此環境未完成乾淨的 npm ci；offline cache 缺少 yaml 套件。本次本機測試使用與 lockfile 對應的既有安裝依賴；乾淨 npm ci 與 Windows 原生結果須以此次 commit 的 GitHub Actions 為準。

涵蓋：

- Dataset、CSV、pipeline、來源取消／共用／大小限制、REST／WebSocket mock transports
- 18種 renderer routes、SSR、heatmap／bar 顏色與透明度、無效顏色與邊界值
- 收合控制列、filter summary、localStorage preference、StrictMode／重掛載
- 可見 Remove、移除後 Cancel、空白 New dashboard、重複 New／取消、Save／Save As 成功回 Preview、save lock／失敗重試／衝突、不變的 schemaVersion 2契約
- Graph 標籤、群組邊界、搜尋、篩選、路徑、drag cancel、連線布局與分組布局
- Synthetic connected fixture 可重現、67 nodes／206 edges／138條跨主要群組 edges；原始140 nodes／120 edges完整保留，共享 identity 唯一、沒有 dangling references
- 2D／3D 切換、相機與選取保存、場景切換、renderer cleanup／失敗回退；此部分以 renderer double 驗證 React 狀態生命週期，並非 WebGL像素驗證
- 後端真 HTTP、原子儲存、ETag、並行、路徑／symlink／payload防護
- 本次 production smoke：Python server 的 index、6個 JS／CSS assets（含按需3D檔案）皆回200，空白儲存目錄的 /dashboards 回空陣列；安全 headers 保留
- npm ls --depth=0 通過，既有安裝中可用套件版本與 lockfile 比對無差異

## 既有依賴查核（歷史結果）

下列是2026-10-07的查核，本次未重跑線上 audit，不能當作新增 Three.js 後的即時安全結論。

完整 npm audit 另回報7項 development dependency alerts（2 moderate、5 high），都來自 Tailwind 3 的 build/watch 依賴；production-only audit 為0。[braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) 尚無patched release；[selector parser advisory](https://github.com/advisories/GHSA-rj75-hqrm-r3gf) 的修正需要跨dependency major。沒有使用 force update或未經驗證的major override。此專案只對可信任的固定source globs／CSS執行建置；不要讓不可信任的glob patterns進入build/watch工具。Tailwind major migration需另行驗證。


## 未計入本機通過的項目

- 後續 commit 的 Ubuntu／Windows GitHub Actions 結果；基準 commit 的已確認結果見上方。CI設定保留雙平台、Python 3.13、Node 24、npm ci、tests與build
- 真實瀏覽器／GPU的WebGL 2視覺、context loss、完整fullscreen、觸控、不同尺寸與SVG pointer座標
- Windows與macOS原生filesystem／ACL／locking
- 真實外部REST／WebSocket站點、CORS、企業登入或效能benchmark
- Atlas／Vault adapter、Atlas export/import、事件串流增量合併／增量布局：尚未實作，不列為已驗證功能

## 本機手動驗收建議

1. RS Knowledge顯示Synthetic data；展開／收合Dashboards與Filters，篩選摘要及Reset仍可使用。
2. Edit → 新增／移動／resize／Duplicate／Remove → Cancel，確認還原；Escape取消單次拖曳。
3. New dashboard → 加panel → Save命名 → Preview；重新載入後開啟。重複New再Cancel應返回原畫面。
4. Save As → 修改 → Save；第二視窗先更新後，舊revision應無法覆寫，失敗保留草稿。
5. Graph切換兩個synthetic情境、兩種布局與2D／3D；核對搜尋、filters、path、selection、zoom／fit及fallback提示。
6. Heatmap／bar調色與透明度，Save後重開確認設定；切換Agent Validation核對CSV join及budget ratio。

## 2026-10-10 AEP integration work in progress

- Node v24.11.1: 25 AEP unit/integration tests passed using the built-in test runner. Covers JSONL/schema bounds, duplicate/ordering/conflict handling, full-run filters, missing data, quantiles, directed paths, REST pagination, cancellation, live sharing/reconnect, cursor reset/gaps, cleanup and runtime registration.
- Live read-only AEP checks: `/runs` and `/health` HTTP 200; local Origin returned the matching CORS header. All six provider views returned datasets. Busy 24-hour overview reached the explicit 10,000-event bound; a selected complete run returned 29 events, 23 spans and 10 transitions without truncation. No trace contents were written to the repository.
- Native Node WebSocket received an `aep.telemetry.v1` frame with numeric ingest_seq. Its close subsequently emitted an error (AEP's minimal close handling); this is not a browser reconnect acceptance result.
- Full `npm test` attempted before the final added tests: 46 passed, six test files failed to load because esbuild was unavailable. AEP UI tests were subsequently added but are also blocked by missing dependencies.
- `npm run build` blocked: tsc unavailable because npm ci could not complete. No typecheck/build success claimed.
- `npm ci --cache .npm-cache --no-audit --no-fund` blocked by corporate Zscaler HTTP 403 for registry.npmjs.org. No registry substitution or security-policy bypass attempted. package.json/package-lock.json unchanged.
- Python 3.12.14 server test attempt: 35 tests, 19 errors at the existing Windows Python 3.13+ private-directory guard, seven skips, nine passes. This is not an accepted Windows test result; no guard was disabled.
- No production browser build was available, so interactive browser acceptance remains pending.

- 2026-10-10 proxy follow-up: inspected the user-designated SSH config read-only. Did not start its SOCKS tunnel to circumvent the known corporate public-registry denial. Internal `https://npm.rsint.net` check failed with TLS unexpected EOF. Approved dependency access is still unresolved.

## 2026-10-10 — npm access recovered and frontend verification passed

- Retried npm ci using the existing registry/configuration: succeeded, 184 packages installed. No SSH tunnel was started and no proxy/registry configuration was changed by this task.
- Fixed TS2801 in AepProvider: when the last query consumer releases the session, abort its controller without the redundant narrowed Promise condition. Aborting a settled controller is harmless; shared active consumers remain protected by the user count.
- Full frontend suite: 106 tests passed, zero failures/skips, including AEP UI and existing applications.
- npm run build: passed TypeScript and Vite production build. Existing >500 kB chunk warnings remain nonfatal.
- esbuild required execution outside the filesystem sandbox to read parent directories; no test assertions or security controls were changed.
- Windows backend verification still requires Python 3.13+. Real browser acceptance remains pending.

## 2026-10-10 — AEP benchmark telemetry (Claude Code)

- `npm test`: 112 passed, 0 failed (adds `aep-benchmarks.test.mjs`, 6 tests).
- `npm run build`: TypeScript and Vite production build passed; the existing >500 kB chunk warnings remain.
- `parseDashboardDocument` accepts `applications/aep_harness/dashboards/overview.yaml` and `benchmarks.yaml`.
- Live shell check (not browser acceptance): AEP Agent Web from commit d29ac63; `AepProvider` read the `tel-smoke-001` benchmark run, its graded case (coverage 0.438), the case's AEP conversation run by `trace_id` and its 23 spans without warnings.

## 2026-10-10 — Combined integration commit verification

User authorized committing the Atlas integration and Claude Code benchmark additions together. Reran full npm test: 112 passed, zero failures/skips. npm run build passed TypeScript and Vite (166 modules); existing chunk-size warnings remain. No implementation changes were made during commit preparation. Windows Python 3.13 backend tests and real browser acceptance remain pending, so this is a checkpoint commit, not full acceptance. No AEP modifications or push. Temporary provider patch is excluded.

## 2026-10-10 — Windows backend tests on Python 3.13 (Claude Code)

- Python 3.13.15 (Astral python-build-standalone via `uv python install 3.13`, user profile only, no system change), at repo root: `python -B -m unittest discover -s tests -p 'server*.py'` → 35 tests, OK, 7 skipped.
- Skips are platform limits, not failures: five need Windows symlink privileges; `test_default_outside_source`, `test_hardlink_and_fifo_rejected` and `test_private_directory_and_files` cover POSIX-only behaviour (Windows uses LOCALAPPDATA and native ACLs).
- The Python 3.13+ guard in `server/windows.py` was not changed. Python 3.12 is not a valid substitute: before 3.13, `mkdir(mode=0o700)` on Windows does not restrict the directory ACL.

## 2026-11-01 — AEP BI enum checkpoint

- npm test (web/): 123 tests passed, 0 failed/cancelled/skipped, duration 153696.1751 ms.
- Python 3.13 server suite at repo root: -B -m unittest discover -s tests -p 'server*.py': 35 tests, OK (skipped=7), 20.302 seconds.
- The first npm run build passed TypeScript but Vite/esbuild could not read a parent directory under the filesystem sandbox. The same build passed with approved execution outside the sandbox: TypeScript passed; Vite 7.3.7 transformed 173 modules and built in 33.48 seconds. Existing >500 kB chunk warnings remain; no code/test weakening or dependency changes.
- Producer golden vendoring/drift acceptance and I1 deliberately deferred pending the coordinator's F1–F3-on-main notification. The enum contract is pending AEP main merge (b6a139c5), not an unresolved specification question.

## 2026-11-01 — AEP BI producer golden and I1 acceptance

Producer: merged AEP main b6a139c5cfae4b21ac42c27f471e9b028e3679b1.
All 17 JSON files were copied verbatim and Git attributes preserve their bytes.
The golden suite passed 17/17: requests.json coverage, health/vault/catalog
validation and controls, every result's table cells or numeric chart marks,
and all error/waiting states. No producer/design mismatch was found.

I1 command from web/ (requires Node 24, AEP interpreter, installed Edge and free
ports 53611/5179; see LOCAL_DEVELOPMENT.md):

```powershell
$env:AEP_REPO = 'C:/Users/Chi_L/Documents/ChatGPT/agentic-engineering-platform'
npm.cmd run test:aep-bi:i1
```

Final I1 exit 0, 6/6 cases passed against the real fixture server:

| Design §6.4 case | Verified outcome |
| --- | --- |
| Vault list | Golden published fictional vault title offered |
| Every panel | All three panels in feed order; every golden default table cell/bar mark/line point; gap=1, warning=2 |
| Parameter refetch | Live domain=AIDC request; accounts TW=2, US=2; wireless coverage also checked |
| result_not_ready | Actual 409 displayed as waiting, then bounded retry obtained wireless tech golden result |
| Stop AEP | Last AIDC data retained with stale/disconnected health and last-data-retained warnings |
| Non-local Origin | 403 with exact error-origin_refused.json |

Zero browser runtime exceptions. Four screenshots, observed requests and JSON
report are in ignored .scratch/aep-bi-i1/. Ports 53611 and 5179 confirmed stopped.
No Agent Web or GUI desktop tests ran. The fixture script ran with AEP cwd and
bytecode writes disabled; no producer source/configuration/fixtures were modified.
The first I1 run passed cases but failed cleanup on an already stopped child;
that cleanup was fixed and the full I1 rerun passed. Initial golden UI tests needed
fixture preloading and MessageChannel cleanup; no assertions were weakened.

- npm run build: TypeScript passed, Vite 7.3.7 built 173 modules in 15.11 seconds;
  existing >500 kB chunk warnings remain.
- Python 3.13: -B -m unittest discover -s tests -p 'server*.py': 35 tests,
  OK (skipped=7), 23.045 seconds.
- npm run check:aep-bi -- --aep <AEP repo>: 17 files match after I1/full checks.
- Owner-present real-vault acceptance (§6.5/I2) remains a separate pending task.
- Final npm test: 141 passed, 0 failed/cancelled/skipped, 143522.0012 ms.
- git diff --check passed. No separate lint script exists; build checks TypeScript.
