import { classify, type RawEvent } from './classify';
import { mergeConsecutive, unifyTruncated } from './merge';
import { applyRangeNote, splitJoinedTitles } from './text';
import type { ImportedEvent } from './types';

export interface FinalizeOptions {
  /** Count holiday names as days off (sources without colors or day-off fields). */
  holidayByName?: boolean;
  /** Join same-title rows on consecutive days (sources that list each day). */
  merge?: boolean;
  /** Let a range continue over days another event fills (printed grids). */
  bridgeOccupied?: boolean;
  /**
   * Repair titles cut by printed table cells: join a cut title with the longer
   * one nearby and split "A. B" into two. Default on. Turn it off for sources
   * whose titles arrive whole (NEIS, ICS), where it would rename real titles.
   */
  repairCutTitles?: boolean;
}

/**
 * Shared last steps for every parser: split "A. B" cells, apply "(10일-19일)"
 * notes, repair cut titles (see `repairCutTitles`), join consecutive days, then classify.
 */
export function finalizeRows(
  rows: readonly RawEvent[],
  options: FinalizeOptions = {},
): ImportedEvent[] {
  const repair = options.repairCutTitles ?? true;
  const split: RawEvent[] = [];
  for (const r of rows) {
    for (const title of repair ? splitJoinedTitles(r.title) : [r.title.trim()].filter(Boolean)) {
      const ev: RawEvent = { ...r, title };
      applyRangeNote(ev);
      if (ev.title) split.push(ev);
    }
  }
  const unified = repair ? unifyTruncated(split) : split;
  const merged =
    options.merge === false
      ? unified
      : mergeConsecutive(unified, { bridgeOccupied: options.bridgeOccupied });
  return classify(merged, options.holidayByName ?? false);
}
