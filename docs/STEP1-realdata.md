# Step 1:接上 Twelve Data 真實股價(部署指南)

做完這步,App 的「今日訊號 / 板塊 / 持倉」就是用真實美股價格在跑。
整個資料流:**PWA → 你的 Cloudflare Worker(藏 key、解 CORS)→ Twelve Data**。

---

## 1. 拿 Twelve Data API key
1. 到 twelvedata.com 註冊(免費 Basic 方案)。
2. 登入後在 Dashboard 複製你的 **API key**。
   - 免費層:每天 800 credits、每分鐘 8。抓 **112 檔**(11 板塊 ETF + 100 股 + SPY)= 112 credits,
     一天跑滿也才用掉 1/7 額度,綽綽有餘;真正的限制是**每分鐘只能 8 檔**,
     所以要分批(App 已幫你處理,每批 8 檔、間隔 60 秒 → 14 批)。

## 2. 部署 Cloudflare Worker
**方法 A(儀表板,最快,跟你 sp500-worker 一樣):**
1. Cloudflare 儀表板 → **Workers & Pages** → **Create** → **Create Worker**。
2. 命名例如 `signaldesk-worker` → **Deploy**(先部署預設範本)。
3. 點 **Edit code**,把 `worker/signaldesk-worker.js` 整支貼上去 → **Deploy**。
4. 回到 Worker 的 **Settings → Variables and Secrets** → **Add**:
   - 類型選 **Secret**,名稱 `TD_API_KEY`,值 = 你的 Twelve Data key → Save。
   - (選用)再加一個一般變數 `ALLOWED_ORIGIN` = 你的網站網址(例
     `https://你的帳號.github.io`),把 CORS 鎖成只有你的站能用,避免額度被盜用。
5. 複製這支 Worker 的網址,長得像:
   `https://signaldesk-worker.你的帳號.workers.dev`

**方法 B(wrangler CLI):**
```bash
npm i -g wrangler
cd worker
wrangler deploy signaldesk-worker.js --name signaldesk-worker
wrangler secret put TD_API_KEY      # 貼上你的 key
```

## 3. 測 Worker 有沒有通
瀏覽器直接開(換成你的網址):
```
https://signaldesk-worker.你的帳號.workers.dev/timeseries?symbols=XLK,AAPL&outputsize=5
```
應該看到一段 JSON,裡面有 `XLK` 和 `AAPL` 各自的 `values` 陣列(日期 + 收盤)。
若看到 `{"error":"Worker 未設定 TD_API_KEY secret"}` → 回步驟 2.4 補 secret。
若看到 `{"error":"twelvedata","code":429,...}` → 額度用盡,等一分鐘。

## 4. 把網址填進 App
打開 `js/config.js`,填這兩行:
```js
USE_REAL_DATA: true,
WORKER_URL: 'https://signaldesk-worker.你的帳號.workers.dev',
```

## 5. 跑起來驗收
```bash
cd SignalDesk
python3 -m http.server 8000
# 開 http://localhost:8000
```
第一次會看到進度:「讀取真實股價 8/112…」→「等待額度重置…」,**約 13 分鐘**跑完
(14 批 × 批間 60 秒,免費層每分鐘只能 8 檔的代價)。跑完後:
- 資料**快取一整天**,同一天再開是秒開。
- 右上角 **↻ 更新** = 清快取、重抓當日最新價(⚠️ 會再等 13 分鐘,不要隨手按)。
- 板塊排名、今日買賣訊號、持倉損益,全部是真實股價算出來的。

> 想秒抓不等待?升級 Twelve Data 付費方案後,把 `config.js` 的 `BATCH_GAP_MS` 改成 `0`。

---

## 驗收清單(這關「完美」的標準)
- [ ] Worker 測試網址能回傳 JSON(步驟 3)
- [ ] App 讀完 112 檔沒報錯
- [ ] 板塊分頁的數字跟你在 TradingView 看 XLK/XLF… 的近月漲跌對得起來
- [ ] 隨便挑一檔(如 AAPL)的現價,跟券商報價接近(免費層是日線收盤,不是即時 tick)
- [ ] 關掉瀏覽器再開,同一天是秒開(快取生效)

這五項都 ✅,Step 1 就算完美,我們再進 Step 2(每日更新邏輯 + 不硬湊 6 檔)。
有任何一項卡住,把畫面訊息或 Worker 回傳的 JSON 貼給我。
