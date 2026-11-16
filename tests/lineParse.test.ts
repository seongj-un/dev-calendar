import { describe, expect, test } from 'vitest';
import { parseLine } from '../src/app/lineParse';

describe('one-line entry', () => {
  test('reads the handoff example', () => {
    expect(parseLine('자료구조 과제 4 12/21 23:59 #ds !과제', '2026-12-10')).toEqual({
      title: '자료구조 과제 4',
      start: '2026-12-21',
      end: '2026-12-21',
      time: '23:59',
      tags: ['ds'],
      category: 'assignment',
    });
  });

  test('reads ranges, time ranges and several tags', () => {
    expect(parseLine('기말 대비 12/14~12/17 #study #ds', '2026-12-10')).toMatchObject({
      title: '기말 대비',
      start: '2026-12-14',
      end: '2026-12-17',
      tags: ['study', 'ds'],
    });
    expect(parseLine('회의 9:00-10:30', '2026-12-10')).toMatchObject({
      title: '회의',
      time: '09:00',
      endTime: '10:30',
    });
    expect(parseLine('배포 2027-01-05 #release', '2026-12-10')).toMatchObject({
      title: '배포',
      start: '2027-01-05',
    });
  });

  test('picks the nearest year and crosses the new year', () => {
    expect(parseLine('신년 계획 1/2', '2026-12-28').start).toBe('2027-01-02');
    expect(parseLine('회고 12/28', '2027-01-03').start).toBe('2026-12-28');
    expect(parseLine('겨울 캠프 12/30~1/2', '2026-12-10')).toMatchObject({
      start: '2026-12-30',
      end: '2027-01-02',
    });
  });

  test('keeps what it cannot read in the title', () => {
    expect(parseLine('v1.2 배포 2/30 25:00', '2026-12-10')).toEqual({
      title: 'v1.2 배포 2/30 25:00',
      tags: [],
    });
    expect(parseLine('C# 스터디 !모임', '2026-12-10')).toEqual({
      title: 'C# 스터디 !모임',
      tags: [],
    });
    expect(parseLine('   ', '2026-12-10').title).toBe('');
  });
});
