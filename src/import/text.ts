import { academicYearOf, localIsoDate, yearInAcademicYear, ymd, type IsoDate } from '../model/date';
import type { RawEvent } from './classify';

/**
 * Generic date-pattern parser for text pulled out of PDFs, HWP files and
 * spreadsheets. It reads lines such as
 *
 *   3. 2.(월) 입학식
 *   3/2 개학식
 *   3월 2일 시업식
 *   3.2~3.6 신입생 적응 주간
 *   4.20.~4.24. 1학기 중간고사
 *   2026-03-02 | 입학식
 *   3월 | 2 | 월 | 입학식        (table row, month cell)
 *   | 3 | 화 | 개학식            (table row, month carried from the row above)
 *
 * Dates without a year are placed in the academic year (March to February).
 */

export interface TextParseResult {
  events: RawEvent[];
  academicYear: number;
  /** Lines that had text but no date we could read. */
  undatedLines: number;
}

export interface TextParseOptions {
  /** Academic year for dates without a year. Detected from the text when absent. */
  academicYear?: number;
  /** Used when nothing in the text names a year. */
  today?: Date;
}

interface DateToken {
  index: number;
  length: number;
  year?: number;
  month?: number;
  day: number;
  /** Matched only a day ("19일"), month comes from context. */
  dayOnly: boolean;
}

const WD = '[월화수목금토일]';
// A weekday mark after a date, possibly in its own table cell. Not followed by
// Hangul, so a title such as "월례회의" keeps its first syllable.
const WEEKDAY = new RegExp(`^\\s*\\|?\\s*\\(?\\s*${WD}(?:요일)?\\s*\\)?\\.?(?![가-힣])`);
const RANGE_SEP = /^\s*(?:~|-|부터|－)\s*/;

// ISO-like dates with a year: 2026-03-02, 2026.3.2, 2026/03/02
const ISO_DATE = /(?<![\d.])(20\d{2})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})\.?(?![\d%절])/g;
// Other full dates: 2026년 3월 2일 / 3. 2. / 3.2 / 3/2 / 3월 2일
const FULL_DATE =
  /(?<![\d.])(?:(20\d{2})\s*(?:년|[.\-/])\s*)?(\d{1,2})\s*(?:월|[./])\s*(\d{1,2})(?:\s*일|\s*\.(?!\d))?(?![\d%절])/g;
// Day only (needs a month from context): 19일
const DAY_ONLY = /(?<![\d.])(\d{1,2})\s*일(?![가-힣])/g;

export function normalizeLine(line: string): string {
  return line
    .normalize('NFKC')
    .replace(/[∼〜～–—―]/g, '~')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "2026학년도" wins; otherwise the first full date's academic year. */
export function detectAcademicYear(text: string, today = new Date()): number {
  const ay = /(20\d{2})\s*학년도/.exec(text);
  if (ay) return Number(ay[1]);
  const full = /(20\d{2})\s*(?:년|[.\-/])\s*(\d{1,2})\s*(?:월|[.\-/])\s*(\d{1,2})/.exec(text);
  if (full) {
    const iso = ymd(Number(full[1]), Number(full[2]), Number(full[3]));
    if (iso) return academicYearOf(iso);
  }
  return academicYearOf(localIsoDate(today));
}

// "(10일-19일)" or "(~13일)" written after a title: the event runs over those days of its month.
const RANGE_NOTE = /\(\s*(\d{1,2})?\s*일?\s*[~-]\s*(\d{1,2})\s*일?\s*\)/;

/**
 * Applies a "(10일-19일)" note to an event that starts in that month. Returns
 * the title without the note. An end day before the start day means the next
 * month ("(28일-3일)").
 */
export function applyRangeNote(ev: { title: string; start: IsoDate; end: IsoDate }): boolean {
  const m = RANGE_NOTE.exec(ev.title);
  if (!m) return false;
  const year = Number(ev.start.slice(0, 4));
  const month = Number(ev.start.slice(5, 7));
  const from = m[1] ? ymd(year, month, Number(m[1])) : ev.start;
  let to = ymd(year, month, Number(m[2]));
  if (from && to && to < from) {
    to = month === 12 ? ymd(year + 1, 1, Number(m[2])) : ymd(year, month + 1, Number(m[2]));
  }
  if (!from || !to) return false;
  ev.title = (ev.title.slice(0, m.index) + ev.title.slice(m.index + m[0].length)).trim();
  ev.start = from;
  ev.end = to;
  return true;
}

function overlapsAny(tokens: DateToken[], index: number, length: number): boolean {
  return tokens.some((t) => index < t.index + t.length && t.index < index + length);
}

function findTokens(line: string, carriedMonth: number | undefined): DateToken[] {
  const tokens: DateToken[] = [];
  for (const m of line.matchAll(ISO_DATE)) {
    tokens.push({
      index: m.index,
      length: m[0].length,
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      dayOnly: false,
    });
  }
  for (const m of line.matchAll(FULL_DATE)) {
    if (overlapsAny(tokens, m.index, m[0].length)) continue;
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    tokens.push({
      index: m.index,
      length: m[0].length,
      year: m[1] ? Number(m[1]) : undefined,
      month,
      day,
      dayOnly: false,
    });
  }
  for (const m of line.matchAll(DAY_ONLY)) {
    const day = Number(m[1]);
    if (day < 1 || day > 31) continue;
    if (!overlapsAny(tokens, m.index, m[0].length))
      tokens.push({ index: m.index, length: m[0].length, day, dayOnly: true });
  }
  // Table row whose first cell is a bare day ("2 | 월 | 입학식") under a carried month.
  if (carriedMonth !== undefined && !tokens.some((t) => !t.dayOnly)) {
    const m = new RegExp(`^(\\d{1,2})\\s*(?:\\||\\(?${WD}\\)?\\s)`).exec(line);
    if (m && !tokens.some((t) => t.index === 0)) {
      tokens.push({ index: 0, length: m[1]!.length, day: Number(m[1]), dayOnly: true });
    }
  }
  return tokens.sort((a, b) => a.index - b.index);
}

/** Skips a weekday mark right after a date: "(월)", " 월요일", "(화)." */
function skipWeekday(line: string, at: number): number {
  const m = WEEKDAY.exec(line.slice(at));
  return m ? at + m[0].length : at;
}

const TIME_RANGE = /(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?:\s*~\s*([01]?\d|2[0-3]):([0-5]\d))?/;

function cleanTitle(text: string): string {
  return text
    .replace(/^[\s|:,·~\-.)\]]+/, '')
    .replace(/[\s|:,·~\-(]+$/, '')
    .replace(/\s*\|\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Leftover cells such as "2", "5월" or "화" are not titles. */
function isTitleLike(title: string): boolean {
  return (
    /[가-힣A-Za-z]/.test(title) &&
    !/^\d{1,2}\s*월$/.test(title) &&
    !new RegExp(`^\\(?${WD}(?:요일)?\\)?$`).test(title)
  );
}

/** In a table row ("| 1학기 중간고사 | 오전만 수업") the title is the first filled cell; remarks follow. */
function firstCell(text: string): string {
  for (const part of text.split('|')) {
    const t = cleanTitle(part);
    if (t) return t;
  }
  return '';
}

export function parseDateText(
  lines: readonly string[],
  options: TextParseOptions = {},
): TextParseResult {
  const text = lines.join('\n');
  const academicYear = options.academicYear ?? detectAcademicYear(text, options.today);
  const events: RawEvent[] = [];
  let undatedLines = 0;
  let carriedMonth: number | undefined;
  let pending: { start: IsoDate; end: IsoDate } | null = null;

  const place = (month: number, day: number, year?: number): IsoDate | null =>
    ymd(year ?? yearInAcademicYear(academicYear, month), month, day);

  for (const rawLine of lines) {
    // Empty leading cells ("| 3 | 화 | 개학식") carry nothing.
    let line = normalizeLine(rawLine).replace(/^[|\s]+/, '');
    if (!line) continue;

    // A month cell at the start of a table row: "3월 | 2 | 월 | 입학식" or "3 | 2 | 월 | ...".
    const monthCell = /^(\d{1,2})\s*월?\s*\|\s*(\d{1,2})\s*일?\s*\|/.exec(line);
    if (monthCell && Number(monthCell[1]) <= 12) {
      line = `${monthCell[1]}/${monthCell[2]} |${line.slice(monthCell[0].length)}`;
    }
    // A line that is only a month ("3월"), or a month heading with nothing else.
    const monthOnly = /^(\d{1,2})\s*월\s*(?:\|\s*)?$/.exec(line);
    if (monthOnly) {
      const m = Number(monthOnly[1]);
      if (m >= 1 && m <= 12) carriedMonth = m;
      continue;
    }
    const leadingMonth = /^(\d{1,2})\s*월\s*\|/.exec(line);
    if (leadingMonth && Number(leadingMonth[1]) <= 12) {
      carriedMonth = Number(leadingMonth[1]);
      line = line.slice(leadingMonth[0].length).trim();
    }

    const note = RANGE_NOTE.exec(line);
    if (note) line = (line.slice(0, note.index) + line.slice(note.index + note[0].length)).trim();
    const firstOfLine = events.length;

    const tokens = findTokens(line, carriedMonth);
    if (!tokens.length) {
      // A title on the line after a date that had none.
      if (pending) {
        const title = cleanTitle(line);
        if (title) events.push({ title, ...pending });
        pending = null;
      } else {
        undatedLines++;
      }
      continue;
    }
    pending = null;

    let i = 0;
    while (i < tokens.length) {
      const t = tokens[i]!;
      const month = t.dayOnly ? carriedMonth : t.month;
      if (month === undefined) {
        i++;
        continue;
      }
      const start = place(month, t.day, t.year);
      if (!start) {
        i++;
        continue;
      }
      if (!t.dayOnly) carriedMonth = month;
      let after = skipWeekday(line, t.index + t.length);
      let end = start;
      let used = 1;

      // Range: a separator and another date right after.
      const sep = RANGE_SEP.exec(line.slice(after));
      const u = tokens[i + 1];
      if (sep && u && u.index === after + sep[0].length) {
        const endMonth = u.dayOnly ? month : u.month!;
        let endYear = u.year ?? (t.year !== undefined ? t.year : undefined);
        if (u.dayOnly && endMonth === month) endYear = Number(start.slice(0, 4));
        let candidate = place(endMonth, u.day, endYear);
        // "12.28~1.3" with explicit start year: the end is in the next year.
        if (candidate && candidate < start && u.year === undefined) {
          candidate = ymd(Number(start.slice(0, 4)) + 1, endMonth, u.day);
        }
        if (candidate && candidate >= start) {
          end = candidate;
          used = 2;
          after = skipWeekday(line, u.index + u.length);
          after += /^\s*까지/.exec(line.slice(after))?.[0].length ?? 0;
        }
      }

      const nextStart = tokens[i + used]?.index ?? line.length;
      let title = line.slice(after, nextStart);
      // Text before the first date belongs to it when nothing follows ("입학식 3. 2.").
      if (i === 0 && !cleanTitle(title) && t.index > 0) title = line.slice(0, t.index);

      const ev: RawEvent = { title: '', start, end };
      const time = TIME_RANGE.exec(title);
      if (time) {
        ev.time = `${time[1]!.padStart(2, '0')}:${time[2]}`;
        if (time[3]) ev.endTime = `${time[3].padStart(2, '0')}:${time[4]}`;
        title = title.slice(0, time.index) + title.slice(time.index + time[0].length);
      }
      ev.title = firstCell(title);
      if (!ev.title) pending = { start, end };
      else if (isTitleLike(ev.title)) events.push(ev);
      i += used;
    }
    const first = events[firstOfLine];
    if (note && first) {
      first.title = `${first.title} ${note[0]}`;
      applyRangeNote(first);
    }
  }
  return { events, academicYear, undatedLines };
}

/** Splits "종업식(1,2). 졸업식(3)" into two titles. */
export function splitJoinedTitles(title: string): string[] {
  return title
    .split(/\.\s+(?=[가-힣[])/)
    .map((p) => p.trim())
    .filter(Boolean);
}
