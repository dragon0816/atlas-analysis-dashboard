# 本機私有儀表板服務

這是以 Python 標準函式庫實作的本機服務，不需第三方 Python 套件。服務只接受 schemaVersion 2 dashboard 文件。

## 啟動

環境：Linux／macOS 使用 Python 3.11 以上；Windows 使用 Python 3.13 以上（建立 0700 目錄時需要此版本的私有 ACL 支援）。目前已在 Linux 執行測試；Windows 屬實驗性支援，Windows 分支與 macOS 仍待各自的實機驗證，不能把 Linux 通過視為 Windows 已通過。

先依根目錄說明建置前端，再從專案根目錄啟動：

```sh
python -m server --port 8127
```

開啟 `http://127.0.0.1:8127/`。預設靜態檔案目錄為 `web/dist`；尚未建置時會回覆具體的建置提示。服務不從 CDN 載入任何資產。

預設儲存目錄在原始碼之外：

- 有設定 `ATLAS_DASHBOARD_DATA_DIR` 時採用此值
- Windows 採用 `%LOCALAPPDATA%\AtlasAnalysisDashboard\dashboards`
- Linux／macOS 採用 `$XDG_DATA_HOME/atlas-analysis-dashboard/dashboards`
- 沒有有效的絕對 XDG 路徑時採用 `~/.local/share/atlas-analysis-dashboard/dashboards`

可明確指定隔離測試目錄：

```sh
python -m server --data-dir /absolute/private/dashboard-data --port 8127
```

Linux／macOS 由服務建立的目錄使用 0700，文件與鎖檔使用 0600。既有儲存目錄必須屬於目前使用者，且群組／其他使用者沒有存取權限。Windows 會驗證目錄與文件 ACL，僅允許目前使用者、SYSTEM 與本機 Administrators 存取；Python 私有目錄的 OWNER RIGHTS 僅在實際 owner 已通過檢查後接受，且拒絕無法確認安全的 ACL；不會修改既有 ACL。Windows 的資料目錄請使用本機磁碟，不支援 UNC／網路磁碟路徑。

儲存路徑的每一層都不能是 symlink；Windows 也拒絕 junction 與其他 reparse point。檔案不能是 hard link 或非一般檔案。Windows 以不允許刪除共享的 handles 固定已驗證的祖先目錄，並用 OPEN_REPARSE_POINT 開啟檔案。請使用實際路徑，且勿把私人儀表板存入 Git checkout。

只允許 literal loopback bind，例如 `127.0.0.1` 或 `::1`，不接受 `0.0.0.0`。這是單一使用者的本機服務，沒有帳號登入或遠端多租戶模式；不要透過反向代理、公開 tunnel 或對外轉發 port 發佈它。同一個 OS 帳號內的其他本機程式仍可能讀取資料。

## 前端開發

Vite proxy 應把 `/dashboards` 代理至本機後端，並設定 `changeOrigin: true`。若瀏覽器的開發 origin 是 `http://localhost:5173`，後端需明確允許該 origin：

```sh
python -m server --allow-origin http://localhost:5173
```

若前端實際使用 `http://127.0.0.1:5173`，請改填該精確 origin。這個選項只接受本機 HTTP origin；不支援萬用字元。它不提供跨 origin CORS，開發仍透過 Vite proxy。

## API 契約

- `GET /dashboards`：已存檔名稱陣列。
- `GET /dashboards/{name}`：原始 v2 JSON 與強 ETag；讀取不重寫文件。
- `PUT /dashboards/{name}`：`Content-Type: application/json`。建立必須帶 `If-None-Match: *`；更新必須帶最後讀取的 `If-Match`。
- `DELETE /dashboards/{name}`：必須帶最後讀取的 `If-Match`，不能附 request body。刪除後回 204，沒有復原／垃圾桶功能。

建立回 201，更新回 200，回應皆附新 ETag。缺少寫入 precondition 回 428；檔案已存在或 revision 過期回 412，不應盲目重試覆寫。名稱不存在時 GET 回 404。DELETE 的 revision 過期或檔案已被移除時回 412。

同一儲存目錄內的多個服務程序共享檔案鎖：Linux／macOS 使用 flock，Windows 使用 msvcrt 的 byte-range lock。寫入在鎖內執行 ETag 比對、暫存檔寫入、fsync 與 atomic replace，避免兩個 client 靜默覆蓋彼此。Linux／macOS 另執行目錄 fsync；Windows 使用帶 WRITE_THROUGH 的 MoveFileEx，沒有相同的目錄 fsync 介面。Windows lock 最多等待 30 秒，超時不會繼續寫入。發生磁碟錯誤時請重新讀取確認狀態，再決定下一步。

UTF-8 JSON 上限為 2,000,000 bytes，支援有界的 chunked request；不接受壓縮 body、重複 Content-Length、Content-Length 與 Transfer-Encoding 同時存在、重複 JSON key、非有限數值及深度超過 64 的 JSON。已知結構另外限制 128 個 panels、128 個 variables、每 panel 64 個 transforms，且 document value 總數不超過 100,000。

檔名支援 NFC Unicode，最長 180 UTF-8 bytes。路徑字元、控制字元、保留名稱、開頭句點與不安全的結尾字元會拒絕。額外的 document-level metadata 會保留；panel、layout、action 等已知結構嚴格驗證。

Host、Origin 與 Fetch Metadata 檢查防範 DNS rebinding 與跨站請求；API 不允許任意網站跨來源讀寫。所有回應禁止快取，靜態檔案另有 CSP、nosniff 與防嵌入標頭。

## 驗證

```sh
python -m unittest discover -s tests -p 'server*.py' -v
```

測試只使用 TemporaryDirectory，不會讀取預設個人資料目錄。範圍包含真 HTTP create/open/update/delete、ETag stale 412、跨程序 compare-and-swap、atomic failure、Unicode／metadata、symlink／hardlink／FIFO、路徑／Host／Origin、防 request smuggling、chunked 與 2 MB 限制。

Windows 的測試會略過需要 symlink privilege 與 POSIX FIFO／mode bits 的項目；核心 HTTP、schema、atomic failure 與跨程序 CAS 仍會執行。正式使用前，請在 Windows 驗證 Save／重新開啟／兩個視窗衝突，以及本機 ACL 與 reparse point 拒絕行為。
