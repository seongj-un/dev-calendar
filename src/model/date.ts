/**
 * Calendar dates as `YYYY-MM-DD` strings.
 *
 * All arithmetic goes through UTC so the result never depends on the
 * browser's time zone (a KST browser and a UTC CI runner agree).
 */
export type IsoDate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string') return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  return isValidYmd(Number(m[1]), Number(m[2]), Number(m[3]));
}

export function isValidYmd(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Builds an ISO date, or returns null when the parts are not a real date. */
export function ymd(year: number, month: number, day: number): IsoDate | null {
  if (!isValidYmd(year, month, day)) return null;
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

export function parseIso(date: IsoDate): { year: number; month: number; day: number } {
  const m = ISO_DATE.exec(date);
  if (!m) throw new RangeError(`Not an ISO date: ${date}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

function toUtcMs(date: IsoDate): number {
  const { year, month, day } = parseIso(date);
  return Date.UTC(year, month - 1, day);
}

function fromUtcMs(ms: number): IsoDate {
  const d = new Date(ms);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

/** Whole days from `a` to `b` (positive when `b` is later). */
export function diffDays(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS);
}

/** 0 = Sunday ... 6 = Saturday. */
export function weekday(date: IsoDate): number {
  return new Date(toUtcMs(date)).getUTCDay();
}

export function isWeekend(date: IsoDate): boolean {
  const d = weekday(date);
  return d === 0 || d === 6;
}

/** Date of a JS Date in the browser's local zone (what "today" means to the user). */
export function localIsoDate(d: Date): IsoDate {
  return `${String(d.getFullYear()).padStart(4, '0')}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Korean school years start in March: March to December belong to the
 * academic year of the same calendar year, January and February to the
 * previous one.
 */
export function academicYearOf(date: IsoDate): number {
  const { year, month } = parseIso(date);
  return month >= 3 ? year : year - 1;
}

/** Calendar year of `month` within academic year `academicYear`. */
export function yearInAcademicYear(academicYear: number, month: number): number {
  return month >= 3 ? academicYear : academicYear + 1;
}

/** ISO 8601 week number (weeks start on Monday, week 1 holds the first Thursday). */
export function isoWeek(date: IsoDate): { year: number; week: number } {
  const ms = toUtcMs(date);
  const dow = (new Date(ms).getUTCDay() + 6) % 7; // Monday = 0
  const thursday = new Date(ms + (3 - dow) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((thursday.getTime() - jan1) / DAY_MS / 7) + 1;
  return { year, week };
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
