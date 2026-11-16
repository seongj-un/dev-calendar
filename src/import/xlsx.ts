import { ymd, pad2, type IsoDate } from '../model/date';
import type { RawEvent } from './classify';
import { finalizeRows } from './finalize';
import { yearFromWeekdays, type DayMark } from './pdfGrid';
import { detectAcademicYear, parseDateText } from './text';
import type { ImportResult } from './types';

type Xlsx = typeof import('xlsx');

/** A spreadsheet cell after reading: text, number, or a date (with time when set). */
export type Cell = string | number | { date: IsoDate; time?: string } | null;

export interface ColumnMapping {
  /** Row with column names, or -1 when the sheet has none. */
  headerRow: number;
  dateCol: number;
  /** Separate end-date column, if any. */
  endCol?: number;
  titleCol: number;
  /** Month column when the date column holds only day numbers. */
  monthCol?: number;
}

export interface SheetTable {
  sheet: string;
  rows: Cell[][];
  headers: string[];
  mapping: ColumnMapping;
}

export const MAX_SHEET_ROWS = 3000;
export const MAX_SHEET_COLS = 60;

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const MONTH_CELL = /^(\d{1,2})\s*월$/;
const DATE_TEXT = /(?:20\d{2}\s*[-./년]\s*)?\d{1,2}\s*(?:[./]|월)\s*\d{1,2}/;
const TITLE_HEADER = /행사|일정|내용|제목|명칭|title|summary|event/i;
const END_HEADER = /종료|끝|까지|end/i;
const DATE_HEADER = /날짜|일자|시작|date|start|^일$/i;

export async function loadXlsx(): Promise<Xlsx> {
  return import('xlsx');
}

const isDateCell = (c: Cell): c is { date: IsoDate; time?: string } =>
  typeof c === 'object' && c !== null;

export function cellText(c: Cell): string {
  if (c === null) return '';
  if (typeof c === 'string') return c.trim();
  if (typeof c === 'number') return String(c);
  return c.time ? `${c.date} ${c.time}` : c.date;
}

/** Reads every sheet into a grid of cells. Number cells with a date format become dates. */
export function readSheets(XLSX: Xlsx, data: Uint8Array): { name: string; rows: Cell[][] }[] {
  const wb = XLSX.read(data, {
    type: 'array',
    cellDates: false,
    cellNF: true,
    sheetRows: MAX_SHEET_ROWS,
  });
  const out: { name: string; rows: Cell[][] }[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    const rows: Cell[][] = [];
    const lastRow = Math.min(range.e.r, range.s.r + MAX_SHEET_ROWS - 1);
    const lastCol = Math.min(range.e.c, range.s.c + MAX_SHEET_COLS - 1);
    for (let r = range.s.r; r <= lastRow; r++) {
      const row: Cell[] = [];
      for (let c = range.s.c; c <= lastCol; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })] as
          { t: string; v?: unknown; z?: string } | undefined;
        row.push(cell ? toCell(XLSX, cell) : null);
      }
      rows.push(row);
    }
    out.push({ name, rows });
  }
  return out;
}

function toCell(XLSX: Xlsx, cell: { t: string; v?: unknown; z?: string }): Cell {
  if (cell.t === 's' || cell.t === 'str') {
    const s = typeof cell.v === 'string' ? cell.v.trim() : '';
    return s || null;
  }
  if (cell.t === 'n' && typeof cell.v === 'number') {
    if (cell.z && XLSX.SSF.is_date(cell.z)) {
      const p = XLSX.SSF.parse_date_code(cell.v) as {
        y: number;
        m: number;
        d: number;
        H: number;
        M: number;
      };
      const date = ymd(p.y, p.m, p.d);
      if (!date) return null;
      return p.H || p.M ? { date, time: `${pad2(p.H)}:${pad2(p.M)}` } : { date };
    }
    return cell.v;
  }
  if (cell.t === 'b') return String(cell.v);
  return null;
}

/**
 * Month-column grid, the layout school PDFs are printed from: a 요일 column
 * and one block of columns per month ("3월" header), day numbers first,
 * events after them. Returns null when the sheet is not laid out that way.
 */
export function readSheetGrid(
  rows: Cell[][],
  fallbackYear: number,
): { events: RawEvent[]; academicYear: number } | null {
  for (let hr = 0; hr < Math.min(rows.length, 20); hr++) {
    const header = rows[hr]!;
    const wdCol = header.findIndex((c) => typeof c === 'string' && c.replace(/\s/g, '') === '요일');
    if (wdCol < 0) continue;
    const months = header
      .map((c, i) => ({ i, m: typeof c === 'string' ? MONTH_CELL.exec(c) : null }))
      .filter((x): x is { i: number; m: RegExpExecArray } => x.m !== null)
      .map((x) => ({ col: x.i, month: Number(x.m[1]) }))
      .filter((x) => x.month >= 1 && x.month <= 12);
    if (months.length < 2) continue;
    const width = months[1]!.col - months[0]!.col;

    const days: DayMark[] = [];
    const cells = new Map<string, { month: number; day: number; lines: string[] }>();
    for (let r = hr + 1; r < rows.length; r++) {
      const row = rows[r]!;
      const wdText = typeof row[wdCol] === 'string' ? (row[wdCol] as string).trim() : '';
      const weekday = WEEKDAYS.indexOf(wdText);
      months.forEach((m, k) => {
        const end = months[k + 1]?.col ?? m.col + width;
        let day: number | undefined;
        const texts: string[] = [];
        for (let c = m.col; c < end; c++) {
          const v = row[c] ?? null;
          const n =
            typeof v === 'number'
              ? v
              : typeof v === 'string' && /^\d{1,2}$/.test(v)
                ? Number(v)
                : NaN;
          if (day === undefined && Number.isInteger(n) && n >= 1 && n <= 31) day = n;
          else if (typeof v === 'string')
            texts.push(
              ...v
                .split(/\n+/)
                .map((t) => t.trim())
                .filter(Boolean),
            );
        }
        if (day === undefined) {
          // A second row of the same day cell: attach to the last day of this month.
          const last = [...days].reverse().find((d) => d.month === m.month);
          if (last && texts.length) cells.get(`${m.month}-${last.day}`)?.lines.push(...texts);
          return;
        }
        const mark: DayMark = { month: m.month, day, y: -r };
        if (weekday >= 0) mark.weekday = weekday;
        days.push(mark);
        const cell = cells.get(`${m.month}-${day}`) ?? { month: m.month, day, lines: [] };
        cell.lines.push(...texts);
        cells.set(`${m.month}-${day}`, cell);
      });
    }
    if (!days.length) continue;
    const academicYear = yearFromWeekdays(days, fallbackYear) ?? fallbackYear;
    const events: RawEvent[] = [];
    for (const cell of cells.values()) {
      const date = ymd(cell.month >= 3 ? academicYear : academicYear + 1, cell.month, cell.day);
      if (!date) continue;
      for (const line of cell.lines) {
        // "(10일-19일)" on its own line belongs to the title above it.
        const prev = events[events.length - 1];
        if (/^\(\s*\d{1,2}\s*일?\s*[-~]\s*\d{1,2}\s*일?\s*\)$/.test(line) && prev?.start === date) {
          prev.title = `${prev.title} ${line}`;
        } else {
          events.push({ title: line, start: date, end: date });
        }
      }
    }
    return { events, academicYear };
  }
  return null;
}

/** Guesses which columns hold the date, the end date, the title and the month. */
export function guessMapping(rows: Cell[][]): ColumnMapping | null {
  const width = Math.max(0, ...rows.slice(0, 200).map((r) => r.length));
  if (!width) return null;
  const sample = rows.slice(0, 200);

  // A header row: mostly text, no dates, followed by rows that have dates.
  let headerRow = -1;
  for (let r = 0; r < Math.min(sample.length, 10); r++) {
    const row = sample[r]!;
    const texts = row.filter((c) => typeof c === 'string' && !DATE_TEXT.test(c));
    if (texts.length >= 2 && !row.some(isDateCell)) {
      headerRow = r;
      break;
    }
  }
  const headers = (headerRow >= 0 ? sample[headerRow]! : []).map((c) => cellText(c));
  const body = sample.slice(headerRow + 1);
  const filled = (col: number) => body.filter((r) => cellText(r[col] ?? null)).length;
  const dateScore = (col: number) =>
    body.filter((r) => {
      const c = r[col] ?? null;
      return isDateCell(c) || (typeof c === 'string' && DATE_TEXT.test(c));
    }).length;
  const dayScore = (col: number) =>
    body.filter((r) => {
      const c = r[col] ?? null;
      const n =
        typeof c === 'number' ? c : typeof c === 'string' ? Number(c.replace(/일$/, '')) : NaN;
      return Number.isInteger(n) && n >= 1 && n <= 31;
    }).length;

  const cols = [...Array(width).keys()];
  const byDate = [...cols].sort((a, b) => dateScore(b) - dateScore(a));
  let dateCol = byDate[0]!;
  let monthCol: number | undefined;
  if (dateScore(dateCol) < Math.max(1, body.length / 4)) {
    // No full dates: a day-number column with a month column before it.
    const dayCol = cols.find((c) => dayScore(c) >= body.length / 2 && c > 0);
    if (dayCol === undefined) return null;
    dateCol = dayCol;
    monthCol = cols
      .slice(0, dayCol)
      .find(
        (c) =>
          body.some((r) => typeof r[c] === 'string' && MONTH_CELL.test((r[c] as string).trim())) ||
          headers[c] === '월',
      );
    if (monthCol === undefined) return null;
  }
  let endCol = cols.find(
    (c) => c !== dateCol && END_HEADER.test(headers[c] ?? '') && dateScore(c) > 0,
  );
  // Without a named end column, a second column of full dates next to the first one.
  if (endCol === undefined && monthCol === undefined && DATE_HEADER.test(headers[dateCol] ?? '')) {
    endCol = cols.find(
      (c) => c === dateCol + 1 && dateScore(c) > 0 && !TITLE_HEADER.test(headers[c] ?? ''),
    );
  }

  const skip = new Set([dateCol, endCol, monthCol].filter((c) => c !== undefined));
  const titleScore = (col: number) =>
    body.filter((r) => {
      const c = r[col] ?? null;
      return (
        typeof c === 'string' &&
        !DATE_TEXT.test(c) &&
        !/^\d+$/.test(c) &&
        !WEEKDAYS.includes(c.replace(/[()]/g, ''))
      );
    }).length;
  const candidates = cols.filter((c) => !skip.has(c) && filled(c) > 0);
  const named = candidates.find((c) => TITLE_HEADER.test(headers[c] ?? ''));
  const titleCol = named ?? candidates.sort((a, b) => titleScore(b) - titleScore(a))[0];
  if (titleCol === undefined || titleScore(titleCol) === 0) return null;
  const mapping: ColumnMapping = { headerRow, dateCol, titleCol };
  if (endCol !== undefined) mapping.endCol = endCol;
  if (monthCol !== undefined) mapping.monthCol = monthCol;
  return mapping;
}

/**
 * Turns table rows into events with a column mapping (guessed or chosen in
 * the preview). Each row becomes a text line for the shared date parser, so
 * written dates ("3. 2.(월)", "4.20~4.24") work as well as date cells.
 */
export function eventsFromTable(
  rows: Cell[][],
  mapping: ColumnMapping,
  academicYear: number,
): RawEvent[] {
  const lines: string[] = [];
  for (const row of rows.slice(mapping.headerRow + 1)) {
    const title = cellText(row[mapping.titleCol] ?? null).replace(/\s*\n\s*/g, ' ');
    const month = mapping.monthCol !== undefined ? cellText(row[mapping.monthCol] ?? null) : '';
    const start = row[mapping.dateCol] ?? null;
    const end = mapping.endCol !== undefined ? (row[mapping.endCol] ?? null) : null;
    let when = cellText(start);
    if (mapping.monthCol !== undefined && /^\d{1,2}$/.test(when)) when = `${when}일`;
    if (end !== null && cellText(end)) {
      const endText = isDateCell(end) ? end.date : cellText(end);
      when = isDateCell(start)
        ? `${start.date}~${endText} ${start.time ?? ''}`
        : `${when}~${endText}`;
    }
    const monthPart = month ? `${/^\d{1,2}$/.test(month) ? `${month}월` : month} | ` : '';
    if (!title) {
      if (monthPart) lines.push(monthPart.replace(' | ', ''));
      continue;
    }
    lines.push(`${monthPart}${when} | ${title}`);
  }
  return parseDateText(lines, { academicYear }).events;
}

export interface XlsxImportOptions {
  academicYear?: number;
  today?: Date;
  xlsx?: Xlsx;
}

export type XlsxImportResult = ImportResult & { table?: SheetTable };

export async function parseXlsx(
  data: ArrayBuffer | Uint8Array,
  fileName: string,
  options: XlsxImportOptions = {},
): Promise<XlsxImportResult> {
  const XLSX = options.xlsx ?? (await loadXlsx());
  const sheets = readSheets(XLSX, new Uint8Array(data));
  const base = { kind: 'xlsx' as const, source: `file:${fileName}`, label: fileName };
  const allText = sheets.flatMap((s) => s.rows.flat().map(cellText)).join(' ');
  const fallbackYear = options.academicYear ?? detectAcademicYear(allText, options.today);

  let best: XlsxImportResult | null = null;
  for (const sheet of sheets) {
    const grid = readSheetGrid(sheet.rows, fallbackYear);
    let result: XlsxImportResult | null = null;
    if (grid?.events.length) {
      result = {
        ...base,
        academicYear: options.academicYear ?? grid.academicYear,
        events: finalizeRows(grid.events, { holidayByName: true, bridgeOccupied: true }),
        warnings: [],
      };
    } else {
      const mapping = guessMapping(sheet.rows);
      if (mapping) {
        result = {
          ...base,
          academicYear: fallbackYear,
          events: finalizeRows(eventsFromTable(sheet.rows, mapping, fallbackYear), {
            holidayByName: true,
          }),
          warnings: [],
          table: {
            sheet: sheet.name,
            rows: sheet.rows,
            headers: (mapping.headerRow >= 0 ? sheet.rows[mapping.headerRow]! : []).map(cellText),
            mapping,
          },
        };
      }
    }
    if (result && (!best || result.events.length > best.events.length)) best = result;
  }
  if (best && best.events.length) return best;
  return {
    ...base,
    events: [],
    warnings: [{ code: 'no-dates', message: '엑셀에서 날짜와 일정이 있는 열을 찾지 못했습니다.' }],
    ...(best?.table ? { table: best.table } : {}),
  };
}
