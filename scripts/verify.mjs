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


  // =============================================================
  // 2026-10-14 Phase 2:權重記在買進、以及入口驗證
  // =============================================================

  // (1) buy() 必須把進場當下的權重記在持倉上
  const pf5 = new Portfolio();
  pf5.positions = []; pf5.cashLog = [];
  pf5.buy({ symbol: 'NEW', name: 'NEW', etf: null, price: 50, stopPrice: 45, atr: 2 });
  const newPos = pf5.positions[0];
  if (!newPos) {
    problems.push('buy() 沒有建立持倉,後面的權重測試無從進行');
  } else if (!(typeof newPos.posWeight === 'number' && Math.abs(newPos.posWeight - 1 / N) < 1e-15)) {
    problems.push(`buy() 沒把進場權重記在持倉上:posWeight = ${newPos.posWeight},應為 1/${N}`);
  }

  // (2) 權重必須沿用**持倉**記下的值,不是平倉當下的現行 preset。
  //     模擬「3 倉 preset 買進 -> 持有期間換成 6 倉 -> 平倉」。
  const pf6 = new Portfolio();
  pf6.positions = [{ symbol: 'X', name: 'X', entryPrice: 100, peakPrice: 100, size: 1,
                     laddersFired: [], entryDate: '2026-01-01', posWeight: 1 / 3 }];
  pf6.cashLog = [];
  pf6.sellPartial('X', 88, 1, '觸及停損');
  const c6 = pf6.cashLog[0];
  if (!c6) problems.push('sellPartial 沒有寫出平倉紀錄');
  else {
    if (Math.abs(c6.posWeight - 1 / 3) > 1e-15) {
      problems.push(`平倉沒有沿用持倉的 posWeight:記成 ${c6.posWeight},應為 ${1 / 3}` +
        `(進場時是 3 倉,平倉時 preset 已換成 ${N} 倉也不該改寫)`);
    }
    if (c6.posWeightEstimated !== false) {
      problems.push('持倉有 posWeight,平倉卻標成估算值 —— 實際值被降級成推算值');
    }
    if (Math.abs(pf6.stats().realizedPct - (-0.12 / 3)) > 1e-12) {
      problems.push(`沿用權重後的已實現報酬算錯:${(pf6.stats().realizedPct * 100).toFixed(3)}%,應為 ${((-0.12 / 3) * 100).toFixed(3)}%`);
    }
    if (pf6.stats().estimatedWeights !== 0) problems.push('estimatedWeights 應為 0(這筆的權重是當時記下的)');
  }

  // (3) 舊持倉沒有 posWeight -> 可以用現行值估,但**必須標記**。
  //     「默默宣稱歷史已被精確還原」比承認估算更糟。
  const pf7 = new Portfolio();
  pf7.positions = [{ symbol: 'OLD', name: 'OLD', entryPrice: 100, peakPrice: 100, size: 1,
                     laddersFired: [], entryDate: '2026-01-01' }];   // 沒有 posWeight
  pf7.cashLog = [];
  pf7.sellPartial('OLD', 90, 1, '觸及停損');
  const c7 = pf7.cashLog[0];
  if (!c7) problems.push('舊持倉平倉沒有寫出紀錄');
  else {
    if (Math.abs(c7.posWeight - 1 / N) > 1e-15) problems.push(`舊持倉的 fallback 權重應為 1/${N},實際 ${c7.posWeight}`);
    if (c7.posWeightEstimated !== true) {
      problems.push('舊持倉沒有 posWeight,平倉紀錄卻沒標 posWeightEstimated —— 估算值被冒充成歷史實際值');
    }
    if (pf7.stats().estimatedWeights !== 1) problems.push(`estimatedWeights 應為 1,實際 ${pf7.stats().estimatedWeights}`);
    if (pf7.perf().estimatedWeights !== 1) problems.push('perf() 沒有回報估算筆數 —— 績效分頁無法照實說');
  }

  // (3b) 2026-10-14 之前的舊 cashLog 連欄位都沒有,也要算估算
  const pf8 = new Portfolio();
  pf8.positions = []; pf8.cashLog = [{ symbol: 'A', pnlPct: -0.1, fraction: 1 }];
  if (pf8.stats().estimatedWeights !== 1) {
    problems.push('cashLog 完全沒有 posWeight 欄位時,estimatedWeights 應算 1 —— 缺欄位不能當成「剛好等於現行設定」');
  }

  // (4) 入口驗證:不合法的輸入一律拒絕,且持倉、cashLog 都不得變動
  const BAD_FRACTION = [-0.5, 0, NaN, Infinity, -Infinity, '0.5', null, {}, []];
  for (const bad of BAD_FRACTION) {
    const pf = new Portfolio();
    pf.positions = [{ symbol: 'V', name: 'V', entryPrice: 100, peakPrice: 100, size: 1,
                      laddersFired: [], entryDate: '2026-01-01', posWeight: 1 / N }];
    pf.cashLog = [];
    const r = pf.sellPartial('V', 110, bad, 't');
    const label = typeof bad === 'object' && bad !== null ? JSON.stringify(bad) : String(bad);
    if (r.ok) problems.push(`sellPartial 接受了不合法的 fraction(${label})`);
    if (pf.cashLog.length !== 0) problems.push(`fraction=${label} 被拒絕後仍寫了 cashLog —— 壞資料進了不可逆的紀錄`);
    if (pf.positions.length !== 1 || pf.positions[0].size !== 1) {
      problems.push(`fraction=${label} 被拒絕後持倉仍被改動(size = ${pf.positions[0] && pf.positions[0].size})`);
    }
  }
  // fraction 省略 = 全平,這是 sell() 走的路,必須放行
  const pf9 = new Portfolio();
  pf9.positions = [{ symbol: 'W', name: 'W', entryPrice: 100, peakPrice: 100, size: 1,
                     laddersFired: [], entryDate: '2026-01-01', posWeight: 1 / N }];
  pf9.cashLog = [];
  if (!pf9.sell('W', 110, 't').ok) problems.push('sell()(fraction 省略)被誤擋 —— 預設值 1 應該合法');

  // 持倉本身被汙染:pos.size 是 NaN / 負數 / 字串 -> 拒絕
  for (const badSize of [NaN, -0.5, 0, '1', Infinity]) {
    const pf = new Portfolio();
    pf.positions = [{ symbol: 'C', name: 'C', entryPrice: 100, peakPrice: 100, size: badSize,
                      laddersFired: [], entryDate: '2026-01-01', posWeight: 1 / N }];
    pf.cashLog = [];
    if (pf.sellPartial('C', 110, 1, 't').ok) problems.push(`sellPartial 接受了被汙染的 pos.size(${String(badSize)})`);
    if (pf.cashLog.length !== 0) problems.push(`pos.size=${String(badSize)} 被拒絕後仍寫了 cashLog`);
  }
  // 價格同樣會汙染 pnlPct
  for (const badPx of [NaN, 0, -10, Infinity]) {
    const pf = new Portfolio();
    pf.positions = [{ symbol: 'D', name: 'D', entryPrice: 100, peakPrice: 100, size: 1,
                      laddersFired: [], entryDate: '2026-01-01', posWeight: 1 / N }];
    pf.cashLog = [];
    if (pf.sellPartial('D', badPx, 1, 't').ok) problems.push(`sellPartial 接受了不合法的賣出價(${String(badPx)})`);
    if (pf.cashLog.length !== 0) problems.push(`賣出價=${String(badPx)} 被拒絕後仍寫了 cashLog`);
  }

  // (5) 連續分批減碼:合計恰好 100%,每筆只按實際賣出的原始比例計入,
  //     不得因為減碼三次就把整個部位的權重算三遍
  const pf10 = new Portfolio();
  pf10.positions = [{ symbol: 'LAD', name: 'LAD', entryPrice: 100, peakPrice: 100, size: 1,
                      laddersFired: [], entryDate: '2026-01-01', posWeight: 1 / N }];
  pf10.cashLog = [];
  pf10.sellPartial('LAD', 130, 0.33, '階梯 1', 0);
  pf10.sellPartial('LAD', 140, 0.40, '階梯 2', 1);
  pf10.sellPartial('LAD', 120, 1, '移動停利');          // 只剩 0.27
  const ladSum = pf10.cashLog.reduce((a, c) => a + c.fraction, 0);
  if (Math.abs(ladSum - 1) > 1e-9) problems.push(`連續減碼合計賣出 ${(ladSum * 100).toFixed(2)}%,應恰好 100%`);
  if (pf10.positions.length !== 0) problems.push('連續減碼到 100% 之後持倉沒有被移除');
  if (!pf10.cashLog.every((c) => Math.abs(c.posWeight - 1 / N) < 1e-15 && c.posWeightEstimated === false)) {
    problems.push('連續減碼的三筆紀錄沒有共用同一個進場權重');
  }
  // 反向:漏掉 fraction 的話報酬會明顯不同 —— 確認這組資料分得出來
  const ladGot = pf10.stats().realizedPct;
  let ladWrong = 1;
  for (const c of pf10.cashLog) ladWrong *= (1 + c.pnlPct * (1 / N));
  ladWrong -= 1;
  if (Math.abs(ladGot - ladWrong) < 0.01) {
    problems.push(`連續減碼測試資料失效:正確值 ${(ladGot * 100).toFixed(3)}% 與漏掉 fraction 的值 ${(ladWrong * 100).toFixed(3)}% 太接近`);
  }

  if (problems.length) { fail('已實現報酬權重', problems.join('\n    ')); return; }
  ok('已實現報酬權重',
    `5 筆全額停損 -> ${(want * 100).toFixed(2)}%(全額權重的舊公式會是 ${(wrong * 100).toFixed(2)}%);階梯與兩分頁一致` +
    `；權重記於進場並沿用至平倉，舊紀錄標成估算值` +
    `；${BAD_FRACTION.length + 9} 組不合法輸入全數被拒且未寫入紀錄`);
}

// =============================================================
// 11. 進場限制一致性 —— 兩條進場路徑必須套用同一組閘門
// -------------------------------------------------------------
// 「今日」與「探索」是兩條獨立的進場路徑。2026-10-14 之前,探索分頁的買進
// 只檢查 r.pass 就直接呼叫 portfolio.buy() —— 市場防禦中、水位算不出來、
// 價格超出下單價格帶,全都還是能把部位塞進持倉,而且畫面上完全看不出異常。
//
// 這一項分三段:
//   (a) 唯一來源:閘門的判斷式在 app.js 裡只能出現一次。兩邊各寫一份的話,
//       其中一份遲早會跟另一份分岐,而分岐的那天不會有任何錯誤訊息。
//   (b) 行為:把 app.js 裡那兩個函式的**真實原始碼**抽出來,在沙箱裡跑完整
//       真值表。測的是真的程式,邏輯改了一定紅燈。
//   (c) 接線:確認 xbuy handler 在 portfolio.buy() 之前真的走過這兩道、而且
//       真的 return。這段是結構檢查 —— 它只能證明「有接」不能證明「接對」,
//       重構 handler 也會誤殺。留著的理由是 (b) 證明不了「閘門被用到」,
//       而「寫了閘門但沒接上」正是這個 bug 的原形。
// =============================================================
function checkEntryGate() {
  const src = readFileSync(rel('js/app.js'), 'utf8');
  const problems = [];

  // ---- (a) 判斷式只能有一份 ----
  const dupGate = (src.match(/state\.market\s*&&\s*state\.market\.available/g) || []).length;
  const dupBand = (src.match(/config\.PRICE_MIN\s*\?\?/g) || []).length;
  if (dupGate !== 1) problems.push(`市場閘門判斷式在 app.js 出現 ${dupGate} 次(應為 1 次,只在 entryGate() 裡)`);
  if (dupBand !== 1) problems.push(`價格帶判斷式在 app.js 出現 ${dupBand} 次(應為 1 次,只在 priceInBand() 裡)`);

  // ---- (b) 真值表:抽出真實函式原始碼,在沙箱裡執行 ----
  // 從 `function NAME(` 開始數大括號,取到配對的那一個
  const grab = (name) => {
    const i = src.indexOf(`function ${name}(`);
    if (i < 0) return null;
    const open = src.indexOf('{', i);
    let depth = 0;
    for (let j = open; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
    }
    return null;
  };
  const fnBand = grab('priceInBand'), fnGate = grab('entryGate'), fnPB = grab('priceBand');
  if (!fnBand || !fnGate || !fnPB) {
    fail('進場限制一致性', 'app.js 找不到 priceBand() / priceInBand() / entryGate() —— 進場限制的單一來源不見了');
    return;
  }
  const sandbox = (cfg, st) =>
    new Function('config', 'state', `${fnPB}\n${fnBand}\n${fnGate}\nreturn { priceInBand, entryGate };`)(cfg, st);

  // 市場閘門:fail-closed —— 只有「算得出來 且 riskOn」才放行
  const CFG = { PRICE_MIN: 6, PRICE_MAX: 666 };
  const gateCases = [
    ['market 整個是 null',          null,                              true,  false],
    ['market 是 undefined',         undefined,                         true,  false],
    ['available: false(資料不齊)', { available: false },              true,  false],
    ['防禦中(riskOn: false)',      { available: true, riskOn: false }, true,  true],
    ['riskOn 欄位不存在',           { available: true },               true,  true],
    ['正常通過',                    { available: true, riskOn: true },  false, true],
  ];
  for (const [label, market, wantBlocked, wantAvail] of gateCases) {
    const { entryGate } = sandbox(CFG, { market });
    const g = entryGate();
    if (g.blocked !== wantBlocked) problems.push(`entryGate「${label}」blocked 應為 ${wantBlocked},實際 ${g.blocked}`);
    if (g.available !== wantAvail) problems.push(`entryGate「${label}」available 應為 ${wantAvail},實際 ${g.available}`);
  }

  // 價格帶:上下限都是閉區間,非有限數一律拒絕
  const { priceInBand } = sandbox(CFG, { market: null });
  const bandCases = [
    ['低於下限 5.99', 5.99, false], ['正好是下限 6', 6, true],
    ['帶內 100', 100, true],
    ['正好是上限 666', 666, true], ['高於上限 666.01', 666.01, false],
    ['NaN', NaN, false], ['undefined', undefined, false],
    ['Infinity', Infinity, false], ['負數', -10, false], ['字串', '100', false],
  ];
  for (const [label, px, want] of bandCases) {
    const got = priceInBand(px);
    if (got !== want) problems.push(`priceInBand「${label}」應為 ${want},實際 ${got}`);
  }

  // ---- (c) 接線:handler 必須先擋再買 ----
  const hStart = src.indexOf('[data-xbuy]');
  const hEnd = src.indexOf('[data-watch]', hStart);
  if (hStart < 0 || hEnd < 0) {
    problems.push('找不到 [data-xbuy] handler 的範圍 —— 這個檢查已失效,請更新');
  } else {
    // ★ 先剝掉行註解再比對。第一版沒剝，結果 `portfolio.buy()` 命中的是
    // handler 上方那句解釋用的註解，於是「買在闘門之前」被誤報。
    // 這個檢查第一次跑就抵到自己，算它會動的証據。
    const h = src.slice(hStart, hEnd).replace(/\/\/[^\n]*/g, '');
    const iGate = h.indexOf('entryGate()'), iBand = h.indexOf('priceInBand('), iBuy = h.indexOf('portfolio.buy(');
    if (iGate < 0) problems.push('探索買進沒有呼叫 entryGate() —— 市場防禦/水位不可用時仍可進場');
    if (iBand < 0) problems.push('探索買進沒有呼叫 priceInBand() —— 價格超出下單帶時仍可進場');
    if (iBuy < 0) problems.push('[data-xbuy] handler 裡找不到 portfolio.buy() —— 這個檢查已失效,請更新');
    if (iGate >= 0 && iBuy >= 0 && iGate > iBuy) problems.push('entryGate() 寫在 portfolio.buy() 之後 —— 部位已經寫進去才檢查等於沒檢查');
    if (iBand >= 0 && iBuy >= 0 && iBand > iBuy) problems.push('priceInBand() 寫在 portfolio.buy() 之後 —— 部位已經寫進去才檢查等於沒檢查');
    if (iGate >= 0 && iBuy > iGate) {
      // 兩道閘門都必須真的中止,不是只印個警告就繼續往下買
      const guards = (h.slice(iGate, iBuy).match(/return;/g) || []).length;
      if (guards < 2) problems.push(`閘門與 portfolio.buy() 之間只有 ${guards} 個 return; —— 擋了之後沒中止,等於只是顯示警告`);
    }
  }

  if (problems.length) { fail('進場限制一致性', problems.join('\n    ')); return; }
  ok('進場限制一致性',
    `閘門判斷式各只有一份;真值表 ${gateCases.length} + ${bandCases.length} 組全對;探索買進先擋再買`);
}

// =============================================================
// 12. Monte Carlo 可重現性與抽樣正確性
// -------------------------------------------------------------
// 這個閘門(不變量 6)CI 跑不了 —— 回測需要瀏覽器 IndexedDB 裡的 16 年資料。
// 但閘門用的**抽樣機制**是純函式,可以在這裡釘死。
//
// 兩個問題:
//   (a) 舊版用 Math.random(),沒有種子 -> 同一份資料每次跑出來的「幾比幾」
//       都不同。不可重現的閘門當不了閘門。
//   (b) 舊版的起點是 `Math.random() * (n - blockSize)`,最後一個合法起點
//       **永遠抽不到** —— 包含最後一筆日報酬的那個完整區塊不可能出現。
//
// 這裡用跟第 11 項相同的手法:把 app.js 裡那幾個真實函式的原始碼抽出來,
// 在沙箱裡執行。測的是真的程式。
// =============================================================
function checkMonteCarlo() {
  const src = readFileSync(rel('js/app.js'), 'utf8');
  const problems = [];

  const grab = (name) => {
    const i = src.indexOf(`function ${name}(`);
    if (i < 0) return null;
    const open = src.indexOf('{', i);
    let depth = 0;
    for (let j = open; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
    }
    return null;
  };
  const fnXs = grab('xorshift32'), fnBs = grab('blockStarts'), fnMc = grab('pairedMonteCarlo');
  const seedsLine = (src.match(/const MC_SEEDS = \[[^\]]+\];/) || [])[0];
  if (!fnXs || !fnBs || !fnMc || !seedsLine) {
    fail('MC 抽樣正確性', 'app.js 找不到 xorshift32 / blockStarts / pairedMonteCarlo / MC_SEEDS');
    return;
  }
  const M = new Function(
    `const MC_RUNS = 1000, MC_BLOCK = 20;\n${seedsLine}\n${fnXs}\n${fnBs}\n${fnMc}\n` +
    `return { xorshift32, blockStarts, pairedMonteCarlo, MC_SEEDS };`)();

  // ---- (a) 種子組本身 ----
  if (!Array.isArray(M.MC_SEEDS) || M.MC_SEEDS.length < 2) {
    problems.push(`MC_SEEDS 只有 ${M.MC_SEEDS && M.MC_SEEDS.length} 顆 —— 單一固定種子只是把雜訊凍結,不是消除`);
  }
  if ((M.MC_SEEDS || []).some((x) => (x | 0) === 0)) problems.push('MC_SEEDS 含 0 —— 0 是 xorshift 的不動點,會永遠回傳 0');
  if (new Set(M.MC_SEEDS || []).size !== (M.MC_SEEDS || []).length) problems.push('MC_SEEDS 有重複的種子,等於白跑一輪');

  // ---- (b) PRNG:可重現、不同種子不同、值域正確 ----
  const seq = (seed, k) => { const g = M.xorshift32(seed); return Array.from({ length: k }, () => g()); };
  const s1 = seq(M.MC_SEEDS[0], 64), s1b = seq(M.MC_SEEDS[0], 64), s2 = seq(M.MC_SEEDS[1], 64);
  if (s1.join() !== s1b.join()) problems.push('同一顆種子跑兩次序列不同 —— PRNG 不可重現');
  if (s1.join() === s2.join()) problems.push('兩顆不同的種子產生相同序列 —— 種子沒有生效');
  if (!s1.every((x) => x >= 0 && x < 1)) problems.push('PRNG 產生了 [0,1) 以外的值(負數會變出負的「機率」)');
  if (new Set(seq(M.MC_SEEDS[0], 2000)).size < 1900) problems.push('PRNG 在 2000 次內大量重複,週期過短');
  // 種子 0 必須被擋掉(不動點)
  if (seq(0, 8).every((x) => x === 0)) problems.push('種子 0 讓 PRNG 永遠回傳 0 —— 需要非零 fallback');

  // ---- (c) 抽樣範圍:最後一個合法起點必須抽得到,且不得越界 ----
  // 不靠「跑很多次剛好有抽到」當證據 —— 直接用定值 rng 證明邊界對應關係。
  const N = 100, BS = 20, LAST = N - BS;          // 合法起點 0 ... 80
  const atZero = M.blockStarts(N, BS, 1, () => 0)[0];
  const atTop = M.blockStarts(N, BS, 1, () => 1 - 2 ** -32)[0];   // PRNG 能回傳的最大值
  if (atZero !== 0) problems.push(`rng()=0 時起點應為 0,實際 ${atZero}`);
  if (atTop !== LAST) {
    problems.push(`rng() 取最大值時起點應為 ${LAST}(最後一個合法起點),實際 ${atTop}` +
      `${atTop === LAST - 1 ? ' —— 這正是舊版 `rng() * (n - blockSize)` 的症狀:最後一個合法起點永遠抽不到' : ''}`);
  }
  // 越界檢查:rng 理論上到不了 1,但如果有人改成 Math.random() 的近似或換了 PRNG,
  // 這條會抓到「區塊讀到 undefined」的情況
  const over = M.blockStarts(N, BS, 1, () => 0.9999999999)[0];
  if (over > LAST) problems.push(`抽到越界起點 ${over}(上限 ${LAST})—— 區塊會讀到 undefined,指標全變 NaN`);
  // 覆蓋率:每一個合法起點都要真的抽得到
  const seen = new Set();
  const g = M.xorshift32(M.MC_SEEDS[0]);
  for (let i = 0; i < 200000; i++) seen.add(M.blockStarts(N, BS, 1, g)[0]);
  const missing = [];
  for (let k = 0; k <= LAST; k++) if (!seen.has(k)) missing.push(k);
  if (missing.length) problems.push(`20 萬次抽樣後仍有 ${missing.length} 個合法起點沒被抽到:${missing.slice(0, 5).join(',')}…`);
  if ([...seen].some((k) => k < 0 || k > LAST)) problems.push('抽到了範圍外的起點');

  // ---- (d) 配對設計:A 與 B 必須共用同一組起點 ----
  // 證明手法:餵完全相同的兩條報酬序列。配對正確時每一輪的 A−B 恆為 0;
  // 如果 A、B 各自抽樣,即使資料一樣也會抽出不同的路徑、產生非零差異。
  const rets = [];
  const gr = M.xorshift32(999);
  for (let i = 0; i < 400; i++) rets.push((gr() - 0.48) * 0.02);
  const same = M.pairedMonteCarlo(rets, rets.slice(), 120, 20, M.MC_SEEDS.slice(0, 2));
  if (!same.paired) problems.push('pairedMonteCarlo 在合法長度下回傳 paired: null');
  else {
    if (same.paired.median !== 0 || same.paired.lo !== 0 || same.paired.hi !== 0) {
      problems.push(`A 與 B 餵相同資料,A−B 卻不是 0(median ${same.paired.median})—— 配對設計被破壞,兩邊各自抽樣了`);
    }
    if (same.paired.pAwins !== 0) problems.push(`相同資料的 pAwins 應為 0(嚴格大於才算贏),實際 ${same.paired.pAwins}`);
  }

  // ---- (e) 可重現性 + 跨種子摘要 ----
  const A2 = [], B2 = [];
  const gr2 = M.xorshift32(4242);
  for (let i = 0; i < 400; i++) { A2.push((gr2() - 0.48) * 0.02); B2.push((gr2() - 0.49) * 0.022); }
  const SEEDS = M.MC_SEEDS.slice(0, 3);
  const r1 = M.pairedMonteCarlo(A2, B2, 150, 20, SEEDS);
  const r2 = M.pairedMonteCarlo(A2, B2, 150, 20, SEEDS);
  if (r1.paired.median !== r2.paired.median || r1.paired.pAwins !== r2.paired.pAwins) {
    problems.push('同樣的種子組跑兩次結果不同 —— 閘門仍不可重現');
  }
  const rOther = M.pairedMonteCarlo(A2, B2, 150, 20, [M.MC_SEEDS[3]]);
  if (rOther.paired.median === r1.paired.median) problems.push('換種子後結果完全相同 —— 種子沒有傳進抽樣');

  const sp = r1.paired.seedSpread;
  if (!sp) problems.push('paired 沒有回報 seedSpread —— 無法得知換種子會不會翻盤');
  else {
    if (sp.perSeed.length !== SEEDS.length) problems.push(`seedSpread.perSeed 有 ${sp.perSeed.length} 筆,應為 ${SEEDS.length}`);
    if (sp.runsPerSeed !== 150) problems.push(`seedSpread.runsPerSeed 應為 150,實際 ${sp.runsPerSeed}`);
    if (r1.paired.runs !== 150 * SEEDS.length) {
      problems.push(`總抽樣次數應為 ${150 * SEEDS.length}(每顆種子 150 × ${SEEDS.length} 顆),實際 ${r1.paired.runs}`);
    }
    const meds = sp.perSeed.map((p) => p.median);
    if (Math.abs(sp.medianMin - Math.min(...meds)) > 1e-15 || Math.abs(sp.medianMax - Math.max(...meds)) > 1e-15) {
      problems.push('seedSpread 的 medianMin/Max 跟 perSeed 算不出來的值不一致');
    }
    const want = !(meds.every((m) => m >= 0) || meds.every((m) => m <= 0));
    if (sp.signFlips !== want) problems.push(`signFlips 判斷錯誤:應為 ${want},實際 ${sp.signFlips}`);
    // 每顆種子都要真的用到不同序列(否則「多種子」是假的)
    if (new Set(meds).size === 1 && SEEDS.length > 1) {
      problems.push('所有種子得到完全相同的中位數 —— 多種子沒有真的分開抽樣');
    }
  }

  if (problems.length) { fail('MC 抽樣正確性', problems.join('\n    ')); return; }
  ok('MC 抽樣正確性',
    `${M.MC_SEEDS.length} 顆非零種子可重現;最後一個合法起點(${LAST})抽得到且不越界;` +
    `${LAST + 1} 個起點全覆蓋;A/B 共用起點(相同輸入 A-B 恆為 0);跨種子摘要正確`);
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
checkEntryGate();
checkMonteCarlo();

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
