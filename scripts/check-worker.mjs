#!/usr/bin/env node
// =============================================================
// check-worker.mjs — 資料源健康檢查
// -------------------------------------------------------------
// 用法:  node scripts/check-worker.mjs
//        WORKER_URL=https://... node scripts/check-worker.mjs
//
// 為什麼需要:App 依賴三個外部 API(Twelve Data / Tiingo / FMP),
// 它們變更或停用端點時,不會通知你。FMP 就停用過 legacy 的
// v3/gainers,是壞掉之後才發現的。
//
// 這支腳本實際打每個端點,而且**驗證回傳的結構**,不是只看 HTTP 200 ——
// 資料源默默改欄位名時,狀態碼還是 200,但 App 會算出錯的數字。
//
// 退出碼:
//   0 = 全部正常(可能有警告)
//   1 = 有端點壞掉,需要處理
// =============================================================

const WORKER = (process.env.WORKER_URL || 'https://stock.marschannewtag.workers.dev').replace(/\/$/, '');
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://marschannewtag-spec.github.io';

const results = [];
const ok = (name, detail) => results.push({ name, level: 'ok', detail });
const warn = (name, detail) => results.push({ name, level: 'warn', detail });
const bad = (name, detail) => results.push({ name, level: 'bad', detail });

async function getJson(path, headers = {}) {
  const r = await fetch(WORKER + path, { headers });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 不是 JSON */ }
  return { status: r.status, headers: r.headers, data, text };
}

const days = (iso) => Math.round((Date.now() - new Date(iso).getTime()) / 86400000);

// ---- 1. /timeseries(Twelve Data)每日報價的命脈 ----
async function checkTimeseries() {
  const name = '/timeseries';
  try {
    const { status, data } = await getJson('/timeseries?symbols=SPY,AAPL&outputsize=3');
    if (status !== 200 || !data) return bad(name, `HTTP ${status}`);
    if (data.error) return bad(name, `${data.error}${data.message ? ' — ' + data.message : ''}`);

    for (const sym of ['SPY', 'AAPL']) {
      const vals = data[sym] && data[sym].values;
      if (!Array.isArray(vals) || !vals.length) return bad(name, `${sym} 沒有 values 陣列`);
      // 欄位結構驗證 —— 少任何一個,前端算出來的指標就是錯的
      const miss = ['datetime', 'open', 'high', 'low', 'close'].filter((k) => vals[0][k] == null);
      if (miss.length) return bad(name, `${sym} 缺欄位:${miss.join(', ')}(資料源可能改了格式)`);
    }
    const last = data.SPY.values[data.SPY.values.length - 1];
    const age = days(last.datetime);
    const detail = `SPY 最新 ${last.datetime}(${age} 天前)· 收盤 ${last.close}`;
    // 超過 5 天 = 不只是週末,可能連假或資料源卡住
    return age > 5 ? warn(name, detail + ' ← 偏舊,確認是否為連假') : ok(name, detail);
  } catch (e) { bad(name, e.message); }
}

// ---- 2. /history(Tiingo)回測長歷史 ----
async function checkHistory() {
  const name = '/history';
  try {
    const { status, data } = await getJson('/history?symbol=SPY&years=16');
    if (status !== 200 || !data) return bad(name, `HTTP ${status}`);
    if (data.error) return bad(name, data.error);
    if (!Array.isArray(data.bars) || data.bars.length < 200) {
      return bad(name, `bars 只有 ${data.bars ? data.bars.length : 0} 根${data.note ? ' — ' + data.note : ''}`);
    }
    const miss = ['d', 'o', 'h', 'l', 'c'].filter((k) => data.bars[0][k] == null);
    if (miss.length) return bad(name, `缺欄位:${miss.join(', ')}`);
    const years = ((new Date(data.bars[data.bars.length - 1].d) - new Date(data.bars[0].d)) / 31557600000).toFixed(1);
    return ok(name, `SPY ${data.bars.length} 根 · ${data.bars[0].d} ~ ${data.bars[data.bars.length - 1].d}(${years} 年)`);
  } catch (e) { bad(name, e.message); }
}

// ---- 3. /movers(FMP)這個端點被停用過一次 ----
async function checkMovers() {
  const name = '/movers';
  try {
    const { status, data } = await getJson('/movers?type=gainers');
    if (status !== 200 || !data) return bad(name, `HTTP ${status}`);
    if (data.error) return bad(name, data.error);
    if (!Array.isArray(data.movers) || !data.movers.length) {
      return bad(name, `沒有 movers${data.note ? ' — ' + data.note : ''}(FMP 端點可能又被停用)`);
    }
    const m = data.movers[0];
    const miss = ['symbol', 'name', 'price', 'changePct'].filter((k) => m[k] == null);
    if (miss.length) return bad(name, `缺欄位:${miss.join(', ')}`);
    return ok(name, `${data.movers.length} 檔 · 例:${m.symbol} $${m.price}`);
  } catch (e) { bad(name, e.message); }
}

// ---- 4. /marketcap(FMP)Minervini 市值門檻用 ----
async function checkMarketcap() {
  const name = '/marketcap';
  try {
    const { status, data } = await getJson('/marketcap?symbols=AAPL');
    if (status !== 200 || !data) return bad(name, `HTTP ${status}`);
    if (data.error) return bad(name, data.error);
    const cap = data.marketCaps && data.marketCaps.AAPL;
    if (!cap || cap < 1e11) return bad(name, `AAPL 市值回 ${cap}(不合理,端點可能有變)`);
    return ok(name, `AAPL $${(cap / 1e12).toFixed(2)}T`);
  } catch (e) { bad(name, e.message); }
}

// ---- 5. CORS 設定狀態 ----
// 這一項只警告不失敗:沒設不代表壞掉,但你應該知道。
async function checkCors() {
  const name = 'CORS 鎖來源';
  try {
    const evil = await getJson('/timeseries?symbols=AAPL&outputsize=1', { Origin: 'https://evil-example.test' });
    const acao = evil.headers.get('access-control-allow-origin');
    if (acao === '*') {
      return warn(name,
        'ALLOWED_ORIGIN 沒設,任何網站的 JS 都能呼叫你的 Worker、消耗你的 API 額度。\n' +
        `      到 Cloudflare -> Worker -> Settings -> Variables 加一般變數(不是 secret):\n` +
        `      ALLOWED_ORIGIN = ${SITE_ORIGIN},http://127.0.0.1:8000,http://localhost:8000\n` +
        '      注意:CORS 擋得住別的網站的瀏覽器 JS,擋不住 curl / 腳本。');
    }
    const site = await getJson('/timeseries?symbols=AAPL&outputsize=1', { Origin: SITE_ORIGIN });
    const siteAcao = site.headers.get('access-control-allow-origin');
    if (siteAcao !== SITE_ORIGIN) {
      return bad(name, `已鎖來源,但你自己的網站被擋了!回傳 ${siteAcao},應為 ${SITE_ORIGIN}`);
    }
    return ok(name, `已鎖定(惡意來源得到 ${acao},自家網站正常放行)`);
  } catch (e) { bad(name, e.message); }
}

// =============================================================
console.log(`\n  資料源健康檢查`);
console.log(`  Worker:${WORKER}`);
console.log('  ' + '─'.repeat(64));

await checkTimeseries();
await checkHistory();
await checkMovers();
await checkMarketcap();
await checkCors();

console.log('');
for (const r of results) {
  const mark = r.level === 'ok' ? '✓' : r.level === 'warn' ? '⚠' : '✗';
  console.log(`  ${mark} ${r.name.padEnd(14, ' ')} ${r.detail}`);
}

const bads = results.filter((r) => r.level === 'bad');
const warns = results.filter((r) => r.level === 'warn');
console.log('  ' + '─'.repeat(64));
if (bads.length) {
  console.log(`  ✗ ${bads.length} 個端點有問題 —— App 會壞掉或算出錯的數字\n`);
  process.exit(1);
}
console.log(`  ✓ ${results.length - warns.length} 項正常${warns.length ? `,${warns.length} 項警告(不影響運作)` : ''}\n`);
