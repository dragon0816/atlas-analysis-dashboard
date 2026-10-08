# 驗證紀錄

日期：2026-10-08。

本檔記錄 standalone 版本此次同步的驗證；component DOM／renderer double 不等於實際 GPU 或完整瀏覽器驗收。

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

- 本次 commit 的 Ubuntu／Windows GitHub Actions 結果；CI設定保留雙平台、Python 3.13、Node 24、npm ci、tests與build
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
