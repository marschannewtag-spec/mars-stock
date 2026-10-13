// =============================================================
// portfolio.js — 持倉管理 (需求 1: 永遠不超過 6 倉) + 本地儲存
// -------------------------------------------------------------
// 持倉狀態存在 localStorage，重開 App 不會掉。
// 部署成真正的 PWA 後，這就是離線可用的本地資料庫。
// =============================================================

import { MAX_POSITIONS } from './strategy.js';
import { PRESETS } from './presets.js';
import { config } from './config.js';

// 日常實際使用的倉位數 —— 跟 app.js 的 DAILY_MAX 用同一條式子算,
// 因為「一個部位佔帳戶幾分之幾」取決於**現在這個 preset 開幾個倉**,
// 不是 strategy.js 的那個常數。composite 是 6,兩者目前相等。
//
// ⚠️ 已知不一致(沒有在這次一起改,因為那是交易邏輯不是報表):
//    下面的 isFull() 用的是寫死的 MAX_POSITIONS(6),不是這個值。
//    把 config.DAILY_PRESET 換成 marcus(maxPositions: 3)之後,
//    畫面會說 3 個倉位、訂單清單會配 1/3,但 isFull() 仍會放行到第 6 檔。
//    這是既有行為,改它等於改部位上限 —— 要由專案擁有者決定。
//    見 docs/AUDIT-2026-10-13.md 問題 G。
const DAILY_POS = (PRESETS[config.DAILY_PRESET] || PRESETS.composite).params.maxPositions ?? MAX_POSITIONS;

const STORAGE_KEY = 'usstock_portfolio_v1';

// =============================================================
// 一筆平倉對「整個帳戶」的影響 —— 這是 2026-10-13 修掉的一個 5 倍放大錯誤
// -------------------------------------------------------------
// 錯的版本是 `nav *= (1 + fraction * pnlPct)`。
// fraction 是「這個部位賣掉幾成」(階梯減碼用),**不是這個部位佔帳戶幾成**。
// 所以一筆 −6.5% 的全出場,會被當成「整個帳戶 −6.5%」來複利。
//
// 但這套策略**同時持有 N 檔、每檔 1/N**(N = 現行 preset 的 maxPositions,綜合是 6;
// backtest-real.js 的 alloc = nav / maxPositions 也是同一個模型)。
// 一檔跌 6.5%,帳戶只少 1.08%。
//
// 真實後果:使用者的 5 筆停損分別是 −6.5 / −6.1 / −7.9 / −9.5 / −6.9%,
// 畫面顯示「已實現報酬 **−31.9%**」,實際是 **−6.0%** —— 放大了 5.3 倍。
// 這不是小數點問題:它會讓人以為策略已經崩了而把它關掉,
// 而真正的數字還在回測的正常回撤範圍內。**報錯的數字比沒有數字更危險。**
//
// ⚠️ 這仍然是一個模型,不是你券商帳戶的真實報酬:
//    它假設每一筆都剛好押 1/N、而且空出來的倉位是現金(回測的
//    `alloc = Math.min(nav / maxPos, cash)` 就是這個模型,所以未滿倉時除以 N
//    並不會偏樂觀 —— 偏樂觀的情況是「把錢重新分配給現有持倉」,而這套策略不那樣做)。
//    App 從來沒有記過實際股數或資金(buy() 的 shares 永遠是預設的 1),
//    所以算不出真正的帳戶報酬。要真的算,得先讓持倉記錄股數與成本。
//
// ⚠️ 權重必須在**買進當下**就記在持倉上(posWeight),平倉時直接複製進 cashLog。
//    2026-10-14 修正:原本是在平倉時才寫 `1 / DAILY_POS`,那仍然是錯的 ——
//    權重是「配置」時決定的,不是「出場」時決定的。3 倉 preset 買進、持有期間
//    換成 6 倉,平倉就會被記成 1/6,而正確答案是 1/3。
//    (寫在平倉已經擋住「換 preset 改寫全部歷史」,但擋不住「換 preset 改寫
//     那些跨越切換點的部位」。要擋住就只能記在進場。)
//    買進前就存在的舊持倉、以及 2026-10-14 之前的舊 cashLog 都沒有 posWeight,
//    只能退回用現行值估 —— 那些紀錄會帶 posWeightEstimated: true。
//    **估算值不冒充歷史實際值**:畫面要照實說有幾筆是估的。
//
// ⚠️ 已知的剩餘誤差:這裡是「逐筆平倉事件複利」,不是真正的投資組合報酬。
//    多檔同時持有時,它們不是依序發生、每段都能把整個帳戶再投入的獨立期間。
//    正確做法是每日把所有持倉與現金標記市值、算出一條每日 NAV 曲線
//    (backtest-real.js 的 equity 就是那樣做的),但實盤端沒有每日資料 ——
//    App 只有在你打開它的那幾天才看得到價格。
//    以目前的資料量級,兩種算法差 0.15 個百分點(−6.00% vs 逐筆相加 −6.15%),
//    不影響結論;但部位變大、報酬變大時誤差會放大。詳見 docs/AUDIT-2026-10-13.md。
// =============================================================
const validWeight = (w) => typeof w === 'number' && Number.isFinite(w) && w > 0;

// 這筆平倉的權重是「當下記下的」還是「事後估的」。
// 兩種來源都算估:(a) 明確標了 posWeightEstimated,(b) 根本沒有 posWeight 欄位
// (2026-10-14 之前的紀錄)。缺欄位不能當成「剛好等於現行設定」。
const weightIsEstimated = (c) => c.posWeightEstimated === true || !validWeight(c.posWeight);

function navWeight(c) {
  // posWeight = 這筆平倉的部位當時佔帳戶的比例(1/N)。
  const w = validWeight(c.posWeight) ? c.posWeight : (1 / DAILY_POS);
  return (c.fraction ?? 1) * c.pnlPct * w;
}

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
      // 這個部位進場當下佔帳戶的比例。記在**買進**,平倉時直接複製 ——
      // 權重是配置時決定的,不是出場時決定的。見 navWeight() 上面的註解。
      posWeight: 1 / DAILY_POS,
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

    // ---- 入口驗證。Math.min() 擋不住負數與 NaN ----
    //   Math.min(-0.5, 1) = -0.5  -> pos.size = 1 - (-0.5) = 1.5,部位反而**變大**
    //   Math.min(NaN, 1)  = NaN   -> 部位與 cashLog 一起被汙染,之後每個統計都是 NaN
    // 現行呼叫端(app.js 的賣出訊號)傳的都是 preset 裡的正數,從那裡進不來。
    // 真正的入口是 localStorage 被汙染 —— `pos.size ?? 1` 的 `??` 只擋
    // null/undefined,擋不住 NaN、負數、字串。壞資料必須在這裡止步:
    // 一旦寫進 cashLog 就再也分不出哪筆是壞的,而 cashLog 是不可逆的紀錄。
    const size = pos.size ?? 1;
    const bad = (label, v) =>
      ({ ok: false, msg: `${symbol} ${label}不合法(${String(v)})—— 已拒絕,持倉與紀錄都沒有變動` });
    if (!Number.isFinite(size) || size <= 0) return bad('持倉剩餘比例', pos.size);
    if (!Number.isFinite(fraction) || fraction <= 0) return bad('賣出比例', fraction);
    // 價格不在授權清單裡,但是同一類的洞:NaN 價格會讓 pnlPct 變 NaN,
    // 然後整條資金曲線都是 NaN,而且不會有任何錯誤訊息。
    if (!Number.isFinite(price) || price <= 0) return bad('賣出價格', price);
    if (!Number.isFinite(pos.entryPrice) || pos.entryPrice <= 0) return bad('持倉進場價', pos.entryPrice);

    const sellSize = Math.min(fraction, size);
    const pnlPct = (price - pos.entryPrice) / pos.entryPrice;

    // 權重取自持倉(買進當下寫死)。舊持倉沒有 -> 只能用現行設定估,
    // 並標記起來。估算值不冒充歷史實際值。
    const weightKnown = validWeight(pos.posWeight);
    const posWeight = weightKnown ? pos.posWeight : (1 / DAILY_POS);
    const exitDate = new Date().toISOString().slice(0, 10);
    const holdingDays = Math.max(0, Math.round((new Date(exitDate) - new Date(pos.entryDate)) / 86400000));
    const partial = sellSize < size - 1e-9;

    this.cashLog.push({
      symbol, name: pos.name, entryPrice: pos.entryPrice, exitPrice: price, pnlPct,
      fraction: sellSize, partial,
      // 這個部位進場當下佔帳戶的比例,從持倉複製過來。
      // posWeightEstimated = 這筆的權重是事後用現行設定估的,不是當時記下的。
      posWeight, posWeightEstimated: !weightKnown,
      entryEnv: pos.entryEnv ?? null, exitEnv,         // 市場環境戳記(進場/出場)
      // manual 一定要跟著平倉紀錄走。以前只存在持倉上,部位一平就消失,
      // 事後就再也分不出「系統訊號買的」還是「自己覆蓋買的」——
      // 而那正是紀律稽核唯一需要的欄位。
      manual: pos.manual ?? false,
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
      nav *= (1 + navWeight(c));
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
      estimatedWeights: log.filter(weightIsEstimated).length,
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
  // ⚠️ 已實現報酬要用「賣掉的比例 × 部位權重」加權,而且要複利 —— 跟 perf() 共用
  //    navWeight()。兩次修正疊在一起:
  //    (1) 舊版把每筆 pnlPct 直接相加,忽略 fraction。階梯停利預設是開的,
  //        一筆走完階梯的交易會被重複計算 2~3 次、每次都用全額權重。
  //        例:+40% 減碼 33%、剩下 +10% 出場 -> 顯示 50.0%,實際 20.8%。
  //    (2) 2026-10-13:加了 fraction 之後仍然把每筆當成「整個帳戶」在複利,
  //        忘了除以倉位數 DAILY_POS。詳見 navWeight() 上面的註解 —— 這個錯讓
  //        −6.0% 顯示成 −31.9%。
  //    今日分頁和績效分頁共用同一條公式,兩邊永遠一致。
  //
  // ⚠️ unrealAvgPct 是「每個部位的平均報酬」,不是帳戶報酬。滿倉(6/6)時兩者
  //    剛好相等;只持有 3 檔時,另外一半是現金,帳戶的未實現影響只有這個數字的一半。
  stats() {
    let unreal = 0;
    for (const p of this.positions) {
      if (p.lastPrice) unreal += (p.lastPrice - p.entryPrice) / p.entryPrice;
    }
    let nav = 1;
    let wins = 0;
    for (const c of this.cashLog) {
      nav *= (1 + navWeight(c));
      if (c.pnlPct > 0) wins++;                  // 打平算輸,與 perf() 一致
    }
    return {
      open: this.positions.length,
      unrealAvgPct: this.positions.length ? unreal / this.positions.length : 0,
      realizedPct: nav - 1,
      trades: this.cashLog.length,
      winRate: this.cashLog.length ? wins / this.cashLog.length : 0,
      // 有幾筆的部位權重是事後估的,不是當時記下的。畫面要照實說。
      estimatedWeights: this.cashLog.filter(weightIsEstimated).length,
    };
  }

  reset() {
    this.positions = []; this.cashLog = []; this.save();
  }
}
