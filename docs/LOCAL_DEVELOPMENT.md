# 本機執行、開發與驗收

先跑內附 synthetic applications，確認 dashboard 本身正常，再依 [AEP 整合交接](AEP_TELEMETRY_INTEGRATION.md) 接本機 telemetry。本 repo 沒有 AEP host、正式 traces、API credentials 或已完成的 AEP adapter。

## 1. 環境與版本

- Git；Node.js 24 與隨附 npm。`web/package.json` 要求 Node >=24，CI 固定 Node 24；使用 lockfile 執行 `npm ci`。
- Python：Linux／macOS >=3.11；Windows >=3.13。要和 CI 一致可選 3.13。後端只用標準函式庫，不需要 `pip install`。
- 瀏覽器：支援現代 JavaScript；3D 另需 WebGL 2／GPU。3D 失敗會提示並回到 2D。
- Windows 的私有 ACL／reparse-point 防護仍需在自己的磁碟與帳號實測。macOS 原生 filesystem／瀏覽器也須另驗收。

基準程式碼 `ffe3db1212293a84a3adf4b82feb51da33500974` 的 [Ubuntu／Windows CI](https://github.com/dragon0816/atlas-analysis-dashboard/actions/runs/37773749357) 已通過。這是自動測試與 build 的紀錄，不是互動式瀏覽器驗收；更新後請檢查自己 commit 的 CI。

## 2. Clone、測試、build、啟動

以下指令逐行執行；任何一步失敗就先排錯，不要跳過失敗直接啟動。server 指令須在 repo 根目錄執行。

### Windows PowerShell

安裝 Node 24、Git、Python 3.13 後重新開啟 PowerShell。使用 `npm.cmd` 可避免 PowerShell 對 `npm.ps1` 的執行政策限制，不需放寬系統政策。

```powershell
git --version
node --version
npm.cmd --version
py -3.13 --version
git clone https://github.com/dragon0816/atlas-analysis-dashboard.git
Set-Location atlas-analysis-dashboard
git rev-parse HEAD
Set-Location web
npm.cmd ci
npm.cmd test
npm.cmd run build
Set-Location ..
py -3.13 -m unittest discover -s tests -p 'server*.py'
py -3.13 -m server --host 127.0.0.1 --port 8127
```

若沒有 `py` launcher，先用 `python --version` 確認確實是 >=3.13，再把這些 `py -3.13` 改成 `python`。

### macOS／Linux

```sh
git --version
node --version
npm --version
python3 --version
git clone https://github.com/dragon0816/atlas-analysis-dashboard.git
cd atlas-analysis-dashboard
git rev-parse HEAD
cd web
npm ci
npm test
npm run build
cd ..
python3 -m unittest discover -s tests -p 'server*.py'
python3 -m server --host 127.0.0.1 --port 8127
```

開啟 **http://127.0.0.1:8127/**，保留 server terminal；結束時按 Ctrl+C。這是 build 後的本機模式，Python 提供 `web/dist` 與 `/dashboards` 儲存 API，不需要另一個前端程序。

另一個 terminal 可做唯讀 smoke check：

```powershell
# PowerShell：首頁應 200；已存 dashboard 清單是 JSON 陣列
(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8127/).StatusCode
(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8127/dashboards).Content
```

```sh
# macOS／Linux
curl --fail --max-time 10 -I http://127.0.0.1:8127/
curl --fail --max-time 10 http://127.0.0.1:8127/dashboards
```

全新資料目錄的清單為 `[]`；若以前存過 dashboard，清單非空屬正常。沒有獨立 `/health` endpoint。

## 3. 修改程式時使用 Vite

先完成依賴安裝。開兩個 terminal，兩者都維持 loopback：

```powershell
# Terminal A，repo 根目錄
py -3.13 -m server --port 8127 --allow-origin http://127.0.0.1:5173
# Terminal B，repo 根目錄
Set-Location web
npm.cmd run dev -- --port 5173 --strictPort
```

```sh
# Terminal A，repo 根目錄
python3 -m server --port 8127 --allow-origin http://127.0.0.1:5173
# Terminal B，repo 根目錄
cd web
npm run dev -- --port 5173 --strictPort
```

開啟 **http://127.0.0.1:5173/**。`--strictPort` 防止 Vite 靜默換成 5174，造成 origin 不符。Vite 目前只把 `/dashboards` 代理至 8127；`--allow-origin` 是 Python 的請求 origin 檢查設定，不是通用 CORS 開關，也不會讓 AEP API 自動可用。

修改程式後重新跑 `npm test`／`npm run build` 與後端測試。回到 8127 驗收時必須先重新 build，否則看到的是舊 `web/dist`。目前沒有 `npm start`、`npm run lint` 或獨立 e2e script；`npm run build` 已包含 `tsc --noEmit`。

## 4. 資料、設定與備份

- `applications/`：隨 repo 發佈的 YAML presets 與 synthetic JSON／CSV，build time 載入；修改後需重建。不要把真實 traces 放進去，它們可能被包進前端 bundle。
- 個人 dashboard：server 寫在 repo 外。優先採用 `--data-dir`；未指定時採 `ATLAS_DASHBOARD_DATA_DIR`，再依 OS 預設：
  - Windows：`%LOCALAPPDATA%\AtlasAnalysisDashboard\dashboards`；缺少此環境變數則用家目錄下 `AppData\Local`。
  - Linux／macOS：有效絕對 `$XDG_DATA_HOME/atlas-analysis-dashboard/dashboards`，否則 `~/.local/share/atlas-analysis-dashboard/dashboards`。macOS 目前也是此規則。
- 收合偏好：瀏覽器 localStorage 的 `atlas.dashboard.controls.v1`。清除瀏覽器資料不會刪掉 server 已存的 dashboard；切換 origin 可能有不同偏好。
- dashboard `schemaVersion: 2` 是畫面設定格式，不是 telemetry event schema，也不代表保存了遠端 source 的原始資料。

隔離測試可使用新的 repo 外目錄，讓 server 建立安全權限；不要預先建立成共享目錄：

```powershell
py -3.13 -m server --port 8127 --data-dir "$env:LOCALAPPDATA\AtlasAnalysisDashboard-test\dashboards"
```

```sh
python3 -m server --port 8127 --data-dir "$HOME/.local/share/atlas-analysis-dashboard-test/dashboards"
```

路徑及祖先不可是 symlink；Windows 也拒絕 junction／reparse point、UNC／網路磁碟與不安全 ACL。不要用系統管理員權限或放寬檢查來避過錯誤。詳細條件見 [server 文件](../server/README.md)。

備份時先停止 server，再將資料目錄複製到自己可存取的私人位置；還原時保留私有權限。不要提交個人 dashboard 或 telemetry 到公開 repo。刪除 API 沒有垃圾桶，手動清空資料前請先備份。

## 5. 本機驗收清單

自動測試採 Node test runner／DOM doubles 與 Python unittest；不等於真實 GPU、AEP 或跨平台互動驗收。後端測試使用 temporary directory，不會讀取個人預設儲存目錄。

- [ ] `npm ci`、`npm test`、`npm run build`、Python tests 均成功；記錄 OS、Node／Python、commit，以及 skip 原因。
- [ ] RS Knowledge／Agent Validation 可切換，清楚顯示 synthetic data；Filters 的摘要與 Reset 正常。
- [ ] Edit → 新增／複製／移動／resize／Remove → Cancel 還原；Escape 取消拖曳。
- [ ] New dashboard → 加 panel → Save → Preview；重載後能從已存清單重開。
- [ ] Save As 建立新文件；兩個視窗開同一已存文件，先後儲存時舊 revision 應收到 412，保留草稿。
- [ ] Graph 的 sparse／interconnected、兩種布局、2D／3D、搜尋／篩選／path／fit 正常；無 WebGL 2 時有 fallback 提示。
- [ ] Heatmap／bar 顏色及透明度儲存後保留；Agent Validation 的 CSV join／budget ratio 正常。
- [ ] Network 面板的箭頭不被誤認為現有 path 搜尋已具方向性；現有 timeline 不被誤認為 nested spans。

Telemetry 的驗收是另一階段，見 [整合驗收](AEP_TELEMETRY_INTEGRATION.md#6-整合完成的驗收標準)。

## 6. 常見問題

- **npm 找不到 package.json**：先 `cd web`。**找不到 server module**：回 repo 根目錄執行 Python。
- **Node flag／TypeScript syntax 錯誤**：檢查 `node --version` 與 PATH，使用 Node 24；依 lockfile 重跑 `npm ci`。不要為排錯任意刪 lockfile 或使用 `npm audit fix --force`。
- **npm ci 下載失敗**：檢查本機 registry／網路代理設定；保留錯誤訊息。缺少依賴時不能把既有 node_modules 的測試當成乾淨安裝通過。
- **首頁顯示 build 提示／功能仍舊**：執行 `cd web`、`npm run build`，然後在正確的 8127 頁面重載；不要直接開 `file://.../index.html`。
- **8127／5173 已佔用**：先辨認原程序，或選其他 loopback port。改後端 port 時，同步修改 `web/vite.config.ts` 的 proxy target；改 Vite port 時同步改 `--allow-origin` 與瀏覽器網址。
- **Save 403／origin 錯誤**：一致使用 `127.0.0.1`；確認 Vite proxy、port 與後端 allow-origin 相符。不要關閉 Host／Origin、CSP 或瀏覽器安全機制。
- **Save 412**：另一視窗已更新。先保留要留的修改，再重新開啟最新文件；不要盲目重試覆寫。
- **ACL／private directory 錯誤**：使用新的本機私人目錄，檢查 Python 版本與實際路徑。測試紀錄可寫錯誤類型，但不要公開私人檔名或完整 trace。
- **外部 source 無法讀取**：CLI 能連上不代表瀏覽器能通過 CORS／認證。Python 沒有任意 URL proxy；先依 AEP 文件核對實際 contract。
- **build chunk >500 kB**：是 Vite 大小警告，與 build 失敗不同；不要因此關閉安全設定。實際瀏覽器載入時間仍需量測。

更多： [架構](ARCHITECTURE.md) · [安全](SECURITY.md) · [驗證紀錄](VALIDATION.md)
