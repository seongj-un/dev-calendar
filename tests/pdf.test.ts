import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import * as pdfjsLegacy from 'pdfjs-dist/legacy/build/pdf.mjs';
import { finalizeRows } from '../src/import/finalize';
import { parsePdf } from '../src/import/pdf';
import { parseMonthGrid, pdfTextLines, type PdfTextItem } from '../src/import/pdfGrid';

// The legacy build runs in Node without a worker; the app uses the modern one.
const pdfjs = pdfjsLegacy as unknown as typeof import('pdfjs-dist');

const fixtureUrl = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const SCHOOL_PDF = fixtureUrl('school-2026.pdf');
const SCHOOL_EXPECTED = fixtureUrl('school-2026.expected.json');
const hasSchoolPdf = existsSync(SCHOOL_PDF) && existsSync(SCHOOL_EXPECTED);

interface Expected {
  title: string;
  holiday: boolean;
  start: string;
  end: string;
}

const key = (e: Expected) => `${e.start}|${e.end}|${e.title}|${e.holiday ? 'H' : ''}`;

/**
 * A two-month grid laid out like the school PDF: a 요일 column, one column per
 * month (87.5pt wide), day numbers on the left, centered event text, red days off.
 */
function syntheticGrid(): PdfTextItem[] {
  const items: PdfTextItem[] = [];
  const size = 5.9;
  const text = (str: string, x: number, y: number, width: number, color?: string) =>
    items.push({ str, x, y, width, size, ...(color ? { color } : {}) });
  text('요일', 28.9, 688.4, 11.8);
  const months = [
    { month: 3, first: 0, days: 31, center: 87.8 }, // 2026-03-01 is a Sunday
    { month: 4, first: 3, days: 30, center: 175.3 }, // 2026-04-01 is a Wednesday
  ];
  const rowY = (row: number) => 670.6 - row * 17.75;
  for (const m of months) text(`${m.month}월`, m.center - 6, 688.8, 11.8);
  for (let row = 0; row < 37; row++) text('일월화수목금토'[row % 7]!, 31.8, rowY(row), 5.9);
  const cell = (month: number, day: number) => {
    const m = months.find((x) => x.month === month)!;
    return { left: m.center - 43.75, y: rowY(m.first + day - 1) };
  };
  for (const m of months) {
    for (let d = 1; d <= m.days; d++) {
      const c = cell(m.month, d);
      text(String(d), c.left + 7.7, c.y, d < 10 ? 3.2 : 6.4);
    }
  }
  // Event lines centered in the right part of the cell; dy moves a line up or down.
  const ev = (month: number, day: number, str: string, width: number, dy = 0, color?: string) => {
    const c = cell(month, day);
    text(str, c.left + 53 - width / 2, c.y + dy, width, color);
  };
  const RED = '#ff0000';
  ev(3, 1, '3.1절', 13.7, 0, RED);
  ev(3, 3, '입학식(1)', 24.5, 4.6);
  ev(3, 3, '개학식(2,3)', 29, -4.5);
  ev(3, 10, '신입생전공멘토링', 47.1, 4.6);
  ev(3, 10, '(10일-19일)', 30.7, -4.6);
  ev(4, 7, '중학생 알고리즘', 43.2, 4.6);
  ev(4, 7, '경진대회 예선', 37.4, -4.6);
  ev(4, 8, '1학년 우수학생글로벌프', 64.1, 4.6);
  ev(4, 8, '로그램', 17.6, -4.6);
  ev(4, 9, '신입생 2차전형', 40.0, 4.6, RED);
  ev(4, 9, '재량휴업일', 29.4, -4.6, RED);
  for (const d of [13, 14, 15]) ev(4, d, '교내해커톤 대회', 43.2);
  ev(4, 16, '[의무귀가]', 27.1);
  ev(4, 17, '[의무귀가]', 27.1);
  return items;
}

describe('PDF month-column grid', () => {
  test('reads cells, wrapped lines, notes and red days off', () => {
    const grid = parseMonthGrid([{ items: syntheticGrid() }], { fallbackYear: 2030 });
    // The year comes from the printed weekdays, not from the fallback.
    expect(grid?.academicYear).toBe(2026);
    const rows = finalizeRows(grid!.events, { bridgeOccupied: true }).map(
      (e) => `${e.start}~${e.end} ${e.rawTitle}${e.holiday ? ' H' : ''}${e.review ? ' ?' : ''}`,
    );
    expect(rows).toEqual([
      '2026-03-01~2026-03-01 3.1절 H',
      '2026-03-03~2026-03-03 개학식(2,3)',
      '2026-03-03~2026-03-03 입학식(1)',
      '2026-03-10~2026-03-19 신입생전공멘토링',
      '2026-04-07~2026-04-07 중학생 알고리즘 경진대회 예선',
      '2026-04-08~2026-04-08 1학년 우수학생글로벌프로그램',
      '2026-04-09~2026-04-09 신입생 2차전형 H ?',
      '2026-04-09~2026-04-09 재량휴업일 H',
      '2026-04-13~2026-04-15 교내해커톤 대회',
      '2026-04-16~2026-04-16 [의무귀가]',
      '2026-04-17~2026-04-17 [의무귀가]',
    ]);
  });

  test('falls back to the generic parser for other layouts', () => {
    const item = (str: string, x: number, y: number): PdfTextItem => ({
      str,
      x,
      y,
      width: str.length * 5,
      size: 10,
    });
    const pages = [
      {
        items: [
          item('2026학년도 학사일정', 50, 800),
          item('3. 2.(월)', 50, 760),
          item('입학식', 200, 760),
          item('4. 20.~4. 24.', 50, 740),
          item('1학기 중간고사', 200, 740),
        ],
      },
    ];
    expect(parseMonthGrid(pages, { fallbackYear: 2026 })).toBeNull();
    expect(pdfTextLines(pages)).toEqual([
      '2026학년도 학사일정',
      '3. 2.(월) | 입학식',
      '4. 20.~4. 24. | 1학기 중간고사',
    ]);
  });

  test('reports a PDF without text', async () => {
    const result = await parsePdf(blankPdf(), 'scan.pdf', { pdfjs });
    expect(result.events).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toEqual(['no-text']);
  });

  // The real school file is kept out of the public repository until 성준 approves it;
  // drop it into tests/fixtures to run this comparison.
  test.skipIf(!hasSchoolPdf)('matches the reference result for school-2026.pdf', async () => {
    const result = await parsePdf(readFileSync(SCHOOL_PDF), 'school-2026.pdf', {
      pdfjs,
      today: new Date(2030, 5, 1), // the year must come from the weekdays, not today
    });
    expect(result.kind).toBe('pdf-grid');
    expect(result.academicYear).toBe(2026);
    expect(result.pages).toBe(2);

    const expected = (JSON.parse(readFileSync(SCHOOL_EXPECTED, 'utf8')) as Expected[]).map(key);
    const actual = result.events.map((e) =>
      key({ title: e.rawTitle, holiday: e.holiday, start: e.start, end: e.end }),
    );
    const missing = expected.filter((k) => !actual.includes(k));
    const extra = actual.filter((k) => !expected.includes(k));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    expect(actual).toHaveLength(97);

    const by = (t: string) => result.events.filter((e) => e.rawTitle === t);
    expect(by('1학기 중간고사')[0]).toMatchObject({ category: 'exam', end: '2026-05-01' });
    expect(by('국외현장체험학습(2)')[0]).toMatchObject({ title: '국외현장체험학습', grades: [2] });
    expect(by('[의무귀가]')).toHaveLength(22);
    expect(by('[의무귀가]')[0]?.notice).toBe(true);
    expect(result.events.filter((e) => e.holiday)).toHaveLength(24);
    expect(result.events.filter((e) => e.review).map((e) => e.title)).toEqual([
      '추석',
      '신입생 2차전형',
      '설날',
    ]);
  });
});

/** A one-page PDF that only paints a gray box, like a scan without a text layer. */
function blankPdf(): Uint8Array {
  const stream = '0.9 g 50 50 495 742 re f';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
