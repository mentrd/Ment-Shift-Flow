/**
 * 部署前的資料檢查。由 .github/workflows/deploy.yml 執行。
 *
 * 用法：node scripts/validate-data.js
 *
 * schedule.json 是由網頁匯出、人工貼回 repo 的，所以最可能的失敗是
 * 貼壞（整站白畫面）或排出衝突。這支程式把兩者擋在部署之前。
 *
 * 規則邏輯全部來自 rules.js —— 與前端同一份原始碼，不會漂移。
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  isValidDate,
  findConflicts,
  isWorkdayOn,
  isActiveOn,
  indexById,
  shortLabel,
  weekKeyOf,
} from './rules.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const errors = [];
const warnings = [];

function loadJson(rel) {
  const path = join(ROOT, rel);
  if (!existsSync(path)) {
    errors.push(`缺少檔案：${rel}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    errors.push(`${rel} 無法解析為 JSON：${err.message}`);
    return null;
  }
}

function report() {
  for (const w of warnings) console.warn(`⚠ ${w}`);
  if (errors.length) {
    console.error('');
    for (const e of errors) console.error(`✗ ${e}`);
    console.error(`\n${errors.length} 項錯誤，資料未通過檢查。`);
    process.exit(1);
  }
  console.log(
    warnings.length
      ? `\n✓ 資料通過檢查（${warnings.length} 項警告，不阻擋部署）`
      : '\n✓ 資料通過檢查',
  );
}

/* ── 載入 ─────────────────────────────────────────────── */

const data = loadJson('data/schedule.json');
const holidays = loadJson('data/holidays.json');
if (!data || !holidays) report();

/* ── members ──────────────────────────────────────────── */

const members = data.members;
if (!Array.isArray(members)) {
  errors.push('schedule.json 的 members 必須是陣列');
  report();
}

const seenIds = new Set();
for (const [i, m] of members.entries()) {
  const at = `members[${i}]`;
  const label = m && m.name ? `${at} (${m.name})` : at;

  if (!m || typeof m !== 'object') {
    errors.push(`${at} 不是物件`);
    continue;
  }
  if (typeof m.id !== 'string' || !m.id.trim()) errors.push(`${label} 缺少 id`);
  else if (seenIds.has(m.id)) errors.push(`${label} 的 id 重複：${m.id}`);
  else seenIds.add(m.id);

  if (typeof m.name !== 'string' || !m.name.trim()) errors.push(`${at} 缺少 name`);
  if (m.group !== 'PM' && m.group !== 'RD') {
    errors.push(`${label} 的 group 必須是 PM 或 RD，目前是 ${JSON.stringify(m.group)}`);
  }

  // day 是單一值（不是陣列），這是「一人一週一天」在資料層的保證
  const dayOk = m.day === null || m.day === undefined || (Number.isInteger(m.day) && m.day >= 1 && m.day <= 5);
  if (!dayOk) {
    errors.push(`${label} 的 day 必須是 1–5 的整數或 null，目前是 ${JSON.stringify(m.day)}`);
  }

  for (const field of ['startDate', 'endDate']) {
    if (m[field] != null && !isValidDate(m[field])) {
      errors.push(`${label} 的 ${field} 不是合法日期：${JSON.stringify(m[field])}`);
    }
  }
  if (m.startDate && m.endDate && isValidDate(m.startDate) && isValidDate(m.endDate) && m.startDate > m.endDate) {
    errors.push(`${label} 的 startDate (${m.startDate}) 晚於 endDate (${m.endDate})`);
  }
}

const byId = indexById(members);

/* ── holidays ─────────────────────────────────────────── */

if (typeof holidays !== 'object' || Array.isArray(holidays)) {
  errors.push('holidays.json 必須是以日期為 key 的物件');
} else {
  for (const [date, info] of Object.entries(holidays)) {
    if (!isValidDate(date)) errors.push(`holidays.json 的 key 不是合法日期：${date}`);
    if (!info || typeof info !== 'object') {
      errors.push(`holidays.json ${date} 的值不是物件`);
      continue;
    }
    if (typeof info.name !== 'string' || !info.name.trim()) {
      errors.push(`holidays.json ${date} 缺少 name`);
    }
    if (info.workday !== undefined && typeof info.workday !== 'boolean') {
      errors.push(`holidays.json ${date} 的 workday 必須是 boolean`);
    }
  }

  const years = Object.keys(holidays)
    .filter(isValidDate)
    .map((d) => Number(d.slice(0, 4)));
  const maxYear = years.length ? Math.max(...years) : 0;
  const thisYear = new Date().getFullYear();
  if (maxYear < thisYear) {
    warnings.push(
      `holidays.json 最新年份是 ${maxYear || '(無)'}，已早於今年 ${thisYear}，請執行 node scripts/fetch-holidays.js`,
    );
  }
}

/* ── assignments ──────────────────────────────────────── */

const assignments = data.assignments;
if (assignments == null || typeof assignments !== 'object' || Array.isArray(assignments)) {
  errors.push('schedule.json 的 assignments 必須是以日期為 key 的物件');
} else {
  for (const [date, entry] of Object.entries(assignments)) {
    if (!isValidDate(date)) {
      errors.push(`assignments 的 key 不是合法日期：${date}`);
      continue;
    }
    if (!entry || typeof entry !== 'object') {
      errors.push(`assignments ${date} 的值不是物件`);
      continue;
    }

    for (const field of ['add', 'remove']) {
      const list = entry[field];
      if (list === undefined) continue;
      if (!Array.isArray(list)) {
        errors.push(`assignments ${date} 的 ${field} 必須是陣列`);
        continue;
      }
      for (const id of list) {
        if (!byId[id]) errors.push(`assignments ${date} 的 ${field} 有不存在的成員 id：${id}`);
      }
      const dupes = list.filter((id, i) => list.indexOf(id) !== i);
      if (dupes.length) {
        errors.push(`assignments ${date} 的 ${field} 有重複的 id：${[...new Set(dupes)].join('、')}`);
      }
    }

    // 同一人同時出現在 add 與 remove 是矛盾的意圖，一定是手改出錯
    const both = (entry.add || []).filter((id) => (entry.remove || []).includes(id));
    if (both.length) {
      errors.push(
        `assignments ${date} 同一人同時出現在 add 與 remove：${both.map((id) => byId[id]?.name ?? id).join('、')}`,
      );
    }

    // ── 以下是 warning：資料留著但不會生效 ──
    if (!isWorkdayOn(date, holidays)) {
      const why = holidays[date] ? holidays[date].name : '週末';
      warnings.push(`assignments ${date} 落在${why}，該日指派不會生效（資料保留）`);
    }
    for (const id of entry.add || []) {
      if (byId[id] && !isActiveOn(byId[id], date)) {
        warnings.push(
          `assignments ${date} 指派了 ${byId[id].name}，但其在職區間不含該日，不會生效`,
        );
      }
    }
  }
}

/* ── 「一人一週一天」衝突（硬約束，一律 error）───────────
 * 用 weekKeyOf 按週分組。絕不可按月分組：跨月的週
 * （例如 2026-09-28 一 ～ 2026-10-04 日）會被漏掉。
 */

if (errors.length === 0) {
  for (const c of findConflicts(data, holidays)) {
    errors.push(
      `衝突：${c.name} 在 ${c.weekKey} 那週排了 ${c.dates.length} 天（${c.dates.map(shortLabel).join('、')}）` +
        ' — 一個人一週只能有一天 WFH',
    );
  }
}

/* ── 摘要 ─────────────────────────────────────────────── */

if (errors.length === 0) {
  const weeks = new Set(Object.keys(data.assignments || {}).filter(isValidDate).map(weekKeyOf));
  console.log(
    `成員 ${members.length} 人（PM ${members.filter((m) => m.group === 'PM').length}、` +
      `RD ${members.filter((m) => m.group === 'RD').length}）` +
      `／指派 ${Object.keys(data.assignments || {}).length} 日、涵蓋 ${weeks.size} 週` +
      `／假日 ${Object.keys(holidays).length} 筆`,
  );
}

report();
