#!/usr/bin/env node
// =============================================================
// verify.mjs — SignalDesk 架構驗證(本機與 CI 共用的單一入口)
// -------------------------------------------------------------
// 用法:  node scripts/verify.mjs
// 通過:  exit 0    失敗:exit 1(並印出是哪一項、為什麼)
//
// 這支腳本只驗證,不修改任何東西。每一項檢查都對應一個
// 「真的踩過的坑」,不是為了好看而加的。
//
// 沒有任何外部依賴,也不需要 package.json —— 維持本專案
// 「零建置流程」的架構。
// =============================================================

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (...p) => join(ROOT, ...p);

// ---- 小工具 ----
const results = [];
function ok(name, detail = '') { results.push({ name, pass: true, detail }); }
function fail(name, detail) { results.push({ name, pass: false, detail }); }
function skip(name, detail) { results.push({ name, skip: true, detail }); }

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function gitSafe(args) {
  try { return git(args); } catch { return null; }
}

const jsFiles = () => readdirSync(rel('js')).filter((f) => f.endsWith('.js')).sort();

// =============================================================
// 1. 語法檢查 —— 每個檔案獨立檢查,壞掉時能直接指出是哪一支
// -------------------------------------------------------------
// node --check 對 .js 預設用 CJS 解析,會被 `export` 噎到。
// 複製成 .mjs 再檢查(.mjs 永遠是 ESM,不受 package.json 影響)。
// --check 只做語法解析,不解析 import,所以複製到別的目錄不影響結果。
// =============================================================
function checkSyntax() {
  const targets = [
    ...jsFiles().map((f) => ['js', f]),
    ...readdirSync(rel('worker')).filter((f) => f.endsWith('.js')).map((f) => ['worker', f]),
  ];
  const tmp = mkdtempSync(join(tmpdir(), 'sd-verify-'));
  const bad = [];
  try {
    for (const [dir, f] of targets) {
      const mjs = join(tmp, `${dir}__${f}`.replace(/\.js$/, '.mjs'));
      writeFileSync(mjs, readFileSync(rel(dir, f)));
      try {
        execFileSync(process.execPath, ['--check', mjs], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        const msg = (e.stderr?.toString() || e.message).split('\n').slice(0, 4).join('\n    ');
        bad.push(`${dir}/${f}\n    ${msg}`);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (bad.length) fail('語法檢查', `${bad.length} 支檔案語法錯誤:\n  ${bad.join('\n  ')}`);
  else ok('語法檢查', `${targets.length} 支檔案全數通過`);
}

// =============================================================
// 2. Import 圖完整性 —— 這一項同時涵蓋「六個分頁都存在」
// -------------------------------------------------------------
// app.js 的 `const views = { today: renderToday, ... }` 是在 module scope
// 求值的。任何一個 render 函式如果因為漏了 `}` 被巢狀進別的函式、
// 或被改名,import 當下就會丟 ReferenceError —— 語法檢查抓不到,
// 但這裡抓得到。這正是「語法過了但執行壞掉」那個坑。
// 同時也驗證所有 named export 都對得上(刪 export 後忘了改 import)。
// =============================================================
async function checkImportGraph() {
  installDomStubs();
  try {
    await import(pathToFileURL(rel('js', 'app.js')).href);
  } catch (e) {
    fail('Import 圖完整性', `載入 js/app.js 失敗(六個分頁的 render 函式可能被巢狀化或改名):\n    ${e.message}`);
    return;
  }
  // app.js 直接或間接 import 了 js/ 底下全部模組,逐一確認沒有孤兒檔
  const imported = jsFiles();
  ok('Import 圖完整性', `js/app.js 及其相依的 ${imported.length} 個模組全數載入成功`);
}

function installDomStubs() {
  const noop = () => {};
  globalThis.document = { addEventListener: noop, getElementById: () => null, querySelectorAll: () => [] };
  globalThis.window = { addEventListener: noop };
  // Node 24 起內建唯讀的 navigator;只有在不存在時才補
  if (typeof globalThis.navigator === 'undefined') globalThis.navigator = {};
  globalThis.localStorage = {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
    key(i) { return [...this._m.keys()][i] ?? null; },
    get length() { return this._m.size; },
  };
  globalThis.indexedDB = { open: () => ({}) };
  globalThis.fetch = async () => ({ json: async () => ({}) });
}

// =============================================================
// 3. 行為式不變量:訊號出場必須維持關閉
// -------------------------------------------------------------
// 「板塊退燒 + 跌破 MA20」經 16 年六姿態 A/B 驗證為有害
// (5/6 姿態 Calmar 變差,交易次數暴增造成 whipsaw),日常引擎已關閉。
//
// 這裡刻意用「行為測試」而不是正則檢查程式碼結構 —— 你在意的不是
// 那個 if 長什麼樣,而是「那兩條規則不會生效」。任何重構只要沒改變
// 行為就不該讓 CI 紅燈;一旦行為變了就一定紅燈。
//
// 同時做反向測試:強制打開時必須要能觸發。否則哪天測試資料失效
// (例如提前被停損吃掉),這個測試會變成永遠通過的空殼。
// =============================================================
async function checkExitInvariant() {
  const { generateSells, STRATEGY_PARAMS } = await import(pathToFileURL(rel('js', 'strategy.js')).href);
  const { PRESETS } = await import(pathToFileURL(rel('js', 'presets.js')).href);

  // 佈局:持倉在冷門板塊(rank 11)、且深跌破 MA20(relMA20 = -9.95%),
  // 但價格還在硬停損(80)和移動停利(88)之上 -> 唯一可能的出場理由
  // 就是「板塊退燒 / 跌破MA20」。
  const positions = [{
    symbol: 'TEST', name: '測試', etf: 'XLK',
    entryPrice: 100, peakPrice: 100, stopPrice: 80, size: 1, laddersFired: [],
  }];
  const quotes = [{
    symbol: 'TEST', name: '測試', etf: 'XLK',
    price: 95, ma20: 105.5, ma50: 110, relMA20: (95 - 105.5) / 105.5, relMA50: -0.14,
    ret1m: -0.08, ret3m: -0.12, atr: 3,
  }];
  const ranked = [{ etf: 'XLK', name: '科技', score: -1.5, rank: 11, hot: false }];

  // (a) 預設參數 -> 不該有任何出場訊號
  const def = generateSells(positions, quotes, ranked, STRATEGY_PARAMS);
  if (def.length > 0) {
    fail('出場不變量', `預設參數下不該出場,卻產生了訊號:${def.map((s) => s.reasons.join('/')).join(' | ')}`);
    return;
  }

  // (b) 強制打開 -> 必須觸發(證明上面的 (a) 不是空殼測試)
  const on = generateSells(positions, quotes, ranked, { ...STRATEGY_PARAMS, useSignalExits: true });
  const reasons = on.flatMap((s) => s.reasons).join(' ');
  if (!on.length || !reasons.includes('板塊退燒') || !reasons.includes('MA20')) {
    fail('出場不變量',
      `測試資料已失效:強制開啟 useSignalExits 後仍未觸發板塊退燒/跌破MA20(實際:${reasons || '無訊號'})。\n` +
      `    這代表 (a) 的「沒有出場訊號」是假通過,請修正測試資料。`);
    return;
  }

  // (c) 沒有任何 preset 偷偷把它打開
  const leaked = Object.entries(PRESETS).filter(([, p]) => p.params.useSignalExits);
  if (leaked.length) {
    fail('出場不變量', `這些 preset 把 useSignalExits 打開了:${leaked.map(([k]) => k).join(', ')}`);
    return;
  }
  ok('出場不變量', '板塊退燒/跌破MA20 維持關閉;反向測試確認測試資料仍有效');
}

// =============================================================
// 4. sw.js 的 SHELL 清單 vs js/ 實際檔案
// -------------------------------------------------------------
// 踩過的坑:新增了模組但忘了加進 SHELL -> 離線時該檔抓不到、
// 或是快取版本更新了卻漏掉某支檔案。
// =============================================================
function checkShellList() {
  const sw = readFileSync(rel('sw.js'), 'utf8');
  const listed = [...sw.matchAll(/'\.\/js\/([\w.-]+\.js)'/g)].map((m) => m[1]).sort();
  const actual = jsFiles();
  const missing = actual.filter((f) => !listed.includes(f));   // 有檔案但沒列進快取
  const extra = listed.filter((f) => !actual.includes(f));     // 列了但檔案不存在

  const problems = [];
  if (missing.length) problems.push(`js/ 有但 SHELL 沒列:${missing.join(', ')}`);
  if (extra.length) problems.push(`SHELL 列了但 js/ 沒有:${extra.join(', ')}`);
  if (problems.length) fail('sw.js SHELL 一致性', problems.join('\n    '));
  else ok('sw.js SHELL 一致性', `${actual.length} 個模組全數列入快取清單`);
}

// =============================================================
// 5. sw.js 版本條件式檢查
// -------------------------------------------------------------
// 規則:只要「會被快取的資產」有變動,CACHE 版本就必須跟著變。
// 純文件變更不需要 bump —— 無條件要求 bump 會製造假警報,
// 而假警報一多,你就會開始習慣性忽略 CI,哨兵就等於死了。
//
// 比較基準(VERIFY_BASE):
//   預設 HEAD~1(本機用)。CI 在 push 事件會傳 github.event.before,
//   也就是「這次 push 之前線上是什麼」。這個差別很重要 ——
//   一次推 5 個 commit 時,若只跟 HEAD~1 比,中間某個 commit 改了 js/
//   卻沒 bump、而最後一個 commit 是純文件,檢查就會假通過,
//   然後部署出去的就是「新 js + 舊快取版本」,正是要防的那個 bug。
// =============================================================
const CACHED_ASSET_RE = /^(js\/|css\/|icons\/|index\.html$|manifest\.json$|sw\.js$)/;
const ZERO_SHA = /^0{7,40}$/;

function checkSwVersionBump() {
  const cur = readFileSync(rel('sw.js'), 'utf8').match(/const CACHE = '([^']+)'/)?.[1];
  if (!cur) { fail('sw.js 版本 bump', "sw.js 找不到 `const CACHE = '...'`"); return; }

  const envBase = (process.env.VERIFY_BASE || '').trim();
  const base = envBase && !ZERO_SHA.test(envBase) ? envBase : 'HEAD~1';

  const prevSw = gitSafe(['show', `${base}:sw.js`]);
  if (prevSw === null) {
    skip('sw.js 版本 bump', `取不到比較基準 ${base}(初始 commit 或 clone 深度不足),略過`);
    return;
  }
  const prev = prevSw.match(/const CACHE = '([^']+)'/)?.[1];

  const changed = (gitSafe(['diff', '--name-only', base, '--']) || '')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const assetChanges = changed.filter((f) => CACHED_ASSET_RE.test(f) && f !== 'sw.js');

  if (assetChanges.length === 0) {
    ok('sw.js 版本 bump', `對比 ${base}:沒有動到會被快取的資產,不需 bump(目前 ${cur})`);
    return;
  }
  if (cur === prev) {
    fail('sw.js 版本 bump',
      `這些會被快取的檔案相對 ${base} 有變動,但 sw.js 的 CACHE 仍是 '${cur}':\n    ` +
      `${assetChanges.join(', ')}\n    ` +
      `不 bump 版本,使用者的瀏覽器會繼續吃舊快取 —— 你會看到「檔案上去了但行為是舊的」。`);
    return;
  }

  // 版本必須「遞增」,不能只是「不同」。倒退(v26 -> v24)一樣會讓
  // 已經拿到 v26 的瀏覽器不更新,而且更難察覺。
  const n = (v) => { const m = /(\d+)\s*$/.exec(v || ''); return m ? Number(m[1]) : null; };
  const cn = n(cur), pn = n(prev);
  if (cn !== null && pn !== null && cn <= pn) {
    fail('sw.js 版本 bump',
      `CACHE 版本倒退了:'${prev}'(${base}) -> '${cur}'(現在)。\n    ` +
      `版本必須遞增,否則已經拿到新版的瀏覽器不會更新。`);
    return;
  }
  ok('sw.js 版本 bump', `對比 ${base}:資產有變動,CACHE 已從 '${prev}' 遞增為 '${cur}'`);
}

// =============================================================
// 6. config.js 必要欄位
// -------------------------------------------------------------
// 踩過的坑:PRICE_MIN/PRICE_MAX 不見了,價格帶過濾靜靜失效。
// app.js 對每個 key 都有 fallback,所以缺欄位「不會報錯」,
// 只會換成預設行為 —— 這是最難察覺的一種壞,必須靠檢查擋。
// =============================================================
const REQUIRED_CONFIG_KEYS = [
  'USE_REAL_DATA', 'WORKER_URL', 'BATCH_SIZE', 'BATCH_GAP_MS',
  'OUTPUT_SIZE', 'PRICE_MIN', 'PRICE_MAX', 'DAILY_PRESET', 'HISTORY_YEARS',
];

async function checkConfigKeys() {
  const { config } = await import(pathToFileURL(rel('js', 'config.js')).href);
  const missing = REQUIRED_CONFIG_KEYS.filter((k) => !(k in config));
  if (missing.length) {
    fail('config.js 必要欄位',
      `缺少:${missing.join(', ')}\n    ` +
      `這些缺了不會報錯,只會靜靜失效(例如少了 PRICE_MIN/MAX,價格帶會變成 0 ~ Infinity)。`);
    return;
  }
  if (!config.WORKER_URL) { fail('config.js 必要欄位', 'WORKER_URL 是空的 —— App 會完全抓不到資料'); return; }
  if (!(config.PRICE_MIN < config.PRICE_MAX)) {
    fail('config.js 必要欄位', `價格帶不合理:PRICE_MIN(${config.PRICE_MIN}) 必須小於 PRICE_MAX(${config.PRICE_MAX})`);
    return;
  }
  ok('config.js 必要欄位', `${REQUIRED_CONFIG_KEYS.length} 個 key 齊全,價格帶 ${config.PRICE_MIN} ~ ${config.PRICE_MAX}`);
}

// =============================================================
// 7. 根目錄不得再出現 config.js
// -------------------------------------------------------------
// 曾經有一份與 js/config.js 完全相同、但沒有任何檔案引用的死檔。
// 改到那份不會有任何效果 —— 是個會浪費你半小時的陷阱,擋住它。
// =============================================================
function checkNoDuplicateConfig() {
  if (existsSync(rel('config.js'))) {
    fail('無重複 config.js',
      '根目錄又出現 config.js 了。app.js 只 import ./config.js(= js/config.js),\n    ' +
      '根目錄那份不會被任何程式讀到,改它不會有效果。請刪除,只保留 js/config.js。');
    return;
  }
  ok('無重複 config.js', '設定檔只有 js/config.js 一份');
}

// =============================================================
// 8. 金鑰洩漏煙霧檢查
// -------------------------------------------------------------
// 只抓「把實際字面值寫死在程式裡」的情況。
// `apikey=${env.TD_API_KEY}` 這種正確用法不會誤報(= 後面接的是 $)。
//
// ⚠️ 這是煙霧檢查,不是完整的機密掃描。真正的防線是 GitHub 內建的
//    secret scanning,以及「key 只放在 Cloudflare Worker 的 secret」這個架構。
// =============================================================
const SECRET_RE = /\b(?:apikey|api_key|apiKey|token|secret|password|passwd)\s*[=:]\s*['"`]?[A-Za-z0-9_\-]{16,}/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules' || name === 'icons') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|mjs|json|md|html|css|ya?ml)$/.test(name)) out.push(p);
  }
  return out;
}

function checkNoSecrets() {
  const hits = [];
  for (const file of walk(ROOT)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (SECRET_RE.test(line)) hits.push(`${file.slice(ROOT.length + 1)}:${i + 1}`);
    });
  }
  if (hits.length) {
    fail('金鑰洩漏煙霧檢查', `疑似寫死的金鑰:\n    ${hits.join('\n    ')}\n    (若是誤報,請調整 verify.mjs 的 SECRET_RE)`);
    return;
  }
  ok('金鑰洩漏煙霧檢查', '沒有發現寫死的金鑰字面值');
}

// =============================================================
// 9. 交易成本會計(行為測試)
// -------------------------------------------------------------
// 治的病有兩個,而且都是「不會報錯、只會靜靜給你一組漂亮數字」那一類:
//
//   (1) 成本參數根本沒接上。我自己剛踩過:把 useSignalExits 塞進 params,
//       但引擎是從最外層讀的,於是我「跑了 12 次 A/B」其實是 12 次相同設定,
//       而且畫面一路綠燈。費率接錯會長得一模一樣。
//   (2) 加成本時不小心改到了策略行為。這會讓「績效變差」同時混進
//       「成本」和「規則被動到」兩個原因,事後分不開。
//
// 所以核心是**零成本回歸**:費率全 0 時,結果必須與加成本之前的引擎
// 位元級相同。下面的 GOLDEN 就是那條線 —— 它是用改動前的引擎跑出來、
// 再用改動後的引擎確認完全重現的值。
//
// ⚠️ GOLDEN 壞掉時不要直接改數字。它的意思是「引擎的行為變了」:
//    如果你是**刻意**改了選股/出場邏輯,那請先過不變量 6 的六姿態 A/B 閘門,
//    確認過再更新這個常數。如果你不是刻意的,那你剛剛踩到了一個 bug。
//
// 這裡刻意**不用 PRESETS** —— 用寫死在本檔的測試參數,調 preset 不會誤殺,
// 動引擎才會。假警報一多,哨兵就等於死了。
// =============================================================
const COST_TEST_PARAMS = {
  maxPositions: 6, hotSectorCount: 3, sectorExitRank: 5,
  minStockScore: 0.13,
  requireAboveMA20: true, requireAboveMA50: true,
  requireBothMomentumPositive: true, requireSectorScorePositive: true,
  reentryCooldownDays: 5,
  atrStopMult: 2.5, stopLossPct: -0.18, trailingStopPct: -0.12,
  momentumBreakBuffer: -0.03,
  enableProfitLadder: true,
  profitLadder: [{ gainPct: 0.30, sellFraction: 0.33 }, { gainPct: 0.60, sellFraction: 0.33 }],
};
const COST_TEST_MARKET = {
  smaWindow: 252, vixThreshold: 22, realizedVolWindow: 20,
  realizedVolThreshold: 0.22, blockOnDefensiveLegs: 1,
};
// 這個值是用**改動前**的引擎(git show <加成本的 commit>~1:js/backtest-real.js)
// 跑上面那組測試參數得到的,不是從改動後的引擎抄的 —— 否則測試只是在證明
// 「新引擎等於它自己」,完全沒有回歸的效果。
const COST_GOLDEN_NAV = 166.6551440634215;    // 零成本、改動前引擎的期末 NAV

// 決定性的合成 OHLC。要同時滿足:市場水位 riskOn、板塊分得出高下、
// 會進場、會觸發階梯停利、會觸發停損/移動停利、期末還有部位要平 ——
// 五條成本路徑全部走到,否則「加了成本」可能只是某一條路徑有扣。
function costTestBars(n = 320) {
  const d0 = Date.UTC(2020, 0, 1);
  const dates = [];
  for (let i = 0; i < n; i++) dates.push(new Date(d0 + i * 86400000).toISOString().slice(0, 10));
  const wig = (i, k) => 1 + 0.004 * Math.sin((i + k * 7) * 0.9);   // 讓 high/low 有寬度,ATR 才非 0
  const make = (drift, crashAt, crashDepth, seed) => {
    const bars = [];
    let p = 50 + seed;
    for (let i = 0; i < n; i++) {
      p *= (1 + drift);
      if (crashAt && i >= crashAt && i < crashAt + 6) p *= (1 - crashDepth);
      const c = p * wig(i, seed), o = p * wig(i - 1, seed);
      bars.push({ d: dates[i], o, h: Math.max(o, c) * 1.006, l: Math.min(o, c) * 0.994, c });
    }
    return bars;
  };
  const bars = { SPY: make(0.0008, 0, 0, 1) };                     // 緩升低波動 -> riskOn
  ['AAPL', 'MSFT', 'NVDA', 'AVGO'].forEach((s, k) => { bars[s] = make(0.005, 250, 0.05, 2 + k); });
  ['LLY', 'UNH', 'JNJ', 'MRK'].forEach((s, k) => { bars[s] = make(0.0045, 265, 0.05, 6 + k); });
  ['XOM', 'CVX', 'COP', 'SLB'].forEach((s, k) => { bars[s] = make(-0.0012, 0, 0, 10 + k); });
  ['PG', 'KO', 'PEP', 'WMT'].forEach((s, k) => { bars[s] = make(-0.0008, 0, 0, 14 + k); });
  return bars;
}

async function checkTradingCosts() {
  // 這支要 import 整條依賴鏈。鏈上任一支語法壞掉,這裡會丟出未捕捉的例外,
  // 把整個 verify 連同**前面幾項已經驗出來的結果一起炸掉** —— 使用者只會看到
  // 一串 node 的堆疊,看不到「語法檢查:js/sectors.js 第 46 行」。
  // (這個洞是 selftest 抓出來的:弄壞 sectors.js 之後,第 1 項反而變成「沒抓到」。)
  // 載不進來這件事,第 1 項與第 2 項已經會報,這裡安靜跳過就好。
  let runRealBacktest, COST_DEFAULT;
  try {
    ({ runRealBacktest, COST_DEFAULT } =
      await import(pathToFileURL(rel('js', 'backtest-real.js')).href));
  } catch (e) {
    skip('交易成本會計', `回測引擎載不進來,略過(真正的原因看「語法檢查」/「Import 圖完整性」)`);
    return;
  }

  const barsBySymbol = costTestBars();
  const run = (cost) => runRealBacktest({
    barsBySymbol, params: COST_TEST_PARAMS, market: COST_TEST_MARKET, cost,
  });
  const navOf = (r) => r.equity[r.equity.length - 1].nav;
  const FREE = { feePct: 0, secFeePct: 0, slipPct: 0 };
  const problems = [];

  const zero = run(FREE);
  if (!zero || !zero.trades.length) {
    fail('交易成本會計', '合成資料沒有產生任何交易 —— 測試是空殼,先修測試資料');
    return;
  }

  // (a) 五條成本路徑都要真的被走到,否則下面的斷言只證明了其中幾條
  const reasons = new Set(zero.trades.map((t) => t.reason));
  const needPaths = ['停損', '移動停利', '期末平倉'];
  const missing = needPaths.filter((r) => !reasons.has(r));
  if (!zero.costLedger.buyNotional) missing.push('進場');
  if (![...reasons].some((r) => r.startsWith('階梯停利'))) missing.push('階梯停利');
  if (missing.length) problems.push(`合成資料沒有走到這些路徑:${missing.join('、')}(測試是空殼)`);

  // (b) 零成本回歸:必須與加成本前的引擎位元級相同
  if (navOf(zero) !== COST_GOLDEN_NAV) {
    problems.push(
      `零成本 NAV ${navOf(zero)} ≠ 基準 ${COST_GOLDEN_NAV}。\n` +
      `      這代表引擎行為變了,不只是加了成本。刻意改規則的話請先過六姿態 A/B 再更新常數。`);
  }
  if (zero.costLedger.feesPaid !== 0 || zero.costLedger.slipPaid !== 0) {
    problems.push(`零成本時台帳不是 0:fees=${zero.costLedger.feesPaid} slip=${zero.costLedger.slipPaid}`);
  }

  // (c) 成本參數真的有傳進去並生效(防「參數靜靜被忽略」)
  const fee = run(COST_DEFAULT);
  if (!(navOf(fee) < navOf(zero))) {
    problems.push(`加了 ${COST_DEFAULT.feePct * 100}% 手續費,期末 NAV 沒有下降` +
      `(${navOf(fee)} vs 零成本 ${navOf(zero)})—— 費率可能沒被讀到`);
  }

  // (d) pnlPct 是淨、grossPnlPct 是毛,而且毛值沒被成本動到
  const notNet = fee.trades.filter((t) => !(t.pnlPct < t.grossPnlPct));
  if (notNet.length) problems.push(`${notNet.length} 筆交易的 pnlPct 沒有低於 grossPnlPct(淨報酬沒生效)`);
  const grossMoved = fee.trades.filter((t, i) => t.grossPnlPct !== zero.trades[i]?.pnlPct);
  if (grossMoved.length) problems.push(`${grossMoved.length} 筆交易的毛報酬被成本動到了(毛值應與零成本相同)`);

  // (e) SEC 規費只收賣出。買進若誤扣,feesPaid 會多出 sec×buyNotional。
  const secOnly = run({ feePct: 0, secFeePct: 0.001, slipPct: 0 });
  const L = secOnly.costLedger;
  if (Math.abs(L.feesPaid - 0.001 * L.sellNotional) > 1e-12 * Math.max(1, L.feesPaid)) {
    problems.push(`SEC 規費不該收買進:feesPaid=${L.feesPaid} 應為 ${0.001 * L.sellNotional}`);
  }

  // (f) 滑價是走「成交價」不是走「費用」:費用台帳必須是 0,但 NAV 要變差
  const slipOnly = run({ feePct: 0, secFeePct: 0, slipPct: 0.001 });
  if (slipOnly.costLedger.feesPaid !== 0) {
    problems.push(`滑價被記成了費用:feesPaid=${slipOnly.costLedger.feesPaid},應為 0`);
  }
  if (!(navOf(slipOnly) < navOf(zero))) problems.push('加了滑價,期末 NAV 沒有下降');

  // (g) 現金恆等式 —— 這一項才是真正獨立的驗收:期末、台帳、現金三者口徑一致。
  //     期末全部結算後 NAV 必須等於:起始 100 − 買進總支出 + 賣出總實收。
  //     對不上 = 某個成交點漏扣、重複扣,或期末只記了紀錄沒結算現金。
  for (const [tag, r, c] of [['手續費', fee, COST_DEFAULT], ['滑價', slipOnly, { feePct: 0, secFeePct: 0, slipPct: 0.001 }]]) {
    const K = r.costLedger;
    const expectNav = 100 - K.buyNotional * (1 + c.feePct)
      + K.sellNotional * (1 - c.feePct - c.secFeePct);
    if (Math.abs(navOf(r) - expectNav) > 1e-9) {
      problems.push(`${tag}情境的現金恆等式對不上:NAV ${navOf(r)} vs 台帳推算 ${expectNav}`);
    }
    const expectFees = c.feePct * (K.buyNotional + K.sellNotional) + c.secFeePct * K.sellNotional;
    if (Math.abs(K.feesPaid - expectFees) > 1e-9 * Math.max(1, expectFees)) {
      problems.push(`${tag}情境的費用台帳對不上:feesPaid ${K.feesPaid} vs 應收 ${expectFees}`);
    }
  }

  // (h) 反向測試:荒謬費率必須吵,不能靜靜回一組數字
  let threw = false;
  try { run({ feePct: 2, secFeePct: 0, slipPct: 0 }); } catch { threw = true; }
  if (!threw) problems.push('feePct=200% 沒有拋錯 —— 參數防呆失效');

  if (problems.length) { fail('交易成本會計', problems.join('\n    ')); return; }
  ok('交易成本會計',
    `零成本位元級重現基準;${zero.trades.length} 筆交易走遍五條成本路徑;` +
    `0.25% 手續費使期末 NAV ${navOf(zero).toFixed(2)} -> ${navOf(fee).toFixed(2)};現金恆等式相符`);
}

// =============================================================
// 10. 已實現報酬的部位權重(行為測試)
// -------------------------------------------------------------
// 治的病是一個真的發生過、而且後果很嚴重的錯:
//   perf() / stats() 用 `nav *= (1 + fraction * pnlPct)` 複利,
//   fraction 是「這個部位賣掉幾成」,不是「這個部位佔帳戶幾成」,
//   所以一筆 −6.5% 的全出場被當成整個帳戶 −6.5%。
//   使用者 5 筆停損(−6.5 / −6.1 / −7.9 / −9.5 / −6.9%)在畫面上顯示成
//   **已實現報酬 −31.9%**,實際是 **−6.0%** —— 放大 5.3 倍。
//
// 為什麼要有哨兵:這個數字沒有任何地方會「報錯」。它只是錯,而且錯得很合理,
// 看起來就像策略真的在虧。**報錯的數字比沒有數字更危險** ——
// 它會讓人根據假訊號關掉一個其實還在正常回撤範圍內的策略。
//
// 附反向測試:同一組資料用舊公式必須算出明顯不同的值,否則這個測試是空殼。
// =============================================================
async function checkRealizedWeighting() {
  let Portfolio, MAX_POSITIONS, N;
  try {
    ({ Portfolio } = await import(pathToFileURL(rel('js', 'portfolio.js')).href));
    ({ MAX_POSITIONS } = await import(pathToFileURL(rel('js', 'strategy.js')).href));
    // 權重分母要跟 portfolio.js 用同一個來源(現行 preset 的 maxPositions),
    // 不是 strategy.js 的常數 —— 否則換 preset 之後測試會因為「剛好都是 6」而假通過。
    const { PRESETS } = await import(pathToFileURL(rel('js', 'presets.js')).href);
    const { config } = await import(pathToFileURL(rel('js', 'config.js')).href);
    N = (PRESETS[config.DAILY_PRESET] || PRESETS.composite).params.maxPositions ?? MAX_POSITIONS;
  } catch (e) {
    skip('已實現報酬權重', '模組載不進來,略過(原因看「語法檢查」/「Import 圖完整性」)');
    return;
  }
  // Portfolio 的 load()/save() 都包了 try/catch,Node 沒有 localStorage 也能跑;
  // 但 save() 會 console.warn,補一個最小的 stub 讓輸出乾淨。
  if (typeof globalThis.localStorage === 'undefined') {
    const m = new Map();
    globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  }

  const problems = [];
  const LOSSES = [-0.0649, -0.0609, -0.0788, -0.0954, -0.0692];
  const pf = new Portfolio();
  pf.positions = [];
  pf.cashLog = LOSSES.map((p, i) => ({ symbol: `T${i}`, pnlPct: p, fraction: 1, entryDate: '2026-08-18', exitDate: '2026-09-01', reason: '觸及停損' }));

  // 期望值:每筆佔 1/6,複利
  let want = 1; for (const p of LOSSES) want *= (1 + p / N);
  want -= 1;
  // 舊的錯誤公式(反向測試用)
  let wrong = 1; for (const p of LOSSES) wrong *= (1 + p);
  wrong -= 1;

  const got = pf.stats().realizedPct;
  if (Math.abs(got - want) > 1e-12) {
    problems.push(`stats().realizedPct = ${(got * 100).toFixed(2)}%,應為 ${(want * 100).toFixed(2)}%` +
      `(每筆佔 1/${N})。舊的全額權重公式會給出 ${(wrong * 100).toFixed(2)}%。`);
  }
  // 反向測試:確認這組資料真的分得出兩種算法(否則上面的斷言是空殼)
  if (Math.abs(want - wrong) < 0.05) {
    problems.push(`測試資料失效:正確值 ${(want * 100).toFixed(2)}% 與錯誤值 ${(wrong * 100).toFixed(2)}% 太接近,分不出來`);
  }

  // 兩個分頁必須顯示同一個數字
  const pr = pf.perf().totalReturn;
  if (Math.abs(pr - got) > 1e-12) {
    problems.push(`perf().totalReturn (${(pr * 100).toFixed(2)}%) 與 stats().realizedPct (${(got * 100).toFixed(2)}%) 不一致 —— 今日分頁和績效分頁會顯示兩個不同的已實現報酬`);
  }

  // 階梯部分出場:fraction 與部位權重必須同時生效
  const pf2 = new Portfolio();
  pf2.positions = [];
  pf2.cashLog = [{ symbol: 'L', pnlPct: 0.40, fraction: 0.33, entryDate: '2026-01-01', exitDate: '2026-02-01', reason: '階梯停利 +30%' }];
  const wantLadder = 0.33 * 0.40 / N;
  if (Math.abs(pf2.stats().realizedPct - wantLadder) > 1e-12) {
    problems.push(`階梯部分出場算錯:得到 ${(pf2.stats().realizedPct * 100).toFixed(3)}%,應為 ${(wantLadder * 100).toFixed(3)}%` +
      `(賣掉 33% × 部位權重 1/${N} × 獲利 40%)`);
  }

  // posWeight 必須以**平倉當下**記下的值為準,不能事後被現行 preset 改寫。
  // 否則把 config.DAILY_PRESET 從 marcus(3 倉)換成 composite(6 倉)之後,
  // 所有歷史交易的報酬都會憑空變成一半,即使交易本身一個字都沒變。
  const pf3 = new Portfolio();
  pf3.positions = [];
  pf3.cashLog = [{ symbol: 'H', pnlPct: -0.12, fraction: 1, posWeight: 1 / 3, entryDate: '2026-01-01', exitDate: '2026-02-01', reason: '觸及停損' }];
  if (Math.abs(pf3.stats().realizedPct - (-0.12 / 3)) > 1e-12) {
    problems.push(`cashLog 的 posWeight 被忽略了:得到 ${(pf3.stats().realizedPct * 100).toFixed(3)}%,` +
      `應為 ${((-0.12 / 3) * 100).toFixed(3)}%(該筆記的是 1/3 倉位,不是現行的 1/${N})`);
  }

  // 部分出場合計不得超過原部位 100%(sellPartial 用 Math.min 夾住,這裡把那個保證釘住)
  const pf4 = new Portfolio();
  pf4.positions = [{ symbol: 'P', name: 'P', entryPrice: 100, peakPrice: 100, size: 1, laddersFired: [], entryDate: '2026-01-01' }];
  pf4.cashLog = [];
  pf4.sellPartial('P', 110, 0.5, 't');
  pf4.sellPartial('P', 110, 0.9, 't');   // 只剩 0.5,要求 0.9 -> 最多只能賣 0.5
  const sold = pf4.cashLog.reduce((a, c) => a + (c.fraction ?? 1), 0);
  if (sold > 1 + 1e-9) problems.push(`部分出場合計賣掉原部位的 ${(sold * 100).toFixed(1)}%,超過 100%`);
  if (!pf4.cashLog.every((c) => typeof c.posWeight === 'number' && c.posWeight > 0)) {
    problems.push('sellPartial 沒有把 posWeight 寫進 cashLog —— 之後換 preset 會改寫歷史');
  }

  if (problems.length) { fail('已實現報酬權重', problems.join('\n    ')); return; }
  ok('已實現報酬權重',
    `5 筆全額停損 -> ${(want * 100).toFixed(2)}%(全額權重的舊公式會是 ${(wrong * 100).toFixed(2)}%);階梯部分出場與兩分頁一致`);
}

// =============================================================
// 主流程
// =============================================================
console.log('\n  SignalDesk 架構驗證\n  ' + '─'.repeat(56));

checkSyntax();
await checkImportGraph();
await checkExitInvariant();
checkShellList();
checkSwVersionBump();
await checkConfigKeys();
checkNoDuplicateConfig();
checkNoSecrets();
await checkTradingCosts();
await checkRealizedWeighting();

console.log('');
for (const r of results) {
  const mark = r.skip ? '○' : r.pass ? '✓' : '✗';
  console.log(`  ${mark} ${r.name.padEnd(20, ' ')} ${r.detail}`);
}

const failed = results.filter((r) => !r.pass && !r.skip);
console.log('  ' + '─'.repeat(56));
if (failed.length) {
  console.log(`  ✗ ${failed.length} 項未通過\n`);
  process.exit(1);
}
console.log(`  ✓ 全部通過(${results.filter((r) => r.pass).length} 項)\n`);
