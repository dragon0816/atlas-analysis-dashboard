# Atlas Analysis Dashboard

獨立、設定型的資料分析儀表板。以 **Sources → Transforms → Datasets → Panels → Layout → Editor** 組合不同領域的分析畫面，可在本機瀏覽器編輯，並將個人 dashboard 儲存在本機資料目錄。

## 主要功能

- 18 種面板：line、mask、bar、box、histogram、stat、gauge、table、heatmap、network、area、pie、donut、scatter、text、status、progress、timeline。
- 視覺化編輯器：新增、複製、移除、拖移、二維 resize、數值版面編輯、Save、Save As、Cancel、Restore default。
- 全域 filters、時間範圍、跨面板篩選、details、drill-down、graph highlight。
- JSON、CSV、REST、WebSocket 資料來源；來源共用、取消請求、大小限制、明確的錯誤及截斷提示。
- 順序式 filter、normalize、join、aggregate、calculate、sort、limit 與可重用 pipeline。
- 獨立的 Python 標準函式庫伺服器，提供靜態網頁及帶 ETag 的原子儲存。

## 快速開始

需求：Node.js 24；Linux/macOS 使用 Python 3.11 以上，Windows 使用 Python 3.13 以上。Windows 分支為實驗支援，尚未在本次本機執行環境驗證，請查看對應 CI 結果。

```sh
cd web
npm ci
npm test
npm run build
cd ..
python -m unittest discover -s tests -p 'server*.py'
python -m server --port 8127
```

開啟 http://127.0.0.1:8127 。伺服器預設只監聽 loopback；無須 Python 第三方套件。使用者 dashboard 預設寫入使用者資料目錄，不會寫入 application presets 或 repository。請勿把這個本機伺服器當成已具備登入、多人權限或公開託管能力的服務。

開發模式：先啟動後端，再於另一個 terminal 執行前端。

```sh
python -m server --port 8127 --allow-origin http://127.0.0.1:5173
# 另一個 terminal
cd web
npm run dev
```

## 內附 application

- **RS Knowledge**：13 個 panels、8 個 logical sources，展示知識圖譜、coverage、conflicts、feedback、runs、pipeline health、gap 與 evidence traceability。
- **Agent Validation**：JSON runs 加 CSV budgets，展示 join、normalize、ratio、bar、line、scatter 及 timeline。

兩者皆為 synthetic fixtures。畫面中的題目、分數、owners、sources 與執行紀錄只用來驗證產品功能，不是真實使用者、企業資料或已完成的 benchmark。

新增領域時，可增加 `applications/<id>/` 中的 YAML、JSON、CSV package，不必將領域名稱寫進 Core。資料在 build time 載入，新增或修改 package 後需要重新 build。

## 使用

1. 選 Application 與 Default preset，使用上方 filters。
2. 點 **Edit Dashboard**，從左側 panel library 新增面板，在右側設定來源、pipeline、mapping、display、interaction。
3. 拖標題把手移動，拖右下角調整大小；也可直接修改 Layout 數字。Escape 或 pointer cancel 會還原當次拖曳。
4. **Save As** 建立新名稱與新 identity。**Save** 更新已開啟版本。**Cancel** 還原本次編輯及 filters。
5. **Restore default** 先修改 draft，仍需 Save；Cancel 可撤回。
6. 使用每個 panel 的 **Data** 檢查資料、**Refresh** 重取資料、**Fullscreen** 放大。

若儲存時看到 revision 衝突（HTTP 412），請重新開啟最新版本，避免覆寫另一個視窗已儲存的修改。

詳見 [架構與設定](docs/ARCHITECTURE.md)、[安全與資料界線](docs/SECURITY.md) 及 [驗證紀錄](docs/VALIDATION.md)。
