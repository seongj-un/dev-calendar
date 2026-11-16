import { diffDays, isoWeek, parseIso, weekday, type IsoDate } from '../model/date';
import { CATEGORY_LABELS, type CalendarEvent } from '../model/event';

export const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];
export const MONTH_EN = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "12월 10일" */
export function monthDay(date: IsoDate): string {
  const { month, day } = parseIso(date);
  return `${month}월 ${day}일`;
}

/** "12월 10일 목요일" */
export function monthDayWeekday(date: IsoDate): string {
  return `${monthDay(date)} ${WEEKDAY_KO[weekday(date)]}요일`;
}

/** "12.09" */
export function dotDate(date: IsoDate): string {
  const { month, day } = parseIso(date);
  return `${month}.${String(day).padStart(2, '0')}`;
}

/** "12.09 – 12.11", or "12.09" for one day. */
export function dotRange(e: Pick<CalendarEvent, 'start' | 'end'>): string {
  return e.start === e.end ? dotDate(e.start) : `${dotDate(e.start)} – ${dotDate(e.end)}`;
}

export function weekLabel(date: IsoDate): string {
  return `W${isoWeek(date).week}`;
}

export function spanDays(e: Pick<CalendarEvent, 'start' | 'end'>): number {
  return diffDays(e.start, e.end) + 1;
}

/** Kind word read out for an event: deadline and day off are named, not just the category. */
export function kindWord(e: Pick<CalendarEvent, 'category' | 'deadline' | 'notice'>): string {
  if (e.notice) return '공지';
  if (e.category === 'assignment' || e.deadline) {
    return e.category === 'assignment' ? '과제 마감' : `${CATEGORY_LABELS[e.category]}, 마감`;
  }
  return CATEGORY_LABELS[e.category];
}

/**
 * Accessible name in the order title, kind, date:
 * "2학기 기말고사, 시험, 12월 9일부터 12월 11일까지",
 * "웹 프로그래밍 수행평가, 과제 마감, 12월 4일 23:59".
 */
export function eventLabel(e: CalendarEvent): string {
  const when =
    e.start === e.end ? monthDay(e.start) : `${monthDay(e.start)}부터 ${monthDay(e.end)}까지`;
  const time = !e.allDay && e.time ? ` ${e.time}${e.endTime ? `부터 ${e.endTime}까지` : ''}` : '';
  return `${e.title}, ${kindWord(e)}, ${when}${time}`;
}

/** "D-3", "오늘", or "D+2" for a day already passed. */
export function dday(today: IsoDate, date: IsoDate): string {
  const n = diffDays(today, date);
  if (n === 0) return '오늘';
  return n > 0 ? `D-${n}` : `D+${-n}`;
}

/** "UTC+9" from the browser's offset, with "KST" when it is Korea's. */
export function zoneLabel(now: Date, timeZone?: string): string {
  const offset = -now.getTimezoneOffset();
  const h = Math.trunc(Math.abs(offset) / 60);
  const m = Math.abs(offset) % 60;
  const utc = `UTC${offset >= 0 ? '+' : '-'}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
  return timeZone === 'Asia/Seoul' ? `KST ${utc}` : utc;
}
