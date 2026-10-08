# AEP Harness Telemetry：本機整合與 Claude Code 交接

**狀態：待開發的整合指南。** 本次只補文件，沒有新增 provider、JSONL importer 或 telemetry UI。先完成 [本機啟動與通用 dashboard 驗收](LOCAL_DEVELOPMENT.md)，再開始本頁工作。

## 1. 目前能用的元件與缺口

| 項目 | 目前程式碼 | 整合還需要做的事 |
| --- | --- | --- |
| JSON／CSV | package 或 inline dataset | 沒有 JSONL 逐行 parser、檔案上傳或 telemetry schema validator |
| REST／polling | 瀏覽器 GET 完整 snapshot；`refresh` 單位是秒 | 核對 AEP envelope、pagination、認證及 CORS；新增 adapter |
| WebSocket | 每則訊息重新 normalize 成完整 dataset；有限重連 | 不是 raw event stream；需要 backlog/live 合併、cursor、去重與 reducer |
| Table／filters／transforms | 通用 table／graph dataset 與 pipeline | 把 canonical events 衍生成 runs、spans、transitions、metrics |
| Timeline | `start`／`end`／`label` 的平面事件列表 | 巢狀 spans、open span、缺失 parent、並行 lane |
| Network | 2D／3D、箭頭、重複邊／自迴圈繪製、搜尋及無向 shortest path | 事件到 transition 的聚合語意、次數／失敗原因、有向路徑搜尋 |
| Heatmap | 可重用 renderer、missing／zero 區分 | 定義並計算 strategy × state 的效率指標 |
| 聚合 | count、sum、mean、median 等 | 沒有 p95／percentile operator；需另加有測試的計算 |

`normalizeTable` 只接受 row array 或 `{rows: [...]}`。即使 `/runs` 能回 200，也不能假定 `{runs: [...]}`、`{data: [...]}` 或其他 envelope 可直接設定成 `type: rest`。`query` 目前也不會自動變成 REST URL 的分頁或時間參數；多數通用來源 filter 在前端執行。

目前只內附 RS Knowledge 與 Agent Validation；application menu 不會出現尚未建立的 AEP Harness。後端 `/dashboards` 僅存畫面設定，沒有 telemetry ingestion API、event store 或通用反向代理。

## 2. 先核對本機 AEP 的真實契約

以下是外部實作者回報的介面線索，**未在此 repo 或本機聯調獨立驗證，不是已保證的 API contract**。實作前須以自己 AEP checkout 的程式、文件及合成 sample 核對：

- 預期 base：`http://127.0.0.1:53583/api/v1/telemetry`。
- 回報有 `GET /runs`、`GET /runs/{id}/events`、`GET /events?since=...&until=...`。
- 回報有 WebSocket `/stream?after_ingest_seq=N`，先 backlog 再 live，重連使用最後的 `ingest_seq`。
- 回報有 CLI：`aep-host telemetry export --config <host.json> --out <output.jsonl>`。
- 回報的 AEP sample 路徑：`docs/telemetry/aep-telemetry-v1-sample.jsonl`，含 interrupted run；此檔不是本 repo 已提供的 fixture。
- 回報可由 AEP workspace 的 `telemetry.json` 設 `strategy_label`，restart 後生效；實際格式、適用範圍與 restart 指令請查該 AEP 版本，不要自行猜 JSON 結構。

AEP 的安裝、啟動及 config 由 AEP 專案文件負責；本 repo 沒有提供啟動 AEP 的指令。先取得本機最新版 contract／合成 sample，再確認：

1. REST response envelope、pagination、limit、時間單位、時區與 since／until 是否包含端點。
2. WebSocket URL／握手、逐則 payload 是 event 還是 wrapper、backlog 結束標記、cursor 過期／重設行為。
3. 認證方式、allowed Origin／CORS、錯誤碼、payload 上限；loopback 本身不等於具備認證。
4. schema 的 required／optional fields、status 值、未知 event types、`strategy_label` 與 `strategy_id` 的關係。
5. `ingest_seq` 的確切作用域與生命週期；不要把它和每個 run 的 `sequence` 當成同一個數字。

### 唯讀連線檢查

AEP 已依自己的文件啟動後，在本機 shell 檢查；此步不會把資料送到第三方，但回應可能包含私人資訊，請勿貼到公開 issue。

```powershell
$base = 'http://127.0.0.1:53583/api/v1/telemetry'
$response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Uri "$base/runs"
$response.StatusCode
$payload = $response.Content | ConvertFrom-Json
$payload.GetType().FullName
$payload | Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name
```

```sh
python3 -c 'import json, urllib.request; u="http://127.0.0.1:53583/api/v1/telemetry/runs"; r=urllib.request.urlopen(u, timeout=10); p=json.load(r); print("HTTP", r.status, "type", type(p).__name__); print("keys", list(p) if isinstance(p, dict) else "array/other: inspect shape locally")'
```

只檢查 envelope，尚未驗證 event schema、分頁、瀏覽器 CORS 或 streaming。401／403 時依實際 AEP 文件處理，不要將 token 放入 URL、public YAML 或前端 bundle；不要以停用認證、CSP、瀏覽器安全功能或開放公網 port 解決。

離線路線可先用 AEP 自己的 exporter 輸出到 **repo 外的私人目錄**。把下列占位路徑換成自己的檔案；CLI 是否存在及 flags 須先核對 AEP 版本：

```sh
aep-host telemetry export --config "/absolute/private/host.json" --out "/absolute/private/telemetry.jsonl"
```

Windows 同樣使用引號包住本機檔案路徑。**目前 dashboard 還不能匯入這份 JSONL**；輸出成功只代表接下來有本機 input，不能當成 dashboard 整合成功。

## 3. 兩種 schema 必須分開

- Canonical telemetry event：`schema_version: "aep.telemetry.v1"`，由 AEP 定義、先在 producer 端做 redaction。
- Dashboard document：`schemaVersion: 2`，包含 applicationId／panels／mapping／layout，儲存在 `/dashboards`。

不可把 event 直接 PUT 到 `/dashboards`，也不要為了套 renderer 改寫 authoritative event。adapter 保留 canonical event，建立 derived datasets 供 UI 使用。

早期設計草案提出的最小 envelope 包含 `event_id`、`run_id`、`trace_id`、`span_id`、nullable `parent_span_id`、每 run 單調的 `sequence`、含時區的 `timestamp`、`event_type`、開放字串 `state`、`status`、`attributes`。這是核對起點；不是對尚未取得的最新版 contract 做完整宣告。

重要處理原則：

- `event_id` 去重；以 `(run_id, sequence)` 重建 run 內次序；同 sequence 不同 event 的衝突應提示，不能靜默丟棄。
- `ingest_seq` 若由 transport 提供，按已核對的 cursor contract 用於接續讀取。收到但尚未成功處理的事件不能提前確認，缺口／retention 必須可見。
- timestamps 不足以推斷因果；span hierarchy 依 parent reference，transition 依明確事件或經契約確認的 run 內狀態順序。
- 缺失 tokens 保持 null／unknown；缺少 run.completed 保持 incomplete／interrupted，不補成成功或零 latency。
- 未知 event_type／額外安全 attributes 可保留；unsupported schema version、壞行、缺 required field 需有可定位的錯誤與數量，不能整批默默忽略。
- payload、行長、事件數、記憶體與 retained history 設上限；截斷要顯示。公開測試只用合成 fixture，不含 prompts、tool payloads、credentials 或可識別真實人的 traces。

## 4. 建議開發順序與程式入口

1. **固定 consumer contract**：讀本機 AEP 最新 schema／sample，記錄 envelope、排序與 cursor 語意；先加 sanitized synthetic contract fixtures／tests。
2. **離線 ingestion**：JSONL parser、版本驗證、錯誤行回報、有界 event index、event_id 去重及純函式 reducer。先讓同一輸入可重播、結果固定，再做檔案匯入 UI。
3. **REST adapter**：明確 unwrap、pagination／時間查詢與 cancellation。使用可信 `custom` provider 擴充點；不要改變現有 generic REST／WS 的 snapshot 契約。
4. **可視化**：先 derived runs table，再 nested span timeline、有向 transition graph、strategy/state heatmap、p50／p95。保留不完整資料與 coverage 標示。
5. **Live ingestion**：確認 transport contract 後，以同一 validator／reducer 處理 WS backlog 和 live；重連／backfill、重複／亂序、run 切換與 unsubscribe cleanup 都要測。

既有入口：

- `web/src/platform/sources.ts`：`SourceRegistry`／`SourceProvider`／registerProvider。
- `web/src/platform/runtime.ts`：application-scoped runtime、query／subscribe／pipeline。
- `web/src/platform/dataset.ts`、`types.ts`：normalized table／graph；來源上限 8 MiB、20,000 rows、256 fields，不能當無限 event store。
- `web/src/platform/applicationLoader.ts`、`applications.ts`、`applications/agent_validation/`：application package 範例。新增 package 須重建；不要把真 traces 放進 build glob。
- `web/src/platform/simpleChartModel.ts`、`web/src/components/panels/SupplementalPanel.tsx`：目前平面 timeline。
- `web/src/platform/graphModel.ts`、`web/src/components/panels/NetworkGraphPanel.tsx`：無向 path 與 2D／3D renderer。方向性變更需保留既有 graph 行為及 regression tests。
- `web/src/platform/heatmapModel.ts`、`transforms.ts`：heatmap 資料模型與現有聚合。
- `web/tests/*.test.mjs`、`tests/server_test.py`：既有測試入口。

網路選擇要以實測決定：直接瀏覽器連 AEP 必須符合該服務的 Origin／CORS／認證；若確實需要 proxy，只設計固定 loopback upstream／允許路徑的窄 adapter，另做安全審查，不加入任意 URL proxy。現有 Vite proxy 只處理 `/dashboards`，不是 AEP proxy。

### 建議的 derived datasets

下列名稱與欄位是 consumer 實作提案，不是現有 sources 或對 AEP response 的假定。`strategy_key` 須依核對後的 strategy identity 決定，顯示 label 另存，避免把可變 label 當成穩定 ID。

| Dataset | Identity／主要衍生欄位 | Renderer／mapping |
| --- | --- | --- |
| events | `event_id`；保留 canonical event 與經允許的平面檢視欄位 | table／details，可追溯原始事件 |
| runs | `run_id`；strategy_key、status、start、end、duration_ms、token coverage | table；stat／bar 可用已驗證的 summary 欄位 |
| spans | `(run_id, span_id)`；parent_span_id、label、start、nullable end、duration_ms | 已閉合 span 可暫用平面 timeline 的 `start/end/label`；nested／open-span renderer 仍待新增 |
| transitions | occurrence 保留來源 event IDs；聚合以 `(run_id, from_state, to_state)` 記 count／failures | graph nodes 用 state，edges 用 source／target／weight；有向 path 還需實作 |
| state_metrics | `(strategy_key, state)`；dwell_ms、retry_count、loop_count、coverage／sample_n | heatmap：`x=strategy_key`、`y=state`、`value=選定指標` |
| strategy_metrics | `strategy_key` 加比較 cohort；completed_n、incomplete_n、p50_ms、p95_ms、failure_rate／coverage | table／bar／stat；僅使用已定義且有測試的聚合值 |

Model／skill filter 應先找出符合條件的 run IDs，再保留這些 runs 的所有 lifecycle／span events 進 reducer；直接刪掉不帶 model／skill 的 run.started、run.completed 或 parent events 會破壞 timeline 和 latency。若另做事件層 filter，須標示為局部事件視圖，不拿它計算完整 run 指標。

### 指標定義先於圖表

- Latency 說明採 producer 的 measured duration 或起訖 timestamp 差，不能混合兩種語意；open spans 保留 unknown end。
- Run wall-clock latency 不能用 parent 與 child durations 相加；並行 spans 也會重疊。若要 self time，僅在起訖齊全時扣除 children 時間區間的聯集，缺資料時保留 unknown／coverage。
- p50／p95 寫清 quantile 演算法與樣本母體、單位、有效樣本 n、排除的 incomplete／missing 數量；mean／max 不能冒充 p95。
- Tokens 顯示已回報的和及 reporting coverage；全缺值不可顯示 0。
- Heatmap 明確標示 cell 是 dwell time、retry count、loop count 或其他指標，以及 sum／mean／percentile；缺資料與真 0 分開。
- Strategy 比較要使用相同 benchmark cases／條件；沒有獨立驗證時不要把 progress signal 或 event status 包裝成正確率 benchmark。

## 5. 可直接交給本機 Claude Code 的任務

把以下文字交給能讀到兩個本機 checkout 的 Claude Code，另提供自己的 AEP repo 位置；不要把私人 config 或 traces 貼到公開 repo：

```text
請在 atlas-analysis-dashboard 本機 checkout 延續 AEP Harness telemetry 整合。

先讀 README.md、docs/LOCAL_DEVELOPMENT.md、docs/AEP_TELEMETRY_INTEGRATION.md、
docs/ARCHITECTURE.md、docs/SECURITY.md，以及實際 repo instructions。
依使用者提供的位置讀 AEP 最新 telemetry contract 與 sanitized synthetic sample。
不要假定本文件列出的 AEP endpoints、envelope、auth、CORS、cursor 已被驗證；
先唯讀核對實作，回報差異，缺少 authoritative contract 時先停在契約核對。

保留既有 Python loopback／Host／Origin／CSP／ETag／private storage 防護、
generic REST/WS snapshot providers 與 dashboard schemaVersion 2。
canonical event schema 是 aep.telemetry.v1，與 dashboard schema 分開。

按順序完成：
1. synthetic contract fixtures、JSONL parser／schema validation、有界 event index／reducer。
2. event_id 去重、run sequence 排序、unknown fields、missing tokens、interrupted runs。
3. AEP REST custom provider，驗證 envelope／pagination／auth／CORS；再做 JSONL import UI。
4. derived run table、nested span timeline、有向 transition graph、效率 heatmap、p50／p95。
5. 契約確認後接 WebSocket backlog/live，以驗證過的 ingest_seq 接續並處理 gaps。

使用同一 reducer 讓 JSONL replay、REST backfill、WS 得到一致的 derived datasets。
加 duplicate／out-of-order／missing parent／invalid line／cursor gap／disconnect tests，
以及取消請求、切換 run/application、StrictMode 重掛載和資源釋放 regression tests。
不要偽造未發生的完成事件或把 unknown tokens 當 0。
不要把私人資料、host config、credentials 或真 traces 提交至 repo，也不要開公網 port。

每個階段跑 npm test、npm run build、Python unittest，做本機瀏覽器手動驗收。
先在 local 完成並回報改動、測試、已知限制及 contract 差異；另取得明確指示才 push。
```

## 6. 整合完成的驗收標準

以下均是 **尚待實作／聯調的驗收條件**，不是目前版本已通過的項目：

- [ ] sample 的完整 run 與 interrupted run 都可見；可依 strategy／status／model／skill／time 篩選。
- [ ] 同一批事件亂序、重送或分段載入後結果一致；壞行有行號，不會污染已驗證資料。
- [ ] span 可巢狀呈現；缺 parent／end、平行 spans、重複 start/end 有明確規則與提示。
- [ ] transition A→B 不允許自動推成 B→A；重複、自迴圈與失敗原因可核對來源。
- [ ] heatmap／p50／p95／tokens 的手算 synthetic case 正確；缺資料、樣本量與 coverage 可見。
- [ ] WS backlog + live + 斷線重連與離線 replay 一致；cursor 缺口不被誤報為完整資料。
- [ ] AEP 停止或讀取失敗只讓 UI 顯示 stale／error，不影響 Harness 執行。
- [ ] CLI 讀取與真實瀏覽器 CORS／認證分別驗證；安全 headers、loopback、ETag／ACL regression 全部保留。
- [ ] 公開 diff 與 fixtures 只有程式／文件／合成資料；既有 dashboard tests 與 build 均通過。
