// =============================================================
// portfolio.js — 持倉管理 (需求 1: 永遠不超過 6 倉) + 本地儲存
// -------------------------------------------------------------
// 持倉狀態存在 localStorage，重開 App 不會掉。
// 部署成真正的 PWA 後，這就是離線可用的本地資料庫。
// =============================================================

import { MAX_POSITIONS } from './strategy.js';

const STORAGE_KEY = 'usstock_portfolio_v1';

export class Portfolio {
  constructor() {
    this.positions = []; // { symbol, name, etf, shares, entryPrice, entryDate, peakPrice }
    this.cashLog = [];   // 已實現損益紀錄 (供回測 / 績效統計)
    this.load();
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        this.positions = data.positions || [];
        this.cashLog = data.cashLog || [];
      }
    } catch (e) { /* 第一次使用，沒資料是正常的 */ }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        positions: this.positions, cashLog: this.cashLog,
      }));
    } catch (e) { console.warn('儲存失敗', e); }
  }

  isFull() { return this.positions.length >= MAX_POSITIONS; }
  has(symbol) { return this.positions.some((p) => p.symbol === symbol); }

  // 買進。需求 1: 滿 6 倉或已持有 -> 拒絕。
  buy({ symbol, name, etf, price, shares = 1, stopPrice = null, atr = null, entryEnv = null, entryDate = null, manual = false }) {
    if (this.isFull()) return { ok: false, msg: '已達 6 倉上限' };
    if (this.has(symbol)) return { ok: false, msg: '已持有此標的' };
    this.positions.push({
      symbol, name, etf, shares,
      entryPrice: price, peakPrice: price,
      stopPrice, atr,                                  // 進場時鎖定的 ATR 停損價
      size: 1, laddersFired: [],                       // 分批停利:剩餘比例 + 已觸發的階
      entryEnv,                                         // 進場時的市場環境戳記(Minervini 心法)
      manual,                                           // true = 你自己在外面買的,非系統訊號
      entryDate: entryDate || new Date().toISOString().slice(0, 10),
    });
    this.save();
    return { ok: true };
  }

  // 賣出。fraction = 要賣掉的「原始部位比例」(1 = 全平)。
  // ladderIdx 有值代表這是階梯停利觸發,記下來避免同一階重複觸發。
  sellPartial(symbol, price, fraction = 1, reason = '手動平倉', ladderIdx = null, exitEnv = null) {
    const i = this.positions.findIndex((p) => p.symbol === symbol);
    if (i < 0) return { ok: false, msg: '未持有' };
    const pos = this.positions[i];
    const size = pos.size ?? 1;
    const sellSize = Math.min(fraction, size);
    const pnlPct = (price - pos.entryPrice) / pos.entryPrice;
    const exitDate = new Date().toISOString().slice(0, 10);
    const holdingDays = Math.max(0, Math.round((new Date(exitDate) - new Date(pos.entryDate)) / 86400000));
    const partial = sellSize < size - 1e-9;

    this.cashLog.push({
      symbol, name: pos.name, entryPrice: pos.entryPrice, exitPrice: price, pnlPct,
      fraction: sellSize, partial,
      entryEnv: pos.entryEnv ?? null, exitEnv,         // 市場環境戳記(進場/出場)
      entryDate: pos.entryDate, exitDate, holdingDays, reason,
    });

    pos.size = size - sellSize;
    if (ladderIdx != null) { (pos.laddersFired = pos.laddersFired || []).push(ladderIdx); }
    if (pos.size <= 1e-6) this.positions.splice(i, 1);
    this.save();
    return { ok: true, pnlPct, remaining: pos.size > 1e-6 ? pos.size : 0 };
  }

  // 全平(手動平倉 / 停損等):賣掉剩餘全部
  sell(symbol, price, reason = '手動平倉', exitEnv = null) {
    return this.sellPartial(symbol, price, 1, reason, null, exitEnv);
  }

  // 績效統計 + 資金成長曲線(百分比複利,起點 100)
  perf() {
    const log = this.cashLog;
    const trades = log.length;
    const equity = [{ i: 0, nav: 100 }];
    if (trades === 0) {
      return { trades: 0, equity, totalReturn: 0, winRate: 0, avgWin: 0, avgLoss: 0, payoff: 0, profitFactor: 0, maxDD: 0 };
    }
    let nav = 100;
    const wins = [], losses = [];
    log.forEach((c, idx) => {
      const frac = c.fraction ?? 1;              // 部分出場只按賣掉的比例計入
      nav *= (1 + frac * c.pnlPct);
      equity.push({ i: idx + 1, nav, symbol: c.symbol, pnlPct: c.pnlPct });
      // 打平(pnlPct === 0)算輸不算贏 —— 沒賺就不是贏。
      // stats() 用同一個判準,兩個分頁的勝率才會一致。
      (c.pnlPct > 0 ? wins : losses).push(c.pnlPct);
    });
    const totalReturn = nav / 100 - 1;
    const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
    const grossWin = wins.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
    let peak = 100, maxDD = 0;
    equity.forEach((e) => { peak = Math.max(peak, e.nav); maxDD = Math.min(maxDD, e.nav / peak - 1); });
    return {
      trades, equity, totalReturn,
      winRate: wins.length / trades,
      avgWin, avgLoss,
      payoff: avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : 0,
      maxDD,
    };
  }

  // 每日用最新報價更新持倉的現價與「持倉最高價」(移動停利要用)
  mark(quotes) {
    const by = Object.fromEntries(quotes.map((q) => [q.symbol, q]));
    for (const pos of this.positions) {
      const q = by[pos.symbol];
      if (!q) continue;
      pos.lastPrice = q.price;
      pos.peakPrice = Math.max(pos.peakPrice ?? pos.entryPrice, q.price);
    }
    this.save();
  }

  // 未實現損益統計 + 已實現報酬
  //
  // ⚠️ 已實現報酬必須用「賣掉的比例」加權,而且要複利 —— 跟 perf() 同一套算法。
  //    舊版是把每筆 pnlPct 直接相加,忽略 fraction。因為階梯停利預設是開的
  //    (+30% 減碼 1/3、+60% 再減 1/3),一筆走完階梯的交易會被重複計算 2~3 次、
  //    每次都用全額權重,結果嚴重高估。
  //    例:+40% 減碼 33%、剩下 +10% 出場 -> 舊版顯示 50.0%,實際只有 20.8%。
  //    今日分頁和績效分頁從此顯示同一個數字。
  stats() {
    let unreal = 0;
    for (const p of this.positions) {
      if (p.lastPrice) unreal += (p.lastPrice - p.entryPrice) / p.entryPrice;
    }
    let nav = 1;
    let wins = 0;
    for (const c of this.cashLog) {
      nav *= (1 + (c.fraction ?? 1) * c.pnlPct);
      if (c.pnlPct > 0) wins++;                  // 打平算輸,與 perf() 一致
    }
    return {
      open: this.positions.length,
      unrealAvgPct: this.positions.length ? unreal / this.positions.length : 0,
      realizedPct: nav - 1,
      trades: this.cashLog.length,
      winRate: this.cashLog.length ? wins / this.cashLog.length : 0,
    };
  }

  reset() {
    this.positions = []; this.cashLog = []; this.save();
  }
}
