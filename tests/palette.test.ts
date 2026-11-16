import { describe, expect, test } from 'vitest';
import type { CalendarEvent } from '../src/model/event';
import { buildEntries } from '../src/app/palette/palette';
import {
  matchCommands,
  parseCommand,
  parseGotoDate,
  parsePaletteInput,
  sameSlot,
  searchEvents,
} from '../src/app/palette/parse';

function ev(partial: Partial<CalendarEvent> & { title: string; start: string }): CalendarEvent {
  return {
    id: partial.title,
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

describe('palette input', () => {
  test('reads a one-line event', () => {
    const r = parsePaletteInput('v1.2 배포 12/20 14:00 #release', '2026-12-08');
    expect(r.kind).toBe('text');
    if (r.kind !== 'text') return;
    expect(r.event).toMatchObject({
      title: 'v1.2 배포',
      start: '2026-12-20',
      end: '2026-12-20',
      time: '14:00',
      tags: ['release'],
    });
  });

  test('uses the selected date when the text has none', () => {
    const r = parsePaletteInput('회의 10:00', '2026-12-08');
    if (r.kind !== 'text') throw new Error('not text');
    expect(r.event?.start).toBe('2026-12-08');
  });

  test('text with no title left is a search only', () => {
    const r = parsePaletteInput('12/20 14:00', '2026-12-08');
    if (r.kind !== 'text') throw new Error('not text');
    expect(r.event).toBeNull();
  });

  test('empty input', () => {
    expect(parsePaletteInput('   ', '2026-12-08')).toEqual({ kind: 'empty' });
  });

  test('a leading > is a command, even when it looks like text', () => {
    const r = parsePaletteInput('>export ics', '2026-12-08');
    expect(r).toMatchObject({ kind: 'command', command: { type: 'export', format: 'ics' } });
  });
});

describe('commands', () => {
  test.each([
    ['goto 2027-03', { type: 'goto', date: '2027-03-01' }],
    ['goto 2027-3', { type: 'goto', date: '2027-03-01' }],
    ['goto 2027-03-15', { type: 'goto', date: '2027-03-15' }],
    ['import', { type: 'import' }],
    ['import neis', { type: 'import-neis' }],
    ['import json', { type: 'import-json' }],
    ['export ics', { type: 'export', format: 'ics' }],
    ['export json', { type: 'export', format: 'json' }],
    ['theme dark', { type: 'theme', theme: 'dark' }],
    ['  THEME   Light ', { type: 'theme', theme: 'light' }],
    ['settings', { type: 'settings' }],
    ['copy link', { type: 'copy-link' }],
    ['weekstart mon', { type: 'weekstart', weekStart: 1 }],
    ['help', { type: 'help' }],
  ])('%s', (body, expected) => {
    expect(parseCommand(body)).toEqual(expected);
  });

  test.each([
    '',
    'goto',
    'goto 2027-13',
    'goto 2027-02-30',
    'export',
    'export pdf',
    'theme',
    'settings x',
    'nope',
    'export ics now',
  ])('not a complete command: "%s"', (body) => {
    expect(parseCommand(body)).toBeNull();
  });

  test('goto reads month-only and compact dates', () => {
    expect(parseGotoDate('202703')).toBe('2027-03-01');
    expect(parseGotoDate('2027.3.9')).toBe('2027-03-09');
    expect(parseGotoDate('abc')).toBeNull();
  });

  test('lists commands by prefix of each word', () => {
    expect(matchCommands('ex').map((c) => c.text)).toEqual(['export ics', 'export json']);
    expect(matchCommands('export j').map((c) => c.text)).toEqual(['export json']);
    expect(matchCommands('goto 20').map((c) => c.text)).toEqual(['goto']);
    expect(matchCommands('zzz')).toEqual([]);
  });
});

describe('search', () => {
  const events = [
    ev({ title: 'v1.2 배포', start: '2026-12-20', tags: ['release'] }),
    ev({ title: '자료구조 과제', start: '2026-12-21', tags: ['ds'] }),
    ev({ title: '릴리스 노트', start: '2026-12-22', tags: ['docs', 'release-notes'] }),
  ];

  test('matches title and tags', () => {
    expect(searchEvents(events, '배포').map((e) => e.title)).toEqual(['v1.2 배포']);
    expect(searchEvents(events, 'ds').map((e) => e.title)).toEqual(['자료구조 과제']);
  });

  test('#word is the start of a tag, not a title match', () => {
    expect(searchEvents(events, '#release').map((e) => e.title)).toEqual([
      'v1.2 배포',
      '릴리스 노트',
    ]);
    expect(searchEvents(events, '#배포')).toEqual([]);
  });

  test('every word must match', () => {
    expect(searchEvents(events, '자료구조 ds').length).toBe(1);
    expect(searchEvents(events, '자료구조 release')).toEqual([]);
  });

  test('stops at the limit and ignores an empty query', () => {
    expect(searchEvents(events, 'e', 1).length).toBe(1);
    expect(searchEvents(events, '  ')).toEqual([]);
  });
});

describe('same slot', () => {
  const timed = ev({ title: '회의', start: '2026-12-20', allDay: false, time: '14:00' });
  test('flags the same day and time only', () => {
    expect(sameSlot([timed], { start: '2026-12-20', time: '14:00' })).toHaveLength(1);
    expect(sameSlot([timed], { start: '2026-12-20', time: '15:00' })).toEqual([]);
    expect(sameSlot([timed], { start: '2026-12-21', time: '14:00' })).toEqual([]);
    expect(sameSlot([timed], { start: '2026-12-20' })).toEqual([]);
  });
});

describe('palette rows', () => {
  const events = [
    ev({
      title: '회의',
      start: '2026-12-20',
      allDay: false,
      time: '14:00',
      updatedAt: '2026-12-02T00:00:00.000Z',
    }),
    ev({ title: '배포', start: '2026-12-21', updatedAt: '2026-12-03T00:00:00.000Z' }),
  ];
  const kinds = (input: string) =>
    buildEntries(input, events, '2026-12-08').map((e) =>
      'section' in e ? `# ${e.section}` : e.row.kind,
    );

  test('empty input lists recent events first, newest first, then commands', () => {
    const entries = buildEntries('', events, '2026-12-08');
    const titles = entries.flatMap((e) =>
      'row' in e && e.row.kind === 'event' ? [e.row.event.title] : [],
    );
    expect(titles).toEqual(['배포', '회의']);
    expect(kinds('')[0]).toBe('# 최근 일정');
  });

  test('text shows the new event first, then matches', () => {
    expect(kinds('배포 12/22')).toEqual(['# 새 일정', 'new']);
    expect(kinds('배포')).toEqual(['# 새 일정', 'new', '# 일정', 'event']);
  });

  test('warns when a new event lands on an occupied time', () => {
    const entries = buildEntries('스터디 12/20 14:00', events, '2026-12-08');
    const row = entries.find((e) => 'row' in e && e.row.kind === 'new');
    expect(row && 'row' in row && row.row.kind === 'new' && row.row.clash).toBe(true);
  });

  test('a complete command comes first and is runnable', () => {
    const entries = buildEntries('>goto 2027-03', events, '2026-12-08');
    const first = entries[1];
    expect(first && 'row' in first && first.row.kind === 'command' && first.row.command).toEqual({
      type: 'goto',
      date: '2027-03-01',
    });
  });

  test('a command that needs more input is listed but not runnable', () => {
    const entries = buildEntries('>goto', events, '2026-12-08');
    const first = entries[1];
    expect(first && 'row' in first && first.row.kind === 'command' && first.row.command).toBeNull();
  });
});
