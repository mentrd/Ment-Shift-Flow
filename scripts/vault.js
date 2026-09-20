/**
 * 帳密 → 金鑰 → 解開 GitHub token 的封裝格式（data/vault.json）。
 *
 * 這個模組同時被以下三者使用，請勿複製貼上到別處：
 *   - index.html            （前端登入時解密，透過 <script type="module"> import）
 *   - scripts/make-vault.js （產生 vault.json）
 *   - scripts/test-vault.js （回歸測試）
 * 只用 globalThis.crypto（WebCrypto）：瀏覽器與 Node ≥ 20 同介面、同演算法，
 * 所以 Node 產的密文瀏覽器解得開；不 import 任何 Node 模組。
 *
 * 設計：密碼是金鑰，不是門禁。
 *   keyMaterial = UTF-8(NFKC(trim(password)))
 *   salt        = UTF-8(VAULT_DOMAIN + "\n" + NFKC(trim(user)) + "\n") ‖ 16 bytes 隨機
 *   key         = PBKDF2-HMAC-SHA256(keyMaterial, salt, iterations) → AES-GCM-256
 *   plaintext   = AES-GCM-Decrypt(key, iv, ciphertext, additionalData = UTF-8(VAULT_DOMAIN))
 *
 * 帳號放進 salt：帳號錯與密碼錯的失敗方式完全一樣（GCM tag 驗證失敗），
 * 前端自然做到「不區分哪一個錯」；vault 裡不存帳號、不存 hash、不存提示。
 * 密文是公開的（repo 是 public），唯一防線是迭代數 × 密語長度。
 */

export const VAULT_VERSION = 1;
export const VAULT_DOMAIN = 'Ment-Shift-Flow/vault/v1';
export const DEFAULT_ITERATIONS = 600_000;   // OWASP 2023 對 PBKDF2-HMAC-SHA256 的建議值
export const MIN_ITERATIONS = 100_000;
export const MAX_ITERATIONS = 5_000_000;      // 避免有人把 vault.json 改成十億次讓瀏覽器卡死

const SALT_RANDOM_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class VaultError extends Error {
  /** @param {'no-webcrypto'|'malformed'|'unsupported-version'|'bad-credentials'} code */
  constructor(code, message) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

/* ── base64 ↔ bytes ↔ UTF-8 ────────────────────────────── */

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Uint8Array → base64（分段 0x8000，避免 String.fromCharCode(...bytes) 在大陣列爆堆疊） */
export function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** base64 → Uint8Array。會先去掉空白與換行（GitHub Contents API 回的 content 每 60 字就有一個 \n） */
export function b64ToBytes(s) {
  const bin = atob(String(s).replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 字串 → base64（正確處理中文；直接 btoa(str) 遇到非 Latin-1 會丟錯） */
export const utf8ToB64 = (str) => bytesToB64(enc.encode(str));
/** base64 → 字串 */
export const b64ToUtf8 = (s) => dec.decode(b64ToBytes(s));

/* ── 內部 ──────────────────────────────────────────────── */

function webcrypto() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new VaultError('no-webcrypto', '此環境沒有 WebCrypto（瀏覽器需 HTTPS 或 localhost）');
  }
  return c;
}

/** 全形／半形、尾端空白之類的正規化；大小寫保留（區分） */
const norm = (s) => String(s ?? '').trim().normalize('NFKC');

function concat(...arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

async function deriveKey(user, password, saltRandom, iterations) {
  const { subtle } = webcrypto();
  const salt = concat(enc.encode(`${VAULT_DOMAIN}\n${norm(user)}\n`), saltRandom);
  const km = await subtle.importKey('raw', enc.encode(norm(password)), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    km,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/* ── 公開 API ──────────────────────────────────────────── */

/** 檢查 vault 物件的形狀與範圍；不合就丟 VaultError('malformed' | 'unsupported-version') */
export function assertVaultShape(vault) {
  const bad = (why) => { throw new VaultError('malformed', `vault.json 格式不正確：${why}`); };
  if (!vault || typeof vault !== 'object') bad('不是物件');
  if (vault.v !== VAULT_VERSION) {
    throw new VaultError('unsupported-version', `vault.json 版本 ${vault.v} 不支援（需要 ${VAULT_VERSION}）`);
  }
  if (vault.kdf !== 'PBKDF2' || vault.hash !== 'SHA-256' || vault.cipher !== 'AES-GCM') bad('演算法欄位');
  if (!Number.isInteger(vault.iterations) || vault.iterations < MIN_ITERATIONS || vault.iterations > MAX_ITERATIONS) {
    bad(`iterations 需在 ${MIN_ITERATIONS}–${MAX_ITERATIONS} 之間`);
  }
  let salt, iv, ct;
  try {
    salt = b64ToBytes(vault.salt); iv = b64ToBytes(vault.iv); ct = b64ToBytes(vault.ciphertext);
  } catch { bad('base64 欄位無法解析'); }
  if (salt.length < SALT_RANDOM_BYTES) bad('salt 太短');
  if (iv.length !== IV_BYTES) bad('iv 長度');
  if (ct.length <= TAG_BYTES) bad('ciphertext 太短');
  const t = vault.target;
  if (!t || typeof t !== 'object' || !t.owner || !t.repo || !t.branch || !t.path) bad('target 需有 owner、repo、branch、path');
  if (vault.expiresAt != null && !isDate(vault.expiresAt)) bad('expiresAt 需為 YYYY-MM-DD');
  return vault;
}

/**
 * 產生 vault 物件（make-vault.js 用）。
 * secret 是要保護的字串（GitHub PAT）。iterations 允許小值是為了測試加速；
 * 正式產生時 make-vault.js 用 DEFAULT_ITERATIONS，而解密端的
 * assertVaultShape 會拒絕 < MIN_ITERATIONS 的檔案。
 */
export async function sealVault({ user, password, secret, iterations = DEFAULT_ITERATIONS, target, expiresAt, note }) {
  const c = webcrypto();
  if (!norm(user)) throw new VaultError('malformed', '帳號不可為空');
  if (!norm(password)) throw new VaultError('malformed', '密碼不可為空');
  if (!secret) throw new VaultError('malformed', 'secret 不可為空');
  if (!target) throw new VaultError('malformed', 'target 不可為空');

  const saltRandom = c.getRandomValues(new Uint8Array(SALT_RANDOM_BYTES));
  const iv = c.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(user, password, saltRandom, iterations);
  const ct = new Uint8Array(await c.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(VAULT_DOMAIN), tagLength: TAG_BYTES * 8 },
    key,
    enc.encode(String(secret)),
  ));

  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const vault = {
    v: VAULT_VERSION,
    kdf: 'PBKDF2',
    hash: 'SHA-256',
    iterations,
    salt: bytesToB64(saltRandom),
    cipher: 'AES-GCM',
    iv: bytesToB64(iv),
    ciphertext: bytesToB64(ct),
    target: { owner: target.owner, repo: target.repo, branch: target.branch, path: target.path },
    createdAt: `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`,
  };
  if (expiresAt) vault.expiresAt = expiresAt;
  if (note) vault.note = note;
  return vault;
}

/**
 * 解開 vault → secret 字串。
 * 帳號或密碼錯一律丟 VaultError('bad-credentials')；格式錯丟 'malformed'。
 * 測試可傳 { skipShapeCheck: true } 讓小迭代數的 vault 也能解。
 */
export async function openVault(vault, user, password, { skipShapeCheck = false } = {}) {
  const c = webcrypto();
  if (!skipShapeCheck) assertVaultShape(vault);
  const saltRandom = b64ToBytes(vault.salt);
  const iv = b64ToBytes(vault.iv);
  const ct = b64ToBytes(vault.ciphertext);
  const key = await deriveKey(user, password, saltRandom, vault.iterations);
  try {
    const pt = await c.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(VAULT_DOMAIN), tagLength: TAG_BYTES * 8 },
      key,
      ct,
    );
    return dec.decode(pt);
  } catch {
    // 瀏覽器與 Node 都丟 OperationError；對使用者而言就是「帳號或密碼錯誤」
    throw new VaultError('bad-credentials', '帳號或密碼錯誤');
  }
}
