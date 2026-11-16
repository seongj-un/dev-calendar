import { isIsoDate, ymd, type IsoDate } from '../../model/date';
import type { CalendarEvent } from '../../model/event';
import { parseLine, type LineParse } from '../lineParse';

/** What a palette command does once it is run. */
export type PaletteCommand =
  | { type: 'goto'; date: IsoDate }
  | { type: 'import' }
  | { type: 'import-neis' }
  | { type: 'import-json' }
  | { type: 'export'; format: 'ics' | 'json' }
  | { type: 'theme'; theme: 'light' | 'dark' | 'system' }
  | { type: 'settings' }
  | { type: 'copy-link' }
  | { type: 'weekstart'; weekStart: 0 | 1 }
  | { type: 'help' };

export interface CommandSpec {
  /** What the person types after `>`, e.g. "export ics". */
  text: string;
  /** Text shown for a command that needs an argument, e.g. "goto 2027-03". */
  hint?: string;
  description: string;
}

/** Every command the palette lists. Order is the order shown for a bare `>`. */
export const COMMANDS: readonly CommandSpec[] = [
  { text: 'goto', hint: 'goto 2027-03', description: '날짜로 이동' },
  { text: 'import', description: '학사일정 파일 가져오기' },
  { text: 'import neis', description: '나이스에서 학사일정 가져오기' },
  { text: 'import json', description: 'JSON 백업 가져오기' },
  { text: 'export ics', description: '캘린더 파일(.ics)로 내보내기' },
  { text: 'export json', description: 'JSON 백업 내보내기' },
  { text: 'theme dark', description: '다크 테마' },
  { text: 'theme light', description: '라이트 테마' },
  { text: 'theme system', description: '시스템 테마 따르기' },
  { text: 'settings', description: '설정 열기' },
  { text: 'copy link', description: '이 날짜 링크 복사' },
  { text: 'weekstart sun', description: '한 주를 일요일부터' },
  { text: 'weekstart mon', description: '한 주를 월요일부터' },
  { text: 'help', description: '단축키 표' },
];

/**
 * Reads the argument of `>goto`: 2027-03, 2027-3, 2027-03-15 or 202703.
 * A month alone goes to its first day.
 */
export function parseGotoDate(arg: string): IsoDate | null {
  const m = /^(\d{4})[-./]?(\d{1,2})(?:[-./](\d{1,2}))?$/.exec(arg.trim());
  if (!m) return null;
  const date = ymd(Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : 1);
  return date && isIsoDate(date) ? date : null;
}

/** Turns the text after `>` into a command, or null when it is not a complete one. */
export function parseCommand(body: string): PaletteCommand | null {
  const words = body.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const [verb, arg, extra] = words;
  if (!verb || extra !== undefined) return null;
  switch (verb) {
    case 'goto':
    case 'go': {
      const date = arg ? parseGotoDate(arg) : null;
      return date ? { type: 'goto', date } : null;
    }
    case 'import':
      if (!arg) return { type: 'import' };
      if (arg === 'neis') return { type: 'import-neis' };
      if (arg === 'json') return { type: 'import-json' };
      return null;
    case 'export':
      if (arg === 'ics' || arg === 'json') return { type: 'export', format: arg };
      return null;
    case 'theme':
      if (arg === 'dark' || arg === 'light' || arg === 'system')
        return { type: 'theme', theme: arg };
      return null;
    case 'settings':
      return arg ? null : { type: 'settings' };
    case 'copy':
      return arg === 'link' ? { type: 'copy-link' } : null;
    case 'weekstart':
      if (arg === 'mon') return { type: 'weekstart', weekStart: 1 };
      if (arg === 'sun') return { type: 'weekstart', weekStart: 0 };
      return null;
    case 'help':
      return arg ? null : { type: 'help' };
    default:
      return null;
  }
}

/** Commands whose text starts with what was typed (each word as a prefix). */
export function matchCommands(body: string): CommandSpec[] {
  const typed = body.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!typed.length) return [...COMMANDS];
  return COMMANDS.filter((c) => {
    const words = c.text.split(' ');
    // "goto 2027-03": the verb matches and the argument is free text.
    if (c.hint && typed[0] && c.text.startsWith(typed[0])) return true;
    return typed.every((t, i) => words[i]?.startsWith(t) ?? false);
  });
}

/**
 * Finds events by title and tags. Each word must appear in the title or a tag;
 * `#word` must be the start of a tag. Results keep the order given.
 */
export function searchEvents(
  events: readonly CalendarEvent[],
  query: string,
  limit = 8,
): CalendarEvent[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: CalendarEvent[] = [];
  for (const e of events) {
    const title = e.title.toLowerCase();
    const tags = e.tags.map((t) => t.toLowerCase());
    const hit = words.every((w) =>
      w.startsWith('#') && w.length > 1
        ? tags.some((t) => t.startsWith(w.slice(1)))
        : title.includes(w) || tags.some((t) => t.includes(w.replace(/^#/, ''))),
    );
    if (hit) out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

export type PaletteInput =
  | { kind: 'empty' }
  | {
      kind: 'command';
      /** The full command when the text is one, otherwise null. */
      command: PaletteCommand | null;
      matches: CommandSpec[];
    }
  | {
      kind: 'text';
      /**
       * A new event the text describes; null when it has no title left or names
       * no date and no time (then it is only a search).
       */
      event: (LineParse & { start: IsoDate; end: IsoDate }) | null;
      query: string;
    };

/**
 * Reads the palette input. `>` starts a command; anything else is both a
 * search, and also a one-line event when it names a date or a time
 * ("v1.2 배포 12/20 14:00 #release"). Text with neither is only a search.
 * `base` is the selected date: it fills a missing date and picks the year.
 */
export function parsePaletteInput(input: string, base: IsoDate): PaletteInput {
  const text = input.trim();
  if (!text) return { kind: 'empty' };
  if (text.startsWith('>')) {
    const body = text.slice(1);
    return { kind: 'command', command: parseCommand(body), matches: matchCommands(body) };
  }
  const p = parseLine(text, base);
  const dated = p.start !== undefined || p.time !== undefined;
  const event =
    p.title && dated ? { ...p, start: p.start ?? base, end: p.end ?? p.start ?? base } : null;
  return { kind: 'text', event, query: text };
}

/** Events that already sit at the same day and time as a new one (or the same all-day title). */
export function sameSlot(
  events: readonly CalendarEvent[],
  draft: { start: IsoDate; time?: string },
): CalendarEvent[] {
  if (!draft.time) return [];
  return events.filter((e) => !e.allDay && e.start === draft.start && e.time === draft.time);
}
