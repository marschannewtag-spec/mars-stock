#!/usr/bin/env node
// =============================================================
// check-cf-token.mjs — 部署前確認 Cloudflare token 真的能用
// -------------------------------------------------------------
// 只在 CI 跑(需要 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID 環境變數)。
//
// 為什麼需要:token 有問題時 wrangler 只會丟一句
//   The process '/opt/.../npx' failed with exit code 1
// 完全看不出是「token 無效」、「權限不足」還是「帳號 ID 錯了」——
// 這三種的處理方式完全不同。
//
// 這支腳本問 Cloudflare 三個問題,把失敗變成可行動的訊息:
//   1. token 本身有效嗎?
//   2. 這個 token 能存取這個帳號的 Workers 嗎?
//   3. wrangler.toml 裡的 name 在這個帳號裡存在嗎?
//      (不存在 = 待會會「新建」一支,而不是更新現有的)
//
// 全程不印出 token。
// =============================================================

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const API = 'https://api.cloudflare.com/client/v4';

const fail = (msg, hint) => {
  console.log(`\n  ✗ ${msg}`);
  if (hint) console.log(hint.split('\n').map((l) => '    ' + l).join('\n'));
  console.log('');
  process.exit(1);
};

async function cf(path) {
  const r = await fetch(API + path, { headers: { Authorization: `Bearer ${TOKEN}` } });
  let data = null;
  try { data = await r.json(); } catch { /* 不是 JSON */ }
  return { status: r.status, data };
}
const errorsOf = (d) => (d && Array.isArray(d.errors) ? d.errors : [])
  .map((e) => `- [${e.code ?? '?'}] ${e.message ?? JSON.stringify(e)}`).join('\n');

console.log('\n  Cloudflare token 檢查');
console.log('  ' + '─'.repeat(58));

if (!TOKEN) fail('CLOUDFLARE_API_TOKEN 是空的', '到 repo Settings -> Secrets and variables -> Actions 新增。');
if (!ACCOUNT) fail('CLOUDFLARE_ACCOUNT_ID 是空的', '在 Cloudflare 儀表板網址列:dash.cloudflare.com/<這串>');

// 貼上時多帶到空白或換行是很常見的失誤,而且從介面上完全看不出來
if (TOKEN !== TOKEN.trim()) {
  fail('CLOUDFLARE_API_TOKEN 前後有多餘空白或換行',
    '在 GitHub 把這個 secret 刪掉重加,貼上時注意不要多選到空格或換行。');
}
if (!/^[0-9a-f]{32}$/i.test(ACCOUNT)) {
  fail(`CLOUDFLARE_ACCOUNT_ID 格式不像帳號 ID(長度 ${ACCOUNT.length})`,
    'Account ID 是 32 位十六進位字元,長得像 1adeefe81b60749ee1f28be713130246。\n' +
    '別把 Zone ID 或 token 貼錯位置了。');
}
console.log('  ✓ 兩個 secret 都有值,格式看起來正常');

// ---- 1. token 本身有效嗎 ----
{
  const { status, data } = await cf('/user/tokens/verify');
  if (!data || !data.success) {
    fail(`token 無效(HTTP ${status})`,
      (errorsOf(data) || '(Cloudflare 沒有回傳細節)') + '\n\n' +
      '常見原因:\n' +
      '- token 複製時漏字或多字(它只顯示一次,重建一個比較快)\n' +
      '- token 已被撤銷或過期\n' +
      '重建:https://dash.cloudflare.com/profile/api-tokens');
  }
  console.log(`  ✓ token 有效(狀態 ${data.result?.status ?? 'active'})`);
}

// ---- 2. 能存取這個帳號的 Workers 嗎 ----
let scripts = [];
{
  const { status, data } = await cf(`/accounts/${ACCOUNT}/workers/scripts`);
  if (!data || !data.success) {
    fail(`token 存取不了這個帳號的 Workers(HTTP ${status})`,
      (errorsOf(data) || '(沒有細節)') + '\n\n' +
      '常見原因:\n' +
      '- token 權限不足 —— 建立時要用 "Edit Cloudflare Workers" 範本\n' +
      '- CLOUDFLARE_ACCOUNT_ID 是別的帳號的\n' +
      `- token 建立時限定了 Account Resources,沒包含 ${ACCOUNT}`);
  }
  scripts = (data.result || []).map((x) => x.id);
  console.log(`  ✓ 可存取此帳號的 Workers(現有 ${scripts.length} 支:${scripts.join(', ') || '無'})`);
}

// ---- 3. wrangler.toml 的 name 存在嗎 ----
{
  const toml = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8');
  const name = toml.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
  if (!name) fail('wrangler.toml 找不到 name');

  if (scripts.includes(name)) {
    console.log(`  ✓ 目標 Worker "${name}" 已存在 -> 這次是【更新】現有的`);
  } else {
    fail(`wrangler.toml 的 name = "${name}",但這個帳號裡沒有這支 Worker`,
      `現有的是:${scripts.join(', ') || '(一支都沒有)'}\n\n` +
      '照這樣部署下去 wrangler 會【新建】一支,而不是更新現有的 ——\n' +
      '你會得到兩支、舊的繼續服務你的 App、新的沒人用,而且不會有錯誤訊息。\n' +
      '請把 wrangler.toml 的 name 改成上面其中一個。');
  }
}

console.log('  ' + '─'.repeat(58));
console.log('  ✓ 可以安全部署\n');
