# Atlas 模擬儀器 scalar streaming（P1）

2026-11-04。此 application 使用隔離 Atlas runner 1 的已完成量測資料，不使用 AEP telemetry。
資料是 synthetic，來源時間也是 simulator 宣告的合成時間；不是實機讀值或完整波形。

## 啟動與操作

1. 在 Atlas checkout 安裝 pyproject 依賴、建置 web，執行：

   ```powershell
   python tests/serve_simulation_fixture.py --port 18765 --work build/simulation-demo
   ```

   它只接受 Atlas `build/` 內不存在的新目錄，建立 simulation scope、設定、計畫與 webext selection；
   不關閉任何佔用 port 的程式，不碰正式 UserDir。不使用舊 `atlas gui` 的單一實例啟動路徑。

2. 在本 repo：

   ```powershell
   cd web
   npm.cmd ci
   npm.cmd run dev -- --port 18766 --strictPort
   ```

   開啟 `http://127.0.0.1:18766/` → Dashboards → Application → Atlas Simulated Instrument。
   此開發用 Vite proxy 只將 `/atlas-api` 送到固定 loopback `127.0.0.1:18765`。
   無任意 URL proxy、額外 CORS 或安全設定變更。standalone Python production hosting 沒有此 proxy。

3. 在 `http://127.0.0.1:18765/` 以 Quickstart Environment / Test Plan 產生具名 YAML / JSON。
   Apply working copy 後在 Runner 1 選用，新增文件先明確 Save，再 Run。
   例如 21 samples、sweep -60..-90 step 5，即可顯示循環功率曲線、樣本表與統計。
   合成 clock rate 和 pacing 是兩個設定，吞吐仍含 runner overhead，未做真機效能承諾。

4. Dashboard Save/Open 是原本的獨立服務，可選用 Windows Python >=3.13，依 server/README
   在 port 8127 指定全新私有測試資料目錄。沒有啟動時 list saved dashboards 會報錯；量測串流仍可運作。
   本次用已安裝 Python 3.14.4 執行既有 server 測試與隔離啟動，沒有修改 ACL 或安全要求。

## 契約

來源 `simulation.samples` / `simulation.statistics` 使用 `AtlasSimulationProvider`。
所有 panels 共用一條 EventSource。現有 host extension 仍只能訂閱 host stream；這個
EventSource 是**獨立 dashboard application 的 adapter**，不是 Atlas extension 內另開連線。

`/instances/events` 的 `mux` envelope 是 `{runner,event,data}`，data 為既有 JSON 字串。
start 指定 testcases；result.index 為 testcase ordinal；end 只表示 execution 結束，不能推論全數通過。
result 的 `Simulation.contract` 必須是 tuple `atlas.simulation.power.v1`，並具有：

| 欄位 | 語意 |
| --- | --- |
| sequence | simulator acquisition sequence，P1 預期與計畫 index 一致；不同時提示 |
| acquired_at / timestamp_kind | 有 timezone 的來源時間 / synthetic；不使用接收時間替代 |
| power_dbm / setpoint_dbm | dBm 的有效有限數 |
| frequency_hz | Hz 的有效有限數 |
| error_db | dB；既有 CheckedResult tuple 的 index 2/3 為 limits、index 8 為明確 verdict |

只讀 runner 1 與這個固定來源。execution error 由既有 stats.error + fixture testcase 名稱辨識，
保留 error row、數值為 null；這不是任意儀器/testcase 的通用 adapter。
沒有 contract 的其他測項略過，mixed plan 的數量落差在 end 明示。trace-summary、不合法 units/time/numbers
不會被補成有效功率。結果以 index 去重；衝突保留第一筆並提示。

每 100 ms 發完整 bounded snapshot，最多 5000 rows、每 mux text 64 KB、最多 21 條診斷。
native EventSource 斷線自動重連，保留的圖明示 STALE；onopen 清空再重建現有 start/result/end replay。
只承諾 session-local identity，沒有跨 browser reload、live 與 archive 的 durable identity。
abort/unsubscribe/dispose 會清連線與 timers，沒有額外獨立每 panel socket。

統計的 pass denominator 只包含 error_db 明確 checked pass/fail；error 與 unchecked 分開。
mean/sigma 只用有效 error_db，sigma 為 sample n-1；Cpk 要求一致有效 limits、n>=2、sigma>0，否則 null。
這是目前 snapshot 描述；不完整/stale/truncated coverage 必須保留，不能當正式產線能力結論。

## 可重跑驗證

在 Atlas checkout，對上述 fixture：

```powershell
$env:ATLAS_SIM_TEST_URL='http://127.0.0.1:18765'
python -m unittest discover -s tests -p test_simulation_http.py -v
```

此測試會建立 synthetic named documents，明確 Save all、Run / Stop runner 1，只能對隔離 fixture 執行。
它將真實 mux / reports / Python 統計寫到該 checkout `build/simulation-evidence/`。

再於本 repo 根目錄（兩 checkout 同層）：

```powershell
node --experimental-strip-types scripts/check-atlas-simulation.mjs ../atlas/build/simulation-evidence
cd web
npm.cmd test
npm.cmd run build
```

check script 使用 production adapter 逐列比對保存報表、以 Python statistics 驗 mean/sigma/Cpk，
並驗 replay、error abort 與 Stop incomplete 狀態，產出 `dashboard-comparison.json`。

本次：213 web tests 通過；build 通過（既有大 bundle warning）；53 Python server tests 通過、7 個平台 skip。
真實 12 筆資料的 mean_error_db=0.021519070369582、sample_sigma_db=0.117583645993070、
Cpk=2.773857768418138，與 Python 誤差 <1e-12；source value/unit/time 逐筆一致。
瀏覽器也已確認 Atlas GUI 產生的 21/21 sweep 顯示 line/stat/table，recipe 修改、非法欄位、Apply/Load/Download。
資料與畫面都是合成測試，沒有實機驗收。

## 明確限制與後續

- Atlas exception 在 seq=3 會中止後續計畫：8 個目標只有 2 個有效點與 1 個 error，顯示 3/8；不補零。
- Stop 會強制結束 worker；本次保存的 JSON 是 null。成功完成報表已驗一致，但停止後不能宣稱可靠保存。
  後續需 Atlas host-side durable acquisition journal；本次只保留測試捕捉 JSONL，不新增正式 recorder。
  既有 Atlas runner 可能仍顯示已取得結果的 PASS（例如 1/100）；此 adapter 以 total 另行提示 execution incomplete，不據此宣稱計畫完成。
- 尚未驗 browser 人工斷網故障、5000 筆長跑、跨工位、離線、完整 trace 或 production 部署。
- 此整合沒有修改既有本機 dashboard 的 knowledge 工作樹、Atlas 的未推送 port 修正、vendored renderer 或 AEP API。
- 內部工程師一天交付的 milestones、前提、GUI generator 與 AI Session / Skill 操作詳見 Atlas
  `Docs/GUI-SIMULATION-PLAN.md`、`Docs/GUI-SIMULATION.md`。第二個真實客製案、原始波形與真機另行驗收。


## 第二階段更新（2026-11-04）

上述 P1 的 session-local / Stop null 限制保留為歷史紀錄。本 worktree DashboardPage 改用
`DurableAtlasSimulationProvider`。Atlas opt-in host journal 在 SSE 前 fsync；host archive
`/archive/results/acquisitions/<run_id>.json` 獨立保存 partial/stopped/error，原 worker JSON 仍可能 null。
provider 先 GET `/atlas-api/acquisitions?runner=1&limit=1` 再 bounded paged restore，同一 stream 合併 live，
持久 run_id + event_sequence 去重；只顯示連續前綴、等待缺序、忽略舊 run。斷線 STALE，Stop 顯示 incomplete。
恢復 request 最多每秒一次、三次重試（重連可再試）、5 秒 timeout、8 MiB response、六頁/5000 results，
dispose 清 socket/abort/timers；不增加任意 URL proxy。

開發環境 `VITE_ATLAS_PORT=18775` + Vite port18776 連 Atlas P2 fixture18775；host 固定 loopback。
`node --experimental-strip-types scripts/check-atlas-acquisitions.mjs ../atlas-phase2/build/simulation-evidence`
用 production provider state 對實際 host JSON 逐筆驗證、反序/重播/reconnect 不重算。

本次 web 221 全通過（durable 8 項）及 build 通過；Atlas journal 8/host 3/queue16/HTTP3 通過。
HTTP12/12完成、error3/8、Stop1/100 均有非 null host JSON；GUI Stop3/100、Dashboard reload 同一 UUID，
隔離測試服務正常退出再 resume 後可恢復舊結果。Stop 筆數隨時點改變，不補未完成樣本。
兩筆以上合法樣本的統計與 P1 Python 對照相同；partial 的 pass_rate=1 仍明示 incomplete。

尚未驗實體掉電、host 強殺、5000 筆長跑、多 runner 或 production hosting。host 無自動 retention。
原始波形仍未實作，因 producer 已將 trace 摘要，需在摘要前另訂 block/clock/units/drop/backpressure 契約。
完整評估、API/大小界線、重跑與第二真實產品依賴，見 Atlas `Docs/GUI-SIMULATION-PHASE2.md`。
