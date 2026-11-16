import { addDays, type IsoDate } from '../../model/date';
import { CATEGORY_LABELS, type CalendarEvent } from '../../model/event';

/** Escapes TEXT values (RFC 5545 3.3.11). */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Folds a content line at 75 octets (RFC 5545 3.1). Counts UTF-8 bytes so a
 * Korean syllable (3 bytes) is never cut in half.
 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  // The first line holds 75 octets; continuation lines start with a space.
  let max = 75;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (bytes + size > max) {
      parts.push(current);
      current = '';
      bytes = 0;
      max = 74;
    }
    current += ch;
    bytes += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

function dateValue(date: IsoDate): string {
  return date.replace(/-/g, '');
}

function dateTimeValue(date: IsoDate, time: string): string {
  return `${dateValue(date)}T${time.replace(':', '')}00`;
}

function utcStamp(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/**
 * The DTSTART/DTEND lines of one event.
 * - All-day: DATE values; DTEND is the day after the last day (exclusive end).
 * - Timed: floating local times (the calendar keeps wall times, not zones).
 *   With an end time, DTEND is the last day at that time. Without one, a
 *   one-day event has no DTEND (an instant), and a multi-day event ends at
 *   the start of the day after its last day.
 */
export function whenLines(e: CalendarEvent): string[] {
  if (e.allDay || !e.time) {
    return [
      `DTSTART;VALUE=DATE:${dateValue(e.start)}`,
      `DTEND;VALUE=DATE:${dateValue(addDays(e.end, 1))}`,
    ];
  }
  const lines = [`DTSTART:${dateTimeValue(e.start, e.time)}`];
  if (e.endTime && (e.end > e.start || e.endTime > e.time)) {
    lines.push(`DTEND:${dateTimeValue(e.end, e.endTime)}`);
  } else if (e.end > e.start) {
    lines.push(`DTEND:${dateTimeValue(addDays(e.end, 1), '00:00')}`);
  }
  return lines;
}

export interface IcsExportOptions {
  /** Time written in DTSTAMP. */
  now: Date;
  calendarName?: string;
}

/** Builds a VCALENDAR with one VEVENT per event. Lines end in CRLF. */
export function eventsToIcs(events: readonly CalendarEvent[], options: IcsExportOptions): string {
  const stamp = utcStamp(options.now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//datebook//dev-calendar//KO',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${escapeText(options.calendarName ?? 'datebook')}`,
  ];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${escapeText(e.id)}@datebook`,
      `DTSTAMP:${stamp}`,
      ...whenLines(e),
      `SUMMARY:${escapeText(e.title)}`,
      `CATEGORIES:${[CATEGORY_LABELS[e.category], ...e.tags].map(escapeText).join(',')}`,
    );
    if (e.memo) lines.push(`DESCRIPTION:${escapeText(e.memo)}`);
    if (e.allDay) lines.push('TRANSP:TRANSPARENT');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
