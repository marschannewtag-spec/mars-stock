#!/usr/bin/env node
// =============================================================
// verify-selftest.mjs — 驗證 verify.mjs 自己還有沒有效
// -------------------------------------------------------------
// 用法:  node scripts/verify-selftest.mjs
//
// 為什麼需要這支:
//   「沒失敗過的測試不算測試。」verify.mjs 全綠只證明「現在沒事」,
//   不證明「它抓得到事」。一個檢查可能因為重構、改名、或版本號寫死
//   而悄悄變成永遠通過的空殼 —— 而你完全不會發現,因為它是綠的。
//
//   這支腳本逐項把專案「刻意弄壞」,確認 verify.mjs 真的會紅燈,
//   然後立刻還原。它保護的是保護機制本身。
//
//   (這不是假設性的:開發過程中它就抓到「sw 版本檢查因為測試寫死
//    版本字串而失效」一次。)
//
// ⚠️ 這支腳本會修改並還原檔案,只能在乾淨的工作區跑。
//    下面第一件事就是擋掉髒工作區 —— 否則 git checkout 還原時會把你
//    未提交的修改一起吃掉(這個坑也踩過)。
// =============================================================

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const p = (...x) => join(ROOT, ...x);
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();

// ---- 髒工作區防呆 ----
const dirty = git('status', '--porcelain');
if (dirty) {
  console.error('\n  ✗ 拒絕執行:工作區有未提交的變更。');
  console.error('    這支腳本用 `git checkout -- <file>` 還原,會把你未提交的修改一起還原掉。\n');
  console.error(dirty.split('\n').map((l) => '      ' + l).join('\n'));
  console.error('\n    請先 commit 或 stash 再跑。\n');
  process.exit(2);
}

function runVerify() {
  const r = spawnSync(process.execPath, ['scripts/verify.mjs'], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// 讀寫檔案的小工具;patch 回傳 null 代表「這個改動套用不上」
const read = (f) => readFileSync(p(f), 'utf8');
const write = (f, s) => writeFileSync(p(f), s);
function patch(f, from, to) {
  const before = read(f);
  const after = typeof from === 'string' ? before.replace(from, to) : before.replace(from, to);
  if (after === before) return null;              // 套用不上 -> 測試已失效
  write(f, after);
  return true;
}
const restoreGit = (f) => () => git('checkout', '--', f);

// =============================================================
// 測試案例
// -------------------------------------------------------------
// break() 回傳:
//   true      -> 已成功弄壞,接著應該看到 verify 紅燈
//   null      -> 改動套用不上 = 這個測試已經失效(STALE,算失敗)
//   {skip:''} -> 前提合理地不成立(SKIP,不算失敗)
// =============================================================
const cases = [
  {
    name: '語法檢查',
    expect: '語法檢查',
    break: () => { write('js/sectors.js', read('js/sectors.js') + '\nfunction broken( {\n'); return true; },
    restore: restoreGit('js/sectors.js'),
  },
  {
    name: 'Import 圖(函式改名/巢狀化)',
    expect: 'Import 圖完整性',
    break: () => patch('js/app.js', 'const views = { today: renderToday', 'const views = { today: renderTodayTYPO'),
    restore: restoreGit('js/app.js'),
  },
  {
    // 在 composite preset 的 overrides 裡偷塞 useSignalExits: true,
    // 模擬「有害的出場規則被意外重新啟用」
    name: '出場不變量(preset 偷開)',
    expect: '出場不變量',
    break: () => patch('js/presets.js', /\{ minStockScore: 0\.13,/, '{ useSignalExits: true, minStockScore: 0.13,'),
    restore: restoreGit('js/presets.js'),
  },
  {
    name: 'sw.js SHELL 漏檔',
    expect: 'SHELL 一致性',
    break: () => patch('sw.js', "'./js/market.js', ", ''),
    restore: restoreGit('sw.js'),
  },
  {
    name: 'sw.js 版本沒 bump',
    expect: '版本 bump',
    break: () => {
      // 動態讀上一版版本號,不要寫死字串 —— 寫死的話每次 bump 之後
      // 這個測試就會變成永遠通過的空殼(這正是它要防的病)。
      const prevSw = (() => { try { return git('show', 'HEAD~1:sw.js'); } catch { return null; } })();
      if (prevSw === null) return { skip: '取不到 HEAD~1(初始 commit 或 shallow clone)' };
      const prev = prevSw.match(/const CACHE = '([^']+)'/)?.[1];
      const now = read('sw.js').match(/const CACHE = '([^']+)'/)?.[1];
      if (!prev || !now) return { skip: 'sw.js 找不到 CACHE 版本字串' };
      if (prev === now) return { skip: '本次沒有 bump 版本(純文件 commit),此測試前提不成立' };

      // 這個測試的作法是「把版本改回上一版,看 verify 會不會抓到」。
      // 但如果本次 commit 只動了 sw.js 本身,改回去之後工作區就跟 HEAD~1
      // 完全相同 —— 沒有任何資產變動,verify 正確地回報「不需 bump」,
      // 測試也就無從成立。這是前提不成立,不是 verify 失效。
      const assetChanged = (git('diff', '--name-only', 'HEAD~1', '--') || '')
        .split('\n').map((s) => s.trim())
        .filter((f) => f && f !== 'sw.js' && /^(js\/|css\/|icons\/|index\.html$|manifest\.json$)/.test(f));
      if (assetChanged.length === 0) {
        return { skip: '本次只動了 sw.js 本身,改回舊版後工作區等同 HEAD~1,此測試前提不成立' };
      }

      return patch('sw.js', `'${now}'`, `'${prev}'`);
    },
    restore: restoreGit('sw.js'),
  },
  {
    name: 'config.js 少一個 key',
    expect: 'config.js 必要欄位',
    break: () => patch('js/config.js', /^\s*PRICE_MIN: 6,\s*$/m, ''),
    restore: restoreGit('js/config.js'),
  },
  {
    name: '根目錄 config.js 復活',
    expect: '無重複 config.js',
    break: () => { write('config.js', 'export const config = {};\n'); return true; },
    restore: () => { if (existsSync(p('config.js'))) unlinkSync(p('config.js')); },
  },
  {
    // 假金鑰用組的,不寫成字面值 —— 否則這支檔案自己會被金鑰檢查掃到(已實測誤報)。
    // 不用「把本檔加進白名單」的解法:把檔案排除在安全掃描外是壞習慣。
    name: '寫死金鑰',
    expect: '金鑰洩漏',
    break: () => {
      const fake = ['abcd1234', 'efgh5678', 'ijklmnop'].join('');
      const key = ['api', 'key'].join('');
      return patch('js/config.js', 'OUTPUT_SIZE: 260,', `OUTPUT_SIZE: 260,\n  ${key}: '${fake}',`);
    },
    restore: restoreGit('js/config.js'),
  },
];

// =============================================================
// 執行
// =============================================================
console.log('\n  verify.mjs 自我測試(逐項弄壞,確認真的會紅燈)');
console.log('  ' + '─'.repeat(58));

let failures = 0, skips = 0;
for (const c of cases) {
  const broke = c.break();
  if (broke && broke.skip) {
    c.restore();
    console.log(`  ○ ${c.name.padEnd(26, ' ')} 跳過 —— ${broke.skip}`);
    skips++;
    continue;
  }
  if (broke === null) {
    c.restore();
    console.log(`  ✗ ${c.name.padEnd(26, ' ')} 測試已失效:改動套用不上,程式碼已變動`);
    console.log(`      -> 這個檢查現在等於沒在測。請更新 verify-selftest.mjs 的這一項。`);
    failures++;
    continue;
  }

  const { code, out } = runVerify();
  c.restore();

  const caught = code === 1 &&
    out.split('\n').some((l) => l.trimStart().startsWith('✗') && l.includes(c.expect));
  if (caught) {
    console.log(`  ✓ ${c.name.padEnd(26, ' ')} verify 有抓到`);
  } else {
    console.log(`  ✗ ${c.name.padEnd(26, ' ')} verify 沒抓到(exit=${code})`);
    console.log(out.split('\n').filter((l) => l.trim()).map((l) => '      ' + l).join('\n'));
    failures++;
  }
}

// 還原後必須回到全綠 —— 確認測試沒有留下殘骸
const final = runVerify();
console.log('  ' + '─'.repeat(58));
if (final.code !== 0) {
  console.log('  ✗ 還原失敗:跑完之後 verify 沒有回到全綠,工作區可能有殘骸\n');
  console.log(final.out);
  process.exit(1);
}
console.log('  ✓ 還原後 verify 全綠,沒有殘骸');

if (failures) {
  console.log(`\n  ✗ ${failures} 項自我測試未通過 —— verify.mjs 的對應檢查可能已失效\n`);
  process.exit(1);
}
console.log(`  ✓ ${cases.length - skips} 項確認有效${skips ? `,${skips} 項跳過` : ''}\n`);
