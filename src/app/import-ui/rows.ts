import { academicYearOf, isValidYmd, pad2, parseIso, type IsoDate } from '../../model/date';
import { eventKey } from '../../model/event';
import type { ImportedEvent } from '../../import/types';

/**
 * Preview rows for the import dialog. Pure, so the status rules are tested
 * without a DOM.
 */

export type RowStatus = 'new' | 'check' | 'grade' | 'exists';

export interface PreviewRow {
  id: number;
  event: ImportedEvent;
  /** Checked rows go into the calendar. */
  include: boolean;
  /** The person changed the check box; grade changes no longer reset it. */
  touched: boolean;
  /** The person edited the row (title, dates or kind). */
  edited: boolean;
}

export type RowFilter = 'all' | 'check' | 'grade' | 'holiday' | 'exists';

export interface RowContext {
  /** Grade shown in the calendar; null shows every grade. */
  grade: number | null;
  /** Keys of events already in the calendar (see `eventKey`). */
  existing: ReadonlySet<string>;
}

export function statusOf(row: PreviewRow, ctx: RowContext): RowStatus {
  if (ctx.existing.has(eventKey(row.event))) return 'exists';
  if (row.event.review && !row.edited) return 'check';
  const grades = row.event.grades;
  if (ctx.grade !== null && grades?.length && !grades.includes(ctx.grade)) return 'grade';
  return 'new';
}

/** Checked by default only for new rows. */
export function defaultInclude(row: PreviewRow, ctx: RowContext): boolean {
  return statusOf(row, ctx) === 'new';
}

export function buildRows(events: readonly ImportedEvent[], ctx: RowContext): PreviewRow[] {
  return events.map((event, id) => {
    const row: PreviewRow = { id, event, include: false, touched: false, edited: false };
    row.include = defaultInclude(row, ctx);
    return row;
  });
}

/** Re-applies the default check to rows the person has not touched. */
export function refreshIncludes(rows: PreviewRow[], ctx: RowContext): void {
  for (const row of rows) if (!row.touched) row.include = defaultInclude(row, ctx);
}

export function matchesFilter(row: PreviewRow, filter: RowFilter, ctx: RowContext): boolean {
  if (filter === 'all') return true;
  if (filter === 'holiday') return row.event.holiday || row.event.category === 'holiday';
  return statusOf(row, ctx) === filter;
}

export function countBy(rows: readonly PreviewRow[], ctx: RowContext): Record<RowFilter, number> {
  const out: Record<RowFilter, number> = { all: 0, check: 0, grade: 0, holiday: 0, exists: 0 };
  for (const row of rows) {
    out.all++;
    for (const f of ['check', 'grade', 'holiday', 'exists'] as const) {
      if (matchesFilter(row, f, ctx)) out[f]++;
    }
  }
  return out;
}

/** "3.01" style day, as the preview and its edit fields show it. */
export function shortDate(date: IsoDate): string {
  const { month, day } = parseIso(date);
  return `${month}.${pad2(day)}`;
}

/**
 * Reads "3.10", "3/10" or "2027-01-05" typed into a preview row. Months
 * without a year are placed in the academic year (March to February).
 */
export function parseShortDate(value: string, academicYear: number): IsoDate | null {
  const v = value.trim();
  const full = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/.exec(v);
  if (full) {
    const [y, m, d] = [Number(full[1]), Number(full[2]), Number(full[3])];
    return isValidYmd(y, m, d) ? `${y}-${pad2(m)}-${pad2(d)}` : null;
  }
  const short = /^(\d{1,2})\s*[./-]\s*(\d{1,2})$/.exec(v);
  if (!short) return null;
  const [m, d] = [Number(short[1]), Number(short[2])];
  const y = m >= 3 ? academicYear : academicYear + 1;
  return isValidYmd(y, m, d) ? `${y}-${pad2(m)}-${pad2(d)}` : null;
}

/** Academic year for the rows: the parser's, else the year of the first row. */
export function rowsAcademicYear(
  events: readonly ImportedEvent[],
  fallback: number | undefined,
): number {
  if (fallback) return fallback;
  const first = events[0]?.start;
  return first ? academicYearOf(first) : new Date().getFullYear();
}

/** Rows grouped by the month they start in, in source order. */
export function groupByMonth<T extends { event: { start: IsoDate } }>(
  rows: readonly T[],
): { key: string; month: number; rows: T[] }[] {
  const groups: { key: string; month: number; rows: T[] }[] = [];
  for (const row of rows) {
    const key = row.event.start.slice(0, 7);
    let g = groups.at(-1);
    if (!g || g.key !== key) {
      g = { key, month: parseIso(row.event.start).month, rows: [] };
      groups.push(g);
    }
    g.rows.push(row);
  }
  return groups;
}
