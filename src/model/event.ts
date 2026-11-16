import { isIsoDate, type IsoDate } from './date';

/** Event kinds. Stored as English ids; the UI shows the Korean labels. */
export const CATEGORIES = [
  'academic',
  'exam',
  'assignment',
  'personal',
  'other',
  'holiday',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  academic: '학사',
  exam: '시험',
  assignment: '과제',
  personal: '개인',
  other: '기타',
  holiday: '쉬는 날',
};

export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);
}

/** `manual` for events typed in by the user, otherwise where an import came from. */
export type EventSource = string;
export const MANUAL_SOURCE = 'manual';

export interface CalendarEvent {
  id: string;
  title: string;
  /** First day, inclusive. */
  start: IsoDate;
  /** Last day, inclusive. Equal to `start` for a one-day event. */
  end: IsoDate;
  allDay: boolean;
  /** `HH:MM`, only when `allDay` is false. */
  time?: string;
  /** `HH:MM` end time on the last day, optional. */
  endTime?: string;
  category: Category;
  tags: string[];
  /** Target school grades, e.g. [2, 3] for "(2,3)". Absent means everyone. */
  grades?: number[];
  /** Bracketed school notices such as "[의무귀가]": shown small, never as a bar. */
  notice?: boolean;
  /** Marked as a deadline (shown in the D-day list). */
  deadline?: boolean;
  memo?: string;
  source: EventSource;
  /** Import batch the event came from; lets the user remove a whole import. */
  batchId?: string;
  createdAt: string;
  updatedAt: string;
}

/** What the user (or an import) supplies; the store fills in the rest. */
export type EventInput = Omit<CalendarEvent, 'id' | 'createdAt' | 'updatedAt' | 'source'> & {
  source?: EventSource;
};

export const LIMITS = {
  title: 200,
  memo: 2000,
  tag: 40,
  tags: 20,
  events: 20_000,
} as const;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isTime(value: unknown): value is string {
  return typeof value === 'string' && TIME.test(value);
}

/** Lowercases, strips a leading `#` and spaces, and drops empty or duplicate tags. */
export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().replace(/^#+/, '').replace(/\s+/g, '-').slice(0, LIMITS.tag);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= LIMITS.tags) break;
  }
  return out;
}

export class EventValidationError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'EventValidationError';
  }
}

/**
 * Checks and normalizes event fields. Builds a fresh object field by field,
 * so unknown keys (including `__proto__` from a crafted backup) never get in.
 */
export function sanitizeInput(input: unknown): EventInput {
  if (typeof input !== 'object' || input === null) {
    throw new EventValidationError('event', '일정 형식이 올바르지 않습니다.');
  }
  const r = input as Record<string, unknown>;
  const title = typeof r.title === 'string' ? r.title.trim() : '';
  if (!title) throw new EventValidationError('title', '제목을 입력해 주세요.');
  if (title.length > LIMITS.title) {
    throw new EventValidationError('title', `제목은 ${LIMITS.title}자까지 쓸 수 있습니다.`);
  }
  if (!isIsoDate(r.start)) throw new EventValidationError('start', '시작일이 올바르지 않습니다.');
  const end = r.end === undefined || r.end === null || r.end === '' ? r.start : r.end;
  if (!isIsoDate(end)) throw new EventValidationError('end', '종료일이 올바르지 않습니다.');
  if (end < r.start) throw new EventValidationError('end', '종료일이 시작일보다 앞섭니다.');
  const category = isCategory(r.category) ? r.category : 'other';

  const out: EventInput = {
    title,
    start: r.start,
    end,
    allDay: true,
    category,
    tags: Array.isArray(r.tags)
      ? normalizeTags(r.tags.filter((t): t is string => typeof t === 'string'))
      : [],
  };

  if (r.allDay === false && isTime(r.time)) {
    out.allDay = false;
    out.time = r.time;
    if (isTime(r.endTime)) out.endTime = r.endTime;
  }
  if (Array.isArray(r.grades)) {
    const grades = [
      ...new Set(r.grades.filter((g): g is number => Number.isInteger(g) && g >= 1 && g <= 6)),
    ].sort((a, b) => a - b);
    if (grades.length) out.grades = grades;
  }
  if (r.notice === true) out.notice = true;
  if (r.deadline === true) out.deadline = true;
  if (typeof r.memo === 'string' && r.memo.trim()) out.memo = r.memo.slice(0, LIMITS.memo);
  if (typeof r.source === 'string' && r.source) out.source = r.source.slice(0, 200);
  if (typeof r.batchId === 'string' && r.batchId) out.batchId = r.batchId.slice(0, 100);
  return out;
}

/**
 * Key used to spot the same event coming in twice (re-import, backup merge).
 * Grades are part of it, so the same field trip for grade 1 and grade 2 stays
 * two events; an event without grades keeps the key it always had.
 */
export function eventKey(e: {
  title: string;
  start: IsoDate;
  end: IsoDate;
  grades?: readonly number[];
}): string {
  const base = `${e.start}|${e.end}|${e.title.replace(/\s+/g, ' ').trim().toLowerCase()}`;
  if (!e.grades?.length) return base;
  return `${base}|g${[...new Set(e.grades)].sort((a, b) => a - b).join(',')}`;
}
