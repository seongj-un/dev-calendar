import { describe, expect, test } from 'vitest';
import { parseIcsText } from '../src/import/ics';
import type { CalendarEvent } from '../src/model/event';
import { escapeText, eventsToIcs, foldLine, whenLines } from '../src/app/export/ics';
import { exportFileName } from '../src/app/export/files';

function ev(partial: Partial<CalendarEvent> & { title: string; start: string }): CalendarEvent {
  return {
    id: 'a1',
    end: partial.start,
    allDay: true,
    category: 'other',
    tags: [],
    source: 'manual',
    createdAt: '2026-12-01T00:00:00.000Z',
    updatedAt: '2026-12-01T00:00:00.000Z',
    ...partial,
  };
}

const NOW = new Date(Date.UTC(2026, 11, 8, 1, 2, 3));

describe('ics export', () => {
  test('a one-day all-day event ends on the next day (exclusive)', () => {
    expect(whenLines(ev({ title: 'x', start: '2026-12-31' }))).toEqual([
      'DTSTART;VALUE=DATE:20261231',
      'DTEND;VALUE=DATE:20270101',
    ]);
  });

  test('a ranged all-day event ends the day after its last day', () => {
    expect(whenLines(ev({ title: 'x', start: '2026-12-09', end: '2026-12-11' }))).toEqual([
      'DTSTART;VALUE=DATE:20261209',
      'DTEND;VALUE=DATE:20261212',
    ]);
  });

  test('timed events keep wall time; the end is written only when known', () => {
    const timed = ev({
      title: 'x',
      start: '2026-12-10',
      allDay: false,
      time: '09:00',
      endTime: '10:30',
    });
    expect(whenLines(timed)).toEqual([
      'DTSTART;TZID=Asia/Seoul:20261210T090000',
      'DTEND;TZID=Asia/Seoul:20261210T103000',
    ]);
    expect(whenLines({ ...timed, endTime: undefined })).toEqual([
      'DTSTART;TZID=Asia/Seoul:20261210T090000',
    ]);
    expect(whenLines({ ...timed, endTime: undefined, end: '2026-12-11' })).toEqual([
      'DTSTART;TZID=Asia/Seoul:20261210T090000',
      'DTEND;TZID=Asia/Seoul:20261212T000000',
    ]);
  });

  test('escapes text and folds long lines on character boundaries', () => {
    expect(escapeText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
    const line = `SUMMARY:${'가'.repeat(60)}`;
    const folded = foldLine(line);
    for (const part of folded.split('\r\n')) {
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, '')).toBe(line);
  });

  test('builds a calendar with CRLF lines and one VEVENT per event', () => {
    const text = eventsToIcs(
      [ev({ title: '배포, v1.2', start: '2026-12-20', tags: ['release'], memo: '줄1\n줄2' })],
      { now: NOW },
    );
    expect(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(text).not.toMatch(/[^\r]\n/);
    expect(text).toContain('DTSTAMP:20261208T010203Z');
    expect(text).toContain('SUMMARY:배포\\, v1.2');
    expect(text).toContain('DESCRIPTION:줄1\\n줄2');
    expect(text).toContain('TRANSP:TRANSPARENT');
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });

  test('timed events carry TZID=Asia/Seoul and the file defines that zone', () => {
    const timed = ev({ title: '회의', start: '2026-12-10', allDay: false, time: '09:00' });
    const text = eventsToIcs([timed], { now: NOW });
    expect(text).toContain('DTSTART;TZID=Asia/Seoul:20261210T090000');
    expect(text).toContain('BEGIN:VTIMEZONE\r\nTZID:Asia/Seoul\r\n');
    expect(text).toContain('TZOFFSETTO:+0900');
    // The zone block comes before the first event; an all-day-only file has none.
    expect(text.indexOf('BEGIN:VTIMEZONE')).toBeLessThan(text.indexOf('BEGIN:VEVENT'));
    expect(
      eventsToIcs([ev({ title: '쉬는 날', start: '2026-12-25' })], { now: NOW }),
    ).not.toContain('VTIMEZONE');
  });

  test('a timed export is read as Seoul time by a calendar in another zone', () => {
    const timed = ev({
      id: 't1',
      title: '회의',
      start: '2026-12-10',
      allDay: false,
      time: '09:00',
    });
    const r = parseIcsText(eventsToIcs([timed], { now: NOW }), 'x.ics', {
      timeZone: 'UTC',
    });
    expect(r.events.map((e) => [e.start, e.time])).toEqual([['2026-12-10', '00:00']]);
  });

  test('our own importer reads the export back', () => {
    const events = [
      ev({ id: 'e1', title: '기말고사', start: '2026-12-09', end: '2026-12-11', category: 'exam' }),
      ev({
        id: 'e2',
        title: '배포',
        start: '2026-12-20',
        allDay: false,
        time: '14:00',
        endTime: '15:00',
      }),
      ev({ id: 'e3', title: '긴 제목 '.repeat(20).trim(), start: '2026-12-24' }),
    ];
    const r = parseIcsText(eventsToIcs(events, { now: NOW }), 'datebook.ics', {
      timeZone: 'Asia/Seoul',
    });
    expect(r.events.map((e) => [e.title, e.start, e.end, e.time ?? '', e.endTime ?? ''])).toEqual(
      events.map((e) => [e.title, e.start, e.end, e.time ?? '', e.endTime ?? '']),
    );
  });

  test('file name carries the local date', () => {
    expect(exportFileName(new Date(2026, 11, 8, 23, 59), 'ics')).toBe('datebook-2026-12-08.ics');
    expect(exportFileName(new Date(2026, 0, 2), 'json')).toBe('datebook-2026-01-02.json');
  });
});
