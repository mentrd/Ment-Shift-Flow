/**
 * 產生 data/vault.json：把 GitHub PAT 用你的帳號＋密碼加密後存起來。
 *
 * 用法：npm run vault
 *       node scripts/make-vault.js [--out data/vault.json] [--iterations 600000]
 *            [--owner mentrd] [--repo Ment-Shift-Flow] [--branch main] [--path data/schedule.json]
 *            [--expires YYYY-MM-DD] [--no-verify] [--force]
 *
 * 互動輸入帳號、密碼、PAT。密碼與 PAT 輸入時不回顯（顯示 *）。
 * PAT 明文只存在這個程序的記憶體裡，不會寫進任何檔案；vault.json 只有密文。
 *
 * 要在終端機（PowerShell／Windows Terminal／macOS Terminal）互動執行；
 * stdin 不是 TTY 時會直接退出，不會退回明文回顯。
 *
 * 加解密與封裝格式在 scripts/vault.js，與前端共用同一份程式碼。
 */

import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import process from 'node:process';

import { sealVault, openVault, DEFAULT_ITERATIONS, MIN_ITERATIONS } from './vault.js';
import { getFile, GitHubError } from './github.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ── 參數 ─────────────────────────────────────────────── */

function parseArgs(argv) {
  const out = {
    out: 'data/vault.json',
    iterations: DEFAULT_ITERATIONS,
    owner: 'mentrd',
    repo: 'Ment-Shift-Flow',
    branch: 'main',
    path: 'data/schedule.json',
    expires: null,
    verify: true,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--out': out.out = next(); break;
      case '--iterations': out.iterations = Number(next()); break;
      case '--owner': out.owner = next(); break;
      case '--repo': out.repo = next(); break;
      case '--branch': out.branch = next(); break;
      case '--path': out.path = next(); break;
      case '--expires': out.expires = next(); break;
      case '--no-verify': out.verify = false; break;
      case '--force': out.force = true; break;
      case '-h': case '--help':
        console.log('用法見檔頭註解：node scripts/make-vault.js --help');
        process.exit(0);
        break;
      default:
        fail(`不認識的參數：${a}`);
    }
  }
  return out;
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

/* ── 互動輸入 ─────────────────────────────────────────── */

async function ask(label) {
  // 每問一題就 close，避免與下面的 raw mode 搶 stdin
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(label)).trim();
  } finally {
    rl.close();
  }
}

/** 逐字讀取、輸出 *。處理 Enter（\r 或 \n）、Backspace、Ctrl-C、Ctrl-U、貼上的多字 chunk */
function askHidden(label) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) {
      reject(new Error('需要在終端機互動執行（stdin 不是 TTY）。請改用 PowerShell 或 Windows Terminal。'));
      return;
    }
    stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';

    const done = (value) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
      resolve(value);
    };

    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { done(buf); return; }        // Windows raw mode 送的是 \r
        if (ch === '\u0003') { stdout.write('\n'); process.exit(130); }  // Ctrl-C
        if (ch === '\u007f' || ch === '\b') {                            // Backspace
          if (buf) { buf = buf.slice(0, -1); stdout.write('\b \b'); }
          continue;
        }
        if (ch === '\u0015') {                                           // Ctrl-U 清空
          stdout.write('\b \b'.repeat(buf.length));
          buf = '';
          continue;
        }
        if (ch < ' ') continue;                                          // 其他控制字元忽略
        buf += ch;
        stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

/* ── 主流程 ───────────────────────────────────────────── */

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20 || !globalThis.crypto?.subtle) fail(`需要 Node ≥ 20（目前 ${process.versions.node}）`);

  const opt = parseArgs(process.argv.slice(2));
  if (!Number.isInteger(opt.iterations) || opt.iterations < MIN_ITERATIONS) {
    fail(`--iterations 至少 ${MIN_ITERATIONS}（前端會拒絕更低的值）`);
  }
  if (opt.expires && !/^\d{4}-\d{2}-\d{2}$/.test(opt.expires)) fail('--expires 需為 YYYY-MM-DD');

  const outPath = resolve(ROOT, opt.out);
  const target = { owner: opt.owner, repo: opt.repo, branch: opt.branch, path: opt.path };

  console.log('── 產生網頁排班用的 vault ──');
  console.log(`寫回目標：${target.owner}/${target.repo}@${target.branch} ${target.path}`);
  console.log(`輸出檔案：${opt.out}`);
  console.log('');

  if (existsSync(outPath) && !opt.force) {
    const ans = await ask(`${opt.out} 已存在，覆寫？(y/N) `);
    if (!/^y(es)?$/i.test(ans)) fail('已取消');
  }

  // 帳號
  const user = await ask('帳號：');
  if (!user) fail('帳號不可為空');
  if (/^(admin|root|user|test)$/i.test(user)) console.log('  ⚠ 帳號太好猜（密文是公開的，帳號也是熵的一部分），建議換一個。');
  console.log(`  帳號：「${user}」（區分大小寫）`);

  // 密碼
  let password;
  for (;;) {
    password = await askHidden('密碼（至少 12 字元，建議 4–5 個隨機單字）：');
    if (password.trim().length < 12) { console.log('  ✗ 太短：密文是公開的，短密語會被離線暴力破解。再試一次。'); continue; }
    if (password.trim().length < 16) console.log('  ⚠ 12–15 字元勉強可用；能更長更好。');
    const again = await askHidden('再輸入一次密碼：');
    if (again !== password) { console.log('  ✗ 兩次不同，重來。'); continue; }
    break;
  }

  // PAT
  let token = await askHidden('GitHub PAT（github_pat_…）：');
  token = token.trim();
  if (!token) fail('PAT 不可為空');
  if (/^ghp_/.test(token)) {
    console.log('  ⚠ 這是 classic token，權限範圍是整個帳號。強烈建議改用 fine-grained PAT（只授權這個 repo、只給 Contents 讀寫）。');
    const ans = await ask('  仍要繼續？(y/N) ');
    if (!/^y(es)?$/i.test(ans)) fail('已取消');
  } else if (!/^(github_pat_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9_]{20,})$/.test(token)) {
    console.log('  ⚠ 看起來不像 GitHub token（預期 github_pat_ 開頭）。');
    const ans = await ask('  仍要繼續？(y/N) ');
    if (!/^y(es)?$/i.test(ans)) fail('已取消');
  }

  // 線上驗證：至少要讀得到目標檔
  if (opt.verify) {
    process.stdout.write('驗證 PAT 能讀取目標檔…');
    try {
      const f = await getFile(target, token);
      console.log(` ✓（sha ${f.sha.slice(0, 7)}，${f.size} bytes）`);
      console.log('  註：寫入權無法在不寫入的情況下驗證；PAT 要有 Contents: Read and write。');
    } catch (err) {
      console.log('');
      if (err instanceof GitHubError) {
        if (err.kind === 'unauthorized') fail('PAT 無效或已撤銷（401）');
        if (err.kind === 'forbidden' || err.kind === 'not-found') {
          fail(`PAT 沒有 ${target.owner}/${target.repo} 的權限，或 org 尚未核准這個 fine-grained PAT（${err.status}：${err.detail}）`);
        }
        if (err.kind === 'network') fail(`無法連線 GitHub API：${err.detail}（離線時可加 --no-verify）`);
      }
      fail(`驗證失敗：${err.message}`);
    }
  } else {
    console.log('已跳過線上驗證（--no-verify）');
  }

  // 加密 → 自驗 → 寫檔
  process.stdout.write(`以 PBKDF2 ${opt.iterations.toLocaleString()} 次迭代加密…`);
  const vault = await sealVault({
    user, password, secret: token,
    iterations: opt.iterations, target,
    expiresAt: opt.expires || undefined,
    note: 'GitHub PAT · Contents Read and write · 只授權此 repo',
  });
  console.log(' ✓');

  const t0 = performance.now();
  const back = await openVault(vault, user, password);
  const ms = Math.round(performance.now() - t0);
  if (back !== token) fail('自我驗證失敗：解回來的不一樣（這不該發生）');
  console.log(`自我驗證 ✓　本機解密耗時 ${ms} ms（瀏覽器約同等級；手機可能 2–3 倍）`);

  writeFileSync(outPath, `${JSON.stringify(vault, null, 2)}\n`, 'utf8');
  password = null;
  token = null;

  console.log('');
  console.log(`已寫入 ${opt.out}（PAT 只以密文存在，明文未寫入任何檔案）`);
  console.log('');
  console.log('下一步：');
  console.log(`  1. git add ${opt.out}`);
  console.log('  2. git commit -m "chore: 更新網頁排班用 vault"');
  console.log('  3. git push');
  console.log('  4. npm run dev → http://localhost:3000 → 右上「登入」用剛設定的帳密測試');
  if (opt.expires) console.log(`提醒：PAT 於 ${opt.expires} 到期，到期前重新執行 npm run vault。`);
  console.log('洩漏時：先到 GitHub 撤銷該 PAT，再建新的並重做 vault（順便換密語）。');
}

main().catch((err) => fail(err.message));
