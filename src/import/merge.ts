import { addDays, diffDays, isWeekend } from '../model/date';
import type { RawEvent } from './classify';

/**
 * Narrow cells cut long titles ("1학년 우수학생글로벌프"). A title of six or
 * more characters that starts another title within three days takes the
 * longer one.
 */
export function unifyTruncated<T extends RawEvent>(rows: T[]): T[] {
  for (const e of rows) {
    if (e.title.length < 6) continue;
    for (const f of rows) {
      if (
        f !== e &&
        f.title.length > e.title.length &&
        f.title.startsWith(e.title) &&
        Math.abs(diffDays(e.start, f.start)) <= 3
      ) {
        e.title = f.title;
        break;
      }
    }
  }
  return rows;
}

export interface MergeOptions {
  /**
   * Also bridge days filled by another event. In a printed grid a cell often
   * has room for one title, so a long break is not repeated on the day of a
   * one-day event inside it.
   */
  bridgeOccupied?: boolean;
}

const isNotice = (title: string) => title.trim().startsWith('[');

/** Titles present on each date (ranges expanded, notices left out). */
function titlesByDate(rows: readonly RawEvent[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    if (isNotice(r.title)) continue;
    const days = Math.min(diffDays(r.start, r.end), 366);
    for (let i = 0, d = r.start; i <= days; i++, d = addDays(d, 1)) {
      const set = map.get(d) ?? new Set<string>();
      set.add(r.title);
      map.set(d, set);
    }
  }
  return map;
}

/**
 * Joins rows with the same title (and grades) on consecutive days into one
 * range. Up to two days in between may be skipped when each of them is a
 * weekend, a day off, or (with `bridgeOccupied`) a day another event fills.
 * Bracketed notices ("[의무귀가]") are repeated reminders and never join.
 */
export function mergeConsecutive<T extends RawEvent>(
  rows: readonly T[],
  options: MergeOptions = {},
): T[] {
  const byDate = titlesByDate(rows);
  const holidays = titlesByDate(rows.filter((r) => r.holiday));
  const bridgeable = (day: string, title: string) => {
    if (isWeekend(day) || holidays.has(day)) return true;
    if (!options.bridgeOccupied) return false;
    return [...(byDate.get(day) ?? [])].some((t) => t !== title);
  };
  const gapBridgeable = (from: string, to: string, title: string) => {
    if (diffDays(from, to) > 3) return false;
    for (let d = addDays(from, 1); d < to; d = addDays(d, 1)) {
      if (!bridgeable(d, title)) return false;
    }
    return true;
  };

  const keyOf = (r: T) =>
    `${r.title}\u0000${(r.grades ?? []).join(',')}\u0000${r.holiday ? 1 : 0}\u0000${r.time ?? ''}`;
  const sorted = [...rows].sort(
    (a, b) => keyOf(a).localeCompare(keyOf(b)) || a.start.localeCompare(b.start),
  );
  const out: T[] = [];
  for (const r of sorted) {
    const prev = out[out.length - 1];
    const joins =
      prev !== undefined &&
      keyOf(prev) === keyOf(r) &&
      !isNotice(r.title) &&
      (r.start <= addDays(prev.end, 1) || gapBridgeable(prev.end, r.start, r.title));
    if (prev && joins) {
      prev.mergedDays = (prev.mergedDays ?? 1) + (r.mergedDays ?? 1);
      if (r.end > prev.end) prev.end = r.end;
      continue;
    }
    out.push({ ...r });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}
