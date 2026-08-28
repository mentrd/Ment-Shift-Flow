/**
 * rules.js 的回歸測試。
 *
 * 用法：node --test scripts/test-rules.js
 * 由 .github/workflows/deploy.yml 在部署前執行。
 *
 * 「一人一週一天」是這個專案唯一的硬約束，而它最容易壞在三個地方：
 * 跨月的週、國定假日、以及日期的 UTC 偏移。這裡把它們全部釘住。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  addDays,
  dowOf,
  isValidDate,
  weekKeyOf,
  weekDays,
  isWorkdayOn,
  wfhOn,
  wfhDaysInWeek,
  canAssign,
  findConflicts,
  monthlyCounts,
  shortLabel,
} from './rules.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

const data = load('data/schedule.json');
const holidays = load('data/holidays.json');

/** 該日 WFH 的人名（依 members 順序） */
const namesOn = (date, d = data) => wfhOn(date, d, holidays).map((m) => m.name);

/** 深拷貝，讓每個測試改資料時互不影響 */
const clone = (o) => JSON.parse(JSON.stringify(o));

describe('日期工具', () => {
  test('dowOf 不受 UTC 偏移影響', () => {
    // new Date('2026-09-01') 會被當 UTC 午夜，在 UTC+8 會變成 8/31。
    // rules.js 用 new Date(y, m-1, d) 本地建構，這裡釘住正確結果。
    assert.equal(dowOf('2026-09-01'), 2, '2026-09-01 是週二');
    assert.equal(dowOf('2026-08-28'), 5, '2026-08-28 是週五');
    assert.equal(dowOf('2026-09-06'), 0, '2026-09-06 是週日');
  });

  test('addDays 跨月跨年', () => {
    assert.equal(addDays('2026-09-30', 1), '2026-10-01');
    assert.equal(addDays('2026-10-01', -1), '2026-09-30');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28', '2026 不是閏年');
    assert.equal(addDays('2028-03-01', -1), '2028-02-29', '2028 是閏年');
  });

  test('isValidDate 擋掉不存在的日期', () => {
    assert.ok(isValidDate('2026-09-01'));
    assert.ok(!isValidDate('2026-02-30'), '2 月沒有 30 日');
    assert.ok(!isValidDate('2026-13-01'));
    assert.ok(!isValidDate('2026-9-1'), '必須是零補位');
    assert.ok(!isValidDate('not-a-date'));
  });

  test('shortLabel', () => {
    assert.equal(shortLabel('2026-09-07'), '09/07 (一)');
    assert.equal(shortLabel('2026-09-11'), '09/11 (五)');
  });
});

describe('週的分組', () => {
  test('週一起算，週日歸前一週', () => {
    assert.equal(weekKeyOf('2026-09-07'), '2026-09-07', '週一是自己');
    assert.equal(weekKeyOf('2026-09-11'), '2026-09-07', '週五');
    assert.equal(weekKeyOf('2026-09-13'), '2026-09-07', '週日仍屬同一週');
    assert.equal(weekKeyOf('2026-09-14'), '2026-09-14', '下週一');
  });

  test('跨月的週共用同一個 key', () => {
    // 這是用月份分組會漏掉衝突的關鍵案例
    assert.equal(weekKeyOf('2026-09-30'), '2026-09-28');
    assert.equal(weekKeyOf('2026-10-02'), '2026-09-28');
    assert.equal(weekKeyOf('2026-10-04'), '2026-09-28');
  });

  test('weekDays 回傳七天，週一到週日', () => {
    assert.deepEqual(weekDays('2026-10-02'), [
      '2026-09-28', '2026-09-29', '2026-09-30',
      '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
    ]);
  });
});

describe('工作日判定', () => {
  test('平日上班、週末不上班', () => {
    assert.ok(isWorkdayOn('2026-09-07', holidays), '週一');
    assert.ok(!isWorkdayOn('2026-09-05', holidays), '週六');
    assert.ok(!isWorkdayOn('2026-09-06', holidays), '週日');
  });

  test('國定假日不上班', () => {
    assert.ok(!isWorkdayOn('2026-09-25', holidays), '中秋節（五）');
    assert.ok(!isWorkdayOn('2026-09-28', holidays), '教師節（一）');
    assert.ok(!isWorkdayOn('2026-10-09', holidays), '國慶補假（五）');
  });

  test('workday:true 的補班日要上班', () => {
    const fake = { '2026-11-21': { name: '補行上班', workday: true } };
    assert.ok(isWorkdayOn('2026-11-21', fake), '雖是週六但要上班');
  });
});

describe('初始資料的每日名單', () => {
  // 對應計畫驗證步驟 5
  const expected = {
    '2026-09-04': ['Louisa', 'Kate', 'Johnny', 'SHERRY', 'LEON', 'ALAN', 'EUDORA'],
    '2026-09-07': ['Max', 'Michelle', 'Chloe', 'RURU', 'TEMA', 'DOWNEY', 'ERIC'],
    '2026-09-11': ['Louisa', 'Kate', 'Johnny', 'SHERRY', 'LEON', 'ALAN', 'EUDORA'],
    '2026-09-14': ['Max', 'Michelle', 'Chloe', 'LEON', 'ALAN', 'EUDORA', 'DOWNEY'],
    '2026-09-18': ['Louisa', 'Kate', 'Johnny'],
    '2026-09-21': ['Max', 'Michelle', 'Chloe', 'RURU', 'TEMA', 'DOWNEY', 'ERIC'],
    '2026-09-25': [], // 中秋
    '2026-09-28': [], // 教師節
  };

  for (const [date, names] of Object.entries(expected)) {
    test(`${shortLabel(date)} → ${names.length ? names.join('、') : '無人'}`, () => {
      assert.deepEqual(namesOn(date), names);
    });
  }

  test('startDate 生效：8 月全員未到職，一個人都沒有', () => {
    // 全體成員的 startDate 都是 2026-09-01
    assert.deepEqual(namesOn('2026-08-31'), [], '8/31（一）');
    assert.deepEqual(namesOn('2026-08-28'), [], '8/28（五）');
    assert.deepEqual(namesOn('2026-09-07').slice(0, 3), ['Max', 'Michelle', 'Chloe'], '9/7 起才有人');
  });
});

describe('一人一週一天：初始資料零衝突', () => {
  test('findConflicts 回傳空陣列', () => {
    assert.deepEqual(findConflicts(data, holidays), []);
  });

  test('8 位 RD 每週最多一天（計畫的核對表）', () => {
    const table = {
      SHERRY: { '2026-08-31': 1, '2026-09-07': 1, '2026-09-14': 0, '2026-09-21': 0 },
      LEON:   { '2026-08-31': 1, '2026-09-07': 1, '2026-09-14': 1, '2026-09-21': 0 },
      ALAN:   { '2026-08-31': 1, '2026-09-07': 1, '2026-09-14': 1, '2026-09-21': 0 },
      EUDORA: { '2026-08-31': 1, '2026-09-07': 1, '2026-09-14': 1, '2026-09-21': 0 },
      RURU:   { '2026-08-31': 0, '2026-09-07': 1, '2026-09-14': 0, '2026-09-21': 1 },
      TEMA:   { '2026-08-31': 0, '2026-09-07': 1, '2026-09-14': 0, '2026-09-21': 1 },
      DOWNEY: { '2026-08-31': 0, '2026-09-07': 1, '2026-09-14': 1, '2026-09-21': 1 },
      ERIC:   { '2026-08-31': 0, '2026-09-07': 1, '2026-09-14': 0, '2026-09-21': 1 },
    };
    for (const [name, weeks] of Object.entries(table)) {
      const id = data.members.find((m) => m.name === name).id;
      for (const [mon, count] of Object.entries(weeks)) {
        assert.equal(
          wfhDaysInWeek(id, mon, data, holidays).length,
          count,
          `${name} 在 ${mon} 那週應有 ${count} 天`,
        );
      }
    }
  });
});

describe('一人一週一天：擋下衝突', () => {
  test('09/11 擋下已在 09/07 排過的 RD', () => {
    // 對應計畫驗證步驟 7
    for (const name of ['RURU', 'TEMA', 'DOWNEY', 'ERIC']) {
      const id = data.members.find((m) => m.name === name).id;
      const r = canAssign(id, '2026-09-11', data, holidays);
      assert.ok(!r.ok, `${name} 應被擋下`);
      assert.equal(r.reason, 'week-taken');
      assert.deepEqual(r.conflictDates, ['2026-09-07']);
    }
  });

  test('先取消再排就通得過', () => {
    // 對應計畫驗證步驟 8
    const id = data.members.find((m) => m.name === 'RURU').id;
    const d = clone(data);
    d.assignments['2026-09-07'].add = d.assignments['2026-09-07'].add.filter((x) => x !== id);
    assert.ok(canAssign(id, '2026-09-11', d, holidays).ok);
  });

  test('跨月的週也算同一週', () => {
    // 對應計畫驗證步驟 9 —— 用月份分組會漏掉這個
    const id = data.members.find((m) => m.name === 'SHERRY').id;
    const d = clone(data);
    d.assignments['2026-09-30'] = { add: [id], remove: [] };

    const r = canAssign(id, '2026-10-02', d, holidays);
    assert.ok(!r.ok, '09/30 與 10/02 同屬 09/28 那一週');
    assert.deepEqual(r.conflictDates, ['2026-09-30']);

    d.assignments['2026-10-02'] = { add: [id], remove: [] };
    const conflicts = findConflicts(d, holidays);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].weekKey, '2026-09-28');
    assert.deepEqual(conflicts[0].dates, ['2026-09-30', '2026-10-02']);
  });

  test('植入的衝突會被偵測到', () => {
    // 對應計畫驗證步驟 12：把 ERIC 加回 09/11
    const id = data.members.find((m) => m.name === 'ERIC').id;
    const d = clone(data);
    d.assignments['2026-09-11'].add.push(id);

    const conflicts = findConflicts(d, holidays);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].name, 'ERIC');
    assert.equal(conflicts[0].weekKey, '2026-09-07');
    assert.deepEqual(conflicts[0].dates, ['2026-09-07', '2026-09-11']);
  });

  test('假日不能排班', () => {
    const id = data.members.find((m) => m.name === 'SHERRY').id;
    assert.equal(canAssign(id, '2026-09-25', data, holidays).reason, 'holiday', '中秋');
    assert.equal(canAssign(id, '2026-09-05', data, holidays).reason, 'holiday', '週六');
  });

  test('未到職不能排班', () => {
    const id = 'pm-max';
    assert.equal(canAssign(id, '2026-08-31', data, holidays).reason, 'inactive');
  });
});

describe('固定日碰上國定假日，該週可以改排別天', () => {
  // 對應計畫驗證步驟 10。這是「檢查基於 wfhOn 實際結果而非名義規則」的價值所在。
  test('教師節（一）讓 PM A 組該週 0 天，可改排週二', () => {
    for (const name of ['Max', 'Michelle', 'Chloe']) {
      const id = data.members.find((m) => m.name === name).id;
      assert.deepEqual(
        wfhDaysInWeek(id, '2026-09-28', data, holidays),
        [],
        `${name} 在教師節那週應為 0 天`,
      );
      assert.ok(
        canAssign(id, '2026-09-29', data, holidays).ok,
        `${name} 應可改排 09/29`,
      );
    }
  });

  test('中秋節（五）讓 PM B 組該週 0 天，可改排週四', () => {
    for (const name of ['Louisa', 'Kate', 'Johnny']) {
      const id = data.members.find((m) => m.name === name).id;
      assert.deepEqual(wfhDaysInWeek(id, '2026-09-25', data, holidays), []);
      assert.ok(canAssign(id, '2026-09-24', data, holidays).ok);
    }
  });

  test('改排後就不能再排第二天', () => {
    const id = 'pm-michelle';
    const d = clone(data);
    d.assignments['2026-09-29'] = { add: [id], remove: [] };
    assert.ok(!canAssign(id, '2026-09-30', d, holidays).ok, '該週已用掉 09/29');
    assert.deepEqual(findConflicts(d, holidays), [], '只有一天，不算衝突');
  });
});

describe('remove 只作用於單日', () => {
  test('取消 09/07 的 Michelle 不影響 09/14', () => {
    const d = clone(data);
    d.assignments['2026-09-07'].remove = ['pm-michelle'];
    assert.ok(!namesOn('2026-09-07', d).includes('Michelle'));
    assert.ok(namesOn('2026-09-14', d).includes('Michelle'), '其他週一不受影響');
    assert.ok(namesOn('2026-09-21', d).includes('Michelle'));
  });
});

describe('月度統計', () => {
  // 對應計畫驗證步驟 15
  test('2026-09 各成員天數', () => {
    const counts = monthlyCounts(2026, 9, data, holidays);
    const byName = Object.fromEntries(
      data.members.map((m) => [m.name, counts[m.id] || 0]),
    );

    // PM A 組：09/07、09/14、09/21（09/28 教師節不計）
    assert.equal(byName.Max, 3);
    assert.equal(byName.Michelle, 3);
    assert.equal(byName.Chloe, 3);
    // PM B 組：09/04、09/11、09/18（09/25 中秋不計）
    assert.equal(byName.Louisa, 3);
    assert.equal(byName.Kate, 3);
    assert.equal(byName.Johnny, 3);
    // RD
    assert.equal(byName.SHERRY, 2, '09/04、09/11');
    assert.equal(byName.LEON, 3, '09/04、09/11、09/14');
    assert.equal(byName.ALAN, 3);
    assert.equal(byName.EUDORA, 3);
    assert.equal(byName.RURU, 2, '09/07、09/21');
    assert.equal(byName.TEMA, 2);
    assert.equal(byName.DOWNEY, 3, '09/07、09/14、09/21');
    assert.equal(byName.ERIC, 2);
  });

  test('2026-08 全員 0 天（都還沒到職）', () => {
    const counts = monthlyCounts(2026, 8, data, holidays);
    assert.deepEqual(counts, {}, '8 月不該有任何人計入');
  });

  test('2026-09 起 startDate 不再影響（9/1 之後照規則展開）', () => {
    const counts = monthlyCounts(2026, 10, data, holidays);
    // 10 月有 4 個週一（5、12、19）與 10/26 光復節補假不計 → 3 天
    assert.equal(counts['pm-michelle'], 3, '10/05、10/12、10/19（10/26 補假不計）');
    // 10 月的週五：2、9(補假)、16、23、30 → 9 日補假不計 → 4 天
    assert.equal(counts['pm-louisa'], 4, '10/02、10/16、10/23、10/30（10/09 補假不計）');
  });
});
