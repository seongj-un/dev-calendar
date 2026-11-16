import { diffDays, isValidYmd, parseIso, ymd, type IsoDate } from '../model/date';
import type { Category } from '../model/event';

/** What a one-line entry ("자료구조 과제 4 12/21 23:59 #ds !과제") fills in. */
export interface LineParse {
  title: string;
  start?: IsoDate;
  end?: IsoDate;
  time?: string;
  endTime?: string;
  tags: string[];
  category?: Category;
}

const KIND_WORDS: Record<string, Category> = {
  학사: 'academic',
  시험: 'exam',
  과제: 'assignment',
  개인: 'personal',
  기타: 'other',
};

const ISO = String.raw`(\d{4})-(\d{1,2})-(\d{1,2})`;
const MD = String.raw`(\d{1,2})/(\d{1,2})`;
const DATE_RANGE = new RegExp(
  String.raw`(?<![\d/])(?:${ISO}|${MD})(?:\s*[~–-]\s*(?:${ISO}|${MD}))?(?![\d/])`,
);
const TIME_RANGE =
  /(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?:\s*[~–-]\s*([01]?\d|2[0-3]):([0-5]\d))?(?![\d:])/;
const TAG = /(?<!\S)#([^\s#!]+)/g;
const KIND = /(?<!\S)!(학사|시험|과제|개인|기타)(?!\S)/;

function pad(n: string): string {
  return n.padStart(2, '0');
}

/** The year that puts month/day closest to the base date (12/28 seen in January is last year). */
function nearestYear(base: IsoDate, month: number, day: number): IsoDate | null {
  const { year } = parseIso(base);
  let best: IsoDate | null = null;
  for (const y of [year - 1, year, year + 1]) {
    const date = ymd(y, month, day);
    if (!date) continue;
    if (best === null || Math.abs(diffDays(base, date)) < Math.abs(diffDays(base, best))) {
      best = date;
    }
  }
  return best;
}

function toDate(
  base: IsoDate,
  isoY?: string,
  isoM?: string,
  isoD?: string,
  m?: string,
  d?: string,
): IsoDate | null {
  if (isoY && isoM && isoD) return ymd(Number(isoY), Number(isoM), Number(isoD));
  if (m && d && isValidYmd(2024, Number(m), Number(d))) {
    return nearestYear(base, Number(m), Number(d));
  }
  return null;
}

/**
 * Reads a one-line entry. Tokens it understands are cut out of the title;
 * anything it cannot read (2/30) stays in the title so nothing is lost.
 * `base` is the selected date: it fills a missing date and picks the year.
 */
export function parseLine(input: string, base: IsoDate): LineParse {
  let rest = ` ${input} `;
  const out: LineParse = { title: '', tags: [] };

  const range = DATE_RANGE.exec(rest);
  if (range) {
    const start = toDate(base, range[1], range[2], range[3], range[4], range[5]);
    let end: IsoDate | null = start;
    if (start && (range[6] || range[9])) {
      end = toDate(start, range[6], range[7], range[8], range[9], range[10]);
      // "12/30~1/2" crosses the year: take the end on or after the start.
      if (end && end < start && !range[6]) {
        end = ymd(parseIso(start).year + 1, Number(range[9]), Number(range[10]));
      }
    }
    if (start && end && end >= start) {
      out.start = start;
      out.end = end;
      rest = rest.replace(range[0], ' ');
    }
  }

  const time = TIME_RANGE.exec(rest);
  if (time && time[1] !== undefined && time[2] !== undefined) {
    out.time = `${pad(time[1])}:${time[2]}`;
    if (time[3] !== undefined && time[4] !== undefined) {
      const endTime = `${pad(time[3])}:${time[4]}`;
      if (endTime > out.time) out.endTime = endTime;
    }
    rest = rest.replace(time[0], ' ');
  }

  const kind = KIND.exec(rest);
  if (kind?.[1]) {
    out.category = KIND_WORDS[kind[1]];
    rest = rest.replace(kind[0], ' ');
  }

  rest = rest.replace(TAG, (_all, tag: string) => {
    if (!out.tags.includes(tag)) out.tags.push(tag);
    return ' ';
  });

  out.title = rest.replace(/\s+/g, ' ').trim();
  return out;
}
