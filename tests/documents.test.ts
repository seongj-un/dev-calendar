import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import * as XLSX from 'xlsx';
import CFB from 'cfb';
import JSZip from 'jszip';
import { eventsFromTable, guessMapping, parseXlsx, type Cell } from '../src/import/xlsx';
import { blocksToLines, cellEvents, readWeeklyTables, type DocBlock } from '../src/import/document';
import { parseHwpx, sectionBlocks } from '../src/import/hwpx';
import { paraText, parseHwp, readRecords } from '../src/import/hwp';
import type { ImportedEvent } from '../src/import/types';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const opts = { today: new Date(2026, 10, 16) };

const show = (events: ImportedEvent[]) =>
  events.map(
    (e) =>
      `${e.start}~${e.end} ${e.title}${e.time ? ` ${e.time}` : ''}${e.grades ? ` g${e.grades}` : ''} ${e.category}`,
  );

describe('Excel', () => {
  test.each(['schedule-table.xlsx', 'schedule-table.xls'])(
    'reads a table with date cells and written dates (%s)',
    async (name) => {
      const r = await parseXlsx(fixture(name), name, { ...opts, xlsx: XLSX });
      expect(r.kind).toBe('xlsx');
      expect(r.table?.sheet).toBe('2026학년도');
      expect(r.table?.mapping).toEqual({ headerRow: 0, dateCol: 0, endCol: 1, titleCol: 2 });
      expect(show(r.events)).toEqual([
        '2026-03-02~2026-03-02 입학식 academic',
        '2026-03-03~2026-03-03 개학식 academic',
        '2026-04-20~2026-04-24 1학기 중간고사 exam',
        '2026-05-05~2026-05-05 어린이날 holiday',
        '2026-05-07~2026-05-07 국제인공지능대전 참관 14:00 academic',
        '2027-02-10~2027-02-16 겨울방학 academic',
      ]);
    },
  );

  test('reads a month-column grid sheet', async () => {
    const r = await parseXlsx(fixture('schedule-grid.xlsx'), 'grid.xlsx', {
      today: new Date(2031, 0, 1),
      xlsx: XLSX,
    });
    expect(r.academicYear).toBe(2026); // from the weekday column
    expect(r.table).toBeUndefined();
    expect(show(r.events)).toEqual([
      '2026-03-01~2026-03-01 3.1절 holiday',
      '2026-03-03~2026-03-03 개학식 g2,3 academic',
      '2026-03-03~2026-03-03 입학식 g1 academic',
      '2026-03-10~2026-03-19 신입생전공멘토링 academic',
      '2026-04-20~2026-04-22 1학기 중간고사 exam',
      '2026-04-24~2026-04-24 [의무귀가] academic',
    ]);
  });

  test('re-reads a table with a mapping chosen in the preview', () => {
    const rows: Cell[][] = [
      ['월', '일', '행사', '날짜(참고)'],
      ['3월', 2, '입학식', null],
      [null, 3, '개학식', null],
      ['4월', 20, '중간고사', null],
    ];
    const guessed = guessMapping(rows);
    expect(guessed).toEqual({ headerRow: 0, dateCol: 1, titleCol: 2, monthCol: 0 });
    expect(eventsFromTable(rows, guessed!, 2026).map((e) => `${e.start} ${e.title}`)).toEqual([
      '2026-03-02 입학식',
      '2026-03-03 개학식',
      '2026-04-20 중간고사',
    ]);
  });

  test('says so when no column holds dates', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['이름', '점수'],
        ['가', 1],
      ]),
      'S',
    );
    const data = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const r = await parseXlsx(data, 'scores.xlsx', { ...opts, xlsx: XLSX });
    expect(r.events).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toEqual(['no-dates']);
  });
});

describe('HWPX', () => {
  test('reads paragraphs and table rows', async () => {
    const r = await parseHwpx(fixture('schedule.hwpx'), 'schedule.hwpx', { ...opts, jszip: JSZip });
    expect(r.academicYear).toBe(2026);
    expect(show(r.events)).toEqual([
      '2026-03-02~2026-03-02 입학식 g1 academic',
      '2026-03-03~2026-03-03 개학식 g2,3 academic',
      '2026-04-20~2026-04-24 1학기 중간고사 exam',
      '2026-05-05~2026-05-05 어린이날 holiday',
      '2026-07-17~2026-08-16 여름방학 academic',
      '2027-01-07~2027-01-07 졸업식 & 종업식 academic',
    ]);
  });

  test('keeps nested table rows inside their cell and decodes entities', () => {
    const xml =
      '<hs:sec><hp:p><hp:run><hp:t>머리 &lt;1&gt; &#xAC00;</hp:t></hp:run></hp:p>' +
      '<hp:tbl><hp:tr><hp:tc><hp:p><hp:t>3/2</hp:t></hp:p></hp:tc><hp:tc>' +
      '<hp:tbl><hp:tr><hp:tc><hp:p><hp:t>안</hp:t></hp:p></hp:tc><hp:tc><hp:p><hp:t>쪽</hp:t></hp:p></hp:tc></hp:tr></hp:tbl>' +
      '</hp:tc></hp:tr></hp:tbl></hs:sec>';
    expect(blocksToLines(sectionBlocks(xml))).toEqual(['머리 <1> 가', '3/2 | 안 | 쪽']);
  });

  test('reports a file that is not HWPX', async () => {
    const r = await parseHwpx(new Uint8Array([1, 2, 3]), 'x.hwpx', { jszip: JSZip });
    expect(r.warnings.map((w) => w.code)).toEqual(['read-failed']);
  });
});

describe('HWP 5.0', () => {
  test("reads weekly plan tables (day number, then that day's events)", () => {
    const c = (...paras: string[]) => paras;
    const blocks: DocBlock[] = [
      { kind: 'para', text: '2026학년도 교육과정 운영 계획' },
      {
        kind: 'table',
        rows: [
          [c('월'), c('주'), c('월'), c('화'), c('수'), c('목'), c('금'), c('일수')],
          // Month label and week number, then day/event pairs, then counts.
          [
            c('3'),
            c('1'),
            c('2'),
            c('대체공휴일'),
            c('3'),
            c('입학식', '진급식'),
            c('4'),
            c(),
            c('5'),
            c(),
            c('6'),
            c(),
            c('4'),
          ],
          // Month cell merged from the row above: empty.
          [
            c(),
            c('5'),
            c('30'),
            c('30~31 수학 캠프'),
            c('31'),
            c(),
            c('1'),
            c(),
            c('2'),
            c(),
            c('3'),
            c('1차고사(1,2)'),
            c('5'),
          ],
          [
            c(),
            c('6'),
            c('6'),
            c('1차고사(1,2)'),
            c('7'),
            c('영어듣기평가(1)'),
            c('8'),
            c(),
            c('9'),
            c(),
            c('10'),
            c(),
            c('5'),
          ],
          [c('수업 일수'), c('월'), c('18'), c('화'), c('19')],
        ],
      },
    ];
    const rows = readWeeklyTables(blocks, 2026)!.map((e) => `${e.start}~${e.end} ${e.title}`);
    expect(rows).toEqual([
      '2026-03-02~2026-03-02 대체공휴일',
      '2026-03-03~2026-03-03 입학식',
      '2026-03-03~2026-03-03 진급식',
      '2026-03-30~2026-03-31 수학 캠프',
      '2026-04-03~2026-04-03 1차고사(1,2)',
      '2026-04-06~2026-04-06 1차고사(1,2)',
      '2026-04-07~2026-04-07 영어듣기평가(1)',
    ]);
    expect(readWeeklyTables([{ kind: 'para', text: '3/2 입학식' }], 2026)).toBeNull();
  });

  test('joins notes and day ranges inside a day cell', () => {
    const show2 = (paras: string[], date: string) =>
      cellEvents(paras, date).map((e) => `${e.start}~${e.end} ${e.title}`);
    expect(show2(['학생상담주간', '(~13일)'], '2026-03-09')).toEqual([
      '2026-03-09~2026-03-09 학생상담주간 (~13일)',
    ]);
    expect(show2(['개교기념일', '(재량휴업일)'], '2026-04-14')).toEqual([
      '2026-04-14~2026-04-14 개교기념일 (재량휴업일)',
    ]);
    expect(show2(['1차고사(3)', '임원수련회28~29'], '2026-08-28')).toEqual([
      '2026-08-28~2026-08-28 1차고사(3)',
      '2026-08-28~2026-08-29 임원수련회',
    ]);
    expect(show2(['30~31', '사회과 탐방', '수학 예술제'], '2026-10-30')).toEqual([
      '2026-10-30~2026-10-31 사회과 탐방',
      '2026-10-30~2026-10-31 수학 예술제',
    ]);
    // A range that does not start on this day is left as text.
    expect(show2(['28~29일 수련회'], '2026-08-27')).toEqual([
      '2026-08-27~2026-08-27 28~29일 수련회',
    ]);
  });

  test('reads paragraphs and table rows from compressed body text', async () => {
    const r = await parseHwp(fixture('schedule.hwp'), 'schedule.hwp', { ...opts, cfb: CFB });
    expect(r.kind).toBe('hwp');
    expect(show(r.events)).toEqual([
      '2026-03-02~2026-03-02 입학식 academic',
      '2026-03-03~2026-03-03 개학식 academic',
      '2026-04-20~2026-04-21 1학기 중간고사 exam',
      '2026-05-05~2026-05-05 어린이날 holiday',
      '2026-07-17~2026-08-16 여름방학 academic',
    ]);
  });

  test('skips inline and extended controls in paragraph text', () => {
    const units = [0x41, 9, 1, 2, 3, 4, 5, 6, 9, 0x42, 0x0b, 0, 0, 0, 0, 0, 0, 0x0b, 0x43, 0x0d];
    const bytes = new Uint8Array(new Uint16Array(units).buffer);
    expect(paraText(bytes)).toBe('A BC');
  });

  test('reads records with the long size form', () => {
    const data = new Uint8Array(4 + 4 + 5000);
    const view = new DataView(data.buffer);
    view.setUint32(0, 67 | (2 << 10) | (0xfff << 20), true);
    view.setUint32(4, 5000, true);
    const [rec] = readRecords(data);
    expect(rec).toMatchObject({ tag: 67, level: 2 });
    expect(rec?.data.length).toBe(5000);
  });

  test('refuses files that are not HWP 5.0, encrypted or for distribution', async () => {
    const notHwp = await parseHwp(new Uint8Array([0, 1, 2]), 'x.hwp', { cfb: CFB });
    expect(notHwp.warnings[0]?.code).toBe('read-failed');

    const make = (flags: number) => {
      const head = new Uint8Array(256);
      head.set(new TextEncoder().encode('HWP Document File'));
      new DataView(head.buffer).setUint32(32, 0x05000300, true);
      new DataView(head.buffer).setUint32(36, flags, true);
      const c = CFB.utils.cfb_new();
      CFB.utils.cfb_add(c, '/FileHeader', head);
      return CFB.write(c, { type: 'array' }) as unknown as Uint8Array;
    };
    const enc = await parseHwp(make(0b11), 'enc.hwp', { cfb: CFB });
    expect(enc.warnings[0]?.message).toMatch(/암호/);
    const dist = await parseHwp(make(0b101), 'dist.hwp', { cfb: CFB });
    expect(dist.warnings[0]?.message).toMatch(/배포용/);
  });
});
