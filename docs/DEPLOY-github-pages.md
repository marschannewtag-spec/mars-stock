# SignalDesk — GitHub Pages 乾淨部署清單

> 核心三原則(每次更新都做,就不會再「只更新一半」):
> 1. **整包覆蓋**所有檔案(唯一例外:`js/config.js`,見下)
> 2. **確認 `sw.js` 版本號有變**(每次出新版都會 bump,例如 v25 → v26)
> 3. **push 後:等 CDN 1~5 分鐘 → 重開 App**
>
> 從 v26 起,SW 註冊加了 `updateViaCache: 'none'`,瀏覽器每次都會從網路檢查 `sw.js`,
> 配上 `skipWaiting()`,**重開 App 就會自動更新,不必再手動 Unregister**。
> Unregister 現在只是「不想等、想立刻確認」時的手段,不是必要步驟。

---

## 一次性設定(只做一次)

**A. Repo 結構**（GitHub Pages 服務的是 **repo 根目錄**,不是子資料夾）

```
marschannewtag-spec/mars-stock/   ← repo 根目錄就是網站根目錄
├─ index.html
├─ manifest.json
├─ sw.js
├─ css/styles.css
├─ js/            ← 13 個 .js,整個資料夾
├─ icons/         ← 3 個 png
├─ docs/          ← 說明文件(網站用不到,放著當參考)
└─ worker/        ← Cloudflare Worker 原始碼(網站用不到)
```

> `worker/signaldesk-worker.js` 是部署到 **Cloudflare Worker**,不是 GitHub Pages。留在 repo 當備份,但 GitHub Pages 不會用它。
>
> ⚠️ **`config.js` 只有一份,在 `js/config.js`**。根目錄以前有一份同名的重複檔,是死檔(`app.js` 只 import `./config.js` = `js/config.js`),已刪除。改設定請改 `js/config.js`。

**B. GitHub Pages 設定**：repo → Settings → Pages → Source 選 `main` 分支 + `/ (root)` → Save。
網址是 <https://marschannewtag-spec.github.io/mars-stock/>。

**C. `js/config.js` 設定一次,之後別亂動**（這是你的個人設定檔）：
```js
USE_REAL_DATA: true,
WORKER_URL: 'https://stock.marschannewtag.workers.dev',  // ← 一定要填!空的 = 抓不到資料
BATCH_SIZE: 8,
BATCH_GAP_MS: 60000,   // 免費層 8檔/分;買了 Grow 改成 0 秒抓
OUTPUT_SIZE: 260,
PRICE_MIN: 6,          // ← 少了這兩行,選股價格帶會完全失效(不報錯,靜靜失效)
PRICE_MAX: 666,
DAILY_PRESET: 'composite',
HISTORY_YEARS: 16,
```
> 這 9 個 key **一個都不能少**。`app.js` 對缺失的 key 全部有 fallback,所以少了不會報錯,
> 只會靜靜地換成預設行為(例如價格帶變成 0 ~ 無限大)。

**D. Cloudflare Worker**（跟 GitHub Pages 完全分開,獨立部署)：
Worker 貼好 `worker/signaldesk-worker.js` + 設好三個 **Secret**：`TD_API_KEY`、`TIINGO_KEY`、`FMP_API_KEY`。

> ⚠️ **`git push` 不會更新 Worker。** Worker 跑在 Cloudflare,GitHub Pages 只服務前端。
> `worker/signaldesk-worker.js` 有變動時,一定要另外去 Cloudflare 重貼一次,
> 否則線上跑的還是舊版 —— 而且不會有任何錯誤訊息告訴你。

**手動重貼 Worker**(還沒設好自動部署時)：
1. Cloudflare 儀表板 → **Workers & Pages** → 點你的 Worker → **Edit code**
2. 全選舊的、貼上新的 `worker/signaldesk-worker.js` → **Deploy**
3. 驗證:`node scripts/check-worker.mjs` —— 五項都要 ✓

**E. 讓 Worker 自動部署**(設定一次,之後不用再手動貼)：

`wrangler.toml` 和 `.github/workflows/deploy-worker.yml` 已經備好,只差兩個 secret。

**① 建 Cloudflare API token**
Cloudflare → 右上角頭像 → **My Profile** → **API Tokens** → **Create Token**
→ 用 **Edit Cloudflare Workers** 範本 → Continue → Create → **複製那串 token**(只顯示一次)

**② 找 Account ID**
Cloudflare → Workers & Pages 頁面右側,或網址列 `dash.cloudflare.com/<這串就是>`

**③ 加進 GitHub**
repo → **Settings → Secrets and variables → Actions** → **New repository secret**,加兩個:

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | ① 複製的那串 |
| `CLOUDFLARE_ACCOUNT_ID` | ② 那串 |

**④ 確認 Worker 名稱**
`wrangler.toml` 裡的 `name = "stock"` 必須跟儀表板上的 Worker 名稱**完全一致**。
不一致的話 wrangler 會**另外新建一支** Worker,而不是更新現有的 —— 你會得到兩支、
舊的繼續服務你的 App、新的沒人用,而且沒有任何錯誤訊息。

設好之後,`worker/` 底下任何改動 push 上去就會自動部署,並自動跑部署後驗證。

**允許的來源清單**寫在 `worker/signaldesk-worker.js` 的 `DEFAULT_ALLOWED_ORIGINS`,
**不在儀表板**。要改就改程式碼 push,設定只放一個地方才不會兩邊打架。

> 誠實界定:這擋得住「別的網站用 JS 呼叫你的 Worker」,擋不住 curl / 腳本
> (CORS 是瀏覽器才遵守的規則)。要擋那些得用 Cloudflare 的 Rate Limiting 規則。

---

## 每次更新的 SOP（照順序做,別跳步）

**1. 解壓我給的新 zip。**

**2. 處理 `config.js`（關鍵!）**
- **預設:不要覆蓋你 repo 裡的 `config.js`**——保住你的 `WORKER_URL`。
- **例外:只有當我明說「這次改了 config」時**(例如改價格帶、preset),你才需要更新 config——這時**手動改那幾行**,別整檔蓋掉(不然 WORKER_URL 會被清空)。

**3. 整包覆蓋其他所有檔案到 repo 的根目錄**
- `index.html`、`manifest.json`、`sw.js`、`css/`、`icons/`,以及 **`js/` 底下全部 13 個檔**。
- ⚠️ **最容易出錯的地方:`js/` 要整個資料夾覆蓋**。你上次就是漏了 `js/strategy.js`,導致 sw 是新的、邏輯是舊的。**寧可整包重傳,不要挑檔案傳。**
- 覆蓋完先在本機檢查一次,再 push:
  ```bash
  git status --short        # 應該只看到你預期會變的檔
  node scripts/verify.mjs   # 8 項架構驗證,綠了才 push
  ```

**3.5. `worker/` 有沒有變?（最容易漏掉的一步)**
```bash
git diff --stat HEAD -- worker/
```
有輸出 = **Worker 程式碼改了,push 之後還要去 Cloudflare 重貼一次**(見上面 D 節)。
`git push` 只更新 GitHub Pages 上的前端,**碰不到 Cloudflare 上的 Worker**。
漏掉的話前端是新的、Worker 是舊的,而且不會有任何錯誤訊息。

**4. push 到 GitHub**
```
git add -A
git commit -m "update to vXX"
git push
```
（或用 GitHub 網頁把整包拖上去覆蓋。）

**5. 等 GitHub Pages CDN 生效:1~5 分鐘**（不是即時,別急著測)。

**6. 重開 App**
- 正常情況:直接關掉分頁再開,或在手機上重開 PWA,**就是最新版了**
  (v26 起 `updateViaCache: 'none'` + `skipWaiting()` 會自動接管)。
- 想立刻確認 / 覺得沒更新:F12 → Application → Service Workers → **Unregister** → **Ctrl+Shift+R**。
- ❌ **絕對不要按「Clear site data」**——會清掉你的 16 年歷史 + paper trading 紀錄。

---

## 部署後驗證（30 秒,每次都做）

**驗證一:sw 版本對不對**
F12 → Console：
```js
caches.keys().then(console.log)
```
→ 應顯示最新版本號（例如 `['signaldesk-v25']`)。

**驗證二:實際邏輯有沒有上去（這是你上次的坑）**
新分頁直接開:
```
https://marschannewtag-spec.github.io/mars-stock/js/strategy.js
```
Ctrl+F 搜一個「這版才有」的關鍵字（例如某個新函式名),搜得到 = 邏輯真的上去了。
> 只驗 `sw.js` 版本**不夠**——它對了不代表 `js/` 底下的檔也上去了。兩個都要驗。

**驗證三:config 的 9 個 key 都在**
新分頁開 <https://marschannewtag-spec.github.io/mars-stock/js/config.js>,
確認 `PRICE_MIN` / `PRICE_MAX` / `DAILY_PRESET` / `HISTORY_YEARS` 都看得到。
少了不會報錯,只會靜靜地失效——這是最難察覺的一種壞。

---

## 症狀對照(出事時查這裡)

| 症狀 | 病因 | 解法 |
|---|---|---|
| `caches.keys()` 是舊版 | sw.js 沒 push 或 CDN 沒生效 | 等幾分鐘 + Unregister + 硬重整 |
| sw 版本對,但行為是舊的 | **`js/` 某些檔沒 push(只更新一半)** | 整個 `js/` 資料夾重新覆蓋 push |
| App 抓不到資料、一片空白 | `js/config.js` 的 `WORKER_URL` 被清空了 | 把 WORKER_URL 填回去 |
| 選股價格帶沒作用 | `js/config.js` 的 PRICE_MIN/MAX 被舊檔蓋掉 | 改回 6 / 666 |
| 回測分頁年數怪怪的 | `js/config.js` 少了 `HISTORY_YEARS` | 補回 16 |
| 用了非預期的 preset | `js/config.js` 少了 `DAILY_PRESET` | 補回 `'composite'` |
| 某些股票 502 | Twelve Data 瞬間失敗(非你的問題) | 按「更新」重試,或忽略 |
| 每天第一次開要等超久 | 正常:112 檔 ÷ 8 檔/分 = 14 批 ≈ 13 分鐘 | 升級 Twelve Data 後把 `BATCH_GAP_MS` 改 0 |

---

## 一句話記住

**「js 整包覆蓋、config 別亂動、sw 版本要變、Unregister 一定做。」**
你上次的 bug 就是漏了「js 整包覆蓋」——只要每次都整個 `js/` 資料夾重傳,就不會再發生。
