// =============================================================
// data-real.js — 真實資料層(Twelve Data,透過你的 Worker)
// -------------------------------------------------------------
// 對外介面跟 MockDataAdapter 完全一樣:
//   getUniverse() / getQuotes() / getSectorETFs() / getHistorical()
// 所以 sectors.js / strategy.js / app.js 都不用改。
//
// 流程:
//   1. ensureLoaded():把 11 檔板塊 ETF + 100 檔股票 + SPY = 112 個代號的日線抓回來,
//      依免費層限制分批(每批 8 檔、間隔 60 秒),抓完存 localStorage。
//      ⚠️ 112 檔 = 14 批,批次間隔 60 秒 -> 每天第一次開 App 要等約 13 分鐘。
//         想秒抓就升級 Twelve Data 付費方案,把 config 的 BATCH_GAP_MS 改成 0。
//   2. 同一天再開 App -> 直接讀 localStorage 快取,不重打 API。
//   3. getQuotes / getSectorETFs 從快取算出跟 mock 一樣的指標欄位。
// =============================================================

import { SECTORS, UNIVERSE } from './data.js';
import { atr } from './indicators.js';

const CACHE_PREFIX = 'td_ohlc_';             // localStorage key 前綴(OHLC 版,舊快取自動失效重抓)
const todayKey = () => CACHE_PREFIX + new Date().toISOString().slice(0, 10);

// 要抓的全部代號 = 11 板塊 ETF + universe 股票 + SPY(市場水位趨勢腿用)
const BASE_SYMBOLS = [...SECTORS.map((s) => s.etf), ...UNIVERSE.map((u) => u.symbol), 'SPY'];

// ---- 自選股(從「探索」買進、不在 universe 裡的)----
// 存 localStorage,讓它們每天跟著一起抓報價,否則持倉不會更新、停損不會觸發。
const EXTRA_KEY = 'sd_extra_symbols';
export function getExtras() {
  try { return JSON.parse(localStorage.getItem(EXTRA_KEY) || '[]'); } catch (e) { return []; }
}
function saveExtras(list) {
  try { localStorage.setItem(EXTRA_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
}
export function addExtraSymbol(symbol, name) {
  const list = getExtras();
  if (!list.some((x) => x.symbol === symbol)) { list.push({ symbol, name: name || symbol }); saveExtras(list); }
}
export function removeExtraSymbol(symbol) {
  saveExtras(getExtras().filter((x) => x.symbol !== symbol));
}
const allSymbols = () => [...new Set([...BASE_SYMBOLS, ...getExtras().map((x) => x.symbol)])];

// ---- 額度用完(429)自動退避重試 ----
// Twelve Data 免費層是「每分鐘 8 credits」,超過就回 code 429,Worker 包成 502 轉回來。
// 這是**等一分鐘就會自己好**的錯誤 —— 讓它中斷整趟 13 分鐘的載入不合理。
// 只重試 429:key 無效、參數錯之類的錯誤重試幾次結果都一樣,
// 立刻失敗才看得到真正的原因(拖 3 分鐘只會讓人以為是網路慢)。
export const RETRY_MAX = 3;          // 最多重試 3 次
const RETRY_WAIT_MS = 60000;         // 額度以「分鐘」為單位重置

async function fetchJSON(url, onRateLimit) {
  for (let retry = 0; ; retry++) {
    const resp = await fetch(url);
    let data;
    try {
      data = await resp.json();
    } catch (e) {
      // 回應不是 JSON(Worker 掛了 / Cloudflare 錯誤頁)。原始訊息是
      // 「Unexpected token <」,看不出發生什麼事,換成帶狀態碼的版本。
      throw new Error(`資料讀取失敗:回應不是 JSON(HTTP ${resp.status})`);
    }
    if (!(data && data.error)) return data;

    const rateLimited = resp.status === 429 || data.code === 429;
    if (!rateLimited || retry >= RETRY_MAX) {
      throw new Error(`資料讀取失敗:${data.message || data.error}${data.code ? ' (code ' + data.code + ')' : ''}`);
    }
    if (onRateLimit) onRateLimit(retry + 1);
    await sleep(RETRY_WAIT_MS);
  }
}

export class RealDataAdapter {
  constructor(config) {
    this.cfg = config;
    this.series = {};          // { SYMBOL: number[] }  收盤價(舊->新)
    this.loaded = false;
  }

  // ---- 從 localStorage 載入今天的快取(有的話)----
  _loadCache() {
    try {
      const raw = localStorage.getItem(todayKey());
      if (raw) { this.series = JSON.parse(raw); return true; }
    } catch (e) { /* ignore */ }
    return false;
  }

  _saveCache() {
    try { localStorage.setItem(todayKey(), JSON.stringify(this.series)); } catch (e) { /* quota */ }
    // 順手清掉舊日期的快取,避免塞爆 localStorage
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith(CACHE_PREFIX) && k !== todayKey()) localStorage.removeItem(k);
      }
    } catch (e) { /* ignore */ }
  }

  // ---- 確保資料就緒;onProgress(done, total, phase) 用來更新進度條 ----
  async ensureLoaded(onProgress) {
    if (this.loaded) return;
    if (!this.cfg.WORKER_URL) {
      throw new Error('尚未設定 WORKER_URL(請先部署 Worker,再填到 config.js)');
    }

    // 先吃快取,只補還沒有的代號
    this._loadCache();
    const symbols = allSymbols();
    const missing = symbols.filter((s) => !this.series[s] || this.series[s].length === 0);

    if (missing.length === 0) { this.loaded = true; return; }

    const { BATCH_SIZE, BATCH_GAP_MS, OUTPUT_SIZE, WORKER_URL } = this.cfg;
    let done = symbols.length - missing.length;

    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      const batch = missing.slice(i, i + BATCH_SIZE);
      const u = `${WORKER_URL.replace(/\/$/, '')}/timeseries`
        + `?symbols=${encodeURIComponent(batch.join(','))}&outputsize=${OUTPUT_SIZE}`;

      // 遇到 429 會在這裡面等 60 秒重試,最多 3 次;其他錯誤直接往外拋。
      const data = await fetchJSON(u, (attempt) => {
        if (onProgress) onProgress(done, symbols.length, 'ratelimit', attempt);
      });

      for (const sym of batch) {
        const values = (data[sym] && data[sym].values) || [];
        // order=ASC:舊->新;存 OHLC(ATR 需要 high/low)+ 日期
        // d 一定要留:沒有它就無從得知「這些價格是哪一天的」。
        // 遇到連假、或資料源異常回了舊資料時,畫面才有辦法誠實告訴你。
        this.series[sym] = values
          .map((v) => ({
            d: (v.datetime || '').slice(0, 10),
            h: parseFloat(v.high), l: parseFloat(v.low), c: parseFloat(v.close),
          }))
          .filter((b) => !isNaN(b.c) && !isNaN(b.h) && !isNaN(b.l));
      }
      this._saveCache();

      done += batch.length;
      if (onProgress) onProgress(done, symbols.length, 'loading');

      // 還有下一批 -> 等節流時間(免費層每分鐘 8 檔)
      if (i + BATCH_SIZE < missing.length && BATCH_GAP_MS > 0) {
        if (onProgress) onProgress(done, symbols.length, 'waiting');
        await sleep(BATCH_GAP_MS);
      }
    }
    this.loaded = true;
  }

  // ---- 從 OHLC 序列算出指標(含 ATR)----
  _metrics(bars) {
    const closes = bars.map((b) => b.c);
    const last = closes[closes.length - 1];
    const prev = closes[closes.length - 2] ?? last;
    const ma = (k) => {
      const s = closes.slice(-k);
      return s.reduce((a, b) => a + b, 0) / s.length;
    };
    const ret = (k) => {
      const past = closes[closes.length - 1 - k];
      return past ? (last - past) / past : 0;
    };
    const ma20 = ma(20), ma50 = ma(50);
    const a = atr(bars, 14);
    return {
      price: last, prevClose: prev, changePct: (last - prev) / prev,
      ma20, ma50,
      relMA20: (last - ma20) / ma20, relMA50: (last - ma50) / ma50,
      ret1m: ret(21), ret3m: ret(63),
      atr: a, atrPct: a ? a / last : null,
    };
  }

  // ===== 對外介面(跟 MockDataAdapter 相同)=====
  getUniverse() { return UNIVERSE; }

  async getQuotes() {
    await this.ensureLoaded();
    // universe + 自選股(自選股 etf = null,不參與板塊輪動,但要有報價才能更新持倉/觸發停損)
    const list = [
      ...UNIVERSE,
      ...getExtras().filter((x) => !UNIVERSE.some((u) => u.symbol === x.symbol))
        .map((x) => ({ symbol: x.symbol, name: x.name, etf: null })),
    ];
    return list
      .filter((u) => this.series[u.symbol] && this.series[u.symbol].length >= 63)
      .map((u) => ({ symbol: u.symbol, name: u.name, etf: u.etf, ...this._metrics(this.series[u.symbol]) }));
  }

  // 直接把已抓好的 bars 塞進快取(從「探索」買進時用,免再打一次 API)
  seedSeries(symbol, bars) {
    if (!bars || !bars.length) return;
    this.series[symbol] = bars;
    this._saveCache();
  }

  async getSectorETFs() {
    await this.ensureLoaded();
    return SECTORS
      .filter((s) => this.series[s.etf] && this.series[s.etf].length >= 63)
      .map((s) => {
        const m = this._metrics(this.series[s.etf]);
        return { etf: s.etf, name: s.name, ret1m: m.ret1m, ret3m: m.ret3m, relMA50: m.relMA50 };
      });
  }

  async getHistorical(symbol, days = 252) {
    await this.ensureLoaded();
    // 回傳收盤價陣列(回測用)
    return (this.series[symbol] || []).map((b) => b.c).slice(-days);
  }

  // 最新一根日線的日期(給畫面標示「這些價格是哪一天的」)。
  // 以 SPY 為準,沒有就退而求其次拿任一檔。
  // 回傳 null = 快取是舊格式(沒存 d),畫面會改標示「日線」而不是假裝知道日期。
  lastDataDate() {
    const pick = (sym) => {
      const bars = this.series[sym];
      return Array.isArray(bars) && bars.length ? bars[bars.length - 1].d : null;
    };
    const spy = pick('SPY');
    if (spy) return spy;
    for (const sym of Object.keys(this.series)) {
      const d = pick(sym);
      if (d) return d;
    }
    return null;
  }

  // 強制重抓:清掉今天的快取,下次 ensureLoaded 會重新拉
  forceRefresh() {
    try { localStorage.removeItem(todayKey()); } catch (e) { /* ignore */ }
    this.series = {};
    this.loaded = false;
    this._vixTried = false;
  }

  // ---- 市場水位資料:SPY(必有)+ VIX(盡力,免費層可能沒有)----
  async getMarketSeries() {
    await this.ensureLoaded();
    const vix = await this._ensureVix();
    const spy = (this.series['SPY'] || []).map((b) => b.c); // market.js 只需要收盤
    return { spy, vix };
  }

  // VIX 盡力抓一次;免費層抓不到就靜默回 null,由 market.js 改用替代波動
  async _ensureVix() {
    if (this.series['VIX'] && this.series['VIX'].length) return this.series['VIX'];
    if (this._vixTried) return null;
    this._vixTried = true;
    try {
      const u = `${this.cfg.WORKER_URL.replace(/\/$/, '')}/timeseries?symbols=VIX&outputsize=${this.cfg.OUTPUT_SIZE}`;
      const r = await fetch(u);
      const d = await r.json();
      if (!d.error && d.VIX && d.VIX.values && d.VIX.values.length) {
        this.series['VIX'] = d.VIX.values.map((v) => parseFloat(v.close)).filter((n) => !isNaN(n));
        this._saveCache();
        return this.series['VIX'];
      }
    } catch (e) { /* VIX 免費層可能沒有,退回替代方案 */ }
    return null;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
