import { describe, expect, test } from 'vitest';
import { classify, splitGrades, type RawEvent } from '../src/import/classify';
import { finalizeRows } from '../src/import/finalize';
import { mergeConsecutive, unifyTruncated } from '../src/import/merge';
import { detectAcademicYear, parseDateText } from '../src/import/text';

const AY = { academicYear: 2026 };

function simple(lines: string[], opts = AY) {
  return parseDateText(lines, opts).events.map((e) =>
    [e.start, e.end, e.title, e.time ?? '', e.endTime ?? ''].join(' ').trim(),
  );
}

describe('parseDateText', () => {
  test('reads the date formats Korean school calendars use', () => {
    expect(
      simple([
        '3. 2.(월) 입학식',
        '3/3 개학식',
        '3월 4일 수요일 학부모 총회',
        '3.9~3.13 신입생 적응 주간',
        '4.20.~4.24. 1학기 중간고사',
        '2026-05-05 어린이날',
        '2026. 7. 17.(금) 제헌절',
        '2027년 1월 7일 졸업식',
      ]),
    ).toEqual([
      '2026-03-02 2026-03-02 입학식',
      '2026-03-03 2026-03-03 개학식',
      '2026-03-04 2026-03-04 학부모 총회',
      '2026-03-09 2026-03-13 신입생 적응 주간',
      '2026-04-20 2026-04-24 1학기 중간고사',
      '2026-05-05 2026-05-05 어린이날',
      '2026-07-17 2026-07-17 제헌절',
      '2027-01-07 2027-01-07 졸업식',
    ]);
  });

  test('places January and February in the next calendar year', () => {
    expect(simple(['1. 7.(목) 종업식', '2.10~2.16 겨울방학', '12.28~1.3 연말 휴가'])).toEqual([
      '2027-01-07 2027-01-07 종업식',
      '2027-02-10 2027-02-16 겨울방학',
      '2026-12-28 2027-01-03 연말 휴가',
    ]);
  });

  test('reads day-only ranges and the "(10일-19일)" note', () => {
    expect(
      simple(['3월 10일~19일 신입생전공멘토링', '3.10(화) 신입생전공멘토링 (10일-19일)']),
    ).toEqual(['2026-03-10 2026-03-19 신입생전공멘토링', '2026-03-10 2026-03-19 신입생전공멘토링']);
  });

  test('carries the month across table rows', () => {
    expect(
      simple([
        '3월 | 2 | 월 | 입학식',
        '| 3 | 화 | 개학식',
        '4월',
        '7일 영어듣기평가(1)',
        '8 (수) 영어듣기평가(2)',
      ]),
    ).toEqual([
      '2026-03-02 2026-03-02 입학식',
      '2026-03-03 2026-03-03 개학식',
      '2026-04-07 2026-04-07 영어듣기평가(1)',
      '2026-04-08 2026-04-08 영어듣기평가(2)',
    ]);
  });

  test('splits two columns on one line and takes a title from the next line', () => {
    expect(simple(['3. 2.(월) 입학식   9. 1.(화) 2학기 개학식', '10. 9.(금)', '한글날'])).toEqual([
      '2026-03-02 2026-03-02 입학식',
      '2026-09-01 2026-09-01 2학기 개학식',
      '2026-10-09 2026-10-09 한글날',
    ]);
  });

  test('pulls out times', () => {
    expect(simple(['5/7 14:00~16:30 국제인공지능대전 참관', '5/8 9:00 동아리 회의'])).toEqual([
      '2026-05-07 2026-05-07 국제인공지능대전 참관 14:00 16:30',
      '2026-05-08 2026-05-08 동아리 회의 09:00',
    ]);
  });

  test('ignores numbers that are not dates', () => {
    const r = parseDateText(
      ['3.1절 기념식', '수업일수 190일', '비율 1.5% 증가', '학사일정 안내'],
      AY,
    );
    expect(r.events).toEqual([]);
    expect(r.undatedLines).toBe(4);
  });

  test('detects the academic year', () => {
    expect(detectAcademicYear('2027학년도 학사일정')).toBe(2027);
    expect(detectAcademicYear('2027. 2. 10. 졸업식')).toBe(2026);
    expect(detectAcademicYear('일정', new Date(2026, 1, 1))).toBe(2025);
    expect(parseDateText(['2027학년도', '3/2 입학식']).events[0]?.start).toBe('2027-03-02');
  });
});

describe('classify and merge', () => {
  test('splits grade suffixes', () => {
    expect(splitGrades('개학식(2,3)')).toEqual({ title: '개학식', grades: [2, 3] });
    expect(splitGrades('입학식 (1)')).toEqual({ title: '입학식', grades: [1] });
    expect(splitGrades('대프콘')).toEqual({ title: '대프콘' });
    expect(splitGrades('(1)')).toEqual({ title: '(1)' });
  });

  test('assigns categories and review flags', () => {
    const rows = classify([
      { title: '1학기 중간고사', start: '2026-04-30', end: '2026-05-01' },
      { title: '전국연합학력평가(1)', start: '2026-03-24', end: '2026-03-24' },
      { title: '직업교육 평가회', start: '2026-10-23', end: '2026-10-23' },
      { title: '[의무귀가]', start: '2026-03-06', end: '2026-03-06' },
      { title: '추석연휴', start: '2026-09-24', end: '2026-09-26', holiday: true },
      { title: '추석', start: '2026-09-25', end: '2026-09-25', holiday: true },
      { title: '신입생 2차전형', start: '2026-10-30', end: '2026-10-30', holiday: true },
      { title: '재량휴업일', start: '2026-10-30', end: '2026-10-30', holiday: true },
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.rawTitle, r]));
    expect(by['1학기 중간고사']?.category).toBe('exam');
    expect(by['전국연합학력평가(1)']).toMatchObject({
      category: 'exam',
      title: '전국연합학력평가',
      grades: [1],
    });
    expect(by['직업교육 평가회']?.category).toBe('academic');
    expect(by['[의무귀가]']).toMatchObject({ notice: true, category: 'academic' });
    expect(by['추석']?.review).toBe('기간 쉬는 날과 겹칩니다: 추석연휴');
    expect(by['추석연휴']?.review).toBeUndefined();
    expect(by['신입생 2차전형']?.review).toMatch(/행사 이름/);
    expect(by['재량휴업일']?.review).toBeUndefined();
  });

  test('recognizes holidays by name only when asked', () => {
    const rows = [{ title: '어린이날', start: '2026-05-05', end: '2026-05-05' }];
    expect(classify(rows)[0]?.holiday).toBe(false);
    expect(classify(rows, true)[0]).toMatchObject({ holiday: true, category: 'holiday' });
  });

  test('joins consecutive days across a weekend but not notices', () => {
    const merged = mergeConsecutive([
      { title: '교내해커톤 대회', start: '2026-07-13', end: '2026-07-13' },
      { title: '교내해커톤 대회', start: '2026-07-14', end: '2026-07-14' },
      { title: '교내해커톤 대회', start: '2026-07-15', end: '2026-07-15' },
      { title: '취업역량강화캠프', start: '2026-11-06', end: '2026-11-06', grades: [2] }, // Fri
      { title: '취업역량강화캠프', start: '2026-11-09', end: '2026-11-09', grades: [2] }, // Mon
      { title: '취업역량강화캠프', start: '2026-11-10', end: '2026-11-10', grades: [3] },
      { title: '[의무귀가]', start: '2026-03-06', end: '2026-03-06' },
      { title: '[의무귀가]', start: '2026-03-07', end: '2026-03-07' },
      { title: '겨울방학', start: '2027-02-03', end: '2027-02-03' }, // Wed
      { title: '겨울방학', start: '2027-02-05', end: '2027-02-05' }, // Fri: Thursday missing
    ] as RawEvent[]).map(
      (e) => `${e.start}~${e.end} ${e.title}${e.grades ? e.grades : ''} ${e.mergedDays ?? 1}`,
    );
    expect(merged).toEqual([
      '2026-03-06~2026-03-06 [의무귀가] 1',
      '2026-03-07~2026-03-07 [의무귀가] 1',
      '2026-07-13~2026-07-15 교내해커톤 대회 3',
      '2026-11-06~2026-11-09 취업역량강화캠프2 2',
      '2026-11-10~2026-11-10 취업역량강화캠프3 1',
      '2027-02-03~2027-02-03 겨울방학 1',
      '2027-02-05~2027-02-05 겨울방학 1',
    ]);
  });

  test('repairs cut titles from a longer one nearby', () => {
    const rows = unifyTruncated([
      { title: '1학년 우수학생글로벌프', start: '2026-11-09', end: '2026-11-09' },
      { title: '1학년 우수학생글로벌프로그램', start: '2026-11-11', end: '2026-11-11' },
      { title: '대프콘', start: '2026-07-08', end: '2026-07-08' },
      { title: '대프콘 결선', start: '2026-07-09', end: '2026-07-09' },
    ]);
    expect(rows.map((r) => r.title)).toEqual([
      '1학년 우수학생글로벌프로그램',
      '1학년 우수학생글로벌프로그램',
      '대프콘',
      '대프콘 결선',
    ]);
  });

  test('finalizeRows splits joined cells and applies notes', () => {
    const rows = finalizeRows([
      { title: '종업식(1,2). 졸업식(3)', start: '2027-01-07', end: '2027-01-07' },
      { title: '신입생전공멘토링 (10일-19일)', start: '2026-03-10', end: '2026-03-10' },
    ]);
    expect(rows.map((r) => `${r.start}~${r.end} ${r.title} ${r.grades ?? ''}`)).toEqual([
      '2026-03-10~2026-03-19 신입생전공멘토링 ',
      '2027-01-07~2027-01-07 졸업식 3',
      '2027-01-07~2027-01-07 종업식 1,2',
    ]);
  });
});
