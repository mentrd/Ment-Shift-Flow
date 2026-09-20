/**
 * vault.js（帳密 → 金鑰 → 解 token）與 github.js（錯誤分類）的回歸測試。
 *
 * 用法：node --test scripts/test-vault.js
 * 由 .github/workflows/deploy.yml 在部署前執行（與 test-rules.js 一起）。
 *
 * 這裡用小迭代數（1000）加速；正式 vault 用 DEFAULT_ITERATIONS，
 * 由 assertVaultShape 擋下低於 MIN_ITERATIONS 的檔案（也在這裡測）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  VAULT_VERSION,
  DEFAULT_ITERATIONS,
  MIN_ITERATIONS,
  VaultError,
  bytesToB64,
  b64ToBytes,
  utf8ToB64,
  b64ToUtf8,
  assertVaultShape,
  sealVault,
  openVault,
} from './vault.js';
import { classifyError, GitHubError } from './github.js';

const TARGET = { owner: 'mentrd', repo: 'Ment-Shift-Flow', branch: 'main', path: 'data/schedule.json' };
const SECRET = 'github_pat_TESTTESTTESTTESTTESTTEST_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUV';
const FAST = 1000;
const open = (v, u, p) => openVault(v, u, p, { skipShapeCheck: true });

const rejectsWith = async (promise, code) => {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof VaultError, `應為 VaultError，實際是 ${err?.name}: ${err?.message}`);
    assert.equal(err.code, code);
    return true;
  });
};

describe('base64 工具', () => {
  test('bytes 往返', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
    assert.deepEqual(b64ToBytes(bytesToB64(bytes)), bytes);
  });

  test('UTF-8 中文往返（直接 btoa 會炸）', () => {
    const s = '網頁排班 ✓ 2026-09-21 — 「中秋節」';
    assert.throws(() => btoa(s), '直接 btoa 非 Latin-1 會丟錯，證明需要 utf8ToB64');
    assert.equal(b64ToUtf8(utf8ToB64(s)), s);
  });

  test('b64ToBytes 容許 GitHub 回傳的每 60 字一個換行', () => {
    const b64 = utf8ToB64('a'.repeat(200));
    const wrapped = b64.replace(/(.{60})/g, '$1\n');
    assert.ok(wrapped.includes('\n'));
    assert.equal(b64ToUtf8(wrapped), 'a'.repeat(200));
  });

  test('大陣列不會爆堆疊', () => {
    const big = new Uint8Array(300_000).fill(7);
    assert.equal(b64ToBytes(bytesToB64(big)).length, 300_000);
  });
});

describe('sealVault / openVault', () => {
  test('正確帳密解回原字串；帳號與密碼都會被 trim 與 NFKC', async () => {
    const v = await sealVault({ user: 'chad', password: 'correct horse battery staple', secret: SECRET, iterations: FAST, target: TARGET });
    assert.equal(await open(v, 'chad', 'correct horse battery staple'), SECRET);
    assert.equal(await open(v, '  chad ', 'correct horse battery staple  '), SECRET, 'trim');
    assert.equal(await open(v, 'ｃｈａｄ', 'correct horse battery staple'), SECRET, 'NFKC 全形 → 半形');
  });

  test('密碼錯、帳號錯、大小寫不同 → 一律 bad-credentials', async () => {
    const v = await sealVault({ user: 'chad', password: 'correct horse battery staple', secret: SECRET, iterations: FAST, target: TARGET });
    await rejectsWith(open(v, 'chad', 'wrong horse'), 'bad-credentials');
    await rejectsWith(open(v, 'someone', 'correct horse battery staple'), 'bad-credentials');
    await rejectsWith(open(v, 'Chad', 'correct horse battery staple'), 'bad-credentials');
  });

  test('密文、iv、salt 任一被動過 → 失敗', async () => {
    const v = await sealVault({ user: 'chad', password: 'pw pw pw pw pw', secret: SECRET, iterations: FAST, target: TARGET });
    const flip = (b64) => {
      const bytes = b64ToBytes(b64);
      bytes[0] ^= 0x01;
      return bytesToB64(bytes);
    };
    await rejectsWith(open({ ...v, ciphertext: flip(v.ciphertext) }, 'chad', 'pw pw pw pw pw'), 'bad-credentials');
    await rejectsWith(open({ ...v, iv: flip(v.iv) }, 'chad', 'pw pw pw pw pw'), 'bad-credentials');
    await rejectsWith(open({ ...v, salt: flip(v.salt) }, 'chad', 'pw pw pw pw pw'), 'bad-credentials');
    await rejectsWith(open({ ...v, iterations: FAST + 1 }, 'chad', 'pw pw pw pw pw'), 'bad-credentials');
  });

  test('每次 seal 的 salt／iv／密文都不同（隨機）', async () => {
    const a = await sealVault({ user: 'u', password: 'p p p p', secret: SECRET, iterations: FAST, target: TARGET });
    const b = await sealVault({ user: 'u', password: 'p p p p', secret: SECRET, iterations: FAST, target: TARGET });
    assert.notEqual(a.salt, b.salt);
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ciphertext, b.ciphertext);
  });

  test('vault 裡沒有帳號、密碼或明文 token', async () => {
    const v = await sealVault({ user: 'chad', password: 'my secret phrase', secret: SECRET, iterations: FAST, target: TARGET });
    const json = JSON.stringify(v);
    assert.ok(!json.includes('chad'));
    assert.ok(!json.includes('my secret phrase'));
    assert.ok(!json.includes('github_pat_'));
  });

  test('空帳號／空密碼／空 secret 拒絕', async () => {
    await rejectsWith(sealVault({ user: '', password: 'x', secret: SECRET, iterations: FAST, target: TARGET }), 'malformed');
    await rejectsWith(sealVault({ user: 'u', password: '   ', secret: SECRET, iterations: FAST, target: TARGET }), 'malformed');
    await rejectsWith(sealVault({ user: 'u', password: 'x', secret: '', iterations: FAST, target: TARGET }), 'malformed');
  });

  test('預設迭代數是 600,000；expiresAt／note 選填', async () => {
    const v = await sealVault({ user: 'u', password: 'p', secret: 's', iterations: FAST, target: TARGET, expiresAt: '2027-03-21', note: 'n' });
    assert.equal(DEFAULT_ITERATIONS, 600_000);
    assert.equal(v.v, VAULT_VERSION);
    assert.equal(v.expiresAt, '2027-03-21');
    assert.equal(v.note, 'n');
    assert.match(v.createdAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(v.target, TARGET);
  });
});

describe('assertVaultShape', () => {
  const good = async () => sealVault({ user: 'u', password: 'p', secret: 's', iterations: MIN_ITERATIONS, target: TARGET });

  test('正常的 vault 通過', async () => {
    assert.ok(assertVaultShape(await good()));
  });

  test('版本不對 → unsupported-version', async () => {
    assert.throws(() => assertVaultShape({ ...{}, v: 2 }), (e) => e.code === 'unsupported-version');
  });

  test('iterations 太低（測試用的小值）→ malformed，正式 openVault 會擋', async () => {
    const v = await sealVault({ user: 'u', password: 'p', secret: 's', iterations: FAST, target: TARGET });
    assert.throws(() => assertVaultShape(v), (e) => e.code === 'malformed');
    await rejectsWith(openVault(v, 'u', 'p'), 'malformed');
  });

  test('缺 target、iv 長度錯、base64 壞掉 → malformed', async () => {
    const v = await good();
    assert.throws(() => assertVaultShape({ ...v, target: { owner: 'x' } }), (e) => e.code === 'malformed');
    assert.throws(() => assertVaultShape({ ...v, iv: bytesToB64(new Uint8Array(8)) }), (e) => e.code === 'malformed');
    assert.throws(() => assertVaultShape({ ...v, ciphertext: '!!!not base64!!!' }), (e) => e.code === 'malformed');
    assert.throws(() => assertVaultShape({ ...v, expiresAt: '2027/03/21' }), (e) => e.code === 'malformed');
  });
});

describe('github.js classifyError', () => {
  const h = (remaining) => ({ get: (k) => (k === 'x-ratelimit-remaining' ? remaining : null) });

  test('狀態碼對應', () => {
    assert.equal(classifyError(0, null), 'network');
    assert.equal(classifyError(401, { message: 'Bad credentials' }), 'unauthorized');
    assert.equal(classifyError(403, { message: 'Resource not accessible by personal access token' }, h('50')), 'forbidden');
    assert.equal(classifyError(403, { message: 'API rate limit exceeded' }, h('0')), 'rate-limited');
    assert.equal(classifyError(404, { message: 'Not Found' }), 'not-found');
    assert.equal(classifyError(409, { message: 'Conflict' }), 'sha-conflict');
    assert.equal(classifyError(422, { message: 'Invalid request' }), 'validation');
    assert.equal(classifyError(500, { message: 'oops' }), 'unknown');
  });

  test('訊息文字優先於狀態碼：sha 不符與 ruleset 拒絕都可能是 409 或 422', () => {
    assert.equal(classifyError(422, { message: 'data/schedule.json does not match abc123' }), 'sha-conflict');
    assert.equal(classifyError(409, { message: 'data/schedule.json is at def456 but expected abc123' }), 'sha-conflict');
    assert.equal(classifyError(422, { message: 'Repository rule violations found' }), 'blocked-by-rules');
    assert.equal(classifyError(409, { message: 'Changes must be made through a pull request.' }), 'blocked-by-rules');
    assert.equal(classifyError(403, { message: 'Protected branch update failed' }), 'blocked-by-rules');
  });

  test('GitHubError 帶著 status／kind／detail', () => {
    const e = new GitHubError(401, 'unauthorized', 'Bad credentials');
    assert.equal(e.status, 401);
    assert.equal(e.kind, 'unauthorized');
    assert.equal(e.detail, 'Bad credentials');
    assert.ok(e instanceof Error);
  });
});
