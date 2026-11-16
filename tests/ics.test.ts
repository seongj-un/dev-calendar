import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parseIcsText, parseProp, parseWhen, unfold } from '../src/import/ics';

const text = readFileSync(new URL('./fixtures/school-2026.ics', import.meta.url), 'utf8');

describe('ICS', () => {
  test('reads all-day, ranged, timed and folded events', () => {
    const r = parseIcsText(text, 'school-2026.ics', { timeZone: 'Asia/Seoul' });
    expect(r.kind).toBe('ics');
    expect(r.source).toBe('file:school-2026.ics');
    expect(r.label).toBe('2026학년도 학사일정 (school-2026.ics)');
    const rows = r.events.map((e) =>
      [e.start, e.end, e.title, e.category, e.time ?? '', e.endTime ?? ''].join(' ').trim(),
    );
    expect(rows).toEqual([
      '2026-03-03 2026-03-03 입학식 academic',
      '2026-03-06 2026-03-06 [의무귀가] academic',
      '2026-04-30 2026-05-01 1학기 중간고사 exam',
      '2026-05-05 2026-05-05 어린이날 holiday',
      '2026-05-07 2026-05-07 국제인공지능대전 참관 academic 14:00 16:30',
      '2026-06-01 2026-06-01 온라인 설명회 academic 09:00 10:30',
      '2026-07-13 2026-07-15 교내해커톤 대회 academic',
    ]);
    expect(r.events[0]?.grades).toEqual([1]);
    expect(r.warnings.map((w) => w.message)).toEqual([
      '반복 일정 1개는 첫 번째 날짜만 넣었습니다.',
      '날짜나 제목을 읽지 못한 일정 1개는 뺐습니다.',
    ]);
  });

  test('converts zoned times into the viewer zone', () => {
    const r = parseIcsText(text, 'x.ics', { timeZone: 'America/Los_Angeles' });
    const seminar = r.events.find((e) => e.title === '국제인공지능대전 참관');
    // 14:00 KST on May 7 is 22:00 PDT on May 6.
    expect(seminar).toMatchObject({ start: '2026-05-06', time: '22:00', endTime: '00:30' });
    expect(seminar?.end).toBe('2026-05-07');
  });

  test('handles CRLF, quoted params, escapes and floating times', () => {
    expect(unfold('A:1\r\n  2\r\nB:3')).toEqual(['A:1 2', 'B:3']);
    expect(parseProp('DTSTART;TZID="Asia/Seoul":20260302T090000')).toEqual({
      name: 'DTSTART',
      params: { TZID: 'Asia/Seoul' },
      value: '20260302T090000',
    });
    const floating = parseWhen(parseProp('DTSTART:20260302T090000')!, 'UTC');
    expect(floating).toEqual({ date: '2026-03-02', time: '09:00', dateOnly: false });
    const unknownZone = parseWhen(parseProp('DTSTART;TZID=Mars/Base:20260302T090000')!, 'UTC');
    expect(unknownZone?.time).toBe('09:00');
    const r = parseIcsText(
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20261009\r\nSUMMARY:한글날\\, 쉬는 날\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
      'crlf.ics',
      { timeZone: 'Asia/Seoul' },
    );
    expect(r.events.map((e) => e.title)).toEqual(['한글날, 쉬는 날']);
  });

  test('says so when the file has no events', () => {
    const r = parseIcsText('BEGIN:VCALENDAR\nEND:VCALENDAR\n', 'empty.ics');
    expect(r.events).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toEqual(['no-dates']);
  });

  test('does not rename or split titles from a personal calendar', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:a',
      'DTSTART;VALUE=DATE:20260701',
      'SUMMARY:1학기 기말고사',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:b',
      'DTSTART;VALUE=DATE:20260703',
      'SUMMARY:1학기 기말고사 성적 확인',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:c',
      'DTSTART;VALUE=DATE:20260705',
      'SUMMARY:캡스톤 회의. 장소 변경됨',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const r = parseIcsText(ics, 'mine.ics', { timeZone: 'Asia/Seoul' });
    expect(r.events.map((e) => [e.title, e.start])).toEqual([
      ['1학기 기말고사', '2026-07-01'],
      ['1학기 기말고사 성적 확인', '2026-07-03'],
      ['캡스톤 회의. 장소 변경됨', '2026-07-05'],
    ]);
    expect(r.events[0]!.category).toBe('exam');
  });

  test('keeps parenthesized numbers in titles and the day the file gives', () => {
    const ics = (summary: string) =>
      `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260410\r\nSUMMARY:${summary}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    for (const title of ['학부모 상담 (1-3)', '수행평가 (10-19)', '진로 주간 (12~15일)']) {
      const r = parseIcsText(ics(title), 'x.ics', { timeZone: 'Asia/Seoul' });
      expect(r.events.map((e) => [e.title, e.start, e.end])).toEqual([
        [title, '2026-04-10', '2026-04-10'],
      ]);
    }
  });
});
