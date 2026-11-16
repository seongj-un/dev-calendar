import { describe, expect, test } from 'vitest';
import {
  academicYearOf,
  addDays,
  diffDays,
  isIsoDate,
  isoWeek,
  isWeekend,
  localIsoDate,
  weekday,
  yearInAcademicYear,
  ymd,
} from '../src/model/date';

describe('date helpers', () => {
  test('validates ISO dates including leap days', () => {
    expect(isIsoDate('2026-03-01')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2027-02-29')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-3-1')).toBe(false);
    expect(isIsoDate(20260301)).toBe(false);
    expect(ymd(2026, 4, 31)).toBeNull();
    expect(ymd(2026, 4, 30)).toBe('2026-04-30');
  });

  test('adds and diffs days across months, years and DST dates', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09'); // US DST start
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02'); // US DST end
    expect(diffDays('2026-03-10', '2026-03-19')).toBe(9);
    expect(diffDays('2027-01-08', '2026-12-31')).toBe(-8);
  });

  test('weekday does not depend on the local zone', () => {
    expect(weekday('2026-03-01')).toBe(0); // Sunday
    expect(weekday('2026-11-16')).toBe(1);
    expect(isWeekend('2026-05-16')).toBe(true);
    expect(isWeekend('2026-05-15')).toBe(false);
  });

  test('ISO week numbers at year edges', () => {
    expect(isoWeek('2026-12-10')).toEqual({ year: 2026, week: 50 });
    expect(isoWeek('2027-01-01')).toEqual({ year: 2026, week: 53 });
    expect(isoWeek('2027-01-04')).toEqual({ year: 2027, week: 1 });
    expect(isoWeek('2024-12-30')).toEqual({ year: 2025, week: 1 });
  });

  test('academic years start in March', () => {
    expect(academicYearOf('2027-02-20')).toBe(2026);
    expect(academicYearOf('2026-03-01')).toBe(2026);
    expect(yearInAcademicYear(2026, 1)).toBe(2027);
    expect(yearInAcademicYear(2026, 12)).toBe(2026);
  });

  test('localIsoDate uses local fields', () => {
    expect(localIsoDate(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
  });
});
