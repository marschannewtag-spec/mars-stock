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

// 要比對哪些檔案:直接從 sw.js 的 SHELL 清單推導 —— 也就是
// 「所有會被瀏覽器快取、進而影響你看到什麼」的檔案,一支都不漏。
//
// 不用手挑清單:「只更新一半」可能發生在任何一支檔案上,手挑的清單
// 一定會漏掉新加的模組,而且漏掉時毫無徵兆。從 SHELL 推導的話,
// 新模組一被加進快取清單就自動納入比對(verify.mjs 又保證 SHELL 和
// js/ 實際檔案一致,兩者互相咬合)。
function filesToCheck() {
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const shell = [...sw.matchAll(/'\.\/([^']*)'/g)]
    .map((m) => m[1])
    .filter(Boolean);                    // './' 這種根路徑項目過濾掉
  return [...new Set(['sw.js', ...shell])];
}
const FILES = filesToCheck();

// 二進位檔(圖示)按位元組比;文字檔先把換行正規化再比,
// 避免 Windows / Linux checkout 的 CRLF 差異造成誤報。
const isBinary = (f) => /\.(png|jpe?g|gif|webp|ico|woff2?)$/i.test(f);

// CDN 傳播會比 workflow 完成再慢一點,所以用輪詢而不是固定 sleep。
// 本機除錯時可用環境變數縮短:MAX_WAIT_MS=0 就是只比對一次。
const MAX_WAIT_MS = Number(process.env.MAX_WAIT_MS ?? 5 * 60 * 1000);
const POLL_MS = Number(process.env.POLL_MS ?? 20 * 1000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 12);

function hashLocal(f) {
  const buf = readFileSync(join(ROOT, f));
  return isBinary(f) ? short(buf) : short(buf.toString('utf8').replace(/\r\n/g, '\n'));
}

async function fetchLive(f) {
  // 加 query 與 no-cache header,避免比到中間層的舊快取
  const url = `${SITE}/${f}?_cb=${Date.now()}`;
  const r = await fetch(url, { headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (isBinary(f)) return short(Buffer.from(await r.arrayBuffer()));
  return short((await r.text()).replace(/\r\n/g, '\n'));
}

async function compareOnce() {
  const rows = [];
  for (const f of FILES) {
    const want = hashLocal(f);
    try {
      const got = await fetchLive(f);
      rows.push({ file: f, want, got, match: want === got });
    } catch (e) {
      rows.push({ file: f, want, got: `抓取失敗(${e.message})`, match: false });
    }
  }
  return rows;
}

// 額外印出人看得懂的版本資訊,而不只是雜湊
const swVersion = (text) => text.match(/const CACHE = '([^']+)'/)?.[1] ?? '(找不到)';

async function liveSwVersion() {
  const r = await fetch(`${SITE}/sw.js?_cb=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } });
  return swVersion(await r.text());
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

// sw.js 的版本號額外用人話印出來(雜湊看不出是哪一版)
try {
  const repoVer = swVersion(readFileSync(join(ROOT, 'sw.js'), 'utf8'));
  console.log(`\n  sw 版本  repo=${repoVer}  線上=${await liveSwVersion()}`);
} catch { /* 上面已經報過錯了 */ }

const bad = rows.filter((r) => !r.match);
console.log('  ' + '─'.repeat(56));
if (bad.length) {
  console.log(`  ✗ ${bad.length} 支檔案的線上版本與 repo 不一致\n`);
  console.log('  可能原因(按發生機率排):');
  console.log('    • Pages 部署失敗 —— 去 Actions 看 "pages build and deployment"。');
  console.log('      特別注意:連續快速推兩次會讓前一次的部署被取消,可能卡住部署鎖,');
  console.log('      使下一次的 deploy 步驟失敗(build 成功但 deploy 失敗)。再推一次通常就好。');
  console.log('    • 這幾支檔案根本沒 push 上去(只更新一半)');
  console.log('    • Pages 還在部署 / CDN 尚未傳播(等幾分鐘再重跑一次)');
  console.log('    • Pages 的 Source 分支設定不是 main\n');
  process.exit(1);
}
console.log(`  ✓ 全部 ${FILES.length} 支會被快取的檔案,線上版本與 repo 完全一致\n`);
