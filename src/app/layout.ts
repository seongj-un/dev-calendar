import {
  addDays,
  daysInMonth,
  diffDays,
  isoWeek,
  parseIso,
  weekday,
  ymd,
  type IsoDate,
} from '../model/date';
import type { CalendarEvent } from '../model/event';

/** 0 = weeks start on Sunday (the print calendar), 1 = Monday. */
export type WeekStart = 0 | 1;

/**
 * How an event is drawn in a day cell. Kinds are told apart by shape, not hue:
 * - `mark`: a one-day day off, drawn as the circled date number plus its name
 * - `notice`: a bracketed reminder ("[의무귀가]"), a small outlined label by the number
 * - `timed`: a one-day event with a start time, a line in the cell
 * - `bar`: everything else (all-day events and ranges), a bar in a lane
 */
export type Shape = 'mark' | 'notice' | 'timed' | 'bar';

export function shapeOf(e: CalendarEvent): Shape {
  if (e.notice) return 'notice';
  if (e.category === 'holiday' && e.start === e.end) return 'mark';
  if (!e.allDay && e.start === e.end) return 'timed';
  return 'bar';
}

/** Legend groups; the side panel filters the calendar by one of them. */
export const KIND_KEYS = ['academic', 'exam', 'due', 'plain', 'holiday', 'notice'] as const;
export type KindKey = (typeof KIND_KEYS)[number];

export const KIND_KEY_LABELS: Record<KindKey, string> = {
  academic: '학사',
  exam: '시험',
  due: '과제 마감',
  plain: '개인·기타',
  holiday: '쉬는 날',
  notice: '공지',
};

export function kindKeyOf(e: CalendarEvent): KindKey {
  if (e.notice) return 'notice';
  if (e.category === 'holiday') return 'holiday';
  if (e.category === 'exam') return 'exam';
  if (e.category === 'assignment' || e.deadline) return 'due';
  if (e.category === 'academic') return 'academic';
  return 'plain';
}

/** Assignments and events marked as a deadline are drawn in the accent text color. */
export function isDue(e: CalendarEvent): boolean {
  return e.category === 'assignment' || e.deadline === true;
}

export interface ViewFilter {
  /** Show only events for this grade (events without grades always show). */
  grade: number | null;
  kind: KindKey | null;
}

export function visibleEvents(
  events: readonly CalendarEvent[],
  filter: ViewFilter,
): CalendarEvent[] {
  return events.filter((e) => {
    if (filter.grade !== null && e.grades?.length && !e.grades.includes(filter.grade)) {
      return false;
    }
    return filter.kind === null || kindKeyOf(e) === filter.kind;
  });
}

export interface Segment {
  event: CalendarEvent;
  /** Column of the first day in this week, 0-6. */
  col: number;
  /** Number of days covered in this week. */
  span: number;
  lane: number;
  /** The event started before this week. */
  contL: boolean;
  /** The event goes on after this week. */
  contR: boolean;
}

export interface WeekLayout {
  days: IsoDate[];
  /** ISO week of the row's Monday, also for Sunday-first rows. */
  week: number;
  segments: Segment[];
  lanes: number;
}

export interface MonthLayout {
  year: number;
  month: number;
  first: IsoDate;
  last: IsoDate;
  weeks: WeekLayout[];
}

const CATEGORY_ORDER: Record<string, number> = {
  holiday: 0,
  exam: 1,
  academic: 2,
  assignment: 3,
  personal: 4,
  other: 5,
};

function barOrder(a: Segment, b: Segment): number {
  return (
    a.col - b.col ||
    b.span - a.span ||
    (CATEGORY_ORDER[a.event.category] ?? 9) - (CATEGORY_ORDER[b.event.category] ?? 9) ||
    a.event.title.localeCompare(b.event.title, 'ko') ||
    a.event.id.localeCompare(b.event.id)
  );
}

/** Puts each bar in the first lane where it overlaps nothing. */
export function placeLanes(segments: Segment[]): number {
  const lanes: Segment[][] = [];
  for (const s of [...segments].sort(barOrder)) {
    let lane = 0;
    while (lanes[lane]?.some((o) => !(s.col + s.span - 1 < o.col || s.col > o.col + o.span - 1))) {
      lane++;
    }
    (lanes[lane] ??= []).push(s);
    s.lane = lane;
  }
  return lanes.length;
}

export function monthLayout(
  year: number,
  month: number,
  events: readonly CalendarEvent[],
  weekStart: WeekStart = 0,
): MonthLayout {
  const first = ymd(year, month, 1);
  if (!first) throw new RangeError(`Bad month ${year}-${month}`);
  const last = addDays(first, daysInMonth(year, month) - 1);
  const offset = (weekday(first) - weekStart + 7) % 7;
  const gridStart = addDays(first, -offset);
  const count = Math.ceil((offset + daysInMonth(year, month)) / 7);
  const bars = events.filter((e) => shapeOf(e) === 'bar');

  const weeks: WeekLayout[] = [];
  for (let w = 0; w < count; w++) {
    const start = addDays(gridStart, w * 7);
    const end = addDays(start, 6);
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const monday = weekStart === 1 ? start : addDays(start, 1);
    const segments: Segment[] = bars
      .filter((e) => e.start <= end && e.end >= start)
      .map((event) => {
        const from = event.start < start ? start : event.start;
        const to = event.end > end ? end : event.end;
        return {
          event,
          col: diffDays(start, from),
          span: diffDays(from, to) + 1,
          lane: 0,
          contL: event.start < start,
          contR: event.end > end,
        };
      });
    const lanes = placeLanes(segments);
    segments.sort((a, b) => a.lane - b.lane || a.col - b.col);
    weeks.push({ days, week: isoWeek(monday).week, segments, lanes });
  }
  return { year, month, first, last: last, weeks };
}

export function weekOf(layout: MonthLayout, date: IsoDate): WeekLayout | undefined {
  return layout.weeks.find((w) => w.days.includes(date));
}

function timeKey(e: CalendarEvent): string {
  return e.allDay ? '' : (e.time ?? '');
}

/** One-day timed events of a date, earliest first. */
export function timedOn(events: readonly CalendarEvent[], date: IsoDate): CalendarEvent[] {
  return events
    .filter((e) => shapeOf(e) === 'timed' && e.start === date)
    .sort(
      (a, b) =>
        timeKey(a).localeCompare(timeKey(b)) ||
        a.title.localeCompare(b.title, 'ko') ||
        a.id.localeCompare(b.id),
    );
}

export function marksOn(events: readonly CalendarEvent[], date: IsoDate): CalendarEvent[] {
  return events.filter((e) => shapeOf(e) === 'mark' && e.start === date);
}

export function noticesOn(events: readonly CalendarEvent[], date: IsoDate): CalendarEvent[] {
  return events.filter((e) => shapeOf(e) === 'notice' && e.start <= date && e.end >= date);
}

/** Any day off (one day or a range) covers this date. */
export function isDayOff(events: readonly CalendarEvent[], date: IsoDate): boolean {
  return events.some(
    (e) => e.category === 'holiday' && !e.notice && e.start <= date && e.end >= date,
  );
}

/**
 * Events of a date in the order the side panel lists them and event mode
 * steps through them: days off, notices, bars from the top lane down, then
 * timed events by time.
 */
export function dayEvents(
  events: readonly CalendarEvent[],
  week: WeekLayout | undefined,
  date: IsoDate,
): CalendarEvent[] {
  const bars = week
    ? week.segments
        .filter((s) => week.days.indexOf(date) >= s.col && week.days.indexOf(date) < s.col + s.span)
        .sort((a, b) => a.lane - b.lane)
        .map((s) => s.event)
    : events
        .filter((e) => shapeOf(e) === 'bar' && e.start <= date && e.end >= date)
        .sort((a, b) => b.end.localeCompare(a.end) || a.title.localeCompare(b.title, 'ko'));
  const holidaysFirst = [
    ...bars.filter((e) => e.category === 'holiday'),
    ...bars.filter((e) => e.category !== 'holiday'),
  ];
  return [
    ...marksOn(events, date),
    ...noticesOn(events, date),
    ...holidaysFirst,
    ...timedOn(events, date),
  ];
}

/** How many timed lines fit under the bars of a week (the rest become "+N개 더"). */
export function timedRoom(lanes: number): number {
  return Math.max(1, 3 - Math.max(0, lanes - 1));
}

/** Upcoming exams and deadlines from today, soonest first. Running ranges count. */
export function upcoming(
  events: readonly CalendarEvent[],
  today: IsoDate,
  limit = 4,
): CalendarEvent[] {
  return events
    .filter((e) => (e.category === 'exam' || isDue(e)) && !e.notice && e.end >= today)
    .sort(
      (a, b) =>
        a.start.localeCompare(b.start) ||
        timeKey(a).localeCompare(timeKey(b)) ||
        a.title.localeCompare(b.title, 'ko'),
    )
    .slice(0, limit);
}

/** Same day of month in the month `delta` away, clamped to that month's last day. */
export function shiftMonth(date: IsoDate, delta: number): IsoDate {
  const { year, month, day } = parseIso(date);
  const index = year * 12 + (month - 1) + delta;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return ymd(y, m, Math.min(day, daysInMonth(y, m))) as IsoDate;
}
