# 安全與資料界線

此產品預設在本機 loopback 使用。程式碼可公開，不表示本機儲存的 dashboard 或使用者接入的資料會公開。

- 伺服器不主動存取外部資料源，不提供任意檔案瀏覽或 URL proxy。
- Dashboard 存入 repository 外的使用者資料目錄，預設目錄／檔案權限限制為本機使用者。
- 後端檢查 Host／Origin，避免一般跨站寫入與 DNS rebinding；開發模式只允許明確指定的 origin。
- 寫入需有 create/update precondition；重複建立及過期 ETag 回 412。
- URL 不允許 credentials；不要把 API keys、tokens、密碼、個人資料或正式資料提交到 application packages、測試 fixtures 或 Git。
- Text panel 使用安全的基本 Markdown 子集，不注入 HTML。互動連結僅允許 HTTP(S)。
- 所有套件由 npm lockfile 安裝並本機 bundle，不使用 CDN。
- 使用者安裝的可信 custom providers 能執行程式，因此不應載入不可信 provider。

目前不提供公開部署所需的登入、TLS termination、多租戶隔離或稽核管理。請勿將 server 綁定或反向代理至公開網路。Windows 分支使用原生 handles、reparse point 防護、ACL 檢查及 msvcrt 鎖，要求 Python 3.13 以上；此分支為實驗支援，本次 Linux 環境無法執行 Windows 驗證。遇到不支援的權限或檔案結構時應拒絕啟動，而非退回較弱的安全模式。

Three.js 與其型別套件由 npm lockfile 鎖定，隨前端在本機 bundle；不從 CDN 載入程式或把 graph 傳送至外部 renderer。控制列偏好使用 localStorage，dashboard 內容仍透過既有 Python／ETag API 儲存在本機資料目錄。此次 UI 更新未變更 HTTP 安全 headers、Host／Origin 驗證、Windows ACL 或儲存路徑防護。
