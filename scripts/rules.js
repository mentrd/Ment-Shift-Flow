/**
 * 排班規則的唯一真實來源。
 *
 * 這個模組同時被以下三者使用，請勿複製貼上到別處：
 *   - index.html  （前端，透過 <script type="module"> import；檢視與編輯都用）
 *   - scripts/validate-data.js（CI 部署前檢查）
 *   - scripts/test-rules.js（回歸測試）
 *
 * 全部是純函式：不讀全域狀態、不碰 DOM、不做 I/O。
 * 資料一律以參數傳入，讓前端與 CI 跑出完全相同的結果。
 * 「異動」段的函式回傳新物件、不 mutate 輸入。
 */

/* ── 日期工具 ─────────────────────────────────────────────
 * 日期一律用 'YYYY-MM-DD' 字串表示。
 * 絕對不要用 new Date('2026-09-01')：那會被當成 UTC 午夜解析，
 * 在 UTC+8 會偏移成前一天。以下都用 new Date(y, m-1, d) 的本地建構式。
 */

/** 'YYYY-MM-DD' → { y, m, d }（數字） */
export function parts(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return { y, m, d };
}

/** Date → 'YYYY-MM-DD'（本地時區） */
export function fmt(dt) {
  const p = (v) => String(v).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

/** 星期幾：0=日, 1=一, … 6=六 */
export function dowOf(dateStr) {
  const { y, m, d } = parts(dateStr);
  return new Date(y, m - 1, d).getDay();
}

/** 日期加減天數，自動跨月跨年 */
export function addDays(dateStr, n) {
  const { y, m, d } = parts(dateStr);
  return fmt(new Date(y, m - 1, d + n));
}

/** 格式檢查（同時擋掉 2026-02-30 這種不存在的日期） */
export function isValidDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) return false;
  const { y, m, d } = parts(dateStr);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

const DOW_LABEL = ['日', '一', '二', '三', '四', '五', '六'];

/** '2026-09-07' → '09/07 (一)'，用於提示訊息 */
export function shortLabel(dateStr) {
  const { m, d } = parts(dateStr);
  const p = (v) => String(v).padStart(2, '0');
  return `${p(m)}/${p(d)} (${DOW_LABEL[dowOf(dateStr)]})`;
}

/* ── 週 ───────────────────────────────────────────────── */

/**
 * 該日所屬那一週的週一日期，作為分組 key。週一起算。
 *
 * ⚠️ 衝突檢查一律用這個分組，不可用月份分組。跨月的週
 *    （例如 2026-09-28 一 ～ 2026-10-04 日）橫跨兩個月，
 *    用月份分組會漏掉衝突。
 */
export function weekKeyOf(dateStr) {
  const dow = dowOf(dateStr);
  const back = dow === 0 ? 6 : dow - 1; // 週日要退 6 天回到週一
  return addDays(dateStr, -back);
}

/** 該週的七天（週一 → 週日） */
export function weekDays(dateStr) {
  const mon = weekKeyOf(dateStr);
  return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(mon, i));
}

/* ── 排班解析 ─────────────────────────────────────────── */

/**
 * 該日是否為上班日。
 * holidays 裡有 workday:true 代表「補行上班」（週六日仍要上班）。
 */
export function isWorkdayOn(dateStr, holidays = {}) {
  const h = holidays[dateStr];
  if (h) return h.workday === true;
  const dow = dowOf(dateStr);
  return dow >= 1 && dow <= 5;
}

/** 成員在該日是否在職（startDate / endDate 皆為可選） */
export function isActiveOn(member, dateStr) {
  if (!member) return false;
  if (member.startDate && dateStr < member.startDate) return false;
  if (member.endDate && dateStr > member.endDate) return false;
  return true;
}

/**
 * 成員在 [from, to] 這段期間內是否有任何一天在職。
 *
 * 名冊類的畫面（月天數面板、人員篩選、人數統計）用它，而不是逐日的
 * isActiveOn：整段期間都不在職的人不該出現在該期間的名冊上。
 * 例如 endDate 2026-09-04 的人，9 月仍要列出（該月有天數），10 月就不該再看到。
 */
export function isActiveInRange(member, from, to) {
  if (!member) return false;
  if (member.startDate && member.startDate > to) return false;
  if (member.endDate && member.endDate < from) return false;
  return true;
}

/** members 陣列 → { id: member } */
export function indexById(members = []) {
  return Object.fromEntries(members.map((m) => [m.id, m]));
}

/**
 * 該日 WFH 的人 → [member, ...]，依 members 原始順序（輸出穩定）。
 *
 * 這是整個 App 的核心。日曆、側欄、統計、衝突檢查全部從它衍生，
 * 所以「誰在哪天 WFH」只有這一處定義。
 *
 * 假日優先於 assignments：若某天已排班、之後政府補公告成假日，
 * 該日指派資料保留但不生效（也讓該人那週可以改排別天）。
 */
export function wfhOn(dateStr, data, holidays = {}) {
  if (!isWorkdayOn(dateStr, holidays)) return [];

  const members = data.members || [];
  const byId = indexById(members);
  const dow = dowOf(dateStr);
  const a = (data.assignments || {})[dateStr] || { add: [], remove: [] };

  // 1. PM 的固定日規則展開
  const ids = new Set(
    members.filter((m) => m.day === dow && isActiveOn(m, dateStr)).map((m) => m.id),
  );
  // 2. 當日取消（PM 臨時回辦公室）
  (a.remove || []).forEach((id) => ids.delete(id));
  // 3. 當日額外指派（RD 排班、PM 臨時改期）
  //    同樣要過 isActiveOn，否則手動指派會繞過到職日
  (a.add || []).filter((id) => isActiveOn(byId[id], dateStr)).forEach((id) => ids.add(id));

  return members.filter((m) => ids.has(m.id));
}

/**
 * 某人在該日所屬那一週的所有 WFH 日期。
 *
 * 刻意基於 wfhOn() 的實際結果而非規則名義值：若某人固定日是週五，
 * 而那週的週五是國定假日，這裡會回傳空陣列 → 該週可以改排別天。
 * 真實案例：2026-09-25 中秋（五）、2026-09-28 教師節（一）。
 */
export function wfhDaysInWeek(memberId, dateStr, data, holidays = {}) {
  return weekDays(dateStr).filter((d) =>
    wfhOn(d, data, holidays).some((m) => m.id === memberId),
  );
}

/**
 * 單一週內違反「一人一週一天」的人。
 * → [{ memberId, name, weekKey, dates: [...] }, ...]
 */
export function conflictsForWeek(dateStr, data, holidays = {}) {
  const byId = indexById(data.members || []);
  const perMember = new Map();
  for (const d of weekDays(dateStr)) {
    for (const m of wfhOn(d, data, holidays)) {
      if (!perMember.has(m.id)) perMember.set(m.id, []);
      perMember.get(m.id).push(d);
    }
  }

  const weekKey = weekKeyOf(dateStr);
  const out = [];
  for (const [id, dates] of perMember) {
    if (dates.length > 1) {
      out.push({ memberId: id, name: byId[id]?.name ?? id, weekKey, dates });
    }
  }
  return out;
}

/**
 * 檢查整份資料是否違反「一人一週一天」。
 * → [{ memberId, name, weekKey, dates: [...] }, ...]
 *
 * 只需掃 assignments 涵蓋的週：PM 規則本身每人單一固定日，
 * 不可能自我衝突；衝突只會來自 assignment 與規則（或另一個
 * assignment）疊在同一週，而那必然落在某個 assignment 的週內。
 */
export function findConflicts(data, holidays = {}) {
  const weeks = new Set(
    Object.keys(data.assignments || {})
      .filter(isValidDate)
      .map(weekKeyOf),
  );

  const out = [];
  for (const mon of [...weeks].sort()) {
    out.push(...conflictsForWeek(mon, data, holidays));
  }
  return out;
}

/**
 * 能不能把 memberId 排在 dateStr？
 * → { ok: true } 或 { ok: false, reason, conflictDates }
 */
export function canAssign(memberId, dateStr, data, holidays = {}) {
  if (!isWorkdayOn(dateStr, holidays)) {
    return { ok: false, reason: 'holiday', conflictDates: [] };
  }
  if (!isActiveOn(indexById(data.members || [])[memberId], dateStr)) {
    return { ok: false, reason: 'inactive', conflictDates: [] };
  }
  const taken = wfhDaysInWeek(memberId, dateStr, data, holidays).filter((d) => d !== dateStr);
  if (taken.length > 0) {
    return { ok: false, reason: 'week-taken', conflictDates: taken };
  }
  return { ok: true, conflictDates: [] };
}

/* ── 異動 ───────────────────────────────────────────────
 * 網頁編輯模式用。每支都以 structuredClone 複製後才動手，回傳新物件；
 * 失敗時回傳的 data 是輸入的等值副本，呼叫端可以無腦覆蓋。
 * 資料只有幾十筆，複製成本可忽略；換來的是測試好寫、UI 好回退。
 */

/** 讓 data.assignments[date] 存在且 add／remove 皆為陣列（mutate，僅本模組內部用） */
function entryFor(data, date) {
  data.assignments ||= {};
  const e = (data.assignments[date] ||= { add: [], remove: [] });
  e.add ||= [];
  e.remove ||= [];
  return e;
}

const pull = (arr, v) => {
  const i = arr.indexOf(v);
  if (i >= 0) arr.splice(i, 1);
};

/** 刪掉 add 與 remove 都空的日期（mutate），避免 JSON 累積 { add: [], remove: [] } 的垃圾 */
export function pruneAssignments(data) {
  for (const [date, e] of Object.entries(data.assignments || {})) {
    if (!(e?.add?.length) && !(e?.remove?.length)) delete data.assignments[date];
  }
  return data;
}

/**
 * 取消 id 在 date 的 WFH → 新 data。
 * 規則來的（固定日）寫進 remove；指派來的直接從 add 移除。
 * 本來就不在該日 WFH → 回傳等值副本（no-op，不寫垃圾）。
 */
export function unassign(data, id, date, holidays = {}) {
  const out = structuredClone(data);
  if (!wfhOn(date, out, holidays).some((m) => m.id === id)) return out;
  const m = indexById(out.members)[id];
  const e = entryFor(out, date);
  pull(e.add, id);
  if (m && m.day === dowOf(date) && !e.remove.includes(id)) e.remove.push(id);
  return pruneAssignments(out);
}

/**
 * 排入 id 到 date → { ok, reason, conflictDates, data }。
 * 目標日是該人固定日 → 只把 id 從 remove 拿掉（恢復），不寫 add；否則 push add（去重）。
 */
export function assign(data, id, date, holidays = {}) {
  const out = structuredClone(data);
  const r = canAssign(id, date, out, holidays);
  if (!r.ok) return { ...r, data: out };
  const m = indexById(out.members)[id];
  const e = entryFor(out, date);
  pull(e.remove, id);
  if (m.day !== dowOf(date) && !e.add.includes(id)) e.add.push(id);
  return { ok: true, conflictDates: [], data: pruneAssignments(out) };
}

/** 切換：該日已 WFH → unassign，否則 assign → 另附 action: 'assigned' | 'unassigned' */
export function applyToggle(data, id, date, holidays = {}) {
  if (wfhOn(date, data, holidays).some((m) => m.id === id)) {
    return { ok: true, conflictDates: [], action: 'unassigned', data: unassign(data, id, date, holidays) };
  }
  return { ...assign(data, id, date, holidays), action: 'assigned' };
}

/**
 * 能不能把 id 從 from 移到 to？
 * 先在副本上 unassign(from) 再 canAssign(to)：直接對原資料 canAssign(to)
 * 會在同週調日時一定被 week-taken 擋下（來源日還在），這就是這支存在的理由。
 */
export function canMove(id, from, to, data, holidays = {}) {
  if (from === to) return { ok: false, reason: 'same-day', conflictDates: [] };
  return canAssign(id, to, unassign(data, id, from, holidays), holidays);
}

/** 移動：canMove 通過才 unassign(from) + assign(to) → { ok, reason, conflictDates, data } */
export function applyMove(data, id, from, to, holidays = {}) {
  const r = canMove(id, from, to, data, holidays);
  if (!r.ok) return { ...r, data: structuredClone(data) };
  return assign(unassign(data, id, from, holidays), id, to, holidays);
}

/**
 * 兩份資料的 assignments 差異 → [{ date, id, kind: 'add'|'remove', op: '+'|'-' }, ...]
 * 以 (date, kind, id) 三元組的對稱差計算：key 順序、空 entry、缺 add/remove 欄位都不算差異。
 * 「N 筆變更未儲存」的 N 就是它的 length；一次移動＝2 筆。
 */
export function diffAssignments(before, after) {
  const triples = (data) => {
    const set = new Set();
    for (const [date, e] of Object.entries(data?.assignments || {})) {
      for (const kind of ['add', 'remove']) {
        for (const id of e?.[kind] || []) set.add(`${date}\u0000${kind}\u0000${id}`);
      }
    }
    return set;
  };
  const a = triples(before);
  const b = triples(after);
  const out = [];
  for (const k of a) if (!b.has(k)) out.push({ ...split(k), op: '-' });
  for (const k of b) if (!a.has(k)) out.push({ ...split(k), op: '+' });
  return out.sort((x, y) => x.date.localeCompare(y.date) || x.kind.localeCompare(y.kind) || x.id.localeCompare(y.id));

  function split(k) {
    const [date, kind, id] = k.split('\u0000');
    return { date, kind, id };
  }
}

/**
 * 產生要寫回 repo 的 schedule.json 內容。
 * - version 沿用、updatedAt 用參數
 * - members 原樣，一人一行（維持既有檔案風格，git diff 才好讀）
 * - assignments 先 prune 再依日期排序，一日一行
 * 不用 JSON.stringify(data, null, 2)：那會把每個 member 展成七行，
 * 第一次網頁儲存就是一大片無意義的 diff。
 */
export function formatSchedule(data, updatedAt) {
  const out = pruneAssignments(structuredClone(data));
  const members = out.members || [];

  // 單行物件：{ "k": v, "k": v }；陣列：[a, b]
  const arr = (xs) => `[${xs.map((x) => JSON.stringify(x)).join(', ')}]`;
  const obj = (pairs) => `{ ${pairs.join(', ')} }`;

  // id 與 name 連逗號一起補白對齊（與手寫檔一致：`"id": "pm-max",      "name": "Max",      "group"`），
  // PM／RD 群組之間空一行
  const cellOf = (k, v, last) => `${JSON.stringify(k)}: ${JSON.stringify(v)}${last ? '' : ','}`;
  const widthOf = (key) => Math.max(0, ...members.map((m) => cellOf(key, m[key] ?? '', false).length));
  const colW = { id: widthOf('id'), name: widthOf('name') };
  const memberLines = members.map((m, i) => {
    const keys = Object.keys(m);
    const cells = keys.map((k, j) => {
      const cell = cellOf(k, m[k], j === keys.length - 1);
      return k in colW && j < keys.length - 1 ? cell.padEnd(colW[k]) : cell;
    });
    const gap = i > 0 && members[i - 1].group !== m.group ? '\n' : '';
    return `${gap}    { ${cells.join(' ')} }`;   // 逗號已在 cell 裡，這裡只用空格接
  });

  const dates = Object.keys(out.assignments || {}).sort();
  const assignmentLines = dates.map((d) => {
    const e = out.assignments[d];
    return `    ${JSON.stringify(d)}: ${obj([`"add": ${arr(e.add || [])}`, `"remove": ${arr(e.remove || [])}`])}`;
  });

  return [
    '{',
    `  "version": ${JSON.stringify(out.version ?? 1)},`,
    `  "updatedAt": ${JSON.stringify(updatedAt)},`,
    '  "members": [',
    memberLines.join(',\n'),
    '  ],',
    '  "assignments": {',
    assignmentLines.join(',\n'),
    '  }',
    '}',
    '',
  ].join('\n');
}

/* ── 月份工具（統計用；注意這是「月」維度，與上面的「週」維度不同）── */

/** 該月所有日期字串 */
export function monthDays(year, month /* 1-12 */) {
  const out = [];
  const last = new Date(year, month, 0).getDate();
  for (let d = 1; d <= last; d++) out.push(fmt(new Date(year, month - 1, d)));
  return out;
}

/**
 * 該月每人的 WFH 天數 → { memberId: count }
 * ⚠️ 按月分組，與 findConflicts 的按週分組是不同維度，不要混用。
 */
export function monthlyCounts(year, month, data, holidays = {}) {
  const counts = {};
  for (const d of monthDays(year, month)) {
    for (const m of wfhOn(d, data, holidays)) {
      counts[m.id] = (counts[m.id] || 0) + 1;
    }
  }
  return counts;
}
