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
//   • 交易成本:手續費 + SEC 規費 + 滑價,見下面 COST_DEFAULT
// =============================================================

import { SECTORS, UNIVERSE } from './data.js';
import { rankSectors } from './sectors.js';
import { generateBuys, computeStops, MAX_POSITIONS } from './strategy.js';
import { computeMarketGate } from './market.js';
import { computeMetrics } from './backtest.js';

const UNI = Object.fromEntries(UNIVERSE.map((u) => [u.symbol, u]));

// =============================================================
// 交易成本
// -------------------------------------------------------------
// 放在這裡而不是 presets.js:費率是**你的券商屬性**,不是姿態屬性。
// 放進 preset 等於允許「Marcus Jin 的手續費跟 Amber 姐姐不一樣」,那是錯的模型。
//
// ⚠️ feePct 是**回測假設**,不是「每個富邦帳戶的官方統一費率」。
//    富邦公開頁寫網路下單 0.25%、依成交金額計算、免收最低手續費
//    (免低收這點是關鍵:有低收的話小額帳戶會被定額費用吃掉)。
//    但實際費率可議價,你自己的對帳單才算數。拿這組數字講話時要說「假設」。
//
// ⚠️ secFeePct 用的是**現行**費率($20.60/百萬),回溯套用到 2010 年。
//    SEC 第 31 條規費歷年調整過很多次,所以這是「現行費率回溯套用」,
//    不是逐日還原。不修正的理由是量級:它只有手續費的約 1/120,
//    歷年變動幅度對年化拖累的影響在 0.001%/年以下,修了也看不出差別。
//    但要揭露,不能假裝回測精確到這一層。
//
// ⚠️ slipPct 預設 0 —— 這是**刻意的**。手續費是公開事實(查得到),
//    滑價是建模假設(沒有權威數字)。混在一起,結論就無法辯護。
//    所以第一次實驗跑零滑價當基準,之後另跑 0.001(每邊 0.1%)做敏感度。
//    零滑價的結果**不是**「實際可交易績效」,只是基準情境。
// =============================================================
export const COST_DEFAULT = {
  feePct: 0.0025,        // 券商手續費,買賣都收(富邦網路下單公告價 0.25%)
  secFeePct: 0.0000206,  // SEC 規費,**只有賣出**收($20.60/百萬,2026-04-02 起)
  slipPct: 0,            // 單邊滑價:買貴、賣便宜。預設 0,見上面
};

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
export function runRealBacktest({ barsBySymbol, params, market, rebalanceEvery = 5, warmup = 63, useSignalExits = false, cost = COST_DEFAULT }) {
  const maxPos = params.maxPositions ?? MAX_POSITIONS;

  // ---- 交易成本:把三個費率摺成兩個「每股倍數」,所有成交點共用 ----
  // buyMult  = 每買 1 股實際付出的錢 ÷ 報價
  // sellMult = 每賣 1 股實際拿到的錢 ÷ 報價
  // 摺成倍數的好處:五個成交點(進場/停損/移動停利/階梯/訊號出場/期末)
  // 不可能各自寫錯一個版本 —— 只有一份公式。
  const C = { ...COST_DEFAULT, ...(cost || {}) };
  const buyMult = (1 + C.slipPct) * (1 + C.feePct);
  const sellMult = (1 - C.slipPct) * (1 - C.feePct - C.secFeePct);
  // 參數餵進荒謬值時要吵。靜靜回一組漂亮但無意義的數字,是這個專案最怕的那種壞。
  if (!(buyMult > 0) || !(sellMult > 0) || !isFinite(buyMult) || !isFinite(sellMult)) {
    throw new Error(`交易成本參數不合理:fee=${C.feePct} sec=${C.secFeePct} slip=${C.slipPct}`);
  }
  // 費用台帳。給驗收用:它必須對得上「費率 × 成交名目」這個算術恆等式,
  // 對不上就是某個成交點漏扣或重複扣了 —— 這是唯一能事先算出答案的檢查。
  let feesPaid = 0, slipPaid = 0, buyNotional = 0, sellNotional = 0;

  // 賣出的共用結算:回傳實收現金,並把費用記進台帳。
  const sellProceeds = (shares, quote) => {
    const execP = quote * (1 - C.slipPct);          // 滑價後的實際成交價
    const notional = shares * execP;
    const fee = notional * (C.feePct + C.secFeePct);
    slipPaid += shares * quote * C.slipPct;
    feesPaid += fee;
    sellNotional += notional;
    return notional - fee;
  };

  // 每筆交易的淨報酬率。
  //   每股實付 = entryPrice × buyMult(存成 costBasis),每股實收 = quote × sellMult。
  // 注意:分子分母都隨股數等比縮放,所以**這個值與 fraction 無關** ——
  // 階梯部分出場不需要另一套算法,比例公式本身就是精確解,不是近似。
  // 寫成 (實收 - 實付)/實付 而不是 實收/實付 - 1:零成本時這會退化成與舊版
  // **完全相同的浮點運算式**,回歸測試才能位元級相等。兩種寫法數學上一樣,
  // 但 (a-b)/b 和 a/b-1 的最後一個 bit 會差 —— 差一個 ULP 就看不出「只差在成本」。
  const netPnl = (p, quote) => (quote * sellMult - p.costBasis) / p.costBasis;
  const grossPnl = (p, quote) => (quote - p.entryPrice) / p.entryPrice;
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
      cash += sellProceeds(p.shares, openP);
      trades.push({
        symbol: p.symbol, pnlPct: netPnl(p, openP), grossPnlPct: grossPnl(p, openP),
        reason: ex.reason, exitDate: date, fraction: p.size ?? 1,
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
      // alloc 是**含手續費與滑價的總預算**,所以股數要除以「每股實付成本」。
      // 寫成 cash -= alloc*(1+fee) 會在 alloc === cash(現金吃緊)時把現金做成負數 ——
      // 那不會報錯,只會讓 NAV 悄悄失真,是這個專案最難察覺的一類壞。
      const costBasis = openP * buyMult;            // 每股實付(含費與滑價)
      const shares = alloc / costBasis;
      buyNotional += shares * openP * (1 + C.slipPct);
      slipPaid += shares * openP * C.slipPct;
      feesPaid += shares * openP * (1 + C.slipPct) * C.feePct;   // 買進不收 SEC 規費
      cash -= alloc;
      positions.push({
        symbol: b.symbol, etf: UNI[b.symbol].etf, shares,
        // 分批停利要用的三個欄位:原始股數(算減碼比例的基準)、剩餘比例、已觸發的階。
        // 跟實盤 portfolio.js 的 size / laddersFired 同語意。
        shares0: shares, size: 1, laddersFired: [],
        // entryPrice 維持**原始報價**,不是 costBasis ——
        // 停損/移動停利是價格規則,摻進手續費就等於偷改了出場邏輯。
        // costBasis 只拿來算淨報酬,絕不餵給 computeStops。
        entryPrice: openP, costBasis, peakPrice: openP, atr: a,
        stopPrice: a ? openP - a * params.atrStopMult : openP * (1 + params.stopLossPct),
      });
    }
    pendingBuys = [];

    // 2) 盤中出場(用當日 OHLC)。全出場優先於階梯,順序與實盤 strategy.js 一致。
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
        cash += sellProceeds(p.shares, exitP);    // p.shares 已扣掉減碼過的部分
        trades.push({
          symbol: p.symbol, pnlPct: netPnl(p, exitP), grossPnlPct: grossPnl(p, exitP),
          reason: hardStop >= trailStop ? '停損' : '移動停利', exitDate: date,
          fraction: p.size ?? 1,
        });
        positions.splice(pi, 1);
        continue;
      }

      // 2b) 分批停利階梯(部分出場)。
      // 實盤是每天收盤跑一次 app.js:用收盤價判斷、用收盤價成交。這裡照抄,
      // 才不會在回測裡拿到實盤做不到的成交價(用當日 high 成交就是變相偷跑)。
      if (params.enableProfitLadder && Array.isArray(params.profitLadder)) {
        const pnl = (bar.c - p.entryPrice) / p.entryPrice;
        const fired = new Set(p.laddersFired);
        let hit = -1;
        for (let k = 0; k < params.profitLadder.length; k++) {
          if (!fired.has(k) && pnl >= params.profitLadder[k].gainPct) { hit = k; break; }
        }
        if (hit >= 0) {
          const frac = Math.min(params.profitLadder[hit].sellFraction, p.size);
          const sellShares = p.shares0 * frac;
          cash += sellProceeds(sellShares, bar.c);
          p.shares -= sellShares;
          p.size -= frac;
          p.laddersFired.push(hit);
          trades.push({
            // pnl(毛)是上面觸發階梯用的判斷值;淨報酬與 frac 無關,見 netPnl 的註解。
            symbol: p.symbol, pnlPct: netPnl(p, bar.c), grossPnlPct: pnl,
            exitDate: date, fraction: frac,
            reason: `階梯停利 +${(params.profitLadder[hit].gainPct * 100).toFixed(0)}%`,
          });
          // 階梯把部位減到 0(理論上不會,兩階合計 0.66)-> 收掉,騰出倉位
          if (p.size <= 1e-6) positions.splice(pi, 1);
        }
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

  // 期末平掉。
  // 以前這裡只推交易紀錄、不碰現金,最後的 NAV 用市值計價 —— 於是「交易紀錄說賣掉了」
  // 跟「NAV 說還握著」用了兩套口徑,而且賣出成本憑空消失。現在真的結算:
  // 賣出現金進 cash,再把 equity 最後一點改寫成結算後的值,三者口徑一致。
  //
  // 只動 equity 的最後一個點(它的日期本來就是平倉日),不新增資料點 ——
  // 新增會憑空多出一個交易日,污染 dailyReturns 的長度與蒙地卡羅抽樣。
  //
  // 零成本時 cash 的結算值恰好等於 navNow(cash + Σ 股數×收盤),
  // 所以 feePct=0 的回歸測試仍然位元級重現舊版。
  const last = cal[cal.length - 1];
  for (const p of positions) {
    const j = idx[p.symbol][last];
    // 最後一天沒有 bar(下市 / 資料缺口):不能成交,就不要假裝賣掉了。
    // navNow 對這種部位本來就當 0,這裡維持一致 —— 不結算、也不推出場紀錄。
    if (j == null) continue;
    const c = barsBySymbol[p.symbol][j].c;
    cash += sellProceeds(p.shares, c);
    trades.push({
      symbol: p.symbol, pnlPct: netPnl(p, c), grossPnlPct: grossPnl(p, c),
      reason: '期末平倉', exitDate: last, fraction: p.size ?? 1,
    });
  }
  if (equity.length) equity[equity.length - 1].nav = cash;

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
    // 成本假設要跟著數字一起被看到。績效數字不附成本口徑,
    // 跟「約 30 秒」那段假說明是同一個病。
    cost: C,
    // 費用台帳。驗收用的算術恆等式:
    //   feesPaid === feePct × (buyNotional + sellNotional) + secFeePct × sellNotional
    // 對不上 = 某個成交點漏扣或重複扣。這是唯一能事先算出答案的檢查,
    // 比「CAGR 應該落在 14% 附近」那種估算區間硬得多。
    costLedger: { feesPaid, slipPaid, buyNotional, sellNotional },
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
