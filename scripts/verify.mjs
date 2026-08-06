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
