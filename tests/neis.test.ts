import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  NeisError,
  fetchSchedule,
  readEnvelope,
  scheduleResult,
  scheduleRowsToEvents,
  searchSchools,
} from '../src/import/neis';

// Saved answers from open.neis.go.kr (서울과학고등학교, 2026학년도), fetched without a key.
// schedule-0622-0712.json joins three keyless answers for consecutive weeks into one,
// to stand in for a keyed answer.
const load = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/neis/${name}`, import.meta.url), 'utf8'));

const SCHOOL = { officeCode: 'B10', schoolCode: '7010084', name: '서울과학고등학교' };
const KEY = '0123456789abcdef0123456789abcdef';

function fakeFetch(answer: unknown | ((url: URL) => unknown), status = 200) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const body = typeof answer === 'function' ? (answer as (u: URL) => unknown)(url) : answer;
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fn, calls };
}

describe('NEIS', () => {
  test('searches schools and reports the keyless limit', async () => {
    const { fn, calls } = fakeFetch(load('schoolInfo-search.json'));
    const r = await searchSchools(' 과학고 ', { fetch: fn });
    expect(r.total).toBe(84);
    expect(r.schools).toHaveLength(5);
    expect(r.schools[0]).toMatchObject({ officeCode: expect.stringMatching(/^[A-Z]\d{2}$/) });
    const url = calls[0]!.url;
    expect(url.origin + url.pathname).toBe('https://open.neis.go.kr/hub/schoolInfo');
    expect(url.searchParams.get('SCHUL_NM')).toBe('과학고');
    expect(url.searchParams.has('KEY')).toBe(false);
    expect(calls[0]!.init?.credentials).toBe('omit');
  });

  test('treats "no data" as an empty result and skips short queries', async () => {
    const { fn, calls } = fakeFetch(load('schoolInfo-none.json'));
    expect(await searchSchools('없는학교이름', { fetch: fn })).toEqual({ schools: [], total: 0 });
    expect(await searchSchools('가', { fetch: fn })).toEqual({ schools: [], total: 0 });
    expect(calls).toHaveLength(1);
  });

  test('turns keyless schedule answers into rows with a warning', async () => {
    const { fn, calls } = fakeFetch(load('schedule-keyless.json'));
    const r = await fetchSchedule(SCHOOL, 2026, { fetch: fn });
    expect(calls).toHaveLength(1);
    const q = calls[0]!.url.searchParams;
    expect(q.get('AA_FROM_YMD')).toBe('20260301');
    expect(q.get('AA_TO_YMD')).toBe('20270228');
    expect(r).toMatchObject({
      kind: 'neis',
      source: 'neis:B10/7010084',
      label: '서울과학고등학교',
    });
    expect(r.events.map((e) => `${e.start} ${e.title} ${e.category}`)).toEqual([
      '2026-03-01 3·1절 holiday',
      '2026-03-02 대체휴일 holiday',
      '2026-03-03 개학식 academic',
      '2026-03-03 봉사활동 academic',
      '2026-03-03 입학식 academic',
    ]);
    expect(r.warnings).toEqual([
      {
        code: 'neis-sample-limit',
        message:
          'NEIS 인증키가 없어 일정 247건 중 5건만 받았습니다. 설정에서 인증키를 넣으면 모두 받을 수 있습니다.',
      },
    ]);
  });

  test('joins days across weekends, keeps grades and drops Saturday rows', async () => {
    const { fn, calls } = fakeFetch(load('schedule-0622-0712.json'));
    const r = await fetchSchedule(SCHOOL, 2026, { fetch: fn, key: ` ${KEY} ` });
    expect(calls[0]!.url.searchParams.get('KEY')).toBe(KEY);
    expect(r.warnings).toEqual([]);
    const rows = r.events.map(
      (e) =>
        `${e.start}~${e.end} ${e.title} ${e.category}${e.grades ? ` g${e.grades}` : ''}${e.mergedDays ? ` x${e.mergedDays}` : ''}`,
    );
    expect(rows).toEqual([
      '2026-06-24~2026-06-24 연구활동 academic',
      '2026-06-25~2026-07-01 기말고사 exam x5',
      '2026-07-02~2026-07-03 집중연구 academic x2',
      '2026-07-06~2026-07-06 동아리활동 academic',
      '2026-07-06~2026-07-06 자율활동 academic',
      '2026-07-07~2026-07-08 연구활동 academic g1,2 x2',
      '2026-07-07~2026-07-07 졸업논문연구 academic g3',
    ]);
  });

  test('pages through long answers with a key', async () => {
    const all = (
      load('schedule-0622-0712.json') as { SchoolSchedule: [unknown, { row: unknown[] }] }
    ).SchoolSchedule[1].row;
    const { fn, calls } = fakeFetch((url: URL) => {
      const page = Number(url.searchParams.get('pIndex'));
      const rows = page === 1 ? all.slice(0, 10) : all.slice(10);
      return {
        SchoolSchedule: [
          { head: [{ list_total_count: all.length }, { RESULT: { CODE: 'INFO-000' } }] },
          { row: rows },
        ],
      };
    });
    const r = await fetchSchedule(SCHOOL, 2026, { fetch: fn, key: KEY });
    expect(calls.map((c) => c.url.searchParams.get('pIndex'))).toEqual(['1', '2']);
    expect(r.events.find((e) => e.title === '기말고사')?.end).toBe('2026-07-01');
  });

  test('maps API and transport errors', async () => {
    await expect(
      fetchSchedule(SCHOOL, 2026, { fetch: fakeFetch(load('error-290.json')).fn, key: KEY }),
    ).rejects.toMatchObject({ code: 'invalid-key', apiCode: 'ERROR-290' });
    await expect(fetchSchedule(SCHOOL, 2026, { key: 'not a key!' })).rejects.toMatchObject({
      code: 'invalid-key',
    });
    await expect(
      fetchSchedule(SCHOOL, 2026, { fetch: fakeFetch({}, 503).fn }),
    ).rejects.toMatchObject({ code: 'http' });
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    await expect(fetchSchedule(SCHOOL, 2026, { fetch: offline })).rejects.toBeInstanceOf(NeisError);
    await expect(fetchSchedule(SCHOOL, 2026, { fetch: offline })).rejects.toMatchObject({
      code: 'network',
    });
    expect(() => readEnvelope('SchoolSchedule', 'x')).toThrow(NeisError);
    expect(() =>
      readEnvelope('SchoolSchedule', {
        SchoolSchedule: [{ head: [{ RESULT: { CODE: 'ERROR-337' } }] }],
      }),
    ).toThrow(/하루 호출 한도/);
  });

  test('a caller abort is passed through, not reported as a network error', async () => {
    const ctrl = new AbortController();
    const hanging = ((_: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      })) as typeof fetch;
    const p = fetchSchedule(SCHOOL, 2026, { fetch: hanging, signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('ignores malformed rows', () => {
    expect(
      scheduleRowsToEvents([
        { AA_YMD: '20261340', EVENT_NM: '잘못된 날짜' },
        { AA_YMD: '20261009', EVENT_NM: '' },
        { AA_YMD: '20261009', EVENT_NM: '한글날', SBTR_DD_SC_NM: '공휴일' },
      ]),
    ).toEqual([{ title: '한글날', start: '2026-10-09', end: '2026-10-09', holiday: true }]);
  });

  test('keeps titles as NEIS sent them, even when one starts with another', () => {
    const r = scheduleResult(
      [
        { AA_YMD: '20260701', EVENT_NM: '1학기 기말고사' },
        { AA_YMD: '20260703', EVENT_NM: '1학기 기말고사 성적 확인' },
        { AA_YMD: '20260706', EVENT_NM: '방학식. 여름방학 시작' },
      ],
      SCHOOL,
      2026,
      { total: 3, keyed: true },
    );
    expect(r.events.map((e) => [e.title, e.start, e.category])).toEqual([
      ['1학기 기말고사', '2026-07-01', 'exam'],
      ['1학기 기말고사 성적 확인', '2026-07-03', 'academic'],
      ['방학식. 여름방학 시작', '2026-07-06', 'academic'],
    ]);
  });

  test('asks for the last day of February in a leap year', async () => {
    const { fn, calls } = fakeFetch({ SchoolSchedule: [{ head: [{ list_total_count: 0 }] }] });
    await fetchSchedule(SCHOOL, 2027, { key: KEY, fetch: fn });
    expect(calls[0]!.url.searchParams.get('AA_TO_YMD')).toBe('20280229');
    await fetchSchedule(SCHOOL, 2026, { key: KEY, fetch: fn });
    expect(calls[1]!.url.searchParams.get('AA_TO_YMD')).toBe('20270228');
  });
});
