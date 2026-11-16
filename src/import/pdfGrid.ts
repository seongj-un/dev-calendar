import { weekday, yearInAcademicYear, ymd } from '../model/date';
import { looksLikeHoliday, type RawEvent } from './classify';

/** A piece of text on a PDF page, in PDF units (origin bottom left). */
export interface PdfTextItem {
  str: string;
  /** Left edge. */
  x: number;
  /** Baseline. Larger is higher on the page. */
  y: number;
  width: number;
  /** Font size. */
  size: number;
  /** Fill color as `#rrggbb` when known. */
  color?: string;
}

export interface PdfPageText {
  items: PdfTextItem[];
}

export interface GridParseResult {
  events: RawEvent[];
  academicYear: number;
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const MONTH_HEAD = /^(\d{1,2})월$/;
const RANGE_NOTE_LINE = /^\(\s*\d{1,2}\s*일?\s*[-~∼]\s*\d{1,2}\s*일?\s*\)$/;

export function isRed(color: string | undefined): boolean {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return false;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return r > 180 && g < 90 && b < 90;
}

/** Rough advance of a string: Hangul and CJK are full width, the rest about half. */
function estimateWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of text)
    w += /[\u1100-\u11ff\u3000-\u9fff\uac00-\ud7af]/.test(ch) ? size : size * 0.5;
  return w;
}

interface Column {
  month: number;
  left: number;
  right: number;
}

export interface DayMark {
  month: number;
  day: number;
  y: number;
  weekday?: number;
}

interface Line {
  month: number;
  str: string;
  x: number;
  y: number;
  width: number;
  size: number;
  red: boolean;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

/**
 * Finds the month-column grid: a "요일" header cell with month headers
 * ("3월" ... "8월") on the same baseline, evenly spaced.
 */
function findColumns(
  items: PdfTextItem[],
): { columns: Column[]; headerY: number; header: PdfTextItem } | null {
  for (const header of items.filter((it) => it.str.trim() === '요일')) {
    const heads = items
      .filter((it) => MONTH_HEAD.test(it.str.trim()) && Math.abs(it.y - header.y) < 3)
      .map((it) => ({ month: Number(MONTH_HEAD.exec(it.str.trim())![1]), cx: it.x + it.width / 2 }))
      .filter((h) => h.month >= 1 && h.month <= 12)
      .sort((a, b) => a.cx - b.cx);
    if (heads.length < 2) continue;
    const gaps = heads.slice(1).map((h, i) => h.cx - heads[i]!.cx);
    const w = median(gaps);
    if (w <= 0 || gaps.some((g) => Math.abs(g - w) > w * 0.2)) continue;
    return {
      columns: heads.map((h) => ({ month: h.month, left: h.cx - w / 2, right: h.cx + w / 2 })),
      headerY: header.y,
      header,
    };
  }
  return null;
}

/**
 * Picks the academic year whose calendar puts each day number on the weekday
 * printed in its row. Returns null when the page has no weekday column.
 */
export function yearFromWeekdays(days: DayMark[], around: number): number | null {
  const marked = days.filter((d) => d.weekday !== undefined);
  if (marked.length < 7) return null;
  let best: { year: number; hits: number } | null = null;
  // Nearest year first, so a tie (calendars repeat) goes to the closer one.
  const candidates = [around];
  for (let k = 1; k <= 6; k++) candidates.push(around - k, around + k);
  for (const ay of candidates) {
    let hits = 0;
    for (const d of marked) {
      const iso = ymd(yearInAcademicYear(ay, d.month), d.month, d.day);
      if (iso && weekday(iso) === d.weekday) hits++;
    }
    if (!best || hits > best.hits) best = { year: ay, hits };
  }
  return best && best.hits >= marked.length * 0.9 ? best.year : null;
}

/** Joins wrapped lines of one cell and keeps separate events apart. */
function joinCellLines(lines: Line[], fullWidth: number): { text: string; red: boolean }[] {
  const out: { text: string; red: boolean; last: Line }[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    const text = line.str.trim();
    if (prev) {
      if (RANGE_NOTE_LINE.test(text)) {
        prev.text = `${prev.text} ${text}`;
        prev.last = line;
        continue;
      }
      const p = prev.last;
      const charW = line.size;
      // The previous line ran to the cell edge: the cell wrapped there.
      const full = p.width >= fullWidth - charW * 0.5;
      const firstWord = text.split(' ')[0] ?? text;
      const wouldOverflow =
        p.width + estimateWidth(' ', p.size) + estimateWidth(firstWord, line.size) > fullWidth;
      // Lines that end a title, start a notice, or name a day off on their own
      // ("신입생 2차전형" / "재량휴업일") are separate events.
      const closed = /[)\]]$/.test(prev.text) || text.startsWith('[') || looksLikeHoliday(text);
      if (!closed && (full || wouldOverflow)) {
        // A full line was cut inside a word; otherwise the break was at a space.
        prev.text = full ? prev.text + text : `${prev.text} ${text}`;
        prev.red ||= line.red;
        prev.last = line;
        continue;
      }
    }
    out.push({ text, red: line.red, last: line });
  }
  return out.map(({ text, red }) => ({ text, red }));
}

/**
 * Reads a school calendar printed as month columns (one column per month,
 * day numbers on the left of each column, events to their right, red text
 * for days off). Returns null when the pages do not have that layout.
 */
export function parseMonthGrid(
  pages: readonly PdfPageText[],
  options: { academicYear?: number; fallbackYear: number },
): GridParseResult | null {
  const cells = new Map<string, { month: number; day: number; lines: Line[] }>();
  const allDays: DayMark[] = [];
  let gridPages = 0;

  for (const page of pages) {
    const items = page.items.filter((it) => it.str.trim() && it.width > 0.5);
    const grid = findColumns(items);
    if (!grid) continue;
    gridPages++;
    const { columns, headerY, header } = grid;
    const w = columns[0]!.right - columns[0]!.left;
    const colOf = (cx: number) => columns.find((c) => c.left <= cx && cx < c.right);

    const weekdayRows: { y: number; weekday: number }[] = [];
    const days: DayMark[] = [];
    const lines: Line[] = [];
    for (const it of items) {
      if (it.y >= headerY - 1) continue;
      const str = it.str.trim();
      const col = colOf(it.x + it.width / 2);
      if (!col) {
        const wd = WEEKDAYS.indexOf(str);
        if (wd >= 0 && Math.abs(it.x - header.x) < w * 0.25)
          weekdayRows.push({ y: it.y, weekday: wd });
        continue;
      }
      if (/^\d{1,2}$/.test(str) && it.x - col.left < w * 0.25) {
        days.push({ month: col.month, day: Number(str), y: it.y });
      } else if (it.x - col.left >= w * 0.2) {
        lines.push({
          month: col.month,
          str,
          x: it.x,
          y: it.y,
          width: it.width,
          size: it.size,
          red: isRed(it.color),
        });
      }
    }
    if (!days.length) continue;

    const ys = weekdayRows.map((r) => r.y).sort((a, b) => b - a);
    const rowPitch = median(
      ys
        .slice(1)
        .map((y, i) => ys[i]! - y)
        .filter((g) => g > 0),
    );
    for (const d of days) {
      const row = weekdayRows.reduce<{ y: number; weekday: number } | null>(
        (best, r) => (!best || Math.abs(r.y - d.y) < Math.abs(best.y - d.y) ? r : best),
        null,
      );
      if (row && (!rowPitch || Math.abs(row.y - d.y) < rowPitch / 2)) d.weekday = row.weekday;
      allDays.push(d);
    }

    const fullWidth = Math.max(...lines.map((l) => l.width), 0);
    const byCell = new Map<string, Line[]>();
    for (const line of lines) {
      let nearest: DayMark | undefined;
      for (const d of days) {
        if (d.month !== line.month) continue;
        if (!nearest || Math.abs(d.y - line.y) < Math.abs(nearest.y - line.y)) nearest = d;
      }
      if (!nearest) continue;
      const key = `${nearest.month}-${nearest.day}`;
      if (!cells.has(key)) cells.set(key, { month: nearest.month, day: nearest.day, lines: [] });
      const list = byCell.get(key) ?? [];
      list.push(line);
      byCell.set(key, list);
    }
    for (const [key, list] of byCell) {
      list.sort((a, b) => b.y - a.y || a.x - b.x);
      cells
        .get(key)!
        .lines.push(
          ...joinCellLines(list, fullWidth).map((j) => ({ ...list[0]!, str: j.text, red: j.red })),
        );
    }
  }
  if (!gridPages) return null;

  const academicYear =
    options.academicYear ?? yearFromWeekdays(allDays, options.fallbackYear) ?? options.fallbackYear;

  const events: RawEvent[] = [];
  for (const cell of cells.values()) {
    const date = ymd(yearInAcademicYear(academicYear, cell.month), cell.month, cell.day);
    if (!date) continue;
    for (const line of cell.lines) {
      events.push({ title: line.str, start: date, end: date, holiday: line.red });
    }
  }
  events.sort((a, b) => a.start.localeCompare(b.start));
  return { events, academicYear };
}

/**
 * Groups items into text lines for the generic date parser. Items far apart
 * on one line are joined with " | " so table cells stay recognizable.
 */
export function pdfTextLines(pages: readonly PdfPageText[]): string[] {
  const out: string[] = [];
  for (const page of pages) {
    const items = page.items.filter((it) => it.str.trim());
    const rows: PdfTextItem[][] = [];
    for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
      const row = rows.find((r) => Math.abs(r[0]!.y - it.y) <= Math.max(1, it.size * 0.4));
      if (row) row.push(it);
      else rows.push([it]);
    }
    for (const row of rows.sort((a, b) => b[0]!.y - a[0]!.y)) {
      row.sort((a, b) => a.x - b.x);
      let text = '';
      let right = -Infinity;
      for (const it of row) {
        const gap = it.x - right;
        if (text) text += gap > it.size * 2 ? ' | ' : gap > it.size * 0.15 ? ' ' : '';
        text += it.str.trim();
        right = it.x + it.width;
      }
      out.push(text);
    }
  }
  return out;
}
