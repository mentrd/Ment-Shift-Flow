# WFH 行事曆

[![Deploy to Pages](https://github.com/mentrd/Ment-Shift-Flow/actions/workflows/deploy.yml/badge.svg)](https://github.com/mentrd/Ment-Shift-Flow/actions/workflows/deploy.yml)
[![Update Taiwan holidays](https://github.com/mentrd/Ment-Shift-Flow/actions/workflows/update-holidays.yml/badge.svg)](https://github.com/mentrd/Ment-Shift-Flow/actions/workflows/update-holidays.yml)

團隊 WFH 的行事曆，部署在 GitHub Pages 上，一個網址全團隊共用。

**網址**：https://mentrd.github.io/Ment-Shift-Flow/

**排班在網頁上做** —— 右上「登入」後可以直接勾選、拖拉排班，按「儲存到 GitHub」就是一個 commit 到
[`data/schedule.json`](data/schedule.json)，約一分鐘後自動部署。未登入的人看到的是純檢視畫面。
成員異動（新增、離職、PM 固定日）仍手改 JSON。

- 月／週檢視，當天 WFH 人員直接顯示在格子裡（週檢視是一天一列）
- 月曆只顯示週一～週五；只有當月出現補班日時，週六（或週日）那一欄才會自動加回來
- PM / RD 分組，可依組別或個別人員篩選；也可以直接點側欄的名字「只看這個人」，再點一次取消
- 側欄顯示所選日期的完整名單，以及當月每人的固定日與 WFH 天數；可整個收合
- 淺色／深色主題，預設跟隨系統，也可以自己指定（記在瀏覽器）
- 台灣國定假日自動抓取、標紅、不排班
- 硬約束：**一個人一週只能有一天 WFH**，網頁在勾選與拖拉當下就擋，部署前再檢查一次
- 登入後：側欄名單變成可勾選清單，排不進去的人直接標明原因（本週已排 09/18／假日／不在職）；
  月曆與週檢視的名字可以拖到別天改期，放得下（綠）／放不下（紅，附原因）即時顯示

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

在網頁上排班時，排不進去的人會直接灰掉並標明原因，拖到不能放的日子會顯示紅框；儲存前也會再擋一次。手改 JSON 的話記得先跑 `npm run check`（見下面「手改 JSON」），比 push 後才發現快得多。網頁若讀到有衝突的資料，頂部會顯示紅色橫幅列出所有衝突（不會自動修改，由你決定留哪一天）。

「週」是**週一起算**。注意跨月的週：2026-09-30（三）與 2026-10-02（五）屬於同一週，兩天排同一個人算衝突。

衝突判定基於「實際 WFH 結果」而非規則名義值，所以**固定日碰到國定假日時，那一週可以改排別天**。例如 2026-09-25（五）中秋節，PM B 組那週沒有 WFH 日，就能改排週四。

除此之外沒有其他限制 —— 同一天幾個人 WFH、整組都 WFH 都可以。

---

## 怎麼改班表

### 網頁排班（一般情況）

1. 開網頁，右上「登入」，輸入帳號密碼（見下面「登入與安全性」；密碼只有排班的人知道）。
2. 點一個日期，側欄的名單變成可勾選清單：勾＝排入、取消勾＝取消這天的 WFH。
   灰掉的人排不進去，右側小字就是原因：`本週已排 09/18`、`已離職`、`9/1 起到職`。
3. 或者直接在月曆／週檢視把名字**拖到別天**。拖曳中目標日會變綠（可放，顯示「移到 09/16」）
   或變紅（不可放，顯示原因）。同一週內調日就是這樣做。
4. 頁面頂端出現「N 筆變更未儲存」，列出每一筆。按 **儲存到 GitHub** 就會以你的名義 commit 到 `main`，
   GitHub Actions 跑檢查並部署，約一分鐘後全團隊看到；按 **放棄** 回到線上版本。
5. 儲存前若別人已經改過 `schedule.json`（sha 不符），會拒絕覆寫並提供「載入遠端版本」。

限制：第一版只能改排班（`assignments`），不能新增成員或改固定日；手機沒有拖拉，用側欄勾選即可；
有未儲存變更時關閉分頁會跳提醒；重新整理就會登出（權限只留在記憶體）。

### 手改 JSON（成員異動、進階）

`data/schedule.json` 是唯一真實來源，直接編輯它：

```jsonc
{
  "members": [
    // PM：day 填 1-5（週一到週五），每人只能一天
    { "id": "pm-michelle", "name": "Michelle", "group": "PM", "day": 1, "startDate": "2026-09-01" },
    // RD：day 一律 null，靠下面的 assignments 逐日指派
    { "id": "rd-sherry", "name": "SHERRY", "group": "RD", "day": null, "startDate": "2026-09-01" }
  ],
  "assignments": {
    // add：該日額外 WFH（RD 指派、PM 臨時改期）
    // remove：該日取消 WFH（PM 臨時回辦公室）
    "2026-09-04": { "add": ["rd-sherry"], "remove": [] },
    "2026-09-07": { "add": [], "remove": ["pm-michelle"] }
  }
}
```

- `id` 只要在檔案內唯一即可，慣例是 `pm-` / `rd-` 加小寫名字。
- `startDate` / `endDate` 可選，用來處理到職／離職；字串比較即可，不必轉日期。目前 `startDate` 全體是 `2026-09-01`，所以 8 月的日曆是空的（網頁會自動從 9 月開始顯示，並在側欄說明原因）。
- **離職請加 `endDate`，不要從 `members` 刪人**：刪掉的話那個人過去的排班與月度統計會一併消失。加 `endDate` 則是該日之後不再排班，歷史照留，側欄會標「9/4 止」。例：Max 的 `endDate` 是 `2026-09-04`。
- 排 RD 時記得同一人**同一週只能出現一次**，週一起算。跨月的週要特別注意：`2026-09-30`（三）與 `2026-10-02`（五）屬於同一週。

改完 push 到 `main`，GitHub Actions 會跑測試 + 檢查資料，通過就自動部署。

```bash
npm run check      # = npm test && npm run validate，跟 CI 跑的完全一樣
```

### 測試與資料是分開的

`scripts/test-rules.js` 讀的是 `scripts/fixtures/schedule.fixture.json`（一份凍結的快照），
只驗證規則邏輯；線上 `data/schedule.json` 的結構與「一人一週一天」由 `scripts/validate-data.js` 檢查。
所以**網頁儲存或手改資料都不會讓測試紅**；測試紅了代表 `scripts/rules.js` 的行為變了。
要更換 fixture 基準時，把 `data/schedule.json` 複製過去，並在同一個 commit 同步更新
測試裡的三處預期值（每日名單、每人每週核對表、月度統計）。

---

## 登入與安全性

### 原理：密碼是金鑰，不是門禁

網頁寫回 GitHub 需要一個 token。這個 token 用 **AES-GCM-256** 加密後放在
[`data/vault.json`](data/vault.json)，金鑰由「帳號＋密碼」經 **PBKDF2-HMAC-SHA256（600,000 次）** 推導。
登入就是拿帳密解開 token：解不開就是帳密錯（帳號錯與密碼錯的失敗方式一樣，不區分）。

- `vault.json` 裡**沒有**帳號、沒有密碼 hash、沒有提示，只有密文與 KDF 參數。
- 解出的 token 只留在瀏覽器記憶體：不進 localStorage、不進 URL；重新整理或關閉分頁就要重新登入。
- token 是 **fine-grained PAT**：只授權這一個 repo、只有 Contents 讀寫、有到期日。就算洩漏也拿不到別的 repo。
- 儲存前會比對遠端 sha，有人搶先改過會拒絕覆寫。
- 為什麼不做「比對密碼 hash」就好：那只是門禁，任何人開 DevTools 改一行就繞過，之後要寫什麼都行。
  這裡沒有 token 就寫不進去，密碼就是那把鑰匙。

### 沒保護什麼（請如實看待）

- **密文是公開的**（repo 是 public）。任何人都能下載 `vault.json` 離線暴力猜帳密；唯一的防線是
  600,000 次 PBKDF2 讓每次猜測變慢（一張高階 GPU 約每秒一萬次）＋**你的密語夠長夠隨機**。
  請用至少 4–5 個隨機單字或 14 個以上隨機字元，不要用 `wfh2026!` 這類規律；帳號也不要用 `admin`。
- **登入後 token 在瀏覽器記憶體裡**。同一台電腦上的惡意瀏覽器擴充、開著 DevTools 的人、或沒鎖的電腦，
  都能拿到 token 或直接按「儲存」。只在自己的裝置登入，離開時登出。
- **拿到 token 就能改這個 repo 的任何檔案**（Contents 權限不分路徑），包括 `index.html`。
  這是 PAT 粒度的限制，靠到期日與洩漏時立刻撤銷來控制影響時間。
- 不取代 GitHub 帳號本身的 2FA；所有網頁 commit 都以 token 主人的名義進 `main`（會 bypass `protect_main` ruleset，token 主人需為 repo admin）。

### 第一次設定：建 PAT、產生 vault

1. GitHub 右上頭像 → **Settings** → 左側最下 **Developer settings** → **Personal access tokens** →
   **Fine-grained tokens** → **Generate new token**。
2. Token name 隨意（例：`Ment-Shift-Flow 網頁排班`）；**Expiration** 建議 6 個月，把到期日抄下來。
3. **Resource owner** 選 **`mentrd`**（org）。下拉沒有 mentrd 代表 org 尚未允許 fine-grained PAT：
   org Settings → Third-party Access → Personal access tokens 開啟。
4. **Repository access** → **Only select repositories** → 只勾 **`Ment-Shift-Flow`**。
5. **Permissions → Repository permissions → Contents → Read and write**（Metadata 會自動加 Read-only）。
   其餘全部 No access。
6. Generate 後立刻複製 `github_pat_…`（只顯示一次），**不要**貼到聊天或筆記，直接進下一步。
7. 在專案目錄執行：

   ```bash
   npm run vault -- --expires 2027-03-21     # 換成你的到期日
   ```

   互動輸入帳號、密碼（不回顯）、PAT（不回顯）。程式會先用 PAT 讀一次 repo 確認權限，
   再加密寫入 `data/vault.json`，並自我解密驗證。PAT 明文不會寫進任何檔案。
8. `git add data/vault.json && git commit -m "chore: 更新網頁排班用 vault" && git push`。
9. 若 org 開了「fine-grained PAT 需管理者核准」，非 owner 建的 token 會卡在 Pending，核准前 API 一律 403／404。

### PAT 到期或洩漏

- **到期前**：登入時會提前 14 天提醒。到 GitHub 建新 PAT → `npm run vault` 重做 → commit push → 刪舊 PAT。
- **懷疑洩漏**：先到 GitHub **Delete** 該 PAT（立即生效，舊密文從此無用）→ 檢查
  [commits](https://github.com/mentrd/Ment-Shift-Flow/commits/main) 有沒有不是你做的 → 建新 PAT →
  `npm run vault`（**順便換密語**）→ commit push。
- 團隊其他人完全無感，他們只讀 Pages。

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
npm run check      # 測試 + 檢查資料，跟 CI 一樣。改完任何東西跑這個就對了
npm test           # 規則與加解密的回歸測試（讀 fixtures，與線上資料無關）
npm run validate   # 只檢查 data/*.json（線上資料的結構與衝突）
npm run holidays   # 重新抓取國定假日
npm run vault      # 互動產生 data/vault.json（帳密加密的 GitHub token）
```

沒有任何 dependency，也不需要 build —— `npm install` 都不必跑。Node 22（`npm run vault` 需 Node ≥ 20）。

> 不能直接用 `file://` 開 `index.html`：頁面用 `fetch` 讀 `data/*.json`，會被瀏覽器的 CORS 規則擋下。一定要透過 http server。
> 登入需要 WebCrypto，只在 HTTPS 或 `localhost` 可用；用區網 IP 開 http 會無法登入（檢視不受影響）。

### 檔案結構

```
index.html                 全部 UI + CSS + JS（登入後可編輯排班並寫回 repo）
data/schedule.json         成員 + 逐日指派（唯一真實來源；網頁儲存或手動編輯）
data/holidays.json         國定假日（程式產生，勿手改）
data/vault.json            帳密加密後的 GitHub token（npm run vault 產生；只有密文）
scripts/rules.js           排班規則與異動邏輯的唯一真實來源
scripts/vault.js           PBKDF2 + AES-GCM 封裝（前端與 make-vault 共用）
scripts/github.js          GitHub Contents API 讀寫（前端與 make-vault 共用）
scripts/make-vault.js      互動產生 data/vault.json
scripts/test-rules.js      規則的回歸測試（讀 fixtures，不依賴線上資料）
scripts/test-vault.js      加解密與錯誤分類的回歸測試
scripts/fixtures/          測試用的凍結快照（不是網頁讀的檔）
scripts/validate-data.js   部署前資料檢查
scripts/fetch-holidays.js  抓取政府行事曆
```

`scripts/rules.js` 同時被 `index.html`（`<script type="module">` import）、
`scripts/validate-data.js` 與 `scripts/test-rules.js`（node import）使用。**規則只有這一份**，
網頁擋下的、CI 擋下的，是同一段程式碼。`vault.js`／`github.js` 同理：Node 產的密文，瀏覽器解的就是同一份實作。

---

## 部署

push 到 `main` 就會觸發 [`deploy.yml`](.github/workflows/deploy.yml)：跑測試 → 檢查資料 → 上傳靜態檔到 Pages。
網頁上按「儲存到 GitHub」也是一次 push，走同一條流程；儲存後約一分鐘全團隊看到新班表。

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
| SHERRY | 09/04 | 09/11 | 09/14 | — |
| LEON   | 09/04 | 09/11 | 09/14 | — |
| ALAN   | 09/04 | 09/11 | 09/18 | — |
| EUDORA | 09/04 | 09/11 | 09/18 | — |
| RURU   | — | 09/07 | 09/14 | 09/21 |
| TEMA   | — | 09/07 | 09/18 | 09/21 |
| DOWNEY | — | 09/07 | 09/14 | 09/21 |
| ERIC   | — | 09/07 | 09/18 | 09/21 |

### 09/18 的補排

原名單沒有 09/18（五），該日只有 PM B 組三人。後來補上 RD 四人：受「一人一週一天」限制，
W 09/14 已排的 LEON、ALAN、EUDORA、DOWNEY 不能再排，剩下可排的正好是
SHERRY、RURU、TEMA、ERIC，補上後 9 月全體 14 人都是 3 天（上表 W 09/14 欄整欄變成有值）。

之後又依需求把 ALAN、EUDORA 調到 09/18，SHERRY、RURU 調到 09/14。09/14 與 09/18
同屬 W 09/14，是同一週內的對調，每人每週仍是一天，月天數也不變 —— 上表已是對調後的結果。

09/25（中秋）與 09/28（教師節）為假日不排班，維持原樣。
