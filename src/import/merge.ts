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

/** True when every day strictly between `a` and `b` is a Saturday or Sunday. */
function onlyWeekendBetween(a: string, b: string): boolean {
  for (let d = addDays(a, 1); d < b; d = addDays(d, 1)) {
    if (!isWeekend(d)) return false;
  }
  return true;
}

/**
 * Joins rows with the same title (and grades) on consecutive days into one
 * range. A gap made only of a weekend still counts as consecutive, so a
 * Friday and the following Monday join. Bracketed notices ("[의무귀가]") are
 * repeated reminders and never join.
 */
export function mergeConsecutive<T extends RawEvent>(rows: readonly T[]): T[] {
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
      !r.title.trim().startsWith('[') &&
      (r.start <= addDays(prev.end, 1) || onlyWeekendBetween(prev.end, r.start));
    if (prev && joins) {
      prev.mergedDays = (prev.mergedDays ?? 1) + (r.mergedDays ?? 1);
      if (r.end > prev.end) prev.end = r.end;
      continue;
    }
    out.push({ ...r });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}
