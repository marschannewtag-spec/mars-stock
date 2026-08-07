// =============================================================
// app.js — UI 主控 (把所有模組串起來、渲染畫面、處理互動)
// -------------------------------------------------------------
// 只負責「呈現 + 互動」。任何策略/資料的真正邏輯都在各自模組裡。
// =============================================================

import { MockDataAdapter, SECTORS, UNIVERSE } from './data.js';
import { RealDataAdapter, addExtraSymbol, removeExtraSymbol, getExtras } from './data-real.js';
import { config } from './config.js';
import { rankSectors } from './sectors.js';
import { generateBuys, generateSells, buyDiagnostic, computeStops, verifyTrendTemplate, MAX_POSITIONS } from './strategy.js';
import { quoteMetrics } from './indicators.js';
import { Portfolio } from './portfolio.js';
import { computeMarketGate } from './market.js';
import { putBars, getBars, putMeta, getMeta } from './histdb.js';
import { runRealBacktest } from './backtest-real.js';
import { PRESETS, PRESET_ORDER } from './presets.js';

// 依 config 選資料來源:真實(Twelve Data / Worker)或模擬
const adapter = config.USE_REAL_DATA ? new RealDataAdapter(config) : new MockDataAdapter();
const portfolio = new Portfolio();

// 日常「今日」分頁採用的姿態 preset(單一來源,改 config.DAILY_PRESET 即可切換)
const DAILY = PRESETS[config.DAILY_PRESET] || PRESETS.composite;
const DP = DAILY.params;                       // 日常策略參數
const DM = DAILY.market;                        // 日常市場水位參數
const DAILY_MAX = DP.maxPositions ?? MAX_POSITIONS;

let state = {
  tab: 'today',
  date: new Date(),
  quotes: [], ranked: [], buys: [], sells: [],
  loading: false, loadMsg: '',
  candInput: '',
};
let exploreRunning = false;
let exploreProgress = '';
let exploreResults = null;
let exploreBars = {};      // 探索最近一次抓到的日線(買進時 seed 給 adapter 用)
let showAddPos = false;    // 手動加入持倉表單開合

// ---- 每天重新計算: 報價 -> 板塊排名 -> 買賣訊號 ----
async function compute() {
  state.quotes = await adapter.getQuotes();
  portfolio.mark(state.quotes);
  state.ranked = rankSectors(await adapter.getSectorETFs(), DP.hotSectorCount);
  logSectorLeader(state.ranked[0] ? state.ranked[0].etf : null);
  pruneExtras();

  // 不重複:算出還在冷卻期(近 N 天賣掉)的代號,買進時排除
  const recentlySold = recentlySoldSymbols(DP.reentryCooldownDays);

  state.buys = generateBuys(tradeable(state.quotes), state.ranked, portfolio.positions, DP, recentlySold);
  state.sells = generateSells(portfolio.positions, state.quotes, state.ranked, DP);

  // 若今天沒補滿,算一下「差在哪」給使用者看(證明是門檻在把關)
  state.buyDiag = buyDiagnostic(tradeable(state.quotes), state.ranked, portfolio.positions, DP, recentlySold);

  // AI 水位:市場層級總開關(防禦時暫停進場)
  const mkt = await adapter.getMarketSeries();
  state.market = computeMarketGate(mkt.spy, mkt.vix, DM);

  // 這批價格實際是哪一天的日線(右上角標示用)
  state.dataDate = adapter.lastDataDate ? adapter.lastDataDate() : null;
}

// 只保留價格帶內的股票(config.PRICE_MIN ~ PRICE_MAX,下單/部位大小限制)
function tradeable(quotes) {
  const lo = config.PRICE_MIN ?? 0, hi = config.PRICE_MAX ?? Infinity;
  return quotes.filter((q) => q.price >= lo && q.price <= hi);
}

// 從已實現紀錄找出近 N 天賣出的代號(冷卻期,避免買→賣→馬上再買的來回洗)
function recentlySoldSymbols(days) {
  const cutoff = Date.now() - days * 86400000;
  return (portfolio.cashLog || [])
    .filter((c) => c.exitDate && new Date(c.exitDate).getTime() >= cutoff)
    .map((c) => c.symbol);
}

// 右上角的日期標示。
// 以前真實模式一律寫「即時」—— 那是騙人的:免費層拿的是「日線收盤」,
// 最新一根可能是昨天、甚至上週五。遇到連假或資料源異常回舊資料時,
// 寫「即時」會讓你對著三天前的價格做今天的決策。
// 現在直接標出這批價格實際的日線日期。
function dateLabel() {
  if (!config.USE_REAL_DATA) {
    return state.date.toLocaleDateString('zh-TW', { month: 'long', day: 'numeric', weekday: 'short' });
  }
  if (!state.dataDate) return '日線';           // 舊格式快取,還不知道日期
  const [, m, d] = state.dataDate.split('-');
  const today = new Date().toISOString().slice(0, 10);
  const staleDays = Math.round((new Date(today) - new Date(state.dataDate)) / 86400000);
  // 超過 4 天 = 不只是週末,值得警告(連假或資料源卡住)
  return `${m}/${d} 收盤${staleDays > 4 ? ` · ${staleDays} 天前` : ''}`;
}

// ---- 格式化小工具 ----
// pct:給「漲跌幅」用,會帶 +/- 號(報酬率、損益)
const pct = (x, d = 1) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;
// pctPlain:給「不是漲跌」的比例用,不加正號(勝率、回撤幅度)
// —— 勝率顯示成「+100%」語意是錯的,它不是一個變動量。
const pctPlain = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
const cls = (x) => (x >= 0 ? 'up' : 'down');
const money = (x) => `$${x.toFixed(2)}`;

// =============================================================
// 各分頁渲染
// =============================================================
function renderToday() {
  const s = portfolio.stats();
  const slots = DAILY_MAX - portfolio.positions.length;
  const blocked = state.market && state.market.available && !state.market.riskOn;

  return `
    <section class="summary">
      <div class="summary-row">
        <div class="metric"><span class="metric-label">持倉</span>
          <span class="metric-val mono">${s.open}<span class="slash">/${DAILY_MAX}</span></span></div>
        <div class="metric"><span class="metric-label">未實現均報酬</span>
          <span class="metric-val mono ${cls(s.unrealAvgPct)}">${pct(s.unrealAvgPct)}</span></div>
        <div class="metric"><span class="metric-label">已實現報酬</span>
          <span class="metric-val mono ${cls(s.realizedPct)}">${pct(s.realizedPct)}</span></div>
      </div>
    </section>

    ${marketBanner()}

    <h2 class="block-head"><span class="dot buy"></span>今日精選買進
      <span class="head-note">${
        blocked ? '市場防禦中' : (slots <= 0 ? '已滿倉' : `精選 ${state.buys.length} 檔 · 空位 ${slots}`)
      }</span></h2>
    ${blocked
      ? (state.buys.length
        ? `<p class="empty">市場水位偏高，以下標的雖通過選股門檻，<strong>今日暫停進場</strong>（觀察名單）：</p>
           ${state.buys.map((b) => buyCard(b, true)).join('')}`
        : `<p class="empty">市場防禦中，且今天也沒有通過門檻的標的。<strong>空手。</strong></p>`)
      : `${state.buys.map((b) => buyCard(b, false)).join('')}${buyFooter(slots)}`
    }

    <h2 class="block-head"><span class="dot sell"></span>今日賣出訊號</h2>
    ${state.sells.length === 0
      ? `<p class="empty">現有持倉皆未觸發出場條件，續抱。</p>`
      : state.sells.map(sellCard).join('')}
  `;
}

// AI 水位橫幅
function marketBanner() {
  const m = state.market;
  if (!m || !m.available) return '';
  const statusCls = m.riskOn ? 'riskon' : 'riskoff';
  const label = m.riskOn ? '進場許可' : '防禦 · 暫停進場';
  const volLabel = m.volSource === 'VIX'
    ? `VIX ${m.volValue.toFixed(1)}`
    : `已實現波動 ${(m.volValue * 100).toFixed(0)}%`;
  return `
    <section class="market ${statusCls}">
      <div class="market-head">
        <span class="market-title">◈ AI 水位</span>
        <span class="market-status">${label}</span>
        <span class="market-cash mono">現金 ${m.cashWeight}%</span>
      </div>
      <div class="market-legs">
        <span class="leg ${m.trendDefensive ? 'bad' : 'good'}">趨勢 SPY vs 12M ${m.spyVsSma >= 0 ? '+' : ''}${(m.spyVsSma * 100).toFixed(1)}%</span>
        <span class="leg ${m.volDefensive ? 'bad' : 'good'}">波動 ${volLabel}</span>
      </div>
      ${m.reasons.length ? `<div class="market-reasons">${m.reasons.map((r) => `<span class="tag warn">${r}</span>`).join('')}</div>` : ''}
    </section>`;
}

// 買進區塊下方:說明「為什麼今天只有這幾檔 / 一檔都沒有」——證明是門檻在把關
function buyFooter(slots) {
  if (slots <= 0) {
    return state.buys.length === 0 ? `<p class="empty">已達 6 倉上限，今天不進場。</p>` : '';
  }
  const diag = state.buyDiag && state.buyDiag.topRejected;
  if (state.buys.length === 0) {
    return `<p class="empty">今天沒有通過品質門檻的標的，<strong>空手觀望</strong>（不硬湊）。${
      diag ? `<br>最接近的是 ${diag.symbol}，卡在:${diag.failedOn}。` : ''
    }</p>`;
  }
  // 有推薦、但沒補滿:也說明一下
  return `<p class="empty" style="margin-top:2px">只推「夠強」的，其餘空位寧可留著。${
    diag ? `下一個候選 ${diag.symbol} 卡在:${diag.failedOn}。` : ''
  }</p>`;
}

function buyCard(b, blocked = false) {
  const stopLine = `<div class="levels mono">進場 約$${b.entry.toFixed(2)}　·　停損 $${b.stopPrice.toFixed(2)} (${pct(b.stopPct)})</div>`;
  return `
    <div class="card signal${blocked ? ' dim' : ''}">
      <div class="card-main">
        <div class="ticker mono">${b.symbol}</div>
        <div class="card-sub">${b.name} · ${b.sectorName}</div>
        <div class="reasons">${b.reasons.map((r) => `<span class="tag">${r}</span>`).join('')}</div>
        ${stopLine}
      </div>
      <div class="card-side">
        <div class="price mono">${money(b.price)}</div>
        <div class="score">動能 ${b.score.toFixed(2)}</div>
        ${blocked
          ? `<button class="btn ghost" disabled>觀察中</button>`
          : `<button class="btn buy" data-buy="${b.symbol}">買進</button>`}
      </div>
    </div>`;
}

function sellCard(s) {
  const partial = s.fraction != null && s.fraction < 1;
  return `
    <div class="card signal">
      <div class="card-main">
        <div class="ticker mono">${s.symbol}</div>
        <div class="card-sub">${s.name}</div>
        <div class="reasons">${s.reasons.map((r) => `<span class="tag warn">${r}</span>`).join('')}</div>
      </div>
      <div class="card-side">
        <div class="price mono">${money(s.price)}</div>
        <div class="score ${cls(s.pnlPct)}">${pct(s.pnlPct)}</div>
        <button class="btn ${partial ? 'ghost' : 'sell'}" data-sell="${s.symbol}">${partial ? '減碼' : '賣出'}</button>
      </div>
    </div>`;
}

function addPosForm() {
  if (!showAddPos) {
    return `<button class="btn ghost wide" id="add-pos-toggle" style="margin-top:14px">＋ 手動加入持倉(你自己買的)</button>`;
  }
  const today = new Date().toISOString().slice(0, 10);
  return `
    <div class="addpos">
      <div class="addpos-head">手動加入持倉<span class="head-note">系統會用真實資料算 ATR 停損,之後跟其他持倉一樣給出場建議</span></div>
      <div class="addpos-row">
        <input id="ap-sym" class="ap-in mono" placeholder="代號 例 PLTR" />
        <input id="ap-price" class="ap-in mono" placeholder="你的進場價" inputmode="decimal" />
        <input id="ap-date" class="ap-in mono" type="date" value="${today}" />
      </div>
      <div class="addpos-row">
        <button class="btn buy" id="add-pos-submit">加入</button>
        <button class="btn ghost" id="add-pos-cancel">取消</button>
      </div>
    </div>`;
}

function renderPortfolio() {
  const hasData = portfolio.positions.length > 0 || portfolio.cashLog.length > 0;
  const clearBtn = hasData
    ? `<button class="btn ghost wide" id="clear-records" style="margin-top:18px">🗑 清空所有紀錄(持倉 + 交易)</button>`
    : '';
  if (portfolio.positions.length === 0) {
    return `<p class="empty big">目前空倉。到「今日」分頁依買進訊號建倉，最多 6 檔。</p>${addPosForm()}${clearBtn}`;
  }
  const quoteBy = Object.fromEntries(state.quotes.map((q) => [q.symbol, q]));
  return `
    <h2 class="block-head">現有持倉 <span class="head-note">${portfolio.positions.length}/${DAILY_MAX}</span></h2>
    ${portfolio.positions.map((p) => {
      const q = quoteBy[p.symbol];
      const last = q ? q.price : (p.lastPrice ?? p.entryPrice);
      const pnl = (last - p.entryPrice) / p.entryPrice;
      const secName = p.etf ? (SECTORS.find((x) => x.etf === p.etf)?.name || p.etf) : '自選股';
      const { hardStop, trailStop, effStop } = computeStops(p, DP);
      const maRef = q ? `MA20 $${q.ma20.toFixed(2)} · MA50 $${q.ma50.toFixed(2)}` : '';
      return `
        <div class="card pos">
          <div class="card-main">
            <div class="ticker mono">${p.symbol}</div>
            <div class="card-sub">${p.name} · ${secName}${p.manual ? ' · <span class="mtag">手動</span>' : ''} · 進場 ${p.entryDate} @ $${p.entryPrice.toFixed(2)}${
              (p.size ?? 1) < 0.999 ? ` · <span class="down">剩 ${Math.round((p.size ?? 1) * 100)}%</span>` : ''
            }</div>
            <div class="levels mono">
              停損 $${hardStop.toFixed(2)}　·　移動停利 $${trailStop.toFixed(2)}
              <span class="eff">實際觸發 $${effStop.toFixed(2)}</span>
            </div>
            ${maRef ? `<div class="levels mono muted">${maRef}</div>` : ''}
          </div>
          <div class="card-side">
            <div class="price mono">${money(last)}</div>
            <div class="score ${cls(pnl)}">${pct(pnl)}</div>
            <button class="btn ghost" data-sell="${p.symbol}">平倉</button>
          </div>
        </div>`;
    }).join('')}
    ${addPosForm()}
    ${clearBtn}`;
}

function renderSectors() {
  const max = Math.max(...state.ranked.map((s) => Math.abs(s.score)), 1);
  return `
    <h2 class="block-head">板塊熱度排名 <span class="head-note">前 ${DP.hotSectorCount} 名才選股</span></h2>
    <p class="hint">分數 = 0.5·1M報酬 + 0.3·3M報酬 + 0.2·相對MA50 (標準化後)</p>
    <div class="heat">
      ${state.ranked.map((s) => {
        const w = Math.max(4, (Math.abs(s.score) / max) * 100);
        return `
          <div class="heat-row ${s.hot ? 'hot' : ''}">
            <div class="heat-rank mono">${String(s.rank).padStart(2, '0')}</div>
            <div class="heat-etf mono">${s.etf}</div>
            <div class="heat-name">${s.name}</div>
            <div class="heat-bar-wrap">
              <div class="heat-bar ${cls(s.score)}" style="width:${w}%"></div>
            </div>
            <div class="heat-vals mono ${cls(s.ret1m)}">${pct(s.ret1m)}</div>
          </div>`;
      }).join('')}
    </div>`;
}

let realBtResult = null;  // 真實 16 年回測(綜合)
let realBtRunning = false;
let mcRunning = false;    // 六姿態 Monte Carlo
let mcProgress = '';
let mcResults = null;
let mcError = null;
let mcCoverage = null;    // 六姿態實際跑在幾檔上(長歷史沒抓齊時很重要)

// Monte Carlo 的 bootstrap 次數。單一來源 —— 文案和呼叫點都引用這個常數,
// 免得改了次數卻忘了改畫面上的說明。
//
// 300 -> 1000 的理由:2026 年度健檢連跑兩次,同一份資料的 Calmar 中位數
// 差了約 0.05,而「綜合」的 A/B 差異只有 0.01 —— 比雜訊還小,兩次結論
// 直接翻盤。次數提高可以收斂中位數,代價是耗時約三倍。
const MC_RUNS = 1000;
const MC_BLOCK = 20;
let histMeta = null;      // 長歷史載入狀態
let histLoading = false;
let histProgress = '';
let spySanity = null;     // SPY 長歷史抽樣(驗證用)
function renderPerf() {
  const p = portfolio.perf();
  const s = portfolio.stats();
  if (p.trades === 0) {
    return `<h2 class="block-head">績效 · 資金曲線 <span class="head-note">百分比複利,起點 100</span></h2>
      <p class="empty big">尚無平倉紀錄。<br>到「今日」買進、之後平倉,這裡就會畫出你的資金成長曲線與交易明細。</p>`;
  }
  const nav = p.equity[p.equity.length - 1].nav;
  const g = (label, val, c = '') => `<div class="bt-metric"><span>${label}</span><b class="mono ${c}">${val}</b></div>`;
  return `
    <h2 class="block-head">資金曲線 <span class="head-note">起點 100 · 現在 ${nav.toFixed(1)}</span></h2>
    ${equitySVG(p.equity)}
    <div class="bt-grid">
      ${g('總報酬', pct(p.totalReturn), cls(p.totalReturn))}
      ${g('最大回撤', pctPlain(p.maxDD), 'down')}
      ${g('交易次數', p.trades)}
      ${g('勝率', pctPlain(p.winRate, 0))}
      ${g('平均獲利', pct(p.avgWin), 'up')}
      ${g('平均虧損', pct(p.avgLoss), 'down')}
      ${g('賺賠比', p.payoff.toFixed(2))}
      ${g('獲利因子', p.profitFactor.toFixed(2))}
    </div>
    ${s.open > 0 ? `<p class="hint" style="margin-top:12px">另有 ${s.open} 筆未平倉,未實現均報酬 ${pct(s.unrealAvgPct)}(不計入上方曲線)。</p>` : ''}

    <h2 class="block-head">交易紀錄 <span class="head-note">最新在上</span></h2>
    ${[...portfolio.cashLog].reverse().map(tradeRow).join('')}
  `;
}

// 自選股清理:沒在持倉裡的自選股,從每日抓取清單移除(省 API 額度)
function pruneExtras() {
  const held = new Set(portfolio.positions.map((p) => p.symbol));
  for (const x of getExtras()) if (!held.has(x.symbol)) removeExtraSymbol(x.symbol);
}

// ---- 市場環境戳記(Minervini 心法:記錄「這筆交易是在什麼市場環境下做的」)----
function currentMarketEnv() {
  const m = state.market || {};
  const water = !m.available ? 'NA' : (m.riskOn ? 'ON' : 'DEF');
  const top = state.ranked && state.ranked[0];
  return {
    water,
    top: top ? top.etf : null,
    topName: top ? top.name : null,
    rot: rotationInfo(),
  };
}

// 每日記錄「當天最強板塊」,供輪動速度計算
function logSectorLeader(etf) {
  if (!etf) return;
  const today = new Date().toISOString().slice(0, 10);
  let log;
  try { log = JSON.parse(localStorage.getItem('sd_sector_log') || '[]'); } catch (e) { log = []; }
  if (log.length && log[log.length - 1].date === today) log[log.length - 1].etf = etf;
  else log.push({ date: today, etf });
  if (log.length > 15) log = log.slice(-15);
  try { localStorage.setItem('sd_sector_log', JSON.stringify(log)); } catch (e) { /* ignore */ }
}

// 輪動速度:近 5 個記錄日裡,板塊龍頭出現過幾種(換得越多 = 越像沒主線的震盪盤)
function rotationInfo() {
  let log;
  try { log = JSON.parse(localStorage.getItem('sd_sector_log') || '[]'); } catch (e) { return null; }
  const recent = log.slice(-5);
  if (recent.length < 3) return null; // 資料還不夠
  return { distinct: new Set(recent.map((x) => x.etf)).size, window: recent.length };
}

const WATER_LABEL = { ON: '進場許可', DEF: '防禦', NA: '—' };
function envStamp(env) {
  if (!env) return '';
  const parts = [`環境:${WATER_LABEL[env.water] || '—'}`];
  if (env.topName) parts.push(`龍頭 ${env.topName}`);
  if (env.rot) parts.push(`輪動 ${env.rot.distinct}/${env.rot.window}`);
  return `<span class="trade-env">${parts.join('　·　')}</span>`;
}

function tradeRow(c) {
  const win = c.pnlPct >= 0;
  return `
    <div class="trade ${win ? 'win' : 'loss'}">
      <div class="trade-main">
        <span class="ticker mono">${c.symbol}</span>
        <span class="trade-sub mono">$${c.entryPrice.toFixed(2)} → $${c.exitPrice.toFixed(2)}</span>
        <span class="trade-meta">${c.partial ? `減碼 ${Math.round((c.fraction ?? 1) * 100)}% · ` : ''}${c.reason || ''} · 持有 ${c.holdingDays ?? '?'} 天 · ${c.exitDate}</span>
        ${envStamp(c.entryEnv)}
      </div>
      <div class="trade-pnl mono ${cls(c.pnlPct)}">${pct(c.pnlPct)}</div>
    </div>`;
}

function renderBacktest() {
  return `
    <h2 class="block-head">長歷史資料 <span class="head-note">Tiingo · ${config.HISTORY_YEARS || 16} 年 · 回測用</span></h2>
    <div class="warn-box">這份長歷史只給回測/驗證用,跟你每天的即時選股完全分開,存在瀏覽器 IndexedDB。
      <br>⚠️ universe 是「今天的贏家」,長歷史解決「樣本太短」,但<strong>解決不了生存者偏差</strong>——絕對報酬會偏樂觀,相對排名才可信。</div>
    ${histSection()}

    <h2 class="block-head">真實回測 <span class="head-note">綜合 preset · 16 年 · Calmar ${realBtResult ? realBtResult.metrics.calmar.toFixed(2) : '—'}</span></h2>
    <div class="warn-box">用上方載入的真實 16 年日線跑「綜合」preset:隔日開盤進場、OHLC 真 ATR 停損、市場水位過濾。
      <br>這是<strong>單一 preset</strong> 的驗證。下一步(B)會六姿態一起跑 + Monte Carlo,以 Calmar 排名。</div>
    ${!histMeta
      ? `<p class="empty">請先在上方「載入 16 年長歷史」,才能跑真實回測。</p>`
      : realBtRunning
        ? `<div class="loading" style="padding:32px"><div class="spinner"></div><p class="load-msg">回測 16 年中…</p></div>`
        : `${realBtResult ? backtestMetrics(realBtResult) : ''}
           <button class="btn ghost wide" id="run-real-bt">▶ 用真實 16 年資料回測(綜合)</button>`}

    <h2 class="block-head">六姿態比較 <span class="head-note">Monte Carlo ${MC_RUNS} 次 · Calmar 排名</span></h2>
    <div class="warn-box">六個 preset 各跑<strong>兩次</strong> 16 年真實回測(A:只用 ATR/移動停利 vs B:再加板塊退燒/跌破MA20),各做 ${MC_RUNS} 次 block bootstrap。
      這是要回答:<strong>「板塊退燒」這條規則到底在幫你還是害你?</strong>
      <br>⚠️ 上一輪跑出來 6 個姿態有 5 個 A&gt;B(B 交易次數暴增造成 whipsaw),所以<strong>日常引擎已經把這兩條規則關掉了</strong>
      (見 <code>strategy.js</code> 的 <code>useSignalExits</code>)。這裡重跑是為了在資料變長之後複驗結論。
      <br>看<strong>相對比較</strong>就好,絕對數字仍被生存者偏差灌水。</div>
    ${mcSection()}`;
}

function mcSection() {
  if (!histMeta) return `<p class="empty">請先載入長歷史。</p>`;
  if (mcRunning) {
    return `<div class="loading" style="padding:32px"><div class="spinner"></div><p class="load-msg">${mcProgress}</p></div>`;
  }
  if (mcError) return `<p class="empty">${mcError}</p><button class="btn buy wide" id="run-mc">▶ 重試</button>`;
  if (!mcResults) {
    return `<p class="empty">六姿態 × A/B 各跑一次 + Monte Carlo(12 次回測 × ${MC_RUNS} 次 bootstrap,
      <strong>約 5~8 分鐘</strong>,中途畫面會卡住屬正常 —— 這是同步運算,不是當掉)。</p>
      <button class="btn buy wide" id="run-mc">▶ 跑 A/B 測試(六姿態 × ${MC_RUNS} 次 MC)</button>`;
  }
  // 判定完全交給配對檢定:95% 區間有沒有跨過 0。
  // 跨過 0 = 這個差異可能只是抽樣造成的,不能宣稱誰比較好。
  const 顯著 = (p) => p && (p.lo > 0 || p.hi < 0);
  const 勝方 = (p) => (!顯著(p) ? null : (p.median > 0 ? 'A' : 'B'));

  const fmt = (m) => `${m.median.toFixed(2)}<br><span class="mc-p5">p5 ${m.p5.toFixed(2)}</span>`;
  const pctStr = (x) => `${(x * 100).toFixed(0)}%`;

  const rows = mcResults.map((r, i) => {
    const p = r.paired;
    const w = 勝方(p);
    const 區間 = p
      ? `${p.median >= 0 ? '+' : ''}${p.median.toFixed(2)}<br><span class="mc-p5">[${p.lo.toFixed(2)}, ${p.hi.toFixed(2)}]</span>`
      : '—';
    return `<tr class="${i === 0 ? 'mc-win' : ''}">
      <td class="mono">${i + 1}</td>
      <td>${r.label}${i === 0 ? ' 🏆' : ''}</td>
      <td class="mono">${fmt(r.a.mc.calmar)}</td>
      <td class="mono">${fmt(r.b.mc.calmar)}</td>
      <td class="mono ${w === 'A' ? 'up' : w === 'B' ? 'down' : 'muted'}">${區間}</td>
      <td class="mono ${w ? (w === 'A' ? 'up' : 'down') : 'muted'}">${p ? pctStr(p.pAwins) : '—'}${
        w ? `<br><span class="mc-p5">${w} 較優</span>` : `<br><span class="mc-p5">分不出</span>`}</td>
      <td class="mono">${r.a.single.trades}/${r.b.single.trades}</td>
    </tr>`;
  }).join('');

  // 結論只計入「95% 區間不跨 0」的那些 —— 其餘視為沒有證據,不是平手
  const decisive = mcResults.filter((r) => 顯著(r.paired));
  const aWins = decisive.filter((r) => 勝方(r.paired) === 'A').length;
  const bWins = decisive.length - aWins;
  const noSignal = mcResults.length - decisive.length;

  const verdict = decisive.length === 0
    ? `<strong>六個姿態全部分不出高下</strong> —— 每一組的 95% 區間都跨過 0。
       這種情況下唯一站得住的判準是交易次數:B 組一律多得多,而回測沒扣手續費與滑價。`
    : aWins > bWins
      ? `<strong class="down">板塊退燒/跌破MA20 偏向傷害績效</strong> —— 有統計證據的 ${decisive.length} 個裡,${aWins} 個是 A 較優${noSignal ? `;另有 ${noSignal} 個分不出` : ''}。`
      : bWins > aWins
        ? `<strong class="up">板塊退燒/跌破MA20 偏向有幫助</strong> —— 有統計證據的 ${decisive.length} 個裡,${bWins} 個是 B 較優${noSignal ? `;另有 ${noSignal} 個分不出` : ''}。但仍要看交易次數是否值得。`
        : `A 與 B 各勝 ${aWins} 個${noSignal ? `,另有 ${noSignal} 個分不出` : ''},沒有方向性結論。看交易次數決定。`;

  const comp = mcResults.find((r) => r.key === (config.DAILY_PRESET || 'composite'));
  const cp = comp && comp.paired;
  const compLine = !comp ? '' : `你日常用的「${comp.label}」:交易 ${comp.a.single.trades} vs ${comp.b.single.trades} 筆。
    ${!cp ? '' : 顯著(cp)
      ? `<strong>A−B = ${cp.median >= 0 ? '+' : ''}${cp.median.toFixed(2)},95% 區間 [${cp.lo.toFixed(2)}, ${cp.hi.toFixed(2)}] 不跨 0
         —— ${勝方(cp)} 確實比較好,A 贏的機率 ${pctStr(cp.pAwins)}。</strong>`
      : `<strong>A 贏的機率 ${pctStr(cp.pAwins)},95% 區間 [${cp.lo.toFixed(2)}, ${cp.hi.toFixed(2)}] 跨過 0
         —— 統計上分不出高下。</strong> 這種情況下唯一站得住的判準是交易次數,
         而回測沒扣手續費與滑價 —— 打平的績效配上多 ${Math.round((comp.b.single.trades / comp.a.single.trades - 1) * 100)}% 的交易,只有壞處。`}`;

  const cov = !mcCoverage ? ''
    : mcCoverage.used < mcCoverage.total
      ? `<p class="hint" style="margin:0 0 10px">⚠️ 這六組結果跑在 <strong class="down">${mcCoverage.used}/${mcCoverage.total} 檔</strong>上
         (${mcCoverage.from} ~ ${mcCoverage.to})—— 長歷史沒抓齊,先去上面「只補抓缺少的」再重跑會更可信。</p>`
      : `<p class="hint" style="margin:0 0 10px">參與股票 ${mcCoverage.used}/${mcCoverage.total} 檔 · ${mcCoverage.from} ~ ${mcCoverage.to}</p>`;

  return `
    ${cov}
    <div class="mc-table-wrap"><table class="mc-table">
      <thead><tr>
        <th>#</th><th>姿態</th><th>A<br>ATR/移動停利</th><th>B<br>+板塊退燒</th><th>A−B<br>95% 區間</th><th>A 贏<br>機率</th><th>交易<br>A/B</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="hint" style="margin-top:10px">
      <strong>A / B 欄</strong>:上面是 Calmar 中位數,下面小字是 p5(${MC_RUNS} 次 bootstrap 中最差的 5%)。
      中位數看報酬品質,中位數到 p5 的距離看這個估計有多不穩。
      <br><strong>A−B 欄</strong>:配對抽樣算出的差異中位數與 95% 區間。
      <strong class="down">區間跨過 0 = 統計上分不出高下</strong> —— 那是「沒有證據」,不是「平手」。
      <br><strong>A 贏機率</strong>:${MC_RUNS} 次配對抽樣中 A 較優的比例。接近 50% 就等於擲硬幣。
    </p>
    <div class="warn-box" style="margin-top:10px">
      <strong>為什麼要「配對」:</strong>每一次抽樣,A 和 B 用<strong>同一組區塊</strong> ——
      也就是讓兩者經歷完全相同的市場路徑。共同的大跌大漲在相減時會抵銷掉,
      剩下的才是那兩條出場規則造成的真實差異。
      <br><br>
      如果改用「各自獨立抽樣、再比兩個中位數」,共同衝擊會變成雜訊把差異淹掉。
      2026 年度健檢就是那樣跑的,連跑兩次「綜合」的勝負直接翻盤
      (A 贏 0.01 → B 贏 0.00)—— <strong>那個 0.01 從來就不是訊號</strong>。
      <br><br>
      ⚠️ 但要記得界線:這裡的絕對數字仍然沒扣交易成本,股票池也有生存者偏差。
      <strong>配對檢定讓「A 和 B 誰比較好」變得可信,沒有讓「這套策略會賺多少」變得可信。</strong>
    </div>
    <p class="hint" style="margin-top:12px">
      <strong>A</strong> = 只用 ATR 停損 + 移動停利 —— <strong>這就是你每天在「今日」看到的賣出建議</strong>(16 年回測驗證過的那套)。
      <strong>B</strong> = 再加上「板塊退燒 + 跌破MA20」,目前<strong>日常引擎沒有啟用</strong>。兩者參數完全相同,唯一差別就是這兩條出場規則。
    </p>
    <p class="hint" style="margin-top:8px">${compLine}</p>
    <p class="hint" style="margin-top:8px">結論:${verdict}</p>
    <button class="btn ghost wide" id="run-mc" style="margin-top:12px">↻ 重跑</button>`;
}

function histSection() {
  if (histLoading) {
    return `<div class="loading" style="padding:32px 24px">
      <div class="spinner"></div><p class="load-msg">${histProgress}</p></div>`;
  }
  if (histMeta) {
    const ok = histMeta.symbols.length;
    const total = histMeta.total ?? (UNIVERSE.length + 1);
    const failed = histMeta.failed || [];
    const coverage = total ? ok / total : 0;
    return `
      <div class="bt-grid">
        <div class="bt-metric"><span>涵蓋率</span><b class="mono ${coverage < 0.9 ? 'down' : 'up'}">${ok}/${total} 檔</b></div>
        <div class="bt-metric"><span>載入日期</span><b class="mono">${(histMeta.loadedAt || '').slice(0, 10)}</b></div>
      </div>
      ${coverage < 0.9 ? `<p class="hint" style="margin-top:10px">⚠️ 只有 ${(coverage * 100).toFixed(0)}% 的股票池有長歷史,
        下面的回測就是跑在這 ${ok} 檔上 —— 結論的適用範圍比全池窄,看的時候要記得。</p>` : ''}
      ${spySanity ? `<p class="hint" style="margin-top:12px">SPY 抽樣驗證:${spySanity.n} 根日線 · ${spySanity.from} ~ ${spySanity.to}</p>${equitySVGfromCloses(spySanity.closes)}` : ''}
      ${failed.length
        ? `<p class="empty">這 ${failed.length} 檔 Tiingo 沒回資料(限流或代號不符):${failed.join(', ')}</p>
           <button class="btn buy wide" id="refill-hist">↻ 只補抓缺少的 ${failed.length} 檔</button>`
        : `<p class="hint">全部載入成功 ✓</p>`}
      <button class="btn ghost wide" id="reload-hist">↻ 全部重抓(${total} 檔,約 ${Math.ceil(total * 1.2 / 60)} 分鐘)</button>`;
  }
  return `<p class="empty">尚未載入。按下方一次把 ${config.HISTORY_YEARS || 16} 年日線拉回來
    (${UNIVERSE.length + 1} 檔,約 ${Math.ceil((UNIVERSE.length + 1) * 1.2 / 60)} 分鐘)。</p>
    <button class="btn buy wide" id="load-hist">▶ 載入 ${config.HISTORY_YEARS || 16} 年長歷史</button>`;
}

// 用一組收盤價畫線(SPY 抽樣驗證),跟 equitySVG 同風格
function equitySVGfromCloses(closes) {
  const w = 320, h = 90, n = closes.length;
  const min = Math.min(...closes), max = Math.max(...closes);
  const x = (i) => (i / (n - 1)) * w;
  const y = (v) => h - ((v - min) / (max - min || 1)) * h;
  const d = closes.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return `<svg class="equity" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="${d}" fill="none" stroke="var(--heat)" stroke-width="1.5"/></svg>`;
}

function backtestMetrics(res) {
  const m = res.metrics;
  const g = (label, val, c = '') => `<div class="bt-metric"><span>${label}</span><b class="mono ${c}">${val}</b></div>`;
  const used = res.universeUsed, total = res.universeTotal;
  const partial = used != null && total != null && used < total;
  return `
    ${used != null ? `<p class="hint" style="margin:0 0 8px">
      回測期間 ${res.from} ~ ${res.to} · <strong class="${partial ? 'down' : ''}">參與股票 ${used}/${total} 檔</strong>${
        partial ? ' —— 長歷史沒抓齊,以下數字只代表這 ' + used + ' 檔的表現' : ''
      }</p>` : ''}
    ${equitySVG(res.equity)}
    <div class="bt-grid">
      ${g('總報酬', pct(m.totalReturn), cls(m.totalReturn))}
      ${g('年化 (CAGR)', pct(m.cagr), cls(m.cagr))}
      ${g('最大回撤', pctPlain(m.maxDD), 'down')}
      ${g('夏普', m.sharpe.toFixed(2))}
      ${g('Calmar(報酬/回撤)', m.calmar.toFixed(2))}
      ${g('交易次數', m.trades)}
      ${g('勝率', pctPlain(m.winRate, 0))}
    </div>`;
}

function equitySVG(equity) {
  const navs = equity.map((e) => e.nav);
  const w = 320, h = 90, n = navs.length;
  const min = Math.min(...navs), max = Math.max(...navs);
  const x = (i) => (i / (n - 1)) * w;
  const y = (v) => h - ((v - min) / (max - min || 1)) * h;
  const d = navs.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const up = navs[n - 1] >= navs[0];
  return `<svg class="equity" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="${d}" fill="none" stroke="var(--${up ? 'buy' : 'sell'})" stroke-width="1.5"/>
  </svg>`;
}

// =============================================================
// 主渲染 + 事件
// =============================================================
// ---- 探索:候選驗證器 ----
function renderExplore() {
  const wl = getWatchlist();
  const picksN = state.buys.length, holdN = portfolio.positions.length;
  return `
    <h2 class="block-head">候選驗證器 <span class="head-note">Minervini 趨勢範本 · 硬驗證</span></h2>
    <div class="warn-box">貼代號、<strong>或整段貼文文字</strong>(自動抓 $代號/#代號),或用下方按鈕帶入。用真實資料跑完整 <strong>Minervini 趨勢範本</strong>:多頭排列(價>MA50>MA150>MA200)、距52週高≤25%、相對強度、流動性。這是嚴格的高標準篩,通過的才是 Stage 2 強勢股。</div>
    <div class="quick-fill">
      <button class="btn ghost sm" id="fill-picks">驗證今日精選${picksN ? ` (${picksN})` : ''}</button>
      <button class="btn ghost sm" id="fill-holdings">驗證持倉${holdN ? ` (${holdN})` : ''}</button>
    </div>
    <button class="btn buy wide" id="fetch-movers" style="margin-bottom:12px">▶ 抓今日熱門漲幅榜 → 自動驗證前 12</button>
    <textarea id="cand-input" class="cand-input" placeholder="貼代號或整段貼文,例:&#10;NVDA, AMZN, MU&#10;或「Micron #MU is testing its 50 day EMA…」">${escapeHtml(state.candInput || '')}</textarea>
    <button class="btn buy wide" id="verify-btn">▶ 驗證候選</button>
    ${wl.length ? `<div class="wl"><span class="wl-label">自訂觀察名單</span>${wl.map((s) => `<span class="wl-chip mono">${s}<button data-unwatch="${s}">×</button></span>`).join('')}<button class="btn ghost sm" id="reverify-watch" style="margin-left:auto">↻ 全部重驗 (${wl.length})</button></div>` : ''}
    ${exploreRunning ? `<div class="loading" style="padding:24px"><div class="spinner"></div><p class="load-msg">${exploreProgress}</p></div>` : ''}
    ${exploreResults ? renderExploreResults() : ''}`;
}

function renderExploreResults() {
  const passN = exploreResults.filter((r) => r.pass).length;
  return `
    <h2 class="block-head">驗證結果 <span class="head-note">${passN}/${exploreResults.length} 通過</span></h2>
    ${exploreResults.map((r) => {
      if (r.insufficient) {
        return `<div class="card"><div class="card-main"><div class="ticker mono">${r.symbol}</div>
          <div class="card-sub">資料不足(需 ≥200 日線算 MA200/52週高低)或代號無效</div></div></div>`;
      }
      const badge = r.pass ? `<span class="verdict pass">通過</span>` : `<span class="verdict fail">未通過</span>`;
      const mc = r.marketCap != null ? `　·　市值 $${(r.marketCap / 1e9).toFixed(1)}B` : '';
      const info = `<div class="levels mono muted">VCP ${r.vcp ? '收縮中 ✓' : '—'}　·　距52週高 ${pct(r.pctFrom52wHigh)}　·　RS ${pct(r.rsVsSpy)}${mc}</div>`;
      return `
        <div class="card ${r.pass ? '' : 'dim'}">
          <div class="card-main">
            <div class="ticker mono">${r.symbol} ${badge}</div>
            <div class="reasons">${r.checks.map((c) => `<span class="tag ${c.ok ? 'okc' : 'nok'}">${c.ok ? '✓' : '✗'} ${c.label}</span>`).join('')}</div>
            ${info}
            ${r.pass ? `<div class="levels mono">進場 約$${r.entry.toFixed(2)}　·　停損 $${r.stopPrice.toFixed(2)} (${pct(r.stopPct)})</div>` : ''}
          </div>
          <div class="card-side">
            <div class="price mono">$${r.price.toFixed(2)}</div>
            <div class="score">動能 ${r.score.toFixed(2)}</div>
            ${r.pass ? `<button class="btn buy" data-xbuy="${r.symbol}">買進</button>
            <button class="btn ghost" data-watch="${r.symbol}">★ 觀察</button>` : ''}
          </div>
        </div>`;
    }).join('')}`;
}

function getWatchlist() { try { return JSON.parse(localStorage.getItem('sd_watchlist') || '[]'); } catch (e) { return []; } }
function saveWatch(s) { const w = getWatchlist(); if (!w.includes(s)) { w.push(s); localStorage.setItem('sd_watchlist', JSON.stringify(w)); } render(); }
function removeWatch(s) { localStorage.setItem('sd_watchlist', JSON.stringify(getWatchlist().filter((x) => x !== s))); render(); }
function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

const views = { today: renderToday, portfolio: renderPortfolio, sectors: renderSectors, explore: renderExplore, perf: renderPerf, backtest: renderBacktest };

function render() {
  const view = document.getElementById('view');
  document.querySelectorAll('.tabbar button').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === state.tab));
  document.getElementById('date-label').textContent = dateLabel();

  if (state.error) {
    view.innerHTML = `<div class="warn-box" style="margin-top:24px">
      <strong>讀取失敗</strong><br>${state.error}
      <br><br>檢查:① config.js 的 WORKER_URL 是否填對 ② Worker 是否設好 TD_API_KEY secret
      ③ Twelve Data 額度是否用盡。</div>
      <button class="btn buy wide" id="retry">重試</button>`;
    document.getElementById('retry').onclick = () => { state.error = null; loadData(); };
    return;
  }
  if (state.loading) { renderLoading(); return; }

  view.innerHTML = views[state.tab]();
  bindViewEvents();
}

function renderLoading() {
  document.getElementById('view').innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      <p class="load-msg">${state.loadMsg || '讀取中…'}</p>
    </div>`;
}

function bindViewEvents() {
  document.querySelectorAll('[data-buy]').forEach((el) =>
    el.onclick = async () => {
      const q = state.quotes.find((x) => x.symbol === el.dataset.buy);
      if (!q) { toast(`${el.dataset.buy} 今日無報價,無法建倉`); return; }
      const stopPrice = q.atr
        ? q.price - q.atr * DP.atrStopMult
        : q.price * (1 + DP.stopLossPct);
      const r = portfolio.buy({ symbol: q.symbol, name: q.name, etf: q.etf, price: q.price, stopPrice, atr: q.atr, entryEnv: currentMarketEnv() });
      if (!r.ok) toast(r.msg); else toast(`已買進 ${q.symbol}`);
      await compute(); render();
    });
  document.querySelectorAll('[data-sell]').forEach((el) =>
    el.onclick = async () => {
      const sym = el.dataset.sell;
      const q = state.quotes.find((x) => x.symbol === sym);
      const pos = portfolio.positions.find((p) => p.symbol === sym);
      if (!pos) { toast('未持有此標的'); return; }

      // 今天抓不到這檔的報價(API 失敗 / 代號失效 / 日線不足 63 根)時,
      // 退回「最後已知價」結算,而不是讓整個按鈕丟 TypeError 卡死。
      const stale = !q;
      const price = q ? q.price : (pos.lastPrice ?? pos.entryPrice);
      if (!(price > 0)) { toast(`${sym} 沒有可用價格,無法平倉`); return; }
      const staleNote = stale ? ' · 用最後已知價' : '';

      const sig = state.sells.find((x) => x.symbol === sym);
      const env = currentMarketEnv();
      let r;
      if (sig && sig.fraction != null && sig.fraction < 1) {
        // 階梯停利:部分減碼
        r = portfolio.sellPartial(sym, price, sig.fraction, sig.reasons.join(' / '), sig.ladderIdx, env);
        if (r.ok) toast(`已減碼 ${sym} ${(sig.fraction * 100).toFixed(0)}% (${pct(r.pnlPct)})${staleNote}`);
      } else {
        // 全平(停損/破線/手動)
        const reason = sig ? sig.reasons.join(' / ') : '手動平倉';
        r = portfolio.sell(sym, price, reason, env);
        if (r.ok) toast(`已平倉 ${sym} (${pct(r.pnlPct)})${staleNote}`);
      }
      if (!r.ok) toast(r.msg);
      await compute(); render();
    });
  const apToggle = document.getElementById('add-pos-toggle');
  if (apToggle) apToggle.onclick = () => { showAddPos = true; render(); };
  const apCancel = document.getElementById('add-pos-cancel');
  if (apCancel) apCancel.onclick = () => { showAddPos = false; render(); };
  const apSubmit = document.getElementById('add-pos-submit');
  if (apSubmit) apSubmit.onclick = () => addManualPosition();
  const clearBtn = document.getElementById('clear-records');
  if (clearBtn) clearBtn.onclick = async () => {
    if (!confirm('確定清空所有持倉與交易紀錄?此動作無法復原(不會影響 16 年回測歷史)。')) return;
    portfolio.reset();
    toast('已清空所有紀錄');
    await compute(); render();
  };
  const loadHist = document.getElementById('load-hist');
  if (loadHist) loadHist.onclick = () => loadHistory(false);
  const refillHist = document.getElementById('refill-hist');
  if (refillHist) refillHist.onclick = () => loadHistory(false);   // 續傳:跳過已有的
  const reloadHist = document.getElementById('reload-hist');
  if (reloadHist) reloadHist.onclick = () => {
    if (!confirm('全部重抓會把已經載入的也重新拉一遍,耗時較久也會消耗 Tiingo 額度。\n只是要補齊缺少的檔案,請用「只補抓缺少的」。\n\n確定要全部重抓?')) return;
    loadHistory(true);
  };
  const runReal = document.getElementById('run-real-bt');
  if (runReal) runReal.onclick = async () => {
    realBtRunning = true; render();
    realBtResult = await runRealBacktestFromDB('composite');
    realBtRunning = false; render();
  };
  const runMc = document.getElementById('run-mc');
  if (runMc) runMc.onclick = () => runAllPresetsMC();
  const verifyBtn = document.getElementById('verify-btn');
  if (verifyBtn) verifyBtn.onclick = () => verifyCandidates();
  const fillPicks = document.getElementById('fill-picks');
  if (fillPicks) fillPicks.onclick = () => {
    const t = state.buys.map((b) => b.symbol);
    if (!t.length) { toast('今日沒有精選(空手或市場防禦)'); return; }
    verifyCandidates(t);
  };
  const fillHold = document.getElementById('fill-holdings');
  if (fillHold) fillHold.onclick = () => {
    const t = portfolio.positions.map((p) => p.symbol);
    if (!t.length) { toast('目前無持倉'); return; }
    verifyCandidates(t);
  };
  const fillWatch = document.getElementById('reverify-watch');
  if (fillWatch) fillWatch.onclick = () => {
    const t = getWatchlist();
    if (!t.length) { toast('觀察名單是空的'); return; }
    verifyCandidates(t);
  };
  document.querySelectorAll('[data-xbuy]').forEach((el) => el.onclick = async () => {
    const sym = el.dataset.xbuy;
    const r = exploreResults && exploreResults.find((x) => x.symbol === sym);
    if (!r || !r.pass) return;
    const u = UNIVERSE.find((x) => x.symbol === sym);   // 在 universe 裡就沿用它的板塊
    const res = portfolio.buy({
      symbol: sym, name: u ? u.name : sym, etf: u ? u.etf : null,
      price: r.entry, stopPrice: r.stopPrice, atr: r.atr,
      entryEnv: currentMarketEnv(),
    });
    if (!res.ok) { toast(res.msg); return; }
    if (!u) {
      // 自選股:登記進每日抓取清單,並把剛抓到的日線直接餵進快取(免再打 API)
      addExtraSymbol(sym, sym);
      adapter.seedSeries(sym, exploreBars[sym]);
    }
    toast(`已買進 ${sym}${u ? '' : '(自選股)'}`);
    state.tab = 'portfolio';
    await compute(); render();
  });
  document.querySelectorAll('[data-watch]').forEach((el) => el.onclick = () => saveWatch(el.dataset.watch));
  document.querySelectorAll('[data-unwatch]').forEach((el) => el.onclick = () => removeWatch(el.dataset.unwatch));
  const fetchMoversBtn = document.getElementById('fetch-movers');
  if (fetchMoversBtn) fetchMoversBtn.onclick = async () => {
    try {
      toast('抓取今日熱門漲幅榜(FMP)…');
      const movers = await fetchMovers('gainers');
      if (!movers.length) { toast('沒抓到熱門(檢查 Worker 的 FMP_API_KEY)'); return; }
      const clean = filterMovers(movers);
      if (!clean.length) { toast(`抓到 ${movers.length} 檔,但都是水餃股/槓桿ETF,已全濾掉`); return; }
      const top = clean.slice(0, 12).map((m) => m.symbol);
      toast(`抓到 ${movers.length} 檔 → 濾掉垃圾剩 ${clean.length} → 驗證前 ${top.length}…`);
      await verifyCandidates(top);
    } catch (e) { toast('熱門榜失敗:' + (e.message || e)); }
  };
}

// ---- 手動加入持倉(你自己在外面買的股票,一樣納入出場建議)----
async function addManualPosition() {
  const sym = (document.getElementById('ap-sym')?.value || '').trim().toUpperCase();
  const priceRaw = (document.getElementById('ap-price')?.value || '').trim();
  const date = (document.getElementById('ap-date')?.value || '').trim() || null;
  const entryPrice = parseFloat(priceRaw);

  if (!/^[A-Z.]{1,6}$/.test(sym)) { toast('請輸入有效代號'); return; }
  if (!(entryPrice > 0)) { toast('請輸入你的進場價'); return; }
  if (portfolio.has(sym)) { toast('已持有此標的'); return; }
  if (portfolio.isFull()) { toast(`已達 ${DAILY_MAX} 倉上限`); return; }
  if (!config.WORKER_URL) { toast('尚未設定 Worker 網址'); return; }

  toast(`讀取 ${sym} 資料…`);
  try {
    const bars = await fetchCandidates([sym]);
    const m = quoteMetrics(bars[sym]);
    if (!m) { toast(`${sym} 資料不足或代號無效`); return; }

    // 停損用「你的進場價」算,不是現價
    const stopPrice = m.atr ? entryPrice - m.atr * DP.atrStopMult : entryPrice * (1 + DP.stopLossPct);
    const u = UNIVERSE.find((x) => x.symbol === sym);
    const r = portfolio.buy({
      symbol: sym, name: u ? u.name : sym, etf: u ? u.etf : null,
      price: entryPrice, stopPrice, atr: m.atr,
      entryEnv: currentMarketEnv(), entryDate: date, manual: true,
    });
    if (!r.ok) { toast(r.msg); return; }
    if (!u) { addExtraSymbol(sym, sym); adapter.seedSeries(sym, bars[sym]); }
    showAddPos = false;
    toast(`已加入 ${sym} @ $${entryPrice.toFixed(2)}`);
    await compute(); render();
  } catch (e) {
    toast('讀取失敗:' + (e.message || e));
  }
}

// 抓 FMP 市值(透過 Worker),回 {SYM: marketCap}
async function fetchMarketCaps(tickers) {
  try {
    const u = `${config.WORKER_URL.replace(/\/$/, '')}/marketcap?symbols=${encodeURIComponent(tickers.join(','))}`;
    const r = await fetch(u);
    const d = await r.json();
    return d.marketCaps || {};
  } catch (e) { return {}; }
}

// 抓 FMP 熱門漲幅榜(透過 Worker),回 [{symbol,name,price,changePct}]
async function fetchMovers(type = 'gainers') {
  const u = `${config.WORKER_URL.replace(/\/$/, '')}/movers?type=${type}`;
  const r = await fetch(u);
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.movers || [];
}

// 前置過濾:濾掉水餃股、槓桿/反向 ETF、SPAC/認股權/單位(留下像樣的正常股票)
// 門檻可調:MIN_PRICE 是「像樣股價」下限。
function filterMovers(movers, minPrice = 10) {
  const JUNK = /(\b(2x|3x|daily|leverage|leveraged|direxion|proshares|granite|inverse|etf|etn|bull|bear)\b)|(\b(rights?|warrants?|units?)\b)|(acquisition corp)/i;
  return movers.filter((m) =>
    (m.price || 0) >= minPrice &&              // 去水餃股
    !JUNK.test(m.name || '') &&                // 去槓桿/反向 ETF、SPAC、認股權
    /^[A-Z]{1,5}$/.test(m.symbol || '')        // 只留正常股票代號
  );
}

// 抓任意代號的日線(候選驗證器用),回 {SYM: bars[]}
async function fetchCandidates(tickers) {
  const barsBySym = {};
  const BATCH = config.BATCH_SIZE || 8, GAP = config.BATCH_GAP_MS || 0;
  for (let i = 0; i < tickers.length; i += BATCH) {
    const batch = tickers.slice(i, i + BATCH);
    exploreProgress = `讀取 ${batch.join(', ')} …`; render();
    const u = `${config.WORKER_URL.replace(/\/$/, '')}/timeseries?symbols=${encodeURIComponent(batch.join(','))}&outputsize=${config.OUTPUT_SIZE}`;
    const r = await fetch(u);
    const d = await r.json();
    if (d.error) throw new Error(d.message || d.error);
    for (const s of batch) {
      const node = d[s] || d[s.toUpperCase()];
      const values = (node && node.values) || [];
      barsBySym[s] = values
        .map((v) => ({
          d: (v.datetime || '').slice(0, 10),
          h: parseFloat(v.high), l: parseFloat(v.low), c: parseFloat(v.close), v: parseFloat(v.volume),
        }))
        .filter((b) => !isNaN(b.c) && !isNaN(b.h) && !isNaN(b.l));
    }
    if (i + BATCH < tickers.length && GAP > 0) { exploreProgress = '等待額度重置…'; render(); await sleep(GAP); }
  }
  return barsBySym;
}

async function verifyCandidates(explicit) {
  let tickers;
  if (explicit && explicit.length) {
    tickers = [...new Set(explicit.map((t) => t.toUpperCase()))].slice(0, 24);
    state.candInput = tickers.join(', ');
  } else {
    const el = document.getElementById('cand-input');
    const raw = el ? el.value : '';
    state.candInput = raw;
    tickers = extractTickers(raw).slice(0, 24);
  }
  if (!tickers.length) { toast('沒抓到代號(試試貼含 $XXX 或 #XXX 的文字)'); return; }
  if (!config.WORKER_URL) { toast('尚未設定 Worker 網址'); return; }
  exploreRunning = true; exploreResults = null; render();
  try {
    // 取 SPY 6 個月報酬,供相對強度(RS)比較
    let spyRet6m = 0;
    try {
      const mkt = await adapter.getMarketSeries();
      const spy = mkt.spy || [];
      if (spy.length > 126) spyRet6m = (spy[spy.length - 1] - spy[spy.length - 1 - 126]) / spy[spy.length - 1 - 126];
    } catch (e) { /* 無 SPY 時 RS 用 0 基準 */ }

    const bars = await fetchCandidates(tickers);
    exploreBars = bars;
    const caps = await fetchMarketCaps(tickers);   // FMP 免費市值
    const results = tickers.map((t) => {
      const m = quoteMetrics(bars[t]);
      if (!m) return { symbol: t, insufficient: true };
      const v = verifyTrendTemplate({ symbol: t, ...m, marketCap: caps[t] }, { spyRet6m }, DP);
      return { symbol: t, price: m.price, ...v };
    });
    results.sort((a, b) => (b.pass ? 1 : 0) - (a.pass ? 1 : 0) || (b.score ?? -9) - (a.score ?? -9));
    exploreResults = results;
  } catch (e) {
    toast('讀取失敗:' + (e.message || e));
  }
  exploreRunning = false; render();
}

// 從任意貼文文字抽出股票代號:優先 $代號 / #代號;沒有才退回大寫詞(去雜訊)
function extractTickers(text) {
  const tagged = [...text.matchAll(/[$#]([A-Za-z]{1,5})\b/g)].map((m) => m[1].toUpperCase());
  if (tagged.length) return [...new Set(tagged)];
  const STOP = new Set(['A','I','THE','AND','OR','IS','IT','ITS','TO','OF','IN','ON','AT','FOR','DAY','EMA','SMA','MA','RSI','ATR','IPO','CEO','CFO','ETF','AI','USD','US','EU','UK','NEW','BUY','SELL','HOLD','LOG','PE','PB','EPS','YOY','QOQ','YTD','ATH','ATL','Q1','Q2','Q3','Q4','FY','GDP','CPI','FED','ROE','ROI']);
  const toks = [...text.matchAll(/\b([A-Z]{1,5})\b/g)].map((m) => m[1]).filter((t) => !STOP.has(t));
  return [...new Set(toks)];
}

// 從 IndexedDB 一次讀齊所有 bars
async function loadAllBarsFromDB() {
  const symbols = [...UNIVERSE.map((u) => u.symbol), 'SPY'];
  const barsBySymbol = {};
  for (const s of symbols) {
    const b = await getBars(s);
    if (b && b.length) barsBySymbol[s] = b;
  }
  return barsBySymbol;
}

// 從 IndexedDB 讀真實長歷史,跑指定 preset 的回測
async function runRealBacktestFromDB(presetKey) {
  const barsBySymbol = await loadAllBarsFromDB();
  if (!barsBySymbol['SPY']) return null;
  const P = PRESETS[presetKey];
  return runRealBacktest({ barsBySymbol, params: P.params, market: P.market });
}

// 六姿態 + Monte Carlo
//
// ⚠️ 整段包在 try/catch 裡是必要的,不是防禦性習慣:
//    這是一段跑 1~2 分鐘的長流程,中間任何一步拋錯,mcRunning 就會永遠
//    停在 true —— 使用者盯著一個永遠不會停的轉圈,而且沒有任何錯誤訊息,
//    連「它是不是還在跑」都無從判斷。失敗要看得見,而且要能重試。
async function runAllPresetsMC() {
  mcRunning = true; mcError = null; mcResults = null; mcProgress = '讀取歷史資料…'; render();
  try {
    await runAllPresetsMCInner();
  } catch (e) {
    mcError = `回測中途失敗:${e && e.message ? e.message : e}。` +
      '(長歷史可能不完整,或某個 preset 的資料有問題。可按重試;仍失敗請看瀏覽器 Console。)';
    console.error('runAllPresetsMC 失敗', e);
  } finally {
    // 不論成功、失敗、或中途拋錯,轉圈一定要停
    mcRunning = false;
    render();
  }
}

async function runAllPresetsMCInner() {
  await sleep(30);
  const barsBySymbol = await loadAllBarsFromDB();
  if (!barsBySymbol['SPY']) { mcError = '找不到 SPY 歷史,請先載入長歷史。'; return; }

  const results = [];
  for (const key of PRESET_ORDER) {
    const P = PRESETS[key];
    // A/B:同一組參數跑兩次,唯一差別是「有沒有板塊退燒 + 跌破MA20 出場」
    mcProgress = `${P.label} … 回測 A/B 兩組 (${results.length + 1}/6)`;
    render(); await sleep(30);
    const btA = runRealBacktest({ barsBySymbol, params: P.params, market: P.market, useSignalExits: false });
    if (!btA) throw new Error(`${P.label} 的 A 組回測沒有結果(歷史資料可能太短)`);
    const btB = runRealBacktest({ barsBySymbol, params: P.params, market: P.market, useSignalExits: true });
    if (!btB) throw new Error(`${P.label} 的 B 組回測沒有結果(歷史資料可能太短)`);
    await sleep(0);

    // 配對抽樣:一次跑完,同時得到 A、B 各自的分佈與 A−B 的分佈
    mcProgress = `${P.label} … 配對 bootstrap ${MC_RUNS} 次 (${results.length + 1}/6)`;
    render(); await sleep(30);
    const pm = pairedMonteCarlo(btA.dailyReturns, btB.dailyReturns, MC_RUNS, MC_BLOCK);
    await sleep(0);

    mcCoverage = { used: btA.universeUsed, total: btA.universeTotal, from: btA.from, to: btA.to };
    results.push({
      key, label: P.label,
      a: { single: btA.metrics, mc: pm.a },   // 已驗證過的那套(只有 ATR/移動停利)
      b: { single: btB.metrics, mc: pm.b },   // 加上板塊退燒/跌破MA20 的對照組
      paired: pm.paired,                      // A−B 的分佈 + A 贏的機率
    });
  }
  // 以 A(已驗證基準)的 Calmar 中位排名
  results.sort((x, y) => (y.a.mc?.calmar.median ?? -99) - (x.a.mc?.calmar.median ?? -99));
  mcResults = results;
  // mcRunning / render 交給外層的 finally 統一負責,生命週期只有一個出口
}

// =============================================================
// pairedMonteCarlo — 配對 block bootstrap
// -------------------------------------------------------------
// 一次抽樣,同時得到 A 的分佈、B 的分佈,以及「A−B」的分佈。
//
// 關鍵在「配對」:每一輪抽出的區塊起點 A 和 B 共用。
// 因為 A/B 是同一段日曆、同一批股票、只差兩條出場規則,共用區塊等於
// 讓兩者經歷完全相同的市場路徑 —— 共同的大跌大漲會在相減時抵銷掉。
//
// 為什麼一定要這樣做:
//   2026 年度健檢用「各自獨立抽樣、比兩個中位數」的方式跑了兩次,
//   「綜合」的勝負直接翻盤(A 贏 0.01 → B 贏 0.00)。原因是真實差異
//   只有 0.01,卻被各自 ±0.05 的抽樣雜訊淹沒。
//   「兩個獨立估計值誰比較大」本來就不是統計檢定;配對之後才問得出
//   「A 贏的機率是多少」這種可以直接下判斷的問題。
//
// 順帶:這樣做比原本「跑兩次獨立 monteCarlo」還省 —— 抽樣次數一樣,
// 但多拿到差異的分佈。
// =============================================================
function pairedMonteCarlo(retsA, retsB, runs = MC_RUNS, blockSize = MC_BLOCK) {
  const empty = { calmar: { median: 0, p5: 0 }, cagr: { median: 0, p5: 0 }, maxdd: { median: 0, worst: 0 }, sharpe: { median: 0 } };
  // 兩邊都是從 warmup 跑到同一個日曆末端,長度本來就該一樣;
  // 取 min 只是防呆,避免哪天改了 warmup 邏輯就悄悄錯位。
  const n = Math.min(retsA.length, retsB.length);
  if (n < blockSize * 3) return { a: empty, b: empty, paired: null };

  const nBlocks = Math.ceil(n / blockSize);
  const years = n / 252;

  // 給定一組區塊起點,算出這條重組序列的各項指標
  const statsFor = (rets, starts) => {
    let nav = 1, peak = 1, maxDD = 0, sum = 0, sumSq = 0, count = 0;
    for (const s of starts) {
      for (let k = 0; k < blockSize && count < n; k++, count++) {
        const x = rets[s + k];
        nav *= (1 + x);
        if (nav > peak) peak = nav;
        const dd = nav / peak - 1;
        if (dd < maxDD) maxDD = dd;
        sum += x; sumSq += x * x;
      }
      if (count >= n) break;
    }
    const mean = sum / count;
    const sd = Math.sqrt(Math.max(0, sumSq / count - mean * mean)) || 1e-9;
    const cagr = Math.pow(Math.max(nav, 1e-9), 1 / years) - 1;
    return { cagr, maxDD, sharpe: (mean / sd) * Math.sqrt(252), calmar: maxDD !== 0 ? cagr / Math.abs(maxDD) : 0 };
  };

  const A = { calmars: [], cagrs: [], maxdds: [], sharpes: [] };
  const B = { calmars: [], cagrs: [], maxdds: [], sharpes: [] };
  const diffs = [];
  let aWins = 0;

  for (let r = 0; r < runs; r++) {
    // ★ 同一組起點,A 和 B 共用 —— 這一行就是「配對」的全部意義
    const starts = [];
    for (let b = 0; b < nBlocks; b++) starts.push(Math.floor(Math.random() * (n - blockSize)));

    const sa = statsFor(retsA, starts);
    const sb = statsFor(retsB, starts);
    A.calmars.push(sa.calmar); A.cagrs.push(sa.cagr); A.maxdds.push(sa.maxDD); A.sharpes.push(sa.sharpe);
    B.calmars.push(sb.calmar); B.cagrs.push(sb.cagr); B.maxdds.push(sb.maxDD); B.sharpes.push(sb.sharpe);

    const d = sa.calmar - sb.calmar;   // 正 = 這一輪 A 較優
    diffs.push(d);
    if (d > 0) aWins++;
  }

  const q = (arr, p) => { const s = [...arr].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
  const pack = (S) => ({
    calmar: { median: q(S.calmars, 0.5), p5: q(S.calmars, 0.05) },
    cagr: { median: q(S.cagrs, 0.5), p5: q(S.cagrs, 0.05) },
    maxdd: { median: q(S.maxdds, 0.5), worst: q(S.maxdds, 0.05) },
    sharpe: { median: q(S.sharpes, 0.5) },
  });

  return {
    a: pack(A),
    b: pack(B),
    paired: {
      pAwins: aWins / runs,        // A 贏的機率 —— 可以直接下判斷的數字
      median: q(diffs, 0.5),       // A−B 的中位數
      lo: q(diffs, 0.025),         // 95% 區間下緣
      hi: q(diffs, 0.975),         // 95% 區間上緣。區間跨過 0 = 分不出高下
      runs,
    },
  };
}

// ---- 載入長歷史(Tiingo via Worker /history)存 IndexedDB ----
//
// force = false(預設,「補抓缺少的」):跳過 IndexedDB 裡已經有的,只補失敗那些。
// force = true (「全部重抓」):不管有沒有,整批重來(年度健檢要更新資料時用)。
//
// 為什麼要有續傳:每日報價的載入本來就有續傳,長歷史卻沒有 —— 以前只要
// 有 N 檔失敗,按「重新載入」會連已經成功的也全部重抓,再撞一次同樣的
// 額度上限,於是那些檔案永遠補不起來。這個不對稱就是元凶。
async function loadHistory(force = false) {
  histLoading = true; histProgress = '準備載入…'; render();
  const symbols = [...UNIVERSE.map((u) => u.symbol), 'SPY'];

  // 先看看 IndexedDB 裡已經有哪些(>200 根才算數,跟寫入時的門檻一致)
  const have = new Set();
  if (!force) {
    for (const sym of symbols) {
      try { const b = await getBars(sym); if (b && b.length > 200) have.add(sym); } catch (e) { /* 當成沒有 */ }
    }
  }
  const todo = symbols.filter((s) => !have.has(s));
  if (todo.length === 0) {
    histProgress = ''; histLoading = false;
    toast(`${symbols.length} 檔都已載入,沒有需要補的`);
    render();
    return;
  }

  // 「本來就已經有幾檔」要在迴圈開始前定住。
  // 直接用 have.size 的話,第一檔抓成功後 have 就變非空,首次完整載入
  // 會從「讀取」莫名其妙變成「補抓」—— 實際跑起來看到才發現。
  const alreadyHad = have.size;

  const failed = [];
  let done = 0;
  for (const sym of todo) {
    histProgress = alreadyHad
      ? `補抓 ${sym} … (${done}/${todo.length},原有 ${alreadyHad} 檔)`
      : `讀取 ${sym} … (${done}/${todo.length})`;
    render();
    try {
      const u = `${config.WORKER_URL.replace(/\/$/, '')}/history?symbol=${sym}&years=${config.HISTORY_YEARS || 16}`;
      const r = await fetch(u);
      const d = await r.json();
      if (d.bars && d.bars.length > 200) { await putBars(sym, d.bars); have.add(sym); }
      else failed.push(sym);
    } catch (e) { failed.push(sym); }
    done++;
    await sleep(1200); // 對 Tiingo 客氣,避免限流
  }
  histMeta = {
    loadedAt: new Date().toISOString(),
    total: symbols.length,
    symbols: symbols.filter((s) => have.has(s)),
    failed, years: config.HISTORY_YEARS,
  };
  await putMeta(histMeta);
  await buildSpySanity();
  histLoading = false; render();
}

async function buildSpySanity() {
  try {
    const bars = await getBars('SPY');
    if (bars && bars.length) {
      const step = Math.max(1, Math.floor(bars.length / 300));
      const closes = bars.filter((_, i) => i % step === 0).map((b) => b.c);
      spySanity = { n: bars.length, from: bars[0].d, to: bars[bars.length - 1].d, closes };
    }
  } catch (e) { /* ignore */ }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 簡易 toast
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

// ---- 啟動 ----
async function init() {
  // 分頁切換
  document.querySelectorAll('.tabbar button').forEach((b) =>
    b.onclick = () => { state.tab = b.dataset.tab; render(); });

  const btn = document.getElementById('next-day');
  if (config.USE_REAL_DATA) {
    // 真實模式:按鈕 = 強制重抓今天的最新股價
    btn.textContent = '↻ 更新';
    btn.onclick = () => {
      if (adapter.forceRefresh) adapter.forceRefresh();
      toast('重新讀取最新股價…');
      loadData();
    };
  } else {
    // 模擬模式:按鈕 = 推進到下一個交易日
    btn.onclick = async () => {
      adapter.advanceDay();
      state.date = new Date(state.date.getTime() + 86400000);
      await compute(); render();
      toast('已更新到下一交易日');
    };
  }

  await loadData();

  // 還原長歷史載入狀態(不阻塞畫面)
  getMeta().then(async (m) => {
    if (m) { histMeta = m; await buildSpySanity(); if (state.tab === 'backtest') render(); }
  }).catch(() => {});
}

// 讀資料(含進度)+ 計算 + 渲染
async function loadData() {
  try {
    state.error = null;
    state.loading = true; state.loadMsg = '準備讀取…'; render();

    if (adapter.ensureLoaded) {
      await adapter.ensureLoaded((done, total, phase) => {
        state.loadMsg = phase === 'waiting'
          ? `已讀取 ${done}/${total} 檔 · 等待額度重置(免費層每分鐘 8 檔)…`
          : `讀取真實股價 ${done}/${total} 檔…`;
        renderLoading();
      });
    }
    await compute();
    state.loading = false;
    render();
  } catch (e) {
    state.loading = false;
    state.error = e.message || String(e);
    render();
  }
}

document.addEventListener('DOMContentLoaded', init);

// 註冊 Service Worker (PWA 離線能力)
//
// updateViaCache: 'none' —— 強制瀏覽器每次都從網路取 sw.js,不吃 HTTP 快取。
// 為什麼需要:GitHub Pages 對 sw.js 送 `Cache-Control: max-age=600`,
// 所以瀏覽器最多會拿 10 分鐘前的舊 sw.js,導致「版本已經 bump 了、
// 但瀏覽器根本還沒發現」的靜默空窗——你在手機上看到的可能是舊策略算出來的訊號。
// 加上 sw.js 裡本來就有的 skipWaiting() + clients.claim(),
// 部署後重開 App 就會是最新版,不用再手動 Unregister。
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () =>
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => {}));
}
