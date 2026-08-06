# SignalDesk · 美股板塊輪動訊號 PWA

每日告訴你「買哪檔、賣哪檔、價格多少」,最多 6 倉,順著當下最熱的板塊選股。
可安裝、可離線的 PWA,無建置流程(沒有 npm / bundler),把資料來源、策略、回測拆成獨立模組。

**線上版:** <https://marschannewtag-spec.github.io/mars-stock/>

---

## 一、需求對照(當初提的 7 點)

| # | 需求 | 在哪實作 | 現況 |
|---|------|----------|------|
| 1 | 永遠不超過 6 倉 | `strategy.js` `MAX_POSITIONS` + `portfolio.js` `buy()` 硬擋 | ✅ 完成 |
| 2 | 每天更新買哪檔+價格 | `strategy.js` `generateBuys()` → 今日分頁 | ✅ 完成 |
| 3 | 每天更新賣哪倉+價格 | `strategy.js` `generateSells()` → 今日分頁 | ✅ 完成 |
| 4 | 選最熱板塊並從中選股 | `sectors.js` `rankSectors()` → 板塊分頁 | ✅ 完成 |
| 5 | 長期驗證+回測會賺 | `backtest-real.js` 事件驅動引擎,吃 Tiingo 16 年真實日線 | ✅ 已接真實資料 + Monte Carlo |
| 6 | 接受大回撤、要高報酬 | ATR 自適應停損 + 移動停利 + 分批停利階梯 | ✅ 已用 A/B + MC 驗證過 |
| 7 | 先做基本架構,之後強化 | 全模組化、可單獨抽換 | ✅ |

> **誠實界定(以你做 MQL5 的標準):**
> 回測**已經**吃真實 16 年調整後日線(Tiingo),也做了 block bootstrap Monte Carlo 300 次。
> 但還有兩個沒解決的偏差,看數字時要扣掉:
> 1. **生存者偏差** — 股票池是「今天的贏家」,16 年前不會有人這樣選。**絕對報酬偏樂觀,只有相對排名可信。**
> 2. **沒有交易成本** — 手續費、滑價、跳空都沒扣。
>
> 另外「AI 水位」是**風險體制偵測**(下跌 + 高波動),不是真估值,擋不掉「很貴但很平靜」的市場。

---

## 二、怎麼跑起來

Service Worker 與 ES Module 不能用 `file://` 直接開,要用一個本地伺服器:

```bash
python -m http.server 8000
```

然後開 <http://localhost:8000>。手機/桌面瀏覽器選「加入主畫面 / 安裝應用程式」即可當 App 用。

**部署:** 這個 repo 的**根目錄**直接就是 GitHub Pages 的網站根目錄。
每次更新的完整 SOP 見 [`docs/DEPLOY-github-pages.md`](docs/DEPLOY-github-pages.md) —— **每次都照那份做**,
特別是「`js/` 整包覆蓋 + bump `sw.js` 版本 + Unregister SW」這三步,少一步就會出現「sw 是新的、邏輯是舊的」。

---

## 三、架構地圖

```
mars-stock/                    ← repo 根目錄 = 網站根目錄
├── index.html                 UI 殼層 + 底部 6 分頁
├── manifest.json              PWA 設定(可安裝)
├── sw.js                      Service Worker(離線快取,cache-first)
├── css/styles.css             交易終端機風格
├── js/                        ← 13 個模組
│   ├── config.js              ★唯一要動的設定檔(Worker 網址、價格帶、preset)
│   ├── data.js                股票池(11 板塊 × 100 檔)+ MockDataAdapter(模擬模式)
│   ├── data-real.js           ★真實資料層:Twelve Data via Worker + 當日 localStorage 快取
│   ├── indicators.js          Wilder ATR + Minervini 完整指標(MA200 / 52週高低 / VCP)
│   ├── sectors.js             板塊熱度排名(z-score 標準化)
│   ├── strategy.js            ★策略核心:品質門檻、ATR 停損、移動停利、階梯停利
│   ├── market.js              AI 水位:SPY 12M 均線 + VIX/已實現波動 → 防禦時暫停進場
│   ├── presets.js             六組風險姿態參數(回測比較用)
│   ├── portfolio.js           持倉 + 部分出場 + 績效統計 + localStorage
│   ├── histdb.js              IndexedDB 封裝(16 年長歷史,localStorage 裝不下)
│   ├── backtest-real.js       ★真實回測引擎:隔日開盤成交、OHLC 真停損、跳空處理
│   ├── backtest.js            績效指標計算(CAGR / MaxDD / Sharpe / Calmar)
│   └── app.js                 UI 主控,把上面全部串起來
├── icons/                     PWA 圖示 × 3
├── docs/                      部署與設定說明
└── worker/signaldesk-worker.js  Cloudflare Worker(部署到 CF,GitHub Pages 不會用)
```

**資料流:**
`Worker → data-real.js(每日快取)→ sectors.js(排板塊)→ strategy.js(選股+出場)→ app.js(畫面)`

UI 完全不碰策略邏輯,所以改策略不會動到畫面,反之亦然。

**六個分頁:** 今日 / 持倉 / 板塊 / 探索 / 績效 / 回測

---

## 四、資料從哪來(三個 API,都走同一支 Worker)

| 用途 | 來源 | Worker 端點 | Secret |
|------|------|-------------|--------|
| 每日報價(112 檔日線) | Twelve Data | `/timeseries` | `TD_API_KEY` |
| 回測長歷史(16 年調整後 OHLC) | Tiingo | `/history` | `TIINGO_KEY` |
| 熱門漲幅榜 | FMP | `/movers` | `FMP_API_KEY` |
| 市值(Minervini 門檻用) | FMP | `/marketcap` | `FMP_API_KEY` |

Worker 的作用:**把 API key 藏起來**(前端永遠看不到)+ **解 CORS**。
部署方式見 [`docs/STEP1-realdata.md`](docs/STEP1-realdata.md)。

> ⚠️ **每天第一次開 App 要等約 13 分鐘。** 112 個代號 ÷ 每分鐘 8 檔(Twelve Data 免費層)
> = 14 批 × 批間 60 秒。抓完快取一整天,同一天再開是秒開。
> 升級付費方案後把 `config.js` 的 `BATCH_GAP_MS` 改成 `0` 就會秒抓。
>
> 右上角「↻ 更新」= 清快取重抓,**會再等 13 分鐘**,不要隨手按。

想換掉 Twelve Data,只要照 `RealDataAdapter` 的介面(`getQuotes` / `getSectorETFs` /
`getHistorical` / `getMarketSeries` / `seedSeries`)做一個新 class,UI 一行都不用改。

---

## 五、調參數的地方

**日常操作**用的是 `js/presets.js` 裡 `config.DAILY_PRESET` 指定的那組(預設 `composite`),
它會覆蓋 `js/strategy.js` 的 `STRATEGY_PARAMS` 預設值。

| 參數 | `composite` 值 | 意義 |
|------|------|------|
| `maxPositions` | 6 | 最多幾倉 |
| `hotSectorCount` | 6 | 前幾名板塊才選股 |
| `minStockScore` | 0.13 | 複合動能分數下限(不夠強就不推,寧缺勿濫) |
| `atrStopMult` | 2.5 | 硬停損 = 進場價 − ATR × 此倍數 |
| `trailingStopPct` | -12% | 自持倉最高點回落多少觸發移動停利 |
| `maxExtensionAboveMA20` | 15% | 高於 MA20 超過此% 就不追(避免接拋物線頂) |
| `reentryCooldownDays` | 5 | 剛賣掉的標的 N 天內不重複推薦 |
| `enableProfitLadder` | true | +30% 減碼 1/3、+60% 再減 1/3,剩下讓移動停利跑 |

- 板塊排名權重:`js/sectors.js` 的 `SECTOR_WEIGHTS`
- 市場水位門檻:`js/market.js` 的 `MARKET_PARAMS`
- 價格帶 / preset 選擇:`js/config.js`

> **`useSignalExits` 預設是關的。** 「板塊退燒 + 跌破 MA20」這兩條出場規則跑過
> 六姿態 × 16 年 A/B 測試,5/6 姿態顯示它們**傷害 Calmar**(交易次數暴增造成
> 「昨天買今天賣」的 whipsaw),所以日常引擎只保留已驗證的 ATR 停損 + 移動停利。
> 回測分頁可以重跑這個 A/B 複驗結論。

---

## 六、還沒做的(下一步候選)

1. **交易成本** — 回測加入手續費/滑價,報酬才真實。這是目前數字最大的水分之一。
2. **生存者偏差** — 用歷史成分股快照重建 universe,而不是拿今天的贏家回測 16 年。
3. **`sw.js` 改 network-first** — 目前是 cache-first。
   已用 `updateViaCache: 'none'` 消掉「sw.js 被 HTTP 快取 10 分鐘」的靜默空窗,
   配上既有的 `skipWaiting()`,部署後重開 App 就會更新,實務上已經夠用。
   真的要根治才需要把 `.js` / `.html` 改成 network-first、只讓 icons/css 走 cache-first。
4. **自動每日更新** — 定時抓 API + 推播通知,不用手動開 App 等 13 分鐘。
5. **訊號邏輯升級** — 成交量確認、部位加碼(pyramiding)、波動度調整部位大小。
