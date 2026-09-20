/**
 * rules.js 的回歸測試。
 *
 * 用法：node --test scripts/test-rules.js
 * 由 .github/workflows/deploy.yml 在部署前執行。
 *
 * 「一人一週一天」是這個專案唯一的硬約束，而它最容易壞在三個地方：
 * 跨月的週、國定假日、以及日期的 UTC 偏移。這裡把它們全部釘住。
 *
 * 這支測試讀的是 scripts/fixtures/schedule.fixture.json —— 一份凍結的快照，
 * 不是線上的 data/schedule.json。網頁登入後可以直接 commit schedule.json，
 * 測試若跟線上資料綁死，每次在網頁上排班都會讓部署紅掉。
 *
 *   - 這裡只驗證「規則邏輯」：改 rules.js 才可能讓它紅。
 *   - 線上資料的結構與零衝突交給 scripts/validate-data.js（CI 的下一步）。
 *   - 三處 golden value（每日名單、每人每週核對表、月度統計）描述的是 fixture，
 *     不需要跟著線上資料更新。真的要換基準時，把 data/schedule.json 複製過來，
 *     並在同一個 commit 同步改這三處預期值。
 *   - holidays 仍讀真的 data/holidays.json：它由程式產生、網頁不會改，
 *     而且釘住的是已公告的政府資料，不會漂移。
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
  isActiveInRange,
  unassign,
  assign,
  applyToggle,
  canMove,
  applyMove,
  diffAssignments,
  pruneAssignments,
  formatSchedule,
} from './rules.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

const data = load('scripts/fixtures/schedule.fixture.json');
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

describe('fixture 的每日名單（凍結快照）', () => {
  // 對應計畫驗證步驟 5
  const expected = {
    '2026-09-04': ['Louisa', 'Kate', 'Johnny', 'SHERRY', 'LEON', 'ALAN', 'EUDORA'],
    '2026-09-07': ['Michelle', 'Chloe', 'RURU', 'TEMA', 'DOWNEY', 'ERIC'],
    '2026-09-11': ['Louisa', 'Kate', 'Johnny', 'SHERRY', 'LEON', 'ALAN', 'EUDORA'],
    '2026-09-14': ['Michelle', 'Chloe', 'SHERRY', 'LEON', 'RURU', 'DOWNEY'],
    '2026-09-18': ['Louisa', 'Kate', 'Johnny', 'ALAN', 'TEMA', 'ERIC'],
    '2026-09-21': ['Michelle', 'Chloe', 'EUDORA', 'RURU', 'TEMA', 'DOWNEY', 'ERIC'],
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
    assert.deepEqual(namesOn('2026-09-07').slice(0, 2), ['Michelle', 'Chloe'], '9/7 起才有人');
  });
});

describe('一人一週一天：fixture 零衝突', () => {
  test('findConflicts 回傳空陣列', () => {
    assert.deepEqual(findConflicts(data, holidays), []);
  });

  test('8 位 RD 每週最多一天（計畫的核對表）', () => {
    const table = {
      // EUDORA 由 09/18 調到 09/21 後，W 09/14 只剩 7 位 RD，EUDORA 那格是 0
      SHERRY: { '2026-08-31': 1, '2026-09-07': 1, '2026-09-14': 1, '2026-09-21': 0 },
      LEON:   { '2026-08-31': 1, '2026-09-07': 1, '2026-09-14': 1, '2026-09-21': 0 },
      ALAN:   { '2026-08-31': 1, '2026-09-07': 1, '2026-09-14': 1, '2026-09-21': 0 },
      EUDORA: { '2026-08-31': 1, '2026-09-07': 1, '2026-09-14': 0, '2026-09-21': 1 },
      RURU:   { '2026-08-31': 0, '2026-09-07': 1, '2026-09-14': 1, '2026-09-21': 1 },
      TEMA:   { '2026-08-31': 0, '2026-09-07': 1, '2026-09-14': 1, '2026-09-21': 1 },
      DOWNEY: { '2026-08-31': 0, '2026-09-07': 1, '2026-09-14': 1, '2026-09-21': 1 },
      ERIC:   { '2026-08-31': 0, '2026-09-07': 1, '2026-09-14': 1, '2026-09-21': 1 },
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
    const id = 'pm-michelle';
    assert.equal(canAssign(id, '2026-08-31', data, holidays).reason, 'inactive');
  });

  test('離職後不能排班', () => {
    // Max 的 endDate 是 2026-09-04，之後的週一都排不進去
    assert.ok(canAssign('pm-max', '2026-09-04', data, holidays).ok, '最後在職日仍可排');
    assert.equal(canAssign('pm-max', '2026-09-07', data, holidays).reason, 'inactive');
    assert.deepEqual(wfhDaysInWeek('pm-max', '2026-09-07', data, holidays), [], '離職後那週 0 天');
  });
});

describe('固定日碰上國定假日，該週可以改排別天', () => {
  // 對應計畫驗證步驟 10。這是「檢查基於 wfhOn 實際結果而非名義規則」的價值所在。
  test('教師節（一）讓 PM A 組該週 0 天，可改排週二', () => {
    for (const name of ['Michelle', 'Chloe']) {
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
    assert.equal(byName.Max, 0, 'endDate 2026-09-04，9 月的週一都在離職後');
    assert.equal(byName.Michelle, 3);
    assert.equal(byName.Chloe, 3);
    // PM B 組：09/04、09/11、09/18（09/25 中秋不計）
    assert.equal(byName.Louisa, 3);
    assert.equal(byName.Kate, 3);
    assert.equal(byName.Johnny, 3);
    // RD —— 跨週調動只換週次不換月，8 位仍都是 3 天
    assert.equal(byName.SHERRY, 3, '09/04、09/11、09/14');
    assert.equal(byName.LEON, 3, '09/04、09/11、09/14');
    assert.equal(byName.ALAN, 3, '09/04、09/11、09/18');
    assert.equal(byName.EUDORA, 3, '09/04、09/11、09/21');
    assert.equal(byName.RURU, 3, '09/07、09/14、09/21');
    assert.equal(byName.TEMA, 3, '09/07、09/18、09/21');
    assert.equal(byName.DOWNEY, 3, '09/07、09/14、09/21');
    assert.equal(byName.ERIC, 3, '09/07、09/18、09/21');
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

describe('名冊：期間在職判定', () => {
  const max = data.members.find((m) => m.name === 'Max');

  test('Max 的 endDate 是 2026-09-04', () => {
    assert.equal(max.endDate, '2026-09-04');
  });

  test('9 月仍在名冊上（該月有在職日）', () => {
    assert.ok(isActiveInRange(max, '2026-09-01', '2026-09-30'));
  });

  test('10 月起不該再出現在名冊上', () => {
    assert.ok(!isActiveInRange(max, '2026-10-01', '2026-10-31'));
    assert.ok(!isActiveInRange(max, '2026-11-01', '2026-11-30'));
  });

  test('週檢視也一樣：離職那週還在，下一週就不在', () => {
    assert.ok(isActiveInRange(max, '2026-08-31', '2026-09-06'), 'W 08/31 含 09/04');
    assert.ok(!isActiveInRange(max, '2026-09-07', '2026-09-13'), 'W 09/07 已離職');
  });

  test('未到職者同理：8 月不在名冊，9 月才在', () => {
    const eudora = data.members.find((m) => m.name === 'EUDORA');
    assert.equal(eudora.startDate, '2026-09-01');
    assert.ok(!isActiveInRange(eudora, '2026-08-01', '2026-08-31'));
    assert.ok(isActiveInRange(eudora, '2026-09-01', '2026-09-30'));
  });

  test('沒有 startDate / endDate 的人一律在職', () => {
    assert.ok(isActiveInRange({ id: 'x' }, '2020-01-01', '2020-01-31'));
  });
});

describe('異動：applyToggle / applyMove（網頁編輯模式用）', () => {
  // fixture 的 W 09/14：RURU、SHERRY、DOWNEY、LEON 在 09/14；ALAN、TEMA、ERIC 在 09/18；EUDORA 該週空
  const ids = (date, d) => wfhOn(date, d, holidays).map((m) => m.id);

  test('同週調日：直接 canAssign 會被擋，canMove 先移除來源日才通得過', () => {
    assert.equal(canAssign('rd-ruru', '2026-09-16', data, holidays).reason, 'week-taken');
    assert.ok(canMove('rd-ruru', '2026-09-14', '2026-09-16', data, holidays).ok);

    const before = clone(data);
    const r = applyMove(data, 'rd-ruru', '2026-09-14', '2026-09-16', holidays);
    assert.ok(r.ok);
    assert.ok(!ids('2026-09-14', r.data).includes('rd-ruru'), '來源日已移除');
    assert.ok(ids('2026-09-16', r.data).includes('rd-ruru'), '目標日已排入');
    assert.deepEqual(r.data.assignments['2026-09-16'], { add: ['rd-ruru'], remove: [] });
    assert.deepEqual(findConflicts(r.data, holidays), []);
    assert.deepEqual(data, before, '不 mutate 輸入');
  });

  test('跨週調日成功（ALAN 09/18 → 09/23，W 09/21 他是空的）', () => {
    const r = applyMove(data, 'rd-alan', '2026-09-18', '2026-09-23', holidays);
    assert.ok(r.ok);
    assert.ok(ids('2026-09-23', r.data).includes('rd-alan'));
    assert.ok(!ids('2026-09-18', r.data).includes('rd-alan'));
  });

  test('跨週調到已排的週被擋，資料不變', () => {
    const r = applyMove(data, 'rd-ruru', '2026-09-14', '2026-09-22', holidays);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'week-taken');
    assert.deepEqual(r.conflictDates, ['2026-09-21']);
    assert.deepEqual(r.data, data);
  });

  test('調到假日被擋；同一天回 same-day', () => {
    assert.equal(applyMove(data, 'rd-ruru', '2026-09-14', '2026-09-25', holidays).reason, 'holiday');
    assert.equal(canMove('rd-ruru', '2026-09-14', '2026-09-14', data, holidays).reason, 'same-day');
  });

  test('PM 固定日取消 → 寫 remove，其他週不受影響', () => {
    const r = applyToggle(data, 'pm-michelle', '2026-09-07', holidays);
    assert.equal(r.action, 'unassigned');
    assert.deepEqual(r.data.assignments['2026-09-07'].remove, ['pm-michelle']);
    assert.deepEqual(r.data.assignments['2026-09-07'].add, data.assignments['2026-09-07'].add, 'add 不動');
    assert.ok(!ids('2026-09-07', r.data).includes('pm-michelle'));
    assert.ok(ids('2026-09-14', r.data).includes('pm-michelle'));
    assert.ok(ids('2026-09-21', r.data).includes('pm-michelle'));
  });

  test('PM 由 remove 恢復 → 刪 remove 而不是加 add', () => {
    const off = applyToggle(data, 'pm-michelle', '2026-09-07', holidays).data;
    const back = applyToggle(off, 'pm-michelle', '2026-09-07', holidays);
    assert.equal(back.action, 'assigned');
    assert.deepEqual(back.data.assignments['2026-09-07'].remove, []);
    assert.ok(!back.data.assignments['2026-09-07'].add.includes('pm-michelle'));
    assert.deepEqual(back.data, data, '完全回到原狀');
  });

  test('PM 同週改期再拉回，空 entry 會被清掉', () => {
    const moved = applyMove(data, 'pm-michelle', '2026-09-07', '2026-09-08', holidays);
    assert.ok(moved.ok);
    assert.deepEqual(moved.data.assignments['2026-09-07'].remove, ['pm-michelle']);
    assert.deepEqual(moved.data.assignments['2026-09-08'], { add: ['pm-michelle'], remove: [] });

    const back = applyMove(moved.data, 'pm-michelle', '2026-09-08', '2026-09-07', holidays);
    assert.ok(back.ok);
    assert.ok(!('2026-09-08' in back.data.assignments), '09/08 的空 entry 已刪');
    assert.deepEqual(back.data, data);
  });

  test('依序取消 09/18 的三位 RD → 該日 key 消失', () => {
    let d = data;
    for (const id of ['rd-alan', 'rd-tema', 'rd-eric']) d = applyToggle(d, id, '2026-09-18', holidays).data;
    assert.ok(!('2026-09-18' in d.assignments));
    assert.deepEqual(ids('2026-09-18', d), ['pm-louisa', 'pm-kate', 'pm-johnny'], '只剩 PM B 組');
  });

  test('不在職的人排不進去；本來就不在的人 unassign 是 no-op', () => {
    assert.equal(applyToggle(data, 'pm-max', '2026-09-07', holidays).reason, 'inactive');
    assert.deepEqual(unassign(data, 'rd-eudora', '2026-09-14', holidays), data);
  });

  test('assign 對已在 add 的人不重複', () => {
    const d = clone(data);
    d.assignments['2026-09-14'].add.push('rd-ruru');  // 人為重複
    const r = assign(d, 'rd-ruru', '2026-09-14', holidays);
    // 已在該日 → canAssign 會因為 taken 包含自己以外的日期… 這裡該週只有 09/14，所以通過
    assert.ok(r.ok);
    assert.equal(r.data.assignments['2026-09-14'].add.filter((x) => x === 'rd-ruru').length, 2, '不新增第三個');
  });

  test('pruneAssignments 刪掉 add／remove 皆空的日期', () => {
    const d = clone(data);
    d.assignments['2026-10-01'] = { add: [], remove: [] };
    d.assignments['2026-10-02'] = {};
    pruneAssignments(d);
    assert.ok(!('2026-10-01' in d.assignments));
    assert.ok(!('2026-10-02' in d.assignments));
    assert.ok('2026-09-14' in d.assignments);
  });

  test('diffAssignments：無變化 0、toggle 1、move 2；空 entry 與 key 順序不算差異', () => {
    assert.deepEqual(diffAssignments(data, data), []);
    assert.equal(diffAssignments(data, applyToggle(data, 'rd-eudora', '2026-09-14', holidays).data).length, 1);
    const mv = diffAssignments(data, applyMove(data, 'rd-ruru', '2026-09-14', '2026-09-16', holidays).data);
    assert.deepEqual(mv, [
      { date: '2026-09-14', kind: 'add', id: 'rd-ruru', op: '-' },
      { date: '2026-09-16', kind: 'add', id: 'rd-ruru', op: '+' },
    ]);

    const noisy = clone(data);
    noisy.assignments['2026-10-01'] = { add: [], remove: [] };
    const reordered = { ...data, assignments: Object.fromEntries(Object.entries(data.assignments).reverse()) };
    assert.deepEqual(diffAssignments(data, noisy), []);
    assert.deepEqual(diffAssignments(data, reordered), []);
  });

  test('formatSchedule 與手寫檔逐位元相同，且 parse 回來等值', () => {
    const src = readFileSync(join(ROOT, 'scripts/fixtures/schedule.fixture.json'), 'utf8').replace(/\r\n/g, '\n');
    const out = formatSchedule(data, data.updatedAt);
    assert.equal(out, src);
    assert.ok(out.endsWith('\n'));
    assert.deepEqual(JSON.parse(out), data);
  });

  test('formatSchedule 會排序日期、清空 entry、換 updatedAt', () => {
    const d = clone(data);
    d.assignments['2026-08-31'] = { add: ['rd-eudora'], remove: [] };
    d.assignments['2026-12-01'] = { add: [], remove: [] };
    const parsed = JSON.parse(formatSchedule(d, '2026-09-21'));
    assert.equal(parsed.updatedAt, '2026-09-21');
    assert.equal(Object.keys(parsed.assignments)[0], '2026-08-31');
    assert.ok(!('2026-12-01' in parsed.assignments));
    assert.deepEqual(parsed.members, data.members);
  });
});
