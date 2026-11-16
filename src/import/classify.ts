import { diffDays, type IsoDate } from '../model/date';
import { LIMITS, type Category } from '../model/event';
import type { ImportedEvent } from './types';

/** A parsed row before classification. */
export interface RawEvent {
  title: string;
  start: IsoDate;
  end: IsoDate;
  /** Known to be a day off (red text in a PDF, NEIS 휴업일/공휴일). */
  holiday?: boolean;
  time?: string;
  endTime?: string;
  /** Category already given by the source; skips the title rules. */
  category?: Category;
  grades?: number[];
  mergedDays?: number;
}

const GRADE_SUFFIX = /\s*\(\s*([1-6](?:\s*,\s*[1-6])*)\s*\)\s*$/;
const NOTICE = /^\[[^\]]+\]$/;

/**
 * Words that name a day off. Used to recognize holidays in sources without
 * colors, and to question a "holiday" whose name looks like an ordinary event.
 */
const HOLIDAY_NAME =
  /공휴일|휴업일|휴교|휴일|연휴|쉬는\s?날|기념일|신정|새해|설날|설\s?연휴|추석|성탄|크리스마스|어린이날|현충일|광복절|개천절|한글날|제헌절|삼일절|3[.·]\s?1절|석가탄신일|부처님\s?오신\s?날|근로자의\s?날|노동절|선거일|지방\s?선거|대통령\s?선거|국회의원\s?선거/;

export function splitGrades(rawTitle: string): { title: string; grades?: number[] } {
  const m = GRADE_SUFFIX.exec(rawTitle);
  if (!m) return { title: rawTitle.trim() };
  const grades = [...new Set(m[1]!.split(',').map((g) => Number(g.trim())))].sort((a, b) => a - b);
  const title = rawTitle.slice(0, m.index).trim();
  return title ? { title, grades } : { title: rawTitle.trim() };
}

export function isNoticeTitle(title: string): boolean {
  return NOTICE.test(title.trim());
}

/** Exams: titles ending in 고사, 평가 or 시험, or "…평가(1)". "직업교육 평가회" is not one. */
export function isExamTitle(title: string, rawTitle = title): boolean {
  return /(고사|평가|시험)$/.test(title.trim()) || /평가\s*\(/.test(rawTitle);
}

export function looksLikeHoliday(title: string): boolean {
  return HOLIDAY_NAME.test(title);
}

/**
 * Turns parsed rows into preview rows: splits the grade suffix, picks a
 * category, and flags rows the user should look at. When `holidayByName` is
 * set (sources without colors or day-off fields), holiday names count too.
 */
export function classify(rows: readonly RawEvent[], holidayByName = false): ImportedEvent[] {
  const out = rows.map((r): ImportedEvent => {
    const rawTitle = r.title.trim();
    const split = splitGrades(rawTitle);
    const { grades } = split;
    // A date-pattern line can swallow a whole paragraph as its title; the store
    // would refuse it, so cut it here where the preview can show it.
    const tooLong = split.title.length > LIMITS.title;
    const title = tooLong ? split.title.slice(0, LIMITS.title).trimEnd() : split.title;
    const notice = isNoticeTitle(title);
    const holiday = Boolean(r.holiday) || (holidayByName && !notice && looksLikeHoliday(title));
    let category: Category;
    if (r.category) category = r.category;
    else if (holiday) category = 'holiday';
    else if (!notice && isExamTitle(title, rawTitle)) category = 'exam';
    else category = 'academic';
    const ev: ImportedEvent = {
      title,
      rawTitle,
      start: r.start,
      end: r.end,
      allDay: !r.time,
      category,
      holiday,
    };
    if (r.time) ev.time = r.time;
    if (r.endTime) ev.endTime = r.endTime;
    const g = r.grades ?? grades;
    if (g?.length) ev.grades = g;
    if (notice) ev.notice = true;
    if (r.mergedDays && r.mergedDays > 1) ev.mergedDays = r.mergedDays;
    if (tooLong) ev.review = '제목이 길어 앞부분만 남겼습니다.';
    return ev;
  });
  flagForReview(out);
  return out.sort(compareRows);
}

/**
 * Marks rows that are probably wrong:
 * - a one-day holiday inside a longer holiday (추석 inside 추석연휴): double;
 * - a "holiday" (red text) whose name is an ordinary event (신입생 2차전형).
 */
export function flagForReview(rows: ImportedEvent[]): void {
  const longHolidays = rows.filter((r) => r.holiday && r.end > r.start);
  for (const r of rows) {
    if (!r.holiday || r.review) continue;
    if (r.start === r.end) {
      const outer = longHolidays.find((h) => h !== r && h.start <= r.start && h.end >= r.end);
      if (outer) {
        r.review = `기간 쉬는 날과 겹칩니다: ${outer.title}`;
        continue;
      }
    }
    if (!looksLikeHoliday(r.title)) {
      r.review = '쉬는 날로 표시됐지만 행사 이름으로 보입니다.';
    }
  }
}

export function compareRows(a: ImportedEvent, b: ImportedEvent): number {
  return (
    a.start.localeCompare(b.start) ||
    diffDays(b.start, b.end) - diffDays(a.start, a.end) ||
    a.rawTitle.localeCompare(b.rawTitle, 'ko')
  );
}
