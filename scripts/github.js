/**
 * GitHub Contents API 的最小封裝：讀一個檔、寫一個檔（= 建一個 commit）。
 *
 * 這個模組同時被以下三者使用：
 *   - index.html            （前端登入後讀取／儲存 data/schedule.json）
 *   - scripts/make-vault.js （產生 vault 前先驗證 PAT 讀得到 repo）
 *   - scripts/test-vault.js （classifyError 的測試）
 * 只用 fetch，不 import Node 模組。api.github.com 支援 CORS，瀏覽器可直接打。
 *
 * 絕對不要在任何地方 console.log token 或 headers。
 */

import { utf8ToB64, b64ToUtf8 } from './vault.js';

export const API = 'https://api.github.com';
export const API_VERSION = '2022-11-28';

export class GitHubError extends Error {
  /**
   * @param {number} status HTTP 狀態碼；網路層失敗為 0
   * @param {'network'|'unauthorized'|'forbidden'|'not-found'|'sha-conflict'|'blocked-by-rules'|'rate-limited'|'validation'|'unknown'} kind
   * @param {string} detail API 回的 message（或網路錯誤訊息）
   */
  constructor(status, kind, detail) {
    super(`GitHub API ${status || 'network'}: ${detail}`);
    this.name = 'GitHubError';
    this.status = status;
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * 從 status + body.message（+ headers）分類。
 * 先看訊息文字再看狀態碼：ruleset／分支保護的拒絕可能是 409 也可能是 422，
 * sha 不符也可能是 409 或 422，只靠狀態碼分不出來。
 */
export function classifyError(status, body, headers) {
  const msg = String(body?.message ?? body ?? '');
  const get = (k) => (headers?.get ? headers.get(k) : headers?.[k]) ?? null;

  if (!status) return 'network';
  if (/does not match|is at .* but expected/i.test(msg)) return 'sha-conflict';
  if (/rule|protected branch|pull request/i.test(msg)) return 'blocked-by-rules';
  if (status === 401) return 'unauthorized';
  if (status === 403) return get('x-ratelimit-remaining') === '0' ? 'rate-limited' : 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 409) return 'sha-conflict';
  if (status === 422) return 'validation';
  return 'unknown';
}

function headersFor(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    ...extra,
  };
}

async function call(url, init) {
  let res;
  try {
    res = await fetch(url, { ...init, cache: 'no-store' });
  } catch (err) {
    throw new GitHubError(0, 'network', err?.message || '無法連線');
  }
  let body = null;
  try { body = await res.json(); } catch { /* 空 body 或非 JSON */ }
  if (!res.ok) {
    throw new GitHubError(res.status, classifyError(res.status, body, res.headers), body?.message ?? res.statusText);
  }
  return body;
}

const contentsUrl = ({ owner, repo, path }) =>
  `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;

/**
 * GET /repos/{owner}/{repo}/contents/{path}?ref={branch}
 * → { sha, text, size, htmlUrl }
 */
export async function getFile({ owner, repo, path, branch }, token) {
  const body = await call(`${contentsUrl({ owner, repo, path })}?ref=${encodeURIComponent(branch)}`, {
    method: 'GET',
    headers: headersFor(token),
  });
  if (body?.type !== 'file' || body.encoding !== 'base64') {
    throw new GitHubError(200, 'unknown', `${path} 不是檔案，或編碼不是 base64`);
  }
  return { sha: body.sha, text: b64ToUtf8(body.content), size: body.size, htmlUrl: body.html_url };
}

/**
 * PUT 同一路徑 → 建一個 commit。
 * text 是 UTF-8 字串；sha 是目前檔案的 blob sha（不符會被 GitHub 拒絕，這就是我們要的樂觀鎖）。
 * → { commitSha, commitUrl, contentSha }
 */
export async function putFile({ owner, repo, path, branch }, token, { text, sha, message }) {
  const body = await call(contentsUrl({ owner, repo, path }), {
    method: 'PUT',
    headers: headersFor(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message, content: utf8ToB64(text), sha, branch }),
  });
  return {
    commitSha: body?.commit?.sha,
    commitUrl: body?.commit?.html_url,
    contentSha: body?.content?.sha,
  };
}
