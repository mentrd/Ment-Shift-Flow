/**
 * 排班規則的唯一真實來源。
 *
 * 這個模組同時被以下兩者使用，請勿複製貼上到別處：
 *   - index.html  （前端，透過 <script type="module"> import）
 *   - scripts/validate-data.js（CI 部署前檢查）
 *
 * 全部是純函式：不讀全域狀態、不碰 DOM、不做 I/O。
 * 資料一律以參數傳入，讓前端與 CI 跑出完全相同的結果。
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
