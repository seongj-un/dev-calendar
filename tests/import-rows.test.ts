import { describe, expect, test } from 'vitest';
import type { ImportedEvent } from '../src/import/types';
import { eventKey } from '../src/model/event';
import {
  buildRows,
  countBy,
  groupByMonth,
  matchesFilter,
  parseShortDate,
  readEditedEnd,
  refreshIncludes,
  shortDate,
  statusOf,
  type RowContext,
} from '../src/app/import-ui/rows';
import {
  isKeyShape,
  loadNeisKey,
  loadSchool,
  maskKey,
  saveSchool,
} from '../src/app/settings/neisPrefs';

function ev(over: Partial<ImportedEvent> = {}): ImportedEvent {
  return {
    title: '개학식',
    rawTitle: '개학식',
    start: '2026-03-03',
    end: '2026-03-03',
    allDay: true,
    category: 'academic',
    holiday: false,
    ...over,
  };
}

const none: RowContext = { grade: null, existing: new Set() };

describe('row status', () => {
  test('a plain row is new and checked', () => {
    const [row] = buildRows([ev()], none);
    expect(statusOf(row!, none)).toBe('new');
    expect(row!.include).toBe(true);
  });

  test('a row with a review reason needs a look and starts unchecked', () => {
    const [row] = buildRows([ev({ review: '행사 이름으로 보입니다.' })], none);
    expect(statusOf(row!, none)).toBe('check');
    expect(row!.include).toBe(false);
  });

  test('editing a row that needed a look makes it new', () => {
    const [row] = buildRows([ev({ review: 'x' })], none);
    row!.edited = true;
    expect(statusOf(row!, none)).toBe('new');
  });

  test('rows for another grade are unchecked, rows for no grade stay', () => {
    const ctx: RowContext = { grade: 2, existing: new Set() };
    const rows = buildRows([ev({ grades: [1] }), ev({ grades: [2, 3] }), ev()], ctx);
    expect(rows.map((r) => statusOf(r, ctx))).toEqual(['grade', 'new', 'new']);
    expect(rows.map((r) => r.include)).toEqual([false, true, true]);
  });

  test('a row already in the calendar is marked and unchecked', () => {
    const ctx: RowContext = { grade: null, existing: new Set([eventKey(ev())]) };
    const [row] = buildRows([ev()], ctx);
    expect(statusOf(row!, ctx)).toBe('exists');
    expect(row!.include).toBe(false);
  });

  test('changing the grade re-checks rows the person did not touch', () => {
    const ctx: RowContext = { grade: null, existing: new Set() };
    const rows = buildRows([ev({ grades: [1] }), ev({ title: 'b', grades: [1] })], ctx);
    rows[1]!.include = false;
    rows[1]!.touched = true;
    ctx.grade = 2;
    refreshIncludes(rows, ctx);
    expect(rows.map((r) => r.include)).toEqual([false, false]);
    ctx.grade = 1;
    refreshIncludes(rows, ctx);
    expect(rows.map((r) => r.include)).toEqual([true, false]);
  });
});

describe('filters and groups', () => {
  test('counts per filter', () => {
    const ctx: RowContext = { grade: 2, existing: new Set() };
    const rows = buildRows(
      [
        ev(),
        ev({ title: '추석', holiday: true, category: 'holiday', review: 'x' }),
        ev({ title: '1학년 행사', grades: [1] }),
      ],
      ctx,
    );
    expect(countBy(rows, ctx)).toEqual({ all: 3, check: 1, grade: 1, holiday: 1, exists: 0 });
    expect(matchesFilter(rows[1]!, 'holiday', ctx)).toBe(true);
  });

  test('groups consecutive rows by start month', () => {
    const rows = buildRows(
      [
        ev(),
        ev({ start: '2026-03-20', end: '2026-03-20', title: 'b' }),
        ev({ start: '2027-01-05', end: '2027-01-05', title: 'c' }),
      ],
      none,
    );
    const groups = groupByMonth(rows);
    expect(groups.map((g) => [g.key, g.month, g.rows.length])).toEqual([
      ['2026-03', 3, 2],
      ['2027-01', 1, 1],
    ]);
  });
});

describe('short dates', () => {
  test('format as M.DD', () => {
    expect(shortDate('2026-03-01')).toBe('3.01');
    expect(shortDate('2026-12-24')).toBe('12.24');
  });

  test('months without a year land in the academic year', () => {
    expect(parseShortDate('3.10', 2026)).toBe('2026-03-10');
    expect(parseShortDate('12/24', 2026)).toBe('2026-12-24');
    expect(parseShortDate('1.05', 2026)).toBe('2027-01-05');
    expect(parseShortDate('2-28', 2026)).toBe('2027-02-28');
  });

  test('a full date is kept, nonsense is refused', () => {
    expect(parseShortDate('2027-01-05', 2026)).toBe('2027-01-05');
    expect(parseShortDate('2026.03.02', 2026)).toBe('2026-03-02');
    expect(parseShortDate('2.30', 2026)).toBeNull();
    expect(parseShortDate('13.01', 2026)).toBeNull();
    expect(parseShortDate('', 2026)).toBeNull();
    expect(parseShortDate('내일', 2026)).toBeNull();
  });

  test('an end is read after its start and moves a year when it would come first', () => {
    expect(readEditedEnd('2.28', '2027-03-01', '2027-02-26')).toBe('2027-02-28');
    expect(readEditedEnd('3.01', '2027-03-01', '2027-02-26')).toBe('2027-03-01');
    expect(readEditedEnd('4.02', null, '2026-05-10')).toBe('2027-04-02');
    expect(readEditedEnd('2.29', null, '2026-05-10')).toBeNull();
    expect(readEditedEnd('2026-04-02', null, '2026-05-10')).toBe('2026-04-02');
  });
});

describe('NEIS key and school storage', () => {
  const store = (initial: Record<string, string> = {}) => {
    const map = new Map(Object.entries(initial));
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
  };

  test('the key shows only its last four characters', () => {
    expect(maskKey('')).toBe('');
    const masked = maskKey('0123456789abcdef0123456789abcdef');
    expect(masked.endsWith('cdef')).toBe(true);
    expect(masked).not.toContain('0123');
    expect(masked.length).toBe(32);
  });

  test('a stored value that is not a key is ignored', () => {
    expect(isKeyShape('short')).toBe(false);
    expect(loadNeisKey(store({ 'datebook:neis-key': '<script>' }))).toBe('');
    expect(loadNeisKey(store({ 'datebook:neis-key': 'abcdef0123456789' }))).toBe(
      'abcdef0123456789',
    );
  });

  test('a school round-trips and bad data reads as none', () => {
    const s = store();
    const school = {
      officeCode: 'G10',
      schoolCode: '7430310',
      name: '대덕소프트웨어마이스터고등학교',
      detail: '고등학교 · 대전',
    };
    saveSchool(s, school);
    expect(loadSchool(s)).toEqual(school);
    saveSchool(s, null);
    expect(loadSchool(s)).toBeNull();
    expect(loadSchool(store({ 'datebook:neis-school': '{"name":1}' }))).toBeNull();
  });
});
