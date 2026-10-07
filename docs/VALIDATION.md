# 驗證紀錄

日期：2026-10-07。

本檔記錄此獨立產品的實測結果；component DOM 測試不等於完整瀏覽器驗收。

## 自動驗證

前端48/48 tests 通過，包含 pipeline、models、SSR 與 component DOM。TypeScript／Vite production build 通過；輸出無 source maps，各 JavaScript chunks 低於500kB。Production npm dependencies audit：0 vulnerabilities（2026-10-07 當次查核）。

後端33項 tests：32通過、1項 Windows-only test 在 Linux 略過。兩端共用30項 document contract fixtures。另以真 HTTP 對兩份實際 YAML presets 完成 create201／reopen200／update200／stale412：RS Knowledge13 panels、Agent Validation6 panels。Production index 及其4個 JS／CSS assets 皆回200。

Windows CI 曾在 test harness 的 module interception 因路徑分隔字元失配而中斷；已改用標準化路徑比對，增加 Windows／POSIX 路徑 regression，並在 Linux 重跑完整48項前端 tests、build與33項後端 tests。更新後的 Windows 原生執行結果仍以對應 commit 的 CI 為準。

完整 npm audit 另回報7項 development dependency alerts（2 moderate、5 high），都來自 Tailwind 3 的 build/watch 依賴；production-only audit 為0。[braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) 尚無patched release；[selector parser advisory](https://github.com/advisories/GHSA-rj75-hqrm-r3gf) 的修正需要跨dependency major。沒有使用 force update或未經驗證的major override。此專案只對可信任的固定source globs／CSS執行建置；不要讓不可信任的glob patterns進入build/watch工具。Tailwind major migration需另行驗證。

測試涵蓋：

- Dataset 正規化、CSV、graph identity、typed filters、join／aggregation／calculation、取消、cache 及大小限制
- REST/WebSocket mock transports 的共享、timeout、reconnect/dispose
- Heatmap／graph models、18 種 renderer routes 與 SSR
- Component DOM：StrictMode、heatmap/table actions、global filters/details、duplicate/cancel、drag/resize cancel、Save As、save lock、第二 application
- 真 HTTP 與本機檔案：建立、讀取、更新、刪除、ETag、原子寫入、並行、安全路徑、symlinks、payload 限制
- TypeScript 編譯及 Vite production build

GitHub Actions 包含 Ubuntu／Windows matrix，不含 secrets 或部署步驟；尚未執行的遠端 CI 不計入本機通過數。

## 尚未驗證

- 完整瀏覽器視覺、SVG pointer 座標、實際 fullscreen、不同螢幕尺寸的視覺品質
- 真實外部 REST／WebSocket 站點及其 CORS／企業登入
- 正式 benchmark、正式知識庫或企業服務
- Windows 實驗分支及 macOS 的原生 filesystem／ACL／locking；已配置 Windows CI，交付前本機僅執行 Linux 測試

當前執行環境的完整瀏覽器／localhost 存取受限，未繞過限制。請於自己的本機瀏覽器完成下列操作：

1. RS Knowledge 預設應顯示 demo 標示；點 heatmap cell，核對 market/product filters 與 details。
2. Edit → 新增／移動／resize／Duplicate／Remove → Cancel，確認完整還原。Escape 取消單次拖曳。
3. Save As → 重新載入 → 修改 → Save。另開視窗更新後，舊 revision 應無法覆寫。
4. Graph 搜尋、filters、pan/zoom、node drag、fit、path、legend、Fullscreen。
5. 切換 Agent Validation，核對 CSV join 及 budget ratio。
