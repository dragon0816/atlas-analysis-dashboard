# Atlas Analysis Dashboard

獨立、設定型的資料分析儀表板。以 **Sources → Transforms → Datasets → Panels → Layout → Editor** 組合不同領域的分析畫面，可在本機瀏覽器編輯，並將個人 dashboard 儲存在本機資料目錄。

## 主要功能

- 18 種面板：line、mask、bar、box、histogram、stat、gauge、table、heatmap、network、area、pie、donut、scatter、text、status、progress、timeline。
- 視覺化編輯器：新增、複製、可見的 Remove、拖移、二維 resize、數值版面編輯、New dashboard、Save 後回 Preview、Save As、Cancel、Restore default。
- 緊湊控制列：Dashboards／Filters 可獨立收合，收合時仍顯示有效篩選摘要；展開偏好只存於瀏覽器 localStorage。
- Network graph 提供 SVG 2D／Three.js WebGL 3D 切換、可讀標籤、群組邊界、依連線或分組分隔的布局，以及搜尋／路徑／篩選。
- Heatmap 與 bar 可調整顏色與填色透明度；編輯模式可將外觀存入 dashboard。
- 全域 filters、時間範圍、跨面板篩選、details、drill-down、graph highlight。
- JSON、CSV、REST、WebSocket 資料來源；來源共用、取消請求、大小限制、明確的錯誤及截斷提示。
- 順序式 filter、normalize、join、aggregate、calculate、sort、limit 與可重用 pipeline。
- 獨立的 Python 標準函式庫伺服器，提供靜態網頁及帶 ETag 的原子儲存。

## 快速開始

第一次移到本機，請依 [本機執行、開發與驗收](docs/LOCAL_DEVELOPMENT.md) 操作；內含 Windows PowerShell、macOS／Linux、儲存位置及排錯。要接 AEP Harness，接著讀 [Telemetry 整合與本機交接](docs/AEP_TELEMETRY_INTEGRATION.md)。**目前可以測試通用 dashboard；AEP telemetry adapter 尚未實作。**

需求：Node.js 24（package 要求 >=24）；Linux/macOS 使用 Python 3.11 以上，Windows 使用 Python 3.13 以上。Windows 分支為實驗支援；Ubuntu／Windows CI 已有通過紀錄，但不代表 Windows 實機瀏覽器／GPU 或 macOS 已驗收。

```sh
git clone https://github.com/dragon0816/atlas-analysis-dashboard.git
cd atlas-analysis-dashboard
cd web
npm ci
npm test
npm run build
cd ..
python3 -m unittest discover -s tests -p 'server*.py'
python3 -m server --port 8127
```

以上為 macOS／Linux；Windows 請使用本機指南中的 `npm.cmd` 與 `py -3.13` 指令。

開啟 http://127.0.0.1:8127 。伺服器預設只監聽 loopback；無須 Python 第三方套件。使用者 dashboard 預設寫入使用者資料目錄，不會寫入 application presets 或 repository。請勿把這個本機伺服器當成已具備登入、多人權限或公開託管能力的服務。

開發模式：先啟動後端，再於另一個 terminal 執行前端。

```sh
python3 -m server --port 8127 --allow-origin http://127.0.0.1:5173
# 另一個 terminal
cd web
npm run dev -- --port 5173 --strictPort
```

## 內附 application

- **RS Knowledge**：13 個 panels、8 個 logical sources，展示知識圖譜、coverage、conflicts、feedback、runs、pipeline health、gap 與 evidence traceability。
- **Agent Validation**：JSON runs 加 CSV budgets，展示 join、normalize、ratio、bar、line、scatter 及 timeline。

RS Knowledge 的 graph 可切換原始 sparse 情境（140 nodes／120 edges）與 interconnected 情境（67 nodes／206 edges）；後者含共享節點與138條跨主要群組連線。其他 panels 保留原本示範資料，並非與新 graph 逐筆對應。

兩者皆為 synthetic fixtures。畫面中的題目、分數、owners、sources 與執行紀錄只用來驗證產品功能，不是真實使用者、企業資料或已完成的 benchmark。

新增領域時，可增加 `applications/<id>/` 中的 YAML、JSON、CSV package，不必將領域名稱寫進 Core。資料在 build time 載入，新增或修改 package 後需要重新 build。

## 使用

1. 展開 **Dashboards** 選 Application 與 Default preset；展開 **Filters** 修改篩選。控制列預設收合，摘要與 Reset filters 仍可見。
2. 點 **Edit Dashboard**，從左側 panel library 新增面板，在右側設定來源、pipeline、mapping、display、interaction。
3. 拖標題把手移動，拖右下角調整大小；也可直接修改 Layout 數字。Escape 或 pointer cancel 會還原當次拖曳。
4. **+ New dashboard** 建立空白草稿，**Cancel** 可回到先前畫面。**Save As** 建立新名稱與新 identity。**Save** 更新已開啟版本，成功後回到 Preview；失敗時保留草稿。**Cancel** 還原本次編輯及 filters。
5. **Restore default** 先修改 draft，仍需 Save；Cancel 可撤回。
6. 使用每個 panel 的 **Data** 檢查資料、**Refresh** 重取資料、**Fullscreen** 放大。

3D 需要支援 WebGL 2 的瀏覽器與 GPU；初始化失敗或 context 遺失時會回到 2D 並提示。3D 座標、深度、邊界大小只是布局結果，不表示證據強度或知識分數。依連線布局的邊界可能重疊，邊界陰影不代表節點成員判定。

## 目前界線

- 尚未實作 Atlas／Vault adapter、Atlas 匯出／匯入流程，也不會自動讀取真實 Vault。
- JSON／CSV package 與 REST provider 已存在，但沒有新增檔案上傳／通用資料匯入精靈。
- WebSocket provider 處理完整 snapshots；尚未提供事件串流的增量合併、增量 graph 更新或增量布局。
- 尚無 AEP `aep.telemetry.v1` 驗證／JSONL 匯入／事件 reducer、巢狀 span timeline、方向性 transition path 或 p95 聚合。通用 timeline 為平面列表；graph 可畫箭頭，但現有 shortest path 採無向搜尋。
- 本機 Python server 仍是唯一隨附後端；沒有帶入託管 demo 的雲端資料庫、登入、部署設定或任何憑證。

若儲存時看到 revision 衝突（HTTP 412），請重新開啟最新版本，避免覆寫另一個視窗已儲存的修改。

詳見 [本機開發](docs/LOCAL_DEVELOPMENT.md)、[AEP 整合交接](docs/AEP_TELEMETRY_INTEGRATION.md)、[架構與設定](docs/ARCHITECTURE.md)、[安全與資料界線](docs/SECURITY.md) 及 [驗證紀錄](docs/VALIDATION.md)。
