# Ment Shift Flow — WFH 排班表

[![Deploy to Pages](https://github.com/mentrd/Ment-Shift-Flow/actions/workflows/deploy.yml/badge.svg)](https://github.com/mentrd/Ment-Shift-Flow/actions/workflows/deploy.yml)
[![Update Taiwan holidays](https://github.com/mentrd/Ment-Shift-Flow/actions/workflows/update-holidays.yml/badge.svg)](https://github.com/mentrd/Ment-Shift-Flow/actions/workflows/update-holidays.yml)

團隊 WFH 排班的月曆檢視，部署在 GitHub Pages 上，一個網址全團隊共用。

**網址**：https://mentrd.github.io/Ment-Shift-Flow/

**這是純檢視工具** —— 網頁不寫入任何資料，排班與成員一律編輯 [`data/schedule.json`](data/schedule.json)，push 後自動部署。

- 月／週檢視，當天 WFH 人員直接顯示在格子裡（週檢視是一天一列）
- 月曆只顯示週一～週五；只有當月出現補班日時，週六（或週日）那一欄才會自動加回來
- PM / RD 分組，可依組別或個別人員篩選（篩選在工具列上）
- 側欄顯示所選日期的完整名單，以及當月每人的固定日與 WFH 天數；可整個收合
- 淺色／深色主題，預設跟隨系統，也可以自己指定（記在瀏覽器）
- 台灣國定假日自動抓取、標紅、不排班
- 硬約束：**一個人一週只能有一天 WFH**，部署前自動檢查，有衝突就擋下部署

---

## 排班規則

| | 排法 | 資料欄位 |
|---|---|---|
| **PM** | 固定每週某一天，規則自動展開到每個月 | `day: 1`（每週一）／`day: 5`（每週五） |
| **RD** | 沒有固定週期，由 RD 主管逐日指派 | `day: null` + `assignments` |

目前的 PM 分組就是 `day` 的同義詞：A 組 = 每週一（`day: 1`），B 組 = 每週五（`day: 5`）。

### 一個人一週只能有一天

這是唯一的硬約束，在兩個地方擋：

1. **資料層** — `day` 是單一數字而非陣列，所以固定日不可能超過一天。
2. **部署前** — `scripts/validate-data.js` 掃過所有週，有衝突就讓 GitHub Actions 失敗、擋下部署，訊息會指出人名、週次與衝突的兩個日期。

改完 JSON 記得先跑 `npm run validate`，比 push 後才發現快得多。網頁本身若讀到有衝突的資料，頂部會顯示紅色橫幅列出所有衝突（不會自動修改，由你決定留哪一天）。

「週」是**週一起算**。注意跨月的週：2026-09-30（三）與 2026-10-02（五）屬於同一週，兩天排同一個人算衝突。

衝突判定基於「實際 WFH 結果」而非規則名義值，所以**固定日碰到國定假日時，那一週可以改排別天**。例如 2026-09-25（五）中秋節，PM B 組那週沒有 WFH 日，就能改排週四。

除此之外沒有其他限制 —— 同一天幾個人 WFH、整組都 WFH 都可以。

---

## 怎麼改班表

`data/schedule.json` 是唯一真實來源，直接編輯它：

```jsonc
{
  "members": [
    // PM：day 填 1-5（週一到週五），每人只能一天
    { "id": "pm-max", "name": "Max", "group": "PM", "day": 1, "startDate": "2026-09-01" },
    // RD：day 一律 null，靠下面的 assignments 逐日指派
    { "id": "rd-sherry", "name": "SHERRY", "group": "RD", "day": null, "startDate": "2026-09-01" }
  ],
  "assignments": {
    // add：該日額外 WFH（RD 指派、PM 臨時改期）
    // remove：該日取消 WFH（PM 臨時回辦公室）
    "2026-09-04": { "add": ["rd-sherry"], "remove": [] },
    "2026-09-07": { "add": [], "remove": ["pm-max"] }
  }
}
```

- `id` 只要在檔案內唯一即可，慣例是 `pm-` / `rd-` 加小寫名字。
- `startDate` / `endDate` 可選，用來處理到職／離職；字串比較即可，不必轉日期。目前全體是 `2026-09-01`，所以 8 月的日曆是空的（網頁會自動從 9 月開始顯示，並在側欄說明原因）。
- 排 RD 時記得同一人**同一週只能出現一次**，週一起算。跨月的週要特別注意：`2026-09-30`（三）與 `2026-10-02`（五）屬於同一週。
- 改完跑 `npm run validate` 再 push。

改完 push 到 `main`，GitHub Actions 會跑測試 + 檢查資料，通過就自動部署。

## 國定假日

`data/holidays.json` **由程式產生，不要手改**。

資料來自行政院人事行政總處公告的「政府行政機關辦公日曆表」（透過
[ruyut/TaiwanCalendar](https://github.com/ruyut/TaiwanCalendar) 提供的 JSON），
由 [`.github/workflows/update-holidays.yml`](.github/workflows/update-holidays.yml)
每月 1 號自動抓取，有變更才 commit。也可以手動跑：

```bash
npm run holidays
```

從 2026 年開始逐年抓，遇到「尚未公告」（404）就停。目前已寫入 2026（22 筆）與 2027（24 筆）。

抓取失敗的年份會**沿用既有資料**而不是清空 —— 上游暫時掛掉不該讓全團隊看到錯誤的排班。

`workday: true` 代表補班日（週六日但要上班），照樣可以排 WFH。

---

## 本機開發

```bash
npm run dev        # 起 static server（npx serve），開 http://localhost:3000
npm test           # 排班規則的回歸測試
npm run validate   # 檢查 data/*.json（CI 部署前跑的就是這個）
npm run holidays   # 重新抓取國定假日
```

沒有任何 dependency，也不需要 build —— `npm install` 都不必跑。

> 不能直接用 `file://` 開 `index.html`：頁面用 `fetch` 讀 `data/*.json`，會被瀏覽器的 CORS 規則擋下。一定要透過 http server。

### 檔案結構

```
index.html                 全部 UI + CSS + JS（純檢視，不寫入資料）
data/schedule.json         成員 + 逐日指派（唯一真實來源，手動編輯）
data/holidays.json         國定假日（程式產生，勿手改）
scripts/rules.js           排班規則的唯一真實來源
scripts/test-rules.js      規則的回歸測試
scripts/validate-data.js   部署前資料檢查
scripts/fetch-holidays.js  抓取政府行事曆
```

`scripts/rules.js` 同時被 `index.html`（`<script type="module">` import）和
`scripts/validate-data.js`（node import）使用。**規則只有這一份**，網頁顯示的結果和 CI 檢查的結果一定一致。

---

## 部署

push 到 `main` 就會觸發 [`deploy.yml`](.github/workflows/deploy.yml)：跑測試 → 檢查資料 → 上傳靜態檔到 Pages。

首次設定需要手動做一次（Actions 無法自行開啟）：

**Settings → Pages → Build and deployment → Source 選 `GitHub Actions`**

> repo 若是 private，GitHub Pages 需要 Enterprise 方案，否則網址不會上線。

---

## 初始資料的一筆修正

建置時提供的 RD 名單中，`2026-09-11`（五）原為 `SHERRY ERIC RURU TEMA`。

但 09/07（一）與 09/11（五）屬於同一週（W 09/07–09/13），而 09/07 已排
`RURU TEMA DOWNEY ERIC`，導致 **ERIC、RURU、TEMA 三人該週有兩天**，違反「一人一週一天」。

依「有衝突就把該週未排的人排上」修正為 `SHERRY LEON ALAN EUDORA` ——
該週未排者正好這四人，剛好填滿 09/11 的四個位子，不需要選擇補位順序。

修正後全 8 位 RD 每週最多一天：

| | W 08/31 | W 09/07 | W 09/14 | W 09/21 |
|---|---|---|---|---|
| SHERRY | 09/04 | 09/11 | — | — |
| LEON   | 09/04 | 09/11 | 09/14 | — |
| ALAN   | 09/04 | 09/11 | 09/14 | — |
| EUDORA | 09/04 | 09/11 | 09/14 | — |
| RURU   | — | 09/07 | — | 09/21 |
| TEMA   | — | 09/07 | — | 09/21 |
| DOWNEY | — | 09/07 | 09/14 | 09/21 |
| ERIC   | — | 09/07 | — | 09/21 |

另外，原名單沒有 09/18（五），該日僅 PM B 組三人 WFH；09/25（中秋）與 09/28（教師節）為假日不排班。這些都照原意保留，沒有自動補人。
