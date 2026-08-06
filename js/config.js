// =============================================================
// config.js — 全域設定(這是你唯一需要動的檔)
// =============================================================

export const config = {
  // ── 資料來源開關 ──
  // true  = 用 Twelve Data 真實股價(需先部署 Worker 並填下面網址)
  // false = 用內建模擬資料(不需 Worker,拿來 demo / 測 UI)
  USE_REAL_DATA: true,

  // ── 你的 Cloudflare Worker 網址(部署後填這裡)──
  // 例:https://signaldesk-worker.你的帳號.workers.dev
  // 尚未部署前先留空,App 會提示你去設定。
  WORKER_URL: 'https://stock.marschannewtag.workers.dev',

  // ── 免費層節流 ──
  // Twelve Data 免費層:每分鐘 8 credits。一次抓 8 檔,批次之間間隔 60 秒。
  // 之後升級付費方案(無每分鐘限制),把 BATCH_GAP_MS 改成 0 就會秒抓。
  BATCH_SIZE: 8,
  BATCH_GAP_MS: 60000,

  // 抓幾天日線(算 MA50 / 3M 動能需要,260 ≈ 一年交易日)
  OUTPUT_SIZE: 260,

  // ── 選股價格帶(app.js 的 tradeable() 會用)──
  // 低於 PRICE_MIN 的水餃股、高於 PRICE_MAX 的高價股都不推薦,
  // 因為部位大小算不漂亮。這兩個沒填 = 過濾完全失效。
  PRICE_MIN: 6,
  PRICE_MAX: 666,

  // ── 日常「今日」分頁採用的風險姿態(見 js/presets.js)──
  // 可選:marcus / uncle / gooptions / bilaal / amber / composite
  DAILY_PRESET: 'composite',

  // ── 回測長歷史要抓幾年(Tiingo via Worker /history)──
  HISTORY_YEARS: 16,
};
