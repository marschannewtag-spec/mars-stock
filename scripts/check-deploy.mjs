#!/usr/bin/env node
// =============================================================
// check-deploy.mjs — 驗證 GitHub Pages 線上檔案真的等於 repo
// -------------------------------------------------------------
// 用法:  node scripts/check-deploy.mjs
//        SITE_URL=https://... node scripts/check-deploy.mjs
//
// 治的是這個病:「sw.js 版本對了,但 js/ 底下某些檔沒上去」——
// 也就是 docs/DEPLOY-github-pages.md 症狀表裡的「只更新一半」。
// 以前要手動開網址、Ctrl+F 搜關鍵字;現在部署完自動比對。
//
// 比對方式:抓線上檔案,與本機 repo 的同一支檔案做內容雜湊比對。
// 換行符先正規化(CRLF -> LF)才雜湊 —— 我們要比的是「內容是否相同」,
// 不是 Windows / Linux checkout 的換行差異。
// =============================================================

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = (process.env.SITE_URL || 'https://marschannewtag-spec.github.io/mars-stock').replace(/\/$/, '');

// 要比對的檔案:涵蓋「殼層 + 設定 + 策略核心 + UI 主控」。
// 這四支只要有一支沒上去,你看到的訊號就可能是錯的。
const FILES = ['sw.js', 'index.html', 'js/config.js', 'js/strategy.js', 'js/app.js'];

// CDN 傳播會比 workflow 完成再慢一點,所以用輪詢而不是固定 sleep。
// 本機除錯時可用環境變數縮短:MAX_WAIT_MS=0 就是只比對一次。
const MAX_WAIT_MS = Number(process.env.MAX_WAIT_MS ?? 5 * 60 * 1000);
const POLL_MS = Number(process.env.POLL_MS ?? 20 * 1000);

const norm = (s) => s.replace(/\r\n/g, '\n');
const hash = (s) => createHash('sha256').update(norm(s)).digest('hex').slice(0, 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const localOf = (f) => readFileSync(join(ROOT, f), 'utf8');

async function fetchLive(f) {
  // 加 query 與 no-cache header,避免比到中間層的舊快取
  const url = `${SITE}/${f}?_cb=${Date.now()}`;
  const r = await fetch(url, { headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

async function compareOnce() {
  const rows = [];
  for (const f of FILES) {
    const want = hash(localOf(f));
    try {
      const got = hash(await fetchLive(f));
      rows.push({ file: f, want, got, match: want === got });
    } catch (e) {
      rows.push({ file: f, want, got: `抓取失敗(${e.message})`, match: false });
    }
  }
  return rows;
}

// 額外印出人看得懂的版本資訊,而不只是雜湊
function swVersion(text) {
  return text.match(/const CACHE = '([^']+)'/)?.[1] ?? '(找不到)';
}

console.log(`\n  部署一致性檢查`);
console.log(`  線上:${SITE}`);
console.log(`  ${'─'.repeat(56)}`);

const deadline = Date.now() + MAX_WAIT_MS;
let rows = [];
let attempt = 0;

while (true) {
  attempt++;
  rows = await compareOnce();
  if (rows.every((r) => r.match)) break;

  if (Date.now() + POLL_MS >= deadline) break;
  const pending = rows.filter((r) => !r.match).map((r) => r.file).join(', ');
  console.log(`  第 ${attempt} 次:${pending} 還不一致,${POLL_MS / 1000} 秒後重試(CDN 傳播中)…`);
  await sleep(POLL_MS);
}

console.log('');
for (const r of rows) {
  console.log(`  ${r.match ? '✓' : '✗'} ${r.file.padEnd(18, ' ')} repo=${r.want}  線上=${r.got}`);
}

// sw.js 的版本號額外用人話印出來
try {
  const liveSw = await fetchLive('sw.js');
  console.log(`\n  sw 版本  repo=${swVersion(localOf('sw.js'))}  線上=${swVersion(liveSw)}`);
} catch { /* 上面已經報過錯了 */ }

const bad = rows.filter((r) => !r.match);
console.log('  ' + '─'.repeat(56));
if (bad.length) {
  console.log(`  ✗ ${bad.length} 支檔案的線上版本與 repo 不一致\n`);
  console.log('  可能原因:');
  console.log('    • Pages 還在部署 / CDN 尚未傳播(等幾分鐘重跑 workflow_dispatch)');
  console.log('    • 這幾支檔案根本沒 push 上去(最常見:只更新一半)');
  console.log('    • Pages 的 Source 分支設定不是 main\n');
  process.exit(1);
}
console.log(`  ✓ ${FILES.length} 支關鍵檔案的線上版本與 repo 完全一致\n`);
