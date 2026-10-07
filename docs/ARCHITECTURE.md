# 架構與設定

## 目錄

```text
applications/                  領域設定與 synthetic fixtures
  <application-id>/
    application.yaml           application 描述與資源路徑
    datasources.yaml           logical source definitions
    transforms.yaml            可重用 pipeline
    schemas/                   選用的領域說明
    dashboards/                唯讀 presets
    data/                      synthetic JSON／CSV
web/src/platform/              contracts、providers、pipeline、models
web/src/components/dashboard/  canvas、properties、panel routing
web/src/components/panels/     通用 renderer
web/src/pages/                 dashboard 工作區
server/                        本機靜態檔案及 dashboard API
tests/                         伺服器驗證
```

## Dataset

Table dataset 含 fields、rows；Graph dataset 含 nodes、edges。兩者均帶 warnings、truncated、sourceRows metadata。數值 unit／limits 是可選的資料欄位 metadata，沒有領域特定含義。

來源最大 20,000 rows、256 fields，外部 payload 最大 8 MiB。Graph renderer 另有 1,000 nodes／3,000 edges 上限；大型圖使用 bounded layout。截斷、重複 identity、dangling edges 會顯示警告，不視為完整資料。一般圖表最多處理2,000個 samples，bar最多200個 marks，box最多100個 categories，table搜尋最多5,000 rows，分頁大小為5–200；各上限皆提供提示。

## Providers

- `json`：inline rows、fields/rows、nodes/edges，或 package path。
- `csv`：inline text 或 package path，支援 RFC 4180 引號及換行。
- `rest`：瀏覽器唯讀 fetch；拒絕非 HTTP(S)、URL credentials、明顯 secret query keys 及 redirects。需要目標站點支援 CORS 或同源。
- `websocket`：bounded JSON 完整 snapshots，source-level 共用連線、最多三次重連、unsubscribe/dispose 清理。
- `custom`：可信任程式可透過 `registerProvider` 註冊。這是程式擴充點，不是不可信程式的 sandbox；編輯器不執行任意 JS。

`bindings` 以資料欄位名稱對應 dashboard variable id。空白、null、`*` 表示不限制。`time_range` 使用 `ISO_FROM/ISO_TO`，允許開放端點；日期控制將 UTC 日初／日終作為包含端點。

外部來源在瀏覽器讀取，後端沒有任意 URL proxy。來源設定由 application package 定義，不把 credentials 存在 dashboard JSON 中。

## Pipeline

各 panel 先取資料，再依順序執行 pipeline，最後交給 renderer。支援：

- filter：field/operator/value 或 where；可使用 `$variable`
- normalize：fields mapping 至 number/string/boolean/time
- join：source、on.left/on.right、left/inner、選用 prefix
- group/aggregate：by 與 metrics 的 field/function/as
- calculate/derive：as、fn、from、factor/offset
- sort、limit、ref

計算使用 sum、difference、ratio、scale、coalesce 等白名單，沒有 eval。明確指定 join prefix 時，右側所有欄位都加 prefix。未指定時只為碰撞欄位加預設 prefix。過大中間結果會限縮並回報。

表單可設定常用步驟；多個 aggregation metrics、normalize mappings、複合 actions 可使用 Advanced JSON。

## 視覺化與互動

所有 renderer 僅接受 dataset、mapping、display 與 callback，不自行 fetch。

一般圖表的 mapping：line／mask 使用 x、y、series；mask 可設定 lower／upper，或使用數值欄位 limits。Bar 使用 category／value。Box 可由 value 原始樣本計算 quartiles，或明確對應 q1／median／q3 與 low／high summary 欄位。Histogram 使用 value 及 display.bins。Stat／gauge 支援 value 與 display.reducer；gauge 的 min/max 可來自 mapping 或 display。Table 提供搜尋、排序、分頁及 row actions。

Line、mask、bar、box、histogram、stat、gauge、table 均提供直接 click／keyboard actions；Data inspector 也可選 row。Area／scatter 為單序列。Progress 為顯示面板，Text 使用不注入 HTML 的基本 Markdown。

Heatmap 支援類別軸、重複 cell aggregation、sequential scale、固定 min/max、threshold、數值、missing/zero 區分、tooltip 及 click。

Network graph 支援 force layout、pan/zoom、node drag、fit、搜尋、node/edge type、community filters、labels、neighborhood/path highlight 及 legend。圖中的缺失關係只是資料狀態，不代表工具產生了新推論。

標準 actions 為 set_filter、open_details、navigate、drill_down、highlight、open_link。`action.values` 可使用 `$x`、`$y`、`$id` 或原始 row 欄位。Details 關聯條件來自 action.values，不硬編碼領域欄位。

## 儲存契約

Dashboard document 使用 schemaVersion 2，包含 applicationId、variables、values、panels、source、transform、mapping、display、interaction、refresh 與 layout。

- `GET /dashboards`：saved names
- `GET /dashboards/{name}`：document 與 ETag
- `PUT /dashboards/{name}`：建立使用 If-None-Match: *；更新使用 If-Match
- `DELETE /dashboards/{name}`：使用 If-Match

文件最大 2 MB。讀取不寫回。使用跨程序鎖、原子 replace、ETag compare-and-swap 防止失去更新；路徑及 symlink 防護避免離開專用資料目錄。

Presets 與個人變體分離。這是單使用者本機工具，未提供帳號、分享權限、多人協作、伺服器端外部 source credential management 或動態 application marketplace。
