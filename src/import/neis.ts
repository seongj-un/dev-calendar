import { daysInMonth, isIsoDate, type IsoDate } from '../model/date';
import type { RawEvent } from './classify';
import { finalizeRows } from './finalize';
import type { ImportResult, ImportWarning } from './types';

/**
 * NEIS open API (open.neis.go.kr). It answers browsers directly (CORS `*`).
 * Without an API key it returns only the first five rows of any query.
 */

export const NEIS_BASE = 'https://open.neis.go.kr/hub';
const PAGE_SIZE = 1000;
const MAX_PAGES = 5;
const TIMEOUT_MS = 15_000;

export interface NeisSchool {
  officeCode: string;
  officeName: string;
  schoolCode: string;
  name: string;
  /** 고등학교, 중학교, 초등학교 ... */
  kind: string;
  region: string;
  address: string;
}

export type NeisErrorCode = 'network' | 'timeout' | 'http' | 'invalid-key' | 'api' | 'format';

export class NeisError extends Error {
  constructor(
    readonly code: NeisErrorCode,
    message: string,
    readonly apiCode?: string,
  ) {
    super(message);
    this.name = 'NeisError';
  }
}

export interface NeisOptions {
  /** NEIS API key from settings. Sent only to open.neis.go.kr. */
  key?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

interface NeisHead {
  list_total_count?: number;
  RESULT?: { CODE?: string; MESSAGE?: string };
}

type Row = Record<string, unknown>;

/** Keys are 32 hex characters; anything else is not sent. */
export function isPlausibleKey(key: string | undefined): key is string {
  return typeof key === 'string' && /^[A-Za-z0-9]{16,64}$/.test(key.trim());
}

function apiMessage(code: string): string {
  switch (code) {
    case 'ERROR-290':
      return 'NEIS 인증키가 올바르지 않습니다. 설정에서 키를 확인해 주세요.';
    case 'ERROR-337':
      return 'NEIS 하루 호출 한도를 넘었습니다. 내일 다시 시도해 주세요.';
    case 'ERROR-500':
    case 'ERROR-600':
    case 'ERROR-601':
      return 'NEIS 서버에 문제가 있어 응답을 받지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
    default:
      return `NEIS가 요청을 처리하지 못했습니다. (${code})`;
  }
}

/** Calls one NEIS service and returns its head and rows. INFO-200 (no data) is an empty list. */
async function call(
  service: 'schoolInfo' | 'SchoolSchedule',
  params: Record<string, string>,
  options: NeisOptions,
): Promise<{ total: number; rows: Row[] }> {
  const query = new URLSearchParams({ Type: 'json', ...params });
  if (options.key?.trim() && !isPlausibleKey(options.key)) {
    throw new NeisError('invalid-key', apiMessage('ERROR-290'), 'ERROR-290');
  }
  if (isPlausibleKey(options.key)) query.set('KEY', options.key.trim());
  const url = `${NEIS_BASE}/${service}?${query.toString()}`;
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  let res: Response;
  try {
    res = await doFetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch (err) {
    if (timeout.aborted) throw new NeisError('timeout', 'NEIS 응답이 15초 안에 오지 않았습니다.');
    if (options.signal?.aborted) throw err;
    throw new NeisError('network', 'NEIS에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.');
  }
  if (!res.ok) {
    throw new NeisError('http', `NEIS가 오류로 응답했습니다. (HTTP ${res.status})`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new NeisError('format', 'NEIS 응답을 읽지 못했습니다.');
  }
  return readEnvelope(service, body);
}

/** Unwraps `{service: [{head: [...]}, {row: [...]}]}` or a bare `{RESULT}`. */
export function readEnvelope(service: string, body: unknown): { total: number; rows: Row[] } {
  if (typeof body !== 'object' || body === null) {
    throw new NeisError('format', 'NEIS 응답을 읽지 못했습니다.');
  }
  const doc = body as Record<string, unknown>;
  const bare = doc.RESULT as NeisHead['RESULT'] | undefined;
  if (bare?.CODE) {
    if (bare.CODE === 'INFO-200') return { total: 0, rows: [] };
    if (bare.CODE === 'ERROR-290')
      throw new NeisError('invalid-key', apiMessage(bare.CODE), bare.CODE);
    throw new NeisError('api', apiMessage(bare.CODE), bare.CODE);
  }
  const parts = doc[service];
  if (!Array.isArray(parts)) throw new NeisError('format', 'NEIS 응답을 읽지 못했습니다.');
  let total = 0;
  let rows: Row[] = [];
  for (const part of parts as Record<string, unknown>[]) {
    if (Array.isArray(part.head)) {
      for (const h of part.head as NeisHead[]) {
        if (typeof h.list_total_count === 'number') total = h.list_total_count;
        const code = h.RESULT?.CODE;
        if (code && code !== 'INFO-000') throw new NeisError('api', apiMessage(code), code);
      }
    }
    if (Array.isArray(part.row))
      rows = part.row.filter((r): r is Row => typeof r === 'object' && r !== null);
  }
  return { total, rows };
}

const str = (row: Row, key: string) =>
  typeof row[key] === 'string' ? (row[key] as string).trim() : '';

export function toSchool(row: Row): NeisSchool | null {
  const school: NeisSchool = {
    officeCode: str(row, 'ATPT_OFCDC_SC_CODE'),
    officeName: str(row, 'ATPT_OFCDC_SC_NM'),
    schoolCode: str(row, 'SD_SCHUL_CODE'),
    name: str(row, 'SCHUL_NM'),
    kind: str(row, 'SCHUL_KND_SC_NM'),
    region: str(row, 'LCTN_SC_NM'),
    address: str(row, 'ORG_RDNMA'),
  };
  return /^[A-Z]\d{2}$/.test(school.officeCode) && /^\d{7}$/.test(school.schoolCode) && school.name
    ? school
    : null;
}

export interface SchoolSearchResult {
  schools: NeisSchool[];
  /** Matches NEIS has; more than `schools.length` when the key is missing. */
  total: number;
}

export async function searchSchools(
  name: string,
  options: NeisOptions = {},
): Promise<SchoolSearchResult> {
  const q = name.trim().slice(0, 50);
  if (q.length < 2) return { schools: [], total: 0 };
  const { total, rows } = await call('schoolInfo', { SCHUL_NM: q, pSize: '100' }, options);
  const schools = rows.map(toSchool).filter((s): s is NeisSchool => s !== null);
  return { schools, total: Math.max(total, schools.length) };
}

const GRADE_FIELDS = [
  'ONE_GRADE_EVENT_YN',
  'TW_GRADE_EVENT_YN',
  'THREE_GRADE_EVENT_YN',
  'FR_GRADE_EVENT_YN',
  'FIV_GRADE_EVENT_YN',
  'SIX_GRADE_EVENT_YN',
];

/** Rows NEIS adds for every Saturday; they are not events. */
const SKIP_TITLES = new Set(['토요휴업일']);

/** Converts schedule rows (one per day) into import rows. Pure, for tests. */
export function scheduleRowsToEvents(rows: readonly Row[]): RawEvent[] {
  const out: RawEvent[] = [];
  for (const row of rows) {
    const ymdStr = str(row, 'AA_YMD');
    const date: IsoDate = `${ymdStr.slice(0, 4)}-${ymdStr.slice(4, 6)}-${ymdStr.slice(6, 8)}`;
    const title = str(row, 'EVENT_NM').replace(/\s+/g, ' ');
    if (!/^\d{8}$/.test(ymdStr) || !isIsoDate(date) || !title || SKIP_TITLES.has(title)) continue;
    const dayOff = str(row, 'SBTR_DD_SC_NM');
    // Grades the school has ("*" marks a grade it does not have) and the ones this event is for.
    const flags = GRADE_FIELDS.map((f) => str(row, f));
    const has = flags.flatMap((v, i) => (v === 'Y' || v === 'N' ? [i + 1] : []));
    const target = flags.flatMap((v, i) => (v === 'Y' ? [i + 1] : []));
    const ev: RawEvent = {
      title,
      start: date,
      end: date,
      holiday: dayOff === '공휴일' || dayOff === '휴업일',
    };
    if (target.length && target.length < has.length) ev.grades = target;
    out.push(ev);
  }
  return out;
}

export async function fetchSchedule(
  school: Pick<NeisSchool, 'officeCode' | 'schoolCode' | 'name'>,
  academicYear: number,
  options: NeisOptions = {},
): Promise<ImportResult> {
  const keyed = isPlausibleKey(options.key);
  const params = {
    ATPT_OFCDC_SC_CODE: school.officeCode,
    SD_SCHUL_CODE: school.schoolCode,
    AA_FROM_YMD: `${academicYear}0301`,
    AA_TO_YMD: `${academicYear + 1}02${String(daysInMonth(academicYear + 1, 2))}`,
    pSize: String(PAGE_SIZE),
  };
  const rows: Row[] = [];
  let total = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await call('SchoolSchedule', { ...params, pIndex: String(page) }, options);
    total = res.total;
    rows.push(...res.rows);
    // Without a key NEIS sends five rows whatever the page size; asking again repeats them.
    if (!keyed || !res.rows.length || rows.length >= total) break;
  }
  return scheduleResult(rows, school, academicYear, { total, keyed });
}

export function scheduleResult(
  rows: readonly Row[],
  school: Pick<NeisSchool, 'officeCode' | 'schoolCode' | 'name'>,
  academicYear: number,
  meta: { total: number; keyed: boolean },
): ImportResult {
  const warnings: ImportWarning[] = [];
  if (meta.total > rows.length) {
    warnings.push({
      code: 'neis-sample-limit',
      message: meta.keyed
        ? `일정 ${meta.total}건 중 ${rows.length}건만 받았습니다.`
        : `NEIS 인증키가 없어 일정 ${meta.total}건 중 ${rows.length}건만 받았습니다. 설정에서 인증키를 넣으면 모두 받을 수 있습니다.`,
    });
  }
  const events = finalizeRows(scheduleRowsToEvents(rows), { merge: true, repairCutTitles: false });
  if (!events.length) {
    warnings.push({
      code: 'no-dates',
      message: `${academicYear}학년도 학사일정이 NEIS에 없습니다.`,
    });
  }
  return {
    kind: 'neis',
    source: `neis:${school.officeCode}/${school.schoolCode}`,
    label: school.name,
    academicYear,
    events,
    warnings,
  };
}
