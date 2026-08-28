/**
 * 抓取台灣政府行政機關辦公日曆表 → 產生 data/holidays.json
 *
 * 用法：node scripts/fetch-holidays.js
 * 由 .github/workflows/update-holidays.yml 每月自動執行。
 *
 * 資料來源是行政院人事行政總處公告的辦公日曆表轉成的 JSON。
 * 上游格式：{ "date": "20260101", "week": "四", "isHoliday": true, "description": "開國紀念日" }
 * 注意上游是「完整年曆」（365 筆，含週末），不是只有假日。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'holidays.json');

const START_YEAR = 2026;
const MAX_YEAR = 2040; // 迴圈保險，正常會在遇到 404 時提早停

const SOURCES = [
  (y) => `https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/${y}.json`,
  // 備援。注意預設分支是 master，不是 main。
  (y) => `https://raw.githubusercontent.com/ruyut/TaiwanCalendar/master/data/${y}.json`,
];

/**
 * 抓某一年。
 * → { status: 'ok', rows } | { status: 'not-published' } | { status: 'error', message }
 */
async function fetchYear(year) {
  const errors = [];
  for (const makeUrl of SOURCES) {
    const url = makeUrl(year);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (res.status === 404) {
        // 兩個來源都 404 才視為尚未公告；先記下來繼續試備援
        errors.push(`404 ${url}`);
        continue;
      }
      if (!res.ok) {
        errors.push(`HTTP ${res.status} ${url}`);
        continue;
      }
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) {
        errors.push(`回應不是非空陣列 ${url}`);
        continue;
      }
      return { status: 'ok', rows };
    } catch (err) {
      errors.push(`${err.name}: ${err.message} ${url}`);
    }
  }
  // 全部來源都 404 → 該年份尚未公告（正常結束條件）
  if (errors.every((e) => e.startsWith('404'))) return { status: 'not-published' };
  return { status: 'error', message: errors.join('; ') };
}

/**
 * 上游一年的資料 → 我們的 { 'YYYY-MM-DD': { name, workday? } }
 *
 * 五種 case（皆已對 2026/2027 真實資料驗證）：
 *   isHoliday + 有 description            → 國定假日 / 補假
 *   isHoliday + 無 description + 週六日   → 普通週末，跳過（前端本來就排除週末）
 *   isHoliday + 無 description + 平日     → 異常防禦（實測 0 筆）
 *   !isHoliday + 週六日                   → 補班日 workday:true
 *   !isHoliday + 平日                     → 正常工作日，跳過
 */
function convert(rows, year) {
  const out = {};
  let holidayCount = 0;
  let makeupCount = 0;

  for (const row of rows) {
    const raw = String(row.date ?? '');
    if (!/^\d{8}$/.test(raw)) throw new Error(`${year}: 非預期的 date 格式 ${JSON.stringify(row.date)}`);
    const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    const isWeekend = row.week === '六' || row.week === '日';
    const desc = (row.description || '').trim();

    if (row.isHoliday) {
      if (!desc && isWeekend) continue; // 普通週末
      out[date] = { name: desc || '放假' };
      holidayCount++;
    } else if (isWeekend) {
      out[date] = { name: desc || '補行上班', workday: true };
      makeupCount++;
    }
  }

  return { map: out, holidayCount, makeupCount };
}

function readExisting() {
  if (!existsSync(OUT)) return {};
  try {
    const parsed = JSON.parse(readFileSync(OUT, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.warn(`⚠ 現有 holidays.json 無法解析（${err.message}），視為空檔`);
    return {};
  }
}

async function main() {
  const existing = readExisting();
  const merged = { ...existing };

  const okYears = [];
  const failedYears = [];
  let consecutiveErrors = 0;

  for (let year = START_YEAR; year <= MAX_YEAR; year++) {
    const result = await fetchYear(year);

    if (result.status === 'not-published') {
      console.log(`${year}: 尚未公告，停止`);
      break;
    }

    if (result.status === 'error') {
      // 關鍵：抓取失敗的年份保留原有資料，不清空。
      // 上游暫時掛掉就把假日清空，會讓全團隊看到錯誤的排班。
      console.error(`✗ ${year}: 抓取失敗，保留現有資料 — ${result.message}`);
      failedYears.push(year);
      // 不是 404 而是真的錯誤（斷網、來源掛掉）時，再試後面的年份沒有意義。
      // 不擋下來的話，每年 2 個來源 × 20s timeout 會讓 CI 卡上十分鐘。
      if (++consecutiveErrors >= 2) {
        console.error('✗ 連續兩年抓取失敗，判定為網路或來源問題，中止');
        break;
      }
      continue;
    }

    const { map, holidayCount, makeupCount } = convert(result.rows, year);

    // 只清掉這一年，其他年份（含抓取失敗的）原封不動
    for (const key of Object.keys(merged)) {
      if (key.startsWith(`${year}-`)) delete merged[key];
    }
    Object.assign(merged, map);

    console.log(`${year}: ${holidayCount} 筆假日 / ${makeupCount} 補班日`);
    okYears.push(year);
    consecutiveErrors = 0;
  }

  if (okYears.length === 0) {
    console.error('✗ 沒有任何年份抓取成功，不寫檔');
    process.exit(1);
  }

  mkdirSync(dirname(OUT), { recursive: true });
  const sorted = Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]]));
  writeFileSync(OUT, JSON.stringify(sorted, null, 2) + '\n', 'utf8');

  console.log(`\n已寫入 ${OUT}`);
  console.log(`共 ${Object.keys(sorted).length} 筆，年份：${okYears.join('、')}`);
  if (failedYears.length) {
    console.error(`⚠ 以下年份抓取失敗、沿用舊資料：${failedYears.join('、')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('✗ 未預期的錯誤：', err);
  process.exit(1);
});
