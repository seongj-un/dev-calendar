import { addDays, isValidYmd, pad2, ymd, type IsoDate } from '../model/date';
import type { RawEvent } from './classify';
import { finalizeRows } from './finalize';
import type { ImportResult, ImportWarning } from './types';

/**
 * iCalendar (.ics) reader for VEVENTs. All-day events use the RFC 5545 rule
 * that DTEND is exclusive. Timed events are shown in `timeZone` (the
 * browser's zone by default). Recurrence rules are not expanded.
 */

export const MAX_ICS_EVENTS = 5000;

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Joins folded lines (a line starting with a space or tab continues the previous one). */
export function unfold(text: string): string[] {
  return text
    .replace(/\r\n|\r/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n');
}

export function parseProp(line: string): Prop | null {
  // NAME;PARAM=VALUE;PARAM="quoted:value":VALUE
  const m = /^([A-Za-z0-9-]+)((?:;[A-Za-z0-9-]+=(?:"[^"]*"|[^;:"]*))*):(.*)$/.exec(line);
  if (!m) return null;
  const params: Record<string, string> = {};
  for (const p of m[2]!.matchAll(/;([A-Za-z0-9-]+)=("[^"]*"|[^;:"]*)/g)) {
    params[p[1]!.toUpperCase()] = p[2]!.replace(/^"|"$/g, '');
  }
  return { name: m[1]!.toUpperCase(), params, value: m[3]! };
}

export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

interface When {
  date: IsoDate;
  time?: string;
  dateOnly: boolean;
}

/** Wall time in `zone` to a UTC instant, by correcting the offset twice (handles DST). */
function zonedToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  zone: string,
): Date | null {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(
      fmt.formatToParts(new Date(guess)).map((p) => [p.type, p.value]),
    );
    const shown = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
    );
    guess += wall - shown;
  }
  return new Date(guess);
}

function inZone(instant: Date, zone: string): { date: IsoDate; time: string } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(instant).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

export function parseWhen(prop: Prop, timeZone: string): When | null {
  const v = prop.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!isValidYmd(y, mo, d)) return null;
  if (m[4] === undefined || prop.params.VALUE === 'DATE') {
    return { date: ymd(y, mo, d)!, dateOnly: true };
  }
  const h = Number(m[4]);
  const mi = Number(m[5]);
  if (h > 23 || mi > 59) return null;
  let instant: Date | null = null;
  if (m[7] === 'Z') instant = new Date(Date.UTC(y, mo - 1, d, h, mi));
  else if (prop.params.TZID) instant = zonedToUtc(y, mo, d, h, mi, prop.params.TZID);
  if (!instant) {
    // Floating time (or an unknown zone): keep the wall time as written.
    return { date: ymd(y, mo, d)!, time: `${pad2(h)}:${pad2(mi)}`, dateOnly: false };
  }
  return { ...inZone(instant, timeZone), dateOnly: false };
}

export interface IcsOptions {
  timeZone?: string;
}

export function parseIcsText(
  text: string,
  fileName: string,
  options: IcsOptions = {},
): ImportResult {
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const warnings: ImportWarning[] = [];
  const rows: RawEvent[] = [];
  let current: Prop[] | null = null;
  let depth = 0;
  let recurring = 0;
  let invalid = 0;
  let calendarName = '';

  for (const line of unfold(text)) {
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper === 'BEGIN:VEVENT') {
      current = [];
      depth = 0;
      continue;
    }
    if (current && upper.startsWith('BEGIN:'))
      depth++; // VALARM inside an event
    else if (current && upper.startsWith('END:') && upper !== 'END:VEVENT') depth--;
    else if (current && upper === 'END:VEVENT') {
      const ev = toRaw(current, timeZone);
      if (ev) {
        rows.push(ev);
        if (current.some((p) => p.name === 'RRULE')) recurring++;
      } else {
        invalid++;
      }
      current = null;
      if (rows.length >= MAX_ICS_EVENTS) {
        warnings.push({
          code: 'too-large',
          message: `일정이 너무 많아 앞의 ${MAX_ICS_EVENTS}개만 읽었습니다.`,
        });
        break;
      }
      continue;
    } else if (current && depth === 0) {
      const p = parseProp(line);
      if (p) current.push(p);
    } else if (!current) {
      const p = parseProp(line);
      if (p?.name === 'X-WR-CALNAME') calendarName = unescapeText(p.value).trim();
    }
  }
  if (recurring) {
    warnings.push({
      code: 'skipped-rows',
      message: `반복 일정 ${recurring}개는 첫 번째 날짜만 넣었습니다.`,
    });
  }
  if (invalid) {
    warnings.push({
      code: 'skipped-rows',
      message: `날짜나 제목을 읽지 못한 일정 ${invalid}개는 뺐습니다.`,
    });
  }
  const events = finalizeRows(rows, { holidayByName: true, merge: false });
  if (!events.length && !invalid) {
    warnings.push({ code: 'no-dates', message: '캘린더 파일에 일정이 없습니다.' });
  }
  return {
    kind: 'ics',
    source: `file:${fileName}`,
    label: calendarName ? `${calendarName} (${fileName})` : fileName,
    events,
    warnings,
  };

  function toRaw(props: Prop[], zone: string): RawEvent | null {
    const get = (name: string) => props.find((p) => p.name === name);
    const summary = get('SUMMARY');
    const dtstart = get('DTSTART');
    if (!summary || !dtstart) return null;
    const title = unescapeText(summary.value).replace(/\s+/g, ' ').trim();
    const start = parseWhen(dtstart, zone);
    if (!title || !start) return null;
    const dtend = get('DTEND');
    const endWhen = dtend ? parseWhen(dtend, zone) : null;
    let end = start.date;
    const ev: RawEvent = { title, start: start.date, end };
    if (start.dateOnly) {
      // DTEND is the day after the last day.
      if (endWhen && endWhen.date > start.date) end = addDays(endWhen.date, -1);
    } else {
      ev.time = start.time;
      if (endWhen && !endWhen.dateOnly) {
        if (endWhen.date >= start.date) end = endWhen.date;
        if (endWhen.time && (end > start.date || endWhen.time > start.time!)) {
          ev.endTime = endWhen.time;
        }
        // An event ending at midnight ends on the previous day.
        if (end > start.date && endWhen.time === '00:00') {
          end = addDays(end, -1);
          delete ev.endTime;
        }
      }
    }
    ev.end = end;
    return ev;
  }
}
