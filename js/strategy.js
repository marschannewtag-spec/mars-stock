// =============================================================
// strategy.js — 策略核心 (需求 1/2/3: 最多 6 倉、每日買進/賣出訊號)
// -------------------------------------------------------------
// 這是整個系統最該被你「強化」的地方。目前是一個可解釋的動能策略骨架:
//
//   買進 (BUY):  只在熱門板塊中選股，挑站上 MA20、動能最強、尚未持有的標的，
//                直到補滿到 MAX_POSITIONS 倉為止。
//   賣出 (SELL): 對現有持倉檢查 4 個出場條件 (停損 / 板塊退燒 / 動能轉弱 /
//                移動停利)，命中任一就出場。
//
// 需求 6「接受大回撤但要高報酬」-> 預設停損放寬、停利改用移動停利讓獲利奔跑。
// 所有參數集中在 STRATEGY_PARAMS，方便你日後最佳化 / 跑 Monte Carlo。
// =============================================================

export const MAX_POSITIONS = 6;

export const STRATEGY_PARAMS = {
  hotSectorCount: 3,        // 視為「熱門」的板塊數
  sectorExitRank: 5,        // 持倉板塊掉出前幾名就出場 (退燒)

  // ── 買進品質門檻(中等)—— 目的:寧缺勿濫,不硬湊滿 6 檔 ──
  minStockScore: 0.13,          // 複合動能分數下限(夠強才推)
  requireAboveMA20: true,       // 需站上 20 日均線
  requireAboveMA50: true,       // 需同時站上 50 日均線
  requireBothMomentumPositive: true, // 1M 與 3M 動能需同向為正(排除下跌中的假反彈)
  requireSectorScorePositive: true,  // 所屬板塊分數需為正
  maxExtensionAboveMA20: 0.15,  // 過度延伸防呆:現價高於 MA20 超過此%就不追(避免接在拋物線頂)
  reentryCooldownDays: 5,       // 剛賣掉的標的,N 個交易日內不重複推薦(不重複)

  // ── 出場 ──
  atrPeriod: 14,            // ATR 週期
  atrStopMult: 2.5,         // 硬停損 = 進場價 − ATR×此倍數 (自適應波動)
  stopLossPct: -0.18,       // 無 ATR 時的備援固定停損 -18%
  trailingStopPct: -0.12,   // 從持倉最高點回落 12% 觸發移動停利
  momentumBreakBuffer: -0.03, // 收盤跌破 MA20 超過 3% 視為動能轉弱

  // ── 分批停利階梯(部分出場)──
  // 到達某獲利% -> 減碼原始部位的某比例;剩下的讓移動停利去跑(讓獲利奔跑)。
  enableProfitLadder: true,
  profitLadder: [
    { gainPct: 0.30, sellFraction: 0.33 }, // +30% 減碼 1/3
    { gainPct: 0.60, sellFraction: 0.33 }, // +60% 再減 1/3
  ],
};

// 個股動能分數 (買進排序用)
function stockScore(q) {
  return 0.5 * q.ret1m + 0.3 * q.ret3m + 0.2 * q.relMA20;
}

// ---- 候選驗證器:對任意代號只跑「個股層級」硬門檻(無板塊上下文)----
export function verifyCandidate(q, params = STRATEGY_PARAMS) {
  const checks = [
    { label: '站上 MA20', ok: q.price > q.ma20 },
    { label: '站上 MA50', ok: q.price > q.ma50 },
    { label: '1M/3M 動能同向為正', ok: q.ret1m > 0 && q.ret3m > 0 },
    { label: `動能分數 ≥ ${params.minStockScore}`, ok: stockScore(q) >= params.minStockScore },
    { label: '未過度延伸', ok: !(params.maxExtensionAboveMA20 != null && q.relMA20 > params.maxExtensionAboveMA20) },
  ];
  const pass = checks.every((c) => c.ok);
  const stopPrice = q.atr ? q.price - q.atr * params.atrStopMult : q.price * (1 + params.stopLossPct);
  return { pass, checks, score: stockScore(q), entry: q.price, stopPrice, stopPct: (stopPrice - q.price) / q.price };
}

// ---- Minervini 趨勢範本驗證(A/B/C 三概念做進引擎)----
// A①/B 趨勢範本 + A③ 相對強度 + B 流動性 + A② VCP(附加指標)
export function verifyTrendTemplate(q, market = {}, params = {}) {
  const minPrice = params.minPrice ?? 20;
  const minVol = params.minVol ?? 2000000;
  const spyRet6m = market.spyRet6m ?? 0;
  const checks = [
    { label: '價 > MA50', ok: q.price > q.ma50 },
    { label: '價 > MA200', ok: q.price > q.ma200 },
    { label: 'MA50>MA150>MA200 多頭排列', ok: q.ma50 > q.ma150 && q.ma150 > q.ma200 },
    { label: 'MA200 上升中', ok: q.ma200 > q.ma200_1mo },
    { label: '距52週高 ≤25%', ok: q.pctFrom52wHigh >= -0.25 },
    { label: '高於52週低 ≥30%', ok: q.pctAbove52wLow >= 0.30 },
    { label: 'RS:6M 跑贏大盤', ok: q.ret6m > spyRet6m },
    { label: '股價 ≥ $' + minPrice, ok: q.price >= minPrice },
    { label: `日均量 ≥ ${(minVol / 1e6).toFixed(0)}M`, ok: q.avgVol30 != null && q.avgVol30 >= minVol },
    { label: '市值 ≥ $2B', ok: q.marketCap == null ? true : q.marketCap >= 2e9 },
  ];
  const pass = checks.every((c) => c.ok);
  const stopPrice = q.atr ? q.price - q.atr * (params.atrStopMult ?? 2.5) : q.price * (1 - 0.18);
  return {
    pass, checks,
    score: stockScore(q),
    vcp: !!q.vcpContracting,
    rsVsSpy: q.ret6m - spyRet6m,
    pctFrom52wHigh: q.pctFrom52wHigh,
    marketCap: q.marketCap ?? null,
    atr: q.atr ?? null,
    entry: q.price, stopPrice, stopPct: (stopPrice - q.price) / q.price,
  };
}

// ---- 產生今日買進清單 (需求 2/4) ----
// 輸入:
//   quotes         全標的快照
//   rankedSectors  已排名板塊(含 score / rank / hot)
//   positions      現有持倉
//   params         策略參數
//   recentlySold   最近賣掉、還在冷卻期的代號陣列(不重複)
// 輸出: BuySignal[]  { symbol, name, etf, sectorName, price, score, reasons[] }
//
// 核心精神:每一檔都要「通過品質門檻」才推,通不過就少推甚至不推 —— 不硬湊 6 檔。
export function generateBuys(quotes, rankedSectors, positions, params = STRATEGY_PARAMS, recentlySold = []) {
  const hotETFs = new Set(rankedSectors.filter((s) => s.hot).map((s) => s.etf));
  const sectorInfo = Object.fromEntries(rankedSectors.map((s) => [s.etf, s]));
  const held = new Set(positions.map((p) => p.symbol));
  const cooling = new Set(recentlySold);
  const maxPos = params.maxPositions ?? MAX_POSITIONS;
  const slotsLeft = maxPos - positions.length;
  if (slotsLeft <= 0) return []; // 需求 1: 滿倉就不再買

  const candidates = quotes
    .filter((q) => hotETFs.has(q.etf))            // 只買熱門板塊
    .filter((q) => !held.has(q.symbol))           // 不重複:已持有的不推
    .filter((q) => !cooling.has(q.symbol))        // 不重複:剛賣掉冷卻中的不推
    .filter((q) => passesQualityGate(q, sectorInfo[q.etf], params)) // ★ 品質門檻
    .map((q) => {
      const stopPrice = q.atr
        ? q.price - q.atr * params.atrStopMult          // ATR 自適應停損
        : q.price * (1 + params.stopLossPct);           // 無 ATR 時備援
      return {
        symbol: q.symbol, name: q.name, etf: q.etf,
        sectorName: sectorInfo[q.etf].name,
        price: q.price,
        entry: q.price,                                 // 進場價 ≈ 現價/隔日開盤附近
        stopPrice,
        stopPct: (stopPrice - q.price) / q.price,
        atr: q.atr,
        score: stockScore(q),
        reasons: buildBuyReasons(q, sectorInfo[q.etf].name),
      };
    })
    .sort((a, b) => b.score - a.score);

  return candidates.slice(0, slotsLeft); // 最多補到滿 6 倉,但通常會少於這個數
}

// 中等品質門檻:五道都通過才算合格標的
function passesQualityGate(q, sector, params) {
  if (params.requireAboveMA20 && !(q.price > q.ma20)) return false;
  if (params.requireAboveMA50 && !(q.price > q.ma50)) return false;
  if (params.requireBothMomentumPositive && !(q.ret1m > 0 && q.ret3m > 0)) return false;
  if (params.requireSectorScorePositive && !(sector && sector.score > 0)) return false;
  if (params.maxExtensionAboveMA20 != null && q.relMA20 > params.maxExtensionAboveMA20) return false;
  if (stockScore(q) < params.minStockScore) return false;
  return true;
}

// 診斷:當今天篩不出東西時,告訴使用者「差在哪」,證明是門檻在把關、不是壞掉。
// 回傳 { topRejected: {symbol, score, failedOn} | null }
export function buyDiagnostic(quotes, rankedSectors, positions, params = STRATEGY_PARAMS, recentlySold = []) {
  const hotETFs = new Set(rankedSectors.filter((s) => s.hot).map((s) => s.etf));
  const sectorInfo = Object.fromEntries(rankedSectors.map((s) => [s.etf, s]));
  const held = new Set(positions.map((p) => p.symbol));
  const cooling = new Set(recentlySold);

  const pool = quotes
    .filter((q) => hotETFs.has(q.etf) && !held.has(q.symbol) && !cooling.has(q.symbol))
    .map((q) => ({ q, score: stockScore(q), failed: whyFailed(q, sectorInfo[q.etf], params) }))
    .filter((x) => x.failed)                    // 只看沒過關的
    .sort((a, b) => b.score - a.score);

  if (pool.length === 0) return { topRejected: null };
  const top = pool[0];
  return { topRejected: { symbol: top.q.symbol, score: top.score, failedOn: top.failed } };
}

function whyFailed(q, sector, params) {
  if (params.requireAboveMA20 && !(q.price > q.ma20)) return '未站上 MA20';
  if (params.requireAboveMA50 && !(q.price > q.ma50)) return '未站上 MA50';
  if (params.requireBothMomentumPositive && !(q.ret1m > 0 && q.ret3m > 0)) return '1M/3M 動能未同向為正';
  if (params.requireSectorScorePositive && !(sector && sector.score > 0)) return '板塊分數為負';
  if (params.maxExtensionAboveMA20 != null && q.relMA20 > params.maxExtensionAboveMA20) return `延伸過度(高於 MA20 ${(q.relMA20 * 100).toFixed(0)}%)`;
  if (stockScore(q) < params.minStockScore) return `動能分數 ${stockScore(q).toFixed(2)} 未達門檻 ${params.minStockScore}`;
  return null; // 其實有過關
}

function buildBuyReasons(q, secName) {
  const r = [];
  r.push(`熱門板塊 ${secName}`);
  if (q.ret1m > 0) r.push(`1M 動能 +${(q.ret1m * 100).toFixed(1)}%`);
  if (q.ret3m > 0) r.push(`3M 動能 +${(q.ret3m * 100).toFixed(1)}%`);
  if (q.price > q.ma20) r.push('站上 MA20');
  if (q.price > q.ma50) r.push('站上 MA50');
  return r;
}

// 計算某持倉當前的出場價位(給畫面顯示用)
// hardStop:進場時就固定的 ATR 停損(存在 pos.stopPrice);trailStop:自高點回落 12%
export function computeStops(pos, params = STRATEGY_PARAMS) {
  const hardStop = (pos.stopPrice != null)
    ? pos.stopPrice
    : pos.entryPrice * (1 + params.stopLossPct);
  const trailStop = (pos.peakPrice ?? pos.entryPrice) * (1 + params.trailingStopPct);
  return { hardStop, trailStop, effStop: Math.max(hardStop, trailStop) };
}

// ---- 產生今日賣出清單 (需求 3) ----
// 輸入: positions(現有持倉，含 peakPrice / stopPrice), quotes(快照), rankedSectors
// 輸出: SellSignal[] { symbol, price, pnlPct, reasons[] }
export function generateSells(positions, quotes, rankedSectors, params = STRATEGY_PARAMS) {
  const quoteBy = Object.fromEntries(quotes.map((q) => [q.symbol, q]));
  const rankBy = Object.fromEntries(rankedSectors.map((s) => [s.etf, s.rank]));
  const sells = [];

  for (const pos of positions) {
    const q = quoteBy[pos.symbol];
    if (!q) continue;
    const price = q.price;
    const pnlPct = (price - pos.entryPrice) / pos.entryPrice;
    const { hardStop, trailStop } = computeStops(pos, params);
    const size = pos.size ?? 1;

    // 1) 全出場條件(優先於階梯:停損/移動停利/退燒/破線 -> 清掉剩餘全部)
    const fullReasons = [];
    if (price <= hardStop) fullReasons.push(`觸及停損 $${hardStop.toFixed(2)} (${(pnlPct * 100).toFixed(1)}%)`);
    if (price <= trailStop && price > hardStop) fullReasons.push(`移動停利 $${trailStop.toFixed(2)}`);
    // 板塊退燒 + 跌破MA20:六姿態 16 年 A/B 測試的結論是「關掉」。
    // ⚠️ 這裡原本寫「5/6 姿態 A>B」—— 那是舊的數字,別再引用。
    //    2026-10-13 含 0.25% 手續費重跑:1/6 有統計證據(方向 A)、5/6 分不出、
    //    0/6 是 B 較優。真正的依據不是「幾比幾」(那個數字在五次分析裡抖成
    //    5/6 → 4/6 → 3/6 → 6/6分不出 → 1/6),而是**把成本放進去之後六個姿態
    //    的 A−B 全部往 A 移動、沒有一個往 B 移動**,而且 B 多做 16%~96% 的交易。
    //    完整數字見 docs/health-2026.md 第 3 項。
    // 故日常引擎預設關閉,只留已驗證的 ATR 停損 + 移動停利。要恢復設 params.useSignalExits=true。
    if (params.useSignalExits) {
      if (pos.etf && (rankBy[pos.etf] ?? 99) > params.sectorExitRank) fullReasons.push('板塊退燒');
      if (q.relMA20 <= params.momentumBreakBuffer) fullReasons.push('跌破 MA20，動能轉弱');
    }
    if (fullReasons.length > 0) {
      sells.push({ symbol: pos.symbol, name: pos.name, price, pnlPct, reasons: fullReasons, fraction: size });
      continue;
    }

    // 2) 分批停利階梯(部分出場):觸發「最低一個尚未執行且已達標」的階
    if (params.enableProfitLadder && Array.isArray(params.profitLadder)) {
      const fired = new Set(pos.laddersFired || []);
      let hit = -1;
      for (let idx = 0; idx < params.profitLadder.length; idx++) {
        if (!fired.has(idx) && pnlPct >= params.profitLadder[idx].gainPct) { hit = idx; break; }
      }
      if (hit >= 0) {
        const r = params.profitLadder[hit];
        sells.push({
          symbol: pos.symbol, name: pos.name, price, pnlPct,
          reasons: [`階梯停利 +${(r.gainPct * 100).toFixed(0)}% → 減碼 ${(r.sellFraction * 100).toFixed(0)}%`],
          fraction: Math.min(r.sellFraction, size),
          ladderIdx: hit,
        });
      }
    }
  }
  return sells;
}
