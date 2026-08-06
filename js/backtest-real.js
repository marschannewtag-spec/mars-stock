// =============================================================
// backtest-real.js — 真實 16 年資料回測引擎(需求 2/5)
// -------------------------------------------------------------
// 事件驅動,吃 IndexedDB 來的真實 OHLC:
//   • 隔日開盤進場(訊號收盤算,隔天 open 成交 -> 避免 look-ahead)
//   • OHLC 真 ATR 停損:當日 low 觸及停損 -> 以 min(open, 停損) 出場(處理跳空)
//   • 移動停利:自持倉最高點回落
//   • 市場水位:SPY 12M 均線 + 已實現波動,防禦時暫停進場
//   • 板塊排名:用成分股平均(免抓 11 檔 ETF 歷史,省 Tiingo 額度)
//   • 帳戶:現金會計,等權 1/maxPositions,起點 NAV=100
// =============================================================

import { SECTORS, UNIVERSE } from './data.js';
import { rankSectors } from './sectors.js';
import { generateBuys, computeStops, MAX_POSITIONS } from './strategy.js';
import { computeMarketGate } from './market.js';
import { computeMetrics } from './backtest.js';

const UNI = Object.fromEntries(UNIVERSE.map((u) => [u.symbol, u]));

// 預算每檔的滾動指標(index 對應該檔自己的 bar)
function precompute(bars) {
  const n = bars.length, c = bars.map((b) => b.c);
  const ma20 = [], ma50 = [], relMA20 = [], relMA50 = [], ret1m = [], ret3m = [], atrArr = [];
  let s20 = 0, s50 = 0;
  for (let i = 0; i < n; i++) {
    s20 += c[i]; if (i >= 20) s20 -= c[i - 20];
    s50 += c[i]; if (i >= 50) s50 -= c[i - 50];
    const m20 = s20 / Math.min(i + 1, 20), m50 = s50 / Math.min(i + 1, 50);
    ma20[i] = m20; ma50[i] = m50;
    relMA20[i] = (c[i] - m20) / m20; relMA50[i] = (c[i] - m50) / m50;
    ret1m[i] = i >= 21 ? (c[i] - c[i - 21]) / c[i - 21] : 0;
    ret3m[i] = i >= 63 ? (c[i] - c[i - 63]) / c[i - 63] : 0;
  }
  // Wilder ATR(逐 index)
  const tr = [0], P = 14;
  for (let i = 1; i < n; i++) {
    const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  let a = null;
  for (let i = 0; i < n; i++) {
    if (i < P) { atrArr[i] = null; continue; }
    if (i === P) a = tr.slice(1, P + 1).reduce((x, y) => x + y, 0) / P;
    else a = (a * (P - 1) + tr[i]) / P;
    atrArr[i] = a;
  }
  return { ma20, ma50, relMA20, relMA50, ret1m, ret3m, atr: atrArr };
}

function navNow(cash, positions, barsBySymbol, idx, date) {
  let v = cash;
  for (const p of positions) {
    const j = idx[p.symbol][date];
    if (j == null) continue;
    v += p.shares * barsBySymbol[p.symbol][j].c;
  }
  return v;
}

// 主函式
export function runRealBacktest({ barsBySymbol, params, market, rebalanceEvery = 5, warmup = 63, useSignalExits = false }) {
  const maxPos = params.maxPositions ?? MAX_POSITIONS;
  const spyBars = barsBySymbol['SPY'] || [];
  const cal = spyBars.map((b) => b.d);          // 主行事曆 = SPY 交易日
  if (cal.length < warmup + 50) return null;

  // 只用有足夠歷史的股票
  const symbols = UNIVERSE.map((u) => u.symbol).filter((s) => (barsBySymbol[s] || []).length > warmup);
  const idx = {}, ind = {};
  for (const s of symbols) {
    const bars = barsBySymbol[s];
    const dm = {}; bars.forEach((b, i) => { dm[b.d] = i; });
    idx[s] = dm; ind[s] = precompute(bars);
  }
  const spyClose = spyBars.map((b) => b.c);
  const spyDate = {}; spyBars.forEach((b, i) => { spyDate[b.d] = i; });

  let cash = 100;
  const positions = [];      // {symbol, etf, shares, entryPrice, peakPrice, stopPrice, atr}
  const equity = [], trades = [];
  let pendingBuys = [];
  let pendingExits = [];     // 訊號出場(板塊退燒/跌破MA20)-> 隔日開盤成交

  for (let t = warmup; t < cal.length; t++) {
    const date = cal[t];

    // 1a) 開盤先執行昨日的訊號出場(隔日開盤成交,與進場同規矩)
    for (const ex of pendingExits) {
      const pi = positions.findIndex((p) => p.symbol === ex.symbol);
      if (pi < 0) continue;
      const j = idx[ex.symbol] && idx[ex.symbol][date];
      if (j == null) continue;
      const openP = barsBySymbol[ex.symbol][j].o;
      if (!openP || openP <= 0) continue;
      const p = positions[pi];
      cash += p.shares * openP;
      trades.push({
        symbol: p.symbol, pnlPct: (openP - p.entryPrice) / p.entryPrice,
        reason: ex.reason, exitDate: date,
      });
      positions.splice(pi, 1);
    }
    pendingExits = [];

    // 1b) 開盤成交昨日排定的買單
    for (const b of pendingBuys) {
      if (positions.length >= maxPos) break;
      const j = idx[b.symbol] && idx[b.symbol][date];
      if (j == null) continue;
      if (positions.some((p) => p.symbol === b.symbol)) continue;
      const openP = barsBySymbol[b.symbol][j].o;
      if (!openP || openP <= 0) continue;
      const nav = navNow(cash, positions, barsBySymbol, idx, date);
      const alloc = Math.min(nav / maxPos, cash);
      if (alloc <= 0) continue;
      const a = ind[b.symbol].atr[j];
      cash -= alloc;
      positions.push({
        symbol: b.symbol, etf: UNI[b.symbol].etf, shares: alloc / openP,
        entryPrice: openP, peakPrice: openP, atr: a,
        stopPrice: a ? openP - a * params.atrStopMult : openP * (1 + params.stopLossPct),
      });
    }
    pendingBuys = [];

    // 2) 盤中出場(用當日 OHLC)
    for (let pi = positions.length - 1; pi >= 0; pi--) {
      const p = positions[pi];
      const j = idx[p.symbol][date];
      if (j == null) continue;
      const bar = barsBySymbol[p.symbol][j];
      p.peakPrice = Math.max(p.peakPrice, bar.h);
      const { hardStop, trailStop } = computeStops(p, params);
      const effStop = Math.max(hardStop, trailStop);
      if (bar.l <= effStop) {
        const exitP = Math.min(bar.o, effStop);   // 跳空開低就以開盤出
        cash += p.shares * exitP;
        trades.push({
          symbol: p.symbol, pnlPct: (exitP - p.entryPrice) / p.entryPrice,
          reason: hardStop >= trailStop ? '停損' : '移動停利', exitDate: date,
        });
        positions.splice(pi, 1);
      }
    }

    // 3) 收盤記 NAV
    equity.push({ date, nav: navNow(cash, positions, barsBySymbol, idx, date) });

    // 4) 收盤後:訊號出場判定 + 換倉選股(共用同一份 quotes/ranked)
    const isRebalance = (t - warmup) % rebalanceEvery === 0;
    const needQuotes = (useSignalExits && positions.length > 0) || (isRebalance && positions.length < maxPos);
    let quotes = null, ranked = null;
    if (needQuotes) {
      quotes = buildQuotes(symbols, idx, ind, date, barsBySymbol);
      ranked = rankSectors(buildSectors(quotes), params.hotSectorCount);
    }

    // 4a) 訊號出場:板塊退燒 / 跌破 MA20(A/B 測試用;預設關閉 = 只用 ATR/移動停利)
    if (useSignalExits && ranked) {
      const rankBy = Object.fromEntries(ranked.map((r) => [r.etf, r.rank]));
      for (const p of positions) {
        const j = idx[p.symbol][date];
        if (j == null) continue;
        const reasons = [];
        if (p.etf && (rankBy[p.etf] ?? 99) > params.sectorExitRank) reasons.push('板塊退燒');
        if (ind[p.symbol].relMA20[j] <= params.momentumBreakBuffer) reasons.push('跌破MA20');
        if (reasons.length) pendingExits.push({ symbol: p.symbol, reason: reasons.join('/') });
      }
    }

    // 4b) 換倉日:市場水位 + 選股 -> 排明天開盤買單
    if (isRebalance && positions.length < maxPos) {
      const si = spyDate[date];
      const gate = computeMarketGate(spyClose.slice(0, si + 1), null, market);
      if (gate.available && gate.riskOn) {
        if (!quotes) {
          quotes = buildQuotes(symbols, idx, ind, date, barsBySymbol);
          ranked = rankSectors(buildSectors(quotes), params.hotSectorCount);
        }
        const sold = recentSold(trades, date, params);
        const buys = generateBuys(quotes, ranked, positions, params, sold);
        pendingBuys = buys.slice(0, maxPos - positions.length);
      }
    }
  }

  // 期末平掉
  const last = cal[cal.length - 1];
  for (const p of positions) {
    const j = idx[p.symbol][last];
    if (j == null) continue;
    const c = barsBySymbol[p.symbol][j].c;
    trades.push({ symbol: p.symbol, pnlPct: (c - p.entryPrice) / p.entryPrice, reason: '期末平倉', exitDate: last });
  }

  const dailyReturns = [];
  for (let i = 1; i < equity.length; i++) dailyReturns.push(equity[i].nav / equity[i - 1].nav - 1);

  // 一併回報「實際參與回測的股票數」。長歷史沒抓齊時,回測是跑在
  // 股票池的一部分上 —— 這個數字必須跟著績效數字一起被看到,
  // 否則會誤以為結論適用於全部 universe。
  return {
    equity, metrics: computeMetrics(equity, trades), trades, dailyReturns,
    universeUsed: symbols.length,
    universeTotal: UNIVERSE.length,
    from: cal[warmup], to: cal[cal.length - 1],
  };
}

function buildQuotes(symbols, idx, ind, date, barsBySymbol) {
  const quotes = [];
  for (const s of symbols) {
    const j = idx[s][date];
    if (j == null || j < 63) continue;
    const bar = barsBySymbol[s][j], I = ind[s];
    quotes.push({
      symbol: s, name: UNI[s].name, etf: UNI[s].etf, price: bar.c,
      ma20: I.ma20[j], ma50: I.ma50[j], relMA20: I.relMA20[j], relMA50: I.relMA50[j],
      ret1m: I.ret1m[j], ret3m: I.ret3m[j], atr: I.atr[j],
    });
  }
  return quotes;
}

function buildSectors(quotes) {
  return SECTORS.map((s) => {
    const mem = quotes.filter((q) => q.etf === s.etf);
    if (!mem.length) return { etf: s.etf, name: s.name, ret1m: -9, ret3m: -9, relMA50: -9 };
    const avg = (f) => mem.reduce((a, m) => a + m[f], 0) / mem.length;
    return { etf: s.etf, name: s.name, ret1m: avg('ret1m'), ret3m: avg('ret3m'), relMA50: avg('relMA50') };
  });
}

function recentSold(trades, date, params) {
  const cutoff = new Date(date).getTime() - (params.reentryCooldownDays || 0) * 86400000;
  return trades.filter((t) => t.exitDate && new Date(t.exitDate).getTime() >= cutoff).map((t) => t.symbol);
}
