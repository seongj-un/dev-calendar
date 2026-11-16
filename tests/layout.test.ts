import { describe, expect, test } from 'vitest';
import type { CalendarEvent } from '../src/model/event';
import {
  dayEvents,
  isDayOff,
  monthLayout,
  shapeOf,
  shiftMonth,
  timedRoom,
  upcoming,
  visibleEvents,
  weekOf,
} from '../src/app/layout';
import { dday, eventLabel, zoneLabel } from '../src/app/format';

let n = 0;
function ev(title: string, start: string, end = start, extra: Partial<CalendarEvent> = {}) {
  return {
    id: `e${++n}`,
    title,
    start,
    end,
    allDay: true,
    category: 'academic',
    tags: [],
    source: 'manual',
    createdAt: '2026-11-16T00:00:00Z',
    updatedAt: '2026-11-16T00:00:00Z',
    ...extra,
  } satisfies CalendarEvent;
}

describe('month layout', () => {
  test('December 2026 starts on Tuesday and has five Sunday-first rows', () => {
    const m = monthLayout(2026, 12, []);
    expect(m.weeks).toHaveLength(5);
    expect(m.weeks[0]!.days[0]).toBe('2026-11-29');
    expect(m.weeks[0]!.days[2]).toBe('2026-12-01');
    expect(m.weeks[4]!.days[6]).toBe('2027-01-02');
    // ISO week of each row's Monday.
    expect(m.weeks.map((w) => w.week)).toEqual([49, 50, 51, 52, 53]);
  });

  test('Monday-first rows begin on Monday', () => {
    const m = monthLayout(2026, 12, [], 1);
    expect(m.weeks[0]!.days[0]).toBe('2026-11-30');
    expect(m.weeks[0]!.week).toBe(49);
  });

  test('splits a range at week edges and keeps overlapping bars in separate lanes', () => {
    const exam = ev('2학기 기말고사', '2026-12-09', '2026-12-11', { category: 'exam' });
    const trip = ev('현장체험학습', '2026-12-11', '2026-12-15');
    const one = ev('학교 축제', '2026-12-08');
    const m = monthLayout(2026, 12, [trip, one, exam]);
    const w2 = weekOf(m, '2026-12-10')!;
    expect(w2.lanes).toBe(2);
    const byTitle = Object.fromEntries(w2.segments.map((s) => [s.event.title, s]));
    expect(byTitle['2학기 기말고사']).toMatchObject({ col: 3, span: 3, lane: 0 });
    // Same lane as the exam is free on the 8th, taken from the 11th.
    expect(byTitle['학교 축제']).toMatchObject({ col: 2, span: 1, lane: 0 });
    expect(byTitle['현장체험학습']).toMatchObject({ col: 5, span: 2, lane: 1, contR: true });

    const w3 = weekOf(m, '2026-12-14')!;
    expect(w3.segments).toHaveLength(1);
    expect(w3.segments[0]).toMatchObject({ col: 0, span: 3, lane: 0, contL: true, contR: false });
  });

  test('draws each kind with its own shape', () => {
    expect(shapeOf(ev('성탄절', '2026-12-25', '2026-12-25', { category: 'holiday' }))).toBe('mark');
    expect(shapeOf(ev('겨울방학', '2026-12-31', '2027-02-28', { category: 'holiday' }))).toBe(
      'bar',
    );
    expect(shapeOf(ev('[의무귀가]', '2026-12-04', '2026-12-04', { notice: true }))).toBe('notice');
    expect(
      shapeOf(ev('자료구조', '2026-12-10', '2026-12-10', { allDay: false, time: '08:50' })),
    ).toBe('timed');
    expect(
      shapeOf(ev('해커톤', '2026-12-12', '2026-12-13', { allDay: false, time: '10:00' })),
    ).toBe('bar');
  });

  test('orders a day as days off, notices, bars by lane, then timed by time', () => {
    const exam = ev('2학기 기말고사', '2026-12-09', '2026-12-11', { category: 'exam' });
    const eng = ev('영어', '2026-12-10', '2026-12-10', { allDay: false, time: '10:40' });
    const ds = ev('자료구조', '2026-12-10', '2026-12-10', { allDay: false, time: '08:50' });
    const notice = ev('[의무귀가]', '2026-12-10', '2026-12-10', { notice: true });
    const off = ev('재량휴업일', '2026-12-10', '2026-12-10', { category: 'holiday' });
    const all = [eng, exam, ds, notice, off];
    const m = monthLayout(2026, 12, all);
    expect(dayEvents(all, weekOf(m, '2026-12-10'), '2026-12-10').map((e) => e.title)).toEqual([
      '재량휴업일',
      '[의무귀가]',
      '2학기 기말고사',
      '자료구조',
      '영어',
    ]);
    expect(isDayOff(all, '2026-12-10')).toBe(true);
    expect(isDayOff(all, '2026-12-11')).toBe(false);
  });

  test('fewer timed lines fit when bars take more lanes', () => {
    expect(timedRoom(0)).toBe(3);
    expect(timedRoom(1)).toBe(3);
    expect(timedRoom(2)).toBe(2);
    expect(timedRoom(5)).toBe(1);
  });

  test('hides other grades and filters by legend kind', () => {
    const first = ev('입학식', '2026-03-02', '2026-03-02', { grades: [1] });
    const all = ev('개학식', '2026-03-02');
    const due = ev('보고서', '2026-03-03', '2026-03-03', { category: 'assignment' });
    expect(visibleEvents([first, all, due], { grade: 2, kind: null })).toEqual([all, due]);
    expect(visibleEvents([first, all, due], { grade: null, kind: null })).toHaveLength(3);
    expect(visibleEvents([first, all, due], { grade: null, kind: 'due' })).toEqual([due]);
  });

  test('lists exams and deadlines from today, running ranges included', () => {
    const exam = ev('2학기 기말고사', '2026-12-09', '2026-12-11', { category: 'exam' });
    const past = ev('중간고사', '2026-10-01', '2026-10-02', { category: 'exam' });
    const due = ev('보고서', '2026-12-17', '2026-12-17', {
      category: 'assignment',
      allDay: false,
      time: '23:59',
    });
    const flagged = ev('신청 마감', '2026-12-12', '2026-12-12', { deadline: true });
    const plain = ev('축제', '2026-12-12');
    expect(upcoming([due, plain, past, flagged, exam], '2026-12-10').map((e) => e.title)).toEqual([
      '2학기 기말고사',
      '신청 마감',
      '보고서',
    ]);
  });

  test('moves by month keeping the day, clamped to the month end', () => {
    expect(shiftMonth('2026-12-10', 1)).toBe('2027-01-10');
    expect(shiftMonth('2027-01-31', 1)).toBe('2027-02-28');
    expect(shiftMonth('2026-03-31', -1)).toBe('2026-02-28');
    expect(shiftMonth('2026-01-15', -1)).toBe('2025-12-15');
  });
});

describe('format', () => {
  test('names events as title, kind, date', () => {
    expect(eventLabel(ev('2학기 기말고사', '2026-12-09', '2026-12-11', { category: 'exam' }))).toBe(
      '2학기 기말고사, 시험, 12월 9일부터 12월 11일까지',
    );
    expect(eventLabel(ev('현장체험학습', '2026-12-18'))).toBe('현장체험학습, 학사, 12월 18일');
    expect(
      eventLabel(
        ev('웹 프로그래밍 수행평가', '2026-12-04', '2026-12-04', {
          category: 'assignment',
          allDay: false,
          time: '23:59',
        }),
      ),
    ).toBe('웹 프로그래밍 수행평가, 과제 마감, 12월 4일 23:59');
    expect(eventLabel(ev('성탄절', '2026-12-25', '2026-12-25', { category: 'holiday' }))).toBe(
      '성탄절, 쉬는 날, 12월 25일',
    );
  });

  test('counts days to a date', () => {
    expect(dday('2026-12-08', '2026-12-08')).toBe('오늘');
    expect(dday('2026-12-08', '2026-12-11')).toBe('D-3');
    expect(dday('2026-12-31', '2027-01-01')).toBe('D-1');
  });

  test('labels the browser time zone', () => {
    const date = new Date('2026-12-10T00:00:00Z');
    const label = zoneLabel(date);
    expect(label).toMatch(/^UTC[+-]\d+(:\d{2})?$/);
  });
});
