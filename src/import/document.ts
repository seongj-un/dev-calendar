import { addDays, ymd, yearInAcademicYear, type IsoDate } from '../model/date';
import type { RawEvent } from './classify';
import { finalizeRows } from './finalize';
import { detectAcademicYear, parseDateText } from './text';
import type { ImportKind, ImportResult } from './types';

/**
 * Document structure shared by the HWP and HWPX readers: paragraphs, and
 * tables as rows of cells, each cell a list of its paragraphs.
 */
export type DocBlock = { kind: 'para'; text: string } | { kind: 'table'; rows: string[][][] };

export interface DocumentImportOptions {
  academicYear?: number;
  today?: Date;
}

const WEEKDAY_NAMES = ['월', '화', '수', '목', '금', '토', '일'];

/** One line per paragraph and per table row (cells joined with " | "). */
export function blocksToLines(blocks: readonly DocBlock[]): string[] {
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'para') {
      if (b.text.trim()) lines.push(b.text.trim());
      continue;
    }
    for (const row of b.rows) {
      const cells = row.map((paras) => paras.join(' ').replace(/\s+/g, ' ').trim());
      if (cells.some(Boolean)) lines.push(cells.join(' | '));
    }
  }
  return lines;
}

const dayNumber = (cell: string[] | undefined): number | null => {
  const t = (cell ?? []).join(' ').trim();
  if (!/^\d{1,2}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 31 ? n : null;
};

/** Number of weekday columns (월, 화, ... in order) in a header row; 0 when fewer than five. */
const weekdayColumns = (row: string[][]): number => {
  const names = row.map((c) => c.join('').replace(/\s/g, ''));
  let k = 0;
  for (const n of names) if (n === WEEKDAY_NAMES[k]) k++;
  return k >= 5 ? k : 0;
};

/**
 * Weekly plan tables, common in school HWP files:
 *
 *   월 | 주 | 월 | 화 | 수 | 목 | 금 | ...
 *   3 | 1 | 2 | 대체공휴일 | 3 | 입학식 | 4 | | 5 | | 6 | | ...
 *     | 2 | 9 | 학생상담주간 | 10 | | ...
 *
 * Each data row holds day numbers, each followed by that day's events. The
 * month is labelled where it starts and moves on when the day number wraps
 * (31 -> 1). Returns events, or null when no table has this layout.
 */
export function readWeeklyTables(
  blocks: readonly DocBlock[],
  academicYear: number,
): RawEvent[] | null {
  const events: RawEvent[] = [];
  let found = false;
  for (const b of blocks) {
    if (b.kind !== 'table') continue;
    let month: number | null = null;
    let lastDay = 0;
    let dayColumns = 0;
    for (const row of b.rows) {
      const header = weekdayColumns(row);
      if (header) {
        dayColumns = header;
        month = null;
        lastDay = 0;
        continue;
      }
      if (!dayColumns) continue;
      // Find where the day columns start: three day numbers two cells apart, in sequence.
      let start = -1;
      for (let k = 0; k + 4 < row.length && start < 0; k++) {
        const a = dayNumber(row[k]);
        const b2 = dayNumber(row[k + 2]);
        const c = dayNumber(row[k + 4]);
        const next = (x: number, y: number | null) =>
          y !== null && (y === x + 1 || (y === 1 && x >= 28));
        if (a !== null && next(a, b2) && next(b2!, c)) start = k;
      }
      if (start < 0) continue;
      found = true;
      // A month label is the first leading cell when two cells (month, week) come before the days.
      const label = start >= 2 ? dayNumber(row[0]) : null;
      if (month === null) month = label !== null && label <= 12 ? label : null;
      if (month === null) continue;
      // Exactly one day/event pair per weekday column; counts after them are not days.
      for (let k = start; k < start + dayColumns * 2; k += 2) {
        const day = dayNumber(row[k]);
        if (day === null) continue;
        if (day < lastDay) month = (month % 12) + 1;
        lastDay = day;
        const date = ymd(yearInAcademicYear(academicYear, month), month, day);
        if (!date) continue;
        events.push(...cellEvents(row[k + 1] ?? [], date));
      }
    }
  }
  return found ? events : null;
}

const DAY_RANGE = /^(\d{1,2})\s*일?\s*~\s*(\d{1,2})\s*일?$/;

/** End date for a "30~31" range written in the cell of day 30, or null. */
function rangeEnd(date: IsoDate, from: string, to: string): IsoDate | null {
  const day = Number(date.slice(8, 10));
  const startDay = Number(from);
  const endDay = Number(to);
  if (startDay !== day || endDay <= startDay || endDay - startDay > 14) return null;
  return addDays(date, endDay - startDay);
}

/**
 * Events of one day cell, one per paragraph. A paragraph in parentheses
 * ("(재량휴업일)", "(~13일)") belongs to the one above it. A day range
 * ("30~31", "임원수련회28~29", "28~29일 수련회") stretches the event.
 */
export function cellEvents(paras: readonly string[], date: IsoDate): RawEvent[] {
  const out: RawEvent[] = [];
  let rangeTo: IsoDate | null = null;
  for (const raw of paras) {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const alone = DAY_RANGE.exec(text);
    if (alone) {
      rangeTo = rangeEnd(date, alone[1]!, alone[2]!);
      continue;
    }
    const prev = out[out.length - 1];
    if (prev && text.startsWith('(')) {
      prev.title = `${prev.title} ${text}`;
      continue;
    }
    let title = text;
    let end = rangeTo ?? date;
    const lead = /^(\d{1,2})\s*일?\s*~\s*(\d{1,2})\s*일?\s+(.+)$/.exec(text);
    const tail = /^(.+?)\s*(\d{1,2})\s*일?\s*~\s*(\d{1,2})\s*일?$/.exec(text);
    if (lead) {
      const e = rangeEnd(date, lead[1]!, lead[2]!);
      if (e) [title, end] = [lead[3]!, e];
    } else if (tail) {
      const e = rangeEnd(date, tail[2]!, tail[3]!);
      if (e) [title, end] = [tail[1]!, e];
    }
    out.push({ title, start: date, end });
  }
  return out;
}

/** Picks the weekly-table reader when it finds events, otherwise the generic date parser. */
export function resultFromBlocks(
  kind: ImportKind,
  blocks: readonly DocBlock[],
  fileName: string,
  options: DocumentImportOptions = {},
): ImportResult {
  const base = { kind, source: `file:${fileName}`, label: fileName };
  const lines = blocksToLines(blocks);
  if (!lines.length) {
    return {
      ...base,
      events: [],
      warnings: [{ code: 'no-text', message: '파일에서 글자를 찾지 못했습니다.' }],
    };
  }
  const academicYear = options.academicYear ?? detectAcademicYear(lines.join('\n'), options.today);
  const weekly = readWeeklyTables(blocks, academicYear);
  const raw = weekly?.length ? weekly : parseDateText(lines, { academicYear }).events;
  const events = finalizeRows(raw, { holidayByName: true });
  return {
    ...base,
    academicYear,
    events,
    warnings: events.length
      ? []
      : [{ code: 'no-dates', message: '파일에서 날짜가 있는 일정을 찾지 못했습니다.' }],
  };
}
