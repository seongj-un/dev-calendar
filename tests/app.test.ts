// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://localhost/#/2026-12-10"}
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '../src/app/app';
import { EventStore, type StorageLike } from '../src/store/store';
import type { EventInput } from '../src/model/event';

class MemoryStorage implements StorageLike {
  map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

const NOW = new Date(2026, 11, 8, 9, 0, 0);
let app: App | null = null;

function setup(seed: Partial<EventInput>[] = []) {
  const storage = new MemoryStorage();
  let n = 0;
  const store = new EventStore(storage, { newId: () => `ev${++n}`, now: () => NOW });
  for (const e of seed) store.add(e);
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  history.replaceState(null, '', '#/2026-12-10');
  app = new App({ root, store, prefsStorage: storage, now: () => NOW });
  return { store, root };
}

function key(k: string, target: EventTarget = document.activeElement ?? document.body, init = {}) {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }),
  );
}

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const cell = (date: string) => $(`.cell[data-date="${date}"]`);
const active = () => document.activeElement as HTMLElement;

const EXAM = {
  title: '2학기 기말고사',
  start: '2026-12-09',
  end: '2026-12-11',
  category: 'exam',
} as const;
const DS = {
  title: '자료구조',
  start: '2026-12-10',
  allDay: false,
  time: '08:50',
  category: 'exam',
} as const;
const ENG = {
  title: '영어',
  start: '2026-12-10',
  allDay: false,
  time: '10:40',
  category: 'exam',
} as const;

beforeEach(() => {
  // happy-dom lays nothing out; treat every element as shown.
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([
    new DOMRect(0, 0, 10, 10),
  ] as unknown as DOMRectList);
});

afterEach(() => {
  app?.destroy();
  app = null;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('month view', () => {
  test('renders the selected month with week numbers and a gridcell per day', () => {
    setup();
    expect($('.num').textContent).toBe('12');
    expect($('.title h1').textContent).toBe('December');
    expect(document.querySelectorAll('[role="row"].week')).toHaveLength(5);
    expect([...document.querySelectorAll('.wkno')].map((w) => w.textContent)).toEqual([
      'W49',
      'W50',
      'W51',
      'W52',
      'W53',
    ]);
    const selected = cell('2026-12-10');
    expect(selected.getAttribute('aria-selected')).toBe('true');
    expect(selected.tabIndex).toBe(0);
    expect(cell('2026-12-11').tabIndex).toBe(-1);
    expect(selected.getAttribute('aria-label')).toBe('12월 10일 목요일, 일정 없음');
    // Columns stay i+2 so the zero-width week column keeps days under their weekday.
    expect(cell('2026-12-06').style.gridColumn).toBe('2');
    expect(cell('2026-12-12').style.gridColumn).toBe('8');
  });

  test('places range bars in the first cell of each week with their span and lane', () => {
    setup([
      EXAM,
      { title: '현장체험학습', start: '2026-12-11', end: '2026-12-15' },
      { title: '성탄절', start: '2026-12-25', category: 'holiday' },
    ]);
    const exam = cell('2026-12-09').querySelector<HTMLElement>('.bar')!;
    expect(exam.classList.contains('exam')).toBe(true);
    expect(exam.style.getPropertyValue('--span')).toBe('3');
    expect(exam.style.getPropertyValue('--lane')).toBe('0');
    expect(exam.getAttribute('aria-label')).toBe(
      '2학기 기말고사, 시험, 12월 9일부터 12월 11일까지',
    );
    expect(exam.textContent).toBe('2학기 기말고사3일');

    const tripA = cell('2026-12-11').querySelector<HTMLElement>('.bar')!;
    expect(tripA.style.getPropertyValue('--span')).toBe('2');
    expect(tripA.style.getPropertyValue('--lane')).toBe('1');
    expect(tripA.classList.contains('cont-r')).toBe(true);
    const tripB = cell('2026-12-13').querySelector<HTMLElement>('.bar')!;
    expect(tripB.classList.contains('cont-l')).toBe(true);
    expect(tripB.style.getPropertyValue('--span')).toBe('3');
    // The continued piece leaves out the day count.
    expect(tripB.querySelector('.sub')).toBeNull();

    const xmas = cell('2026-12-25');
    expect(xmas.querySelector('.n')!.classList.contains('hol-day')).toBe(true);
    expect(xmas.querySelector('.hname')!.textContent).toBe('성탄절');
    expect(xmas.getAttribute('aria-label')).toBe('12월 25일 금요일, 쉬는 날, 일정 1개');
  });

  test('lists the selected day in the side panel and the next exams', () => {
    setup([EXAM, ENG, DS]);
    const rows = [...document.querySelectorAll('.agenda .row-btn')].map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(rows).toEqual([
      '2학기 기말고사, 시험, 12월 9일부터 12월 11일까지',
      '자료구조, 시험, 12월 10일 08:50',
      '영어, 시험, 12월 10일 10:40',
    ]);
    expect([...document.querySelectorAll('.dl .dd')].map((d) => d.textContent)).toEqual([
      'D-1',
      'D-2',
      'D-2',
    ]);
    expect($('.status').textContent).toContain('일정 3개');
  });

  test('filters by kind from the legend', () => {
    setup([EXAM, { title: '동아리 보고서', start: '2026-12-17', category: 'assignment' }]);
    $('[data-filter="due"]').click();
    expect($('[data-filter="due"]').getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelectorAll('.grid .bar')).toHaveLength(1);
    expect($('.grid .bar').textContent).toContain('동아리 보고서');
    $('[data-action="clear-filter"]').click();
    expect(document.querySelectorAll('.grid .bar')).toHaveLength(2);
  });
});

describe('event editor', () => {
  test('adds an event from the one-line entry', () => {
    const { store } = setup();
    $<HTMLButtonElement>('.top [data-action="add"]').click();
    const dialog = $<HTMLDialogElement>('dialog');
    expect(dialog.open).toBe(true);
    const line = $<HTMLInputElement>('#ed-line');
    line.value = '자료구조 과제 4 12/21 23:59 #ds !과제';
    line.dispatchEvent(new Event('input', { bubbles: true }));
    expect($<HTMLInputElement>('#ed-title').value).toBe('자료구조 과제 4');
    expect($<HTMLInputElement>('#ed-start').value).toBe('2026-12-21');
    expect($<HTMLInputElement>('#ed-time').value).toBe('23:59');

    key('Enter', $('#ed-title'), { ctrlKey: true });
    expect(dialog.open).toBe(false);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({
      title: '자료구조 과제 4',
      start: '2026-12-21',
      allDay: false,
      time: '23:59',
      category: 'assignment',
      tags: ['ds'],
    });
    // The calendar follows the new event and announces it with an undo.
    expect(location.hash).toBe('#/2026-12-21');
    expect(cell('2026-12-21').querySelector('.ev.due')!.textContent).toBe('23:59자료구조 과제 4');
    expect($('.toast').textContent).toContain('일정을 추가했습니다: 자료구조 과제 4');
  });

  test('shows field errors instead of saving a bad event', () => {
    const { store } = setup();
    key('n', document.body);
    const save = $<HTMLButtonElement>('dialog button[type="submit"]');
    save.click();
    expect($('#ed-title').getAttribute('aria-invalid')).toBe('true');
    expect($('#ed-title-err').textContent).toBe('제목을 입력해 주세요.');

    $<HTMLInputElement>('#ed-title').value = '스터디';
    const allDay = $<HTMLInputElement>('#ed-allday');
    allDay.checked = false;
    allDay.dispatchEvent(new Event('input', { bubbles: true }));
    save.click();
    expect($('#ed-time-err').textContent).toBe('시간을 입력하거나 하루 종일을 고르세요.');
    expect(store.list()).toHaveLength(0);
  });

  test('edits an imported event and keeps its batch', () => {
    const { store } = setup();
    store.commitImport(
      [
        {
          title: '2학기 기말고사',
          rawTitle: '2학기 기말고사',
          start: '2026-12-09',
          end: '2026-12-11',
          allDay: true,
          category: 'exam',
          holiday: false,
        },
      ],
      { source: 'file:학사일정.pdf', label: '학사일정.pdf' },
    );
    $('.agenda .row-btn').click();
    expect($('.src').textContent).toBe('가져온 학사일정학사일정.pdf');
    const end = $<HTMLInputElement>('#ed-end');
    end.value = '2026-12-12';
    $<HTMLButtonElement>('dialog button[type="submit"]').click();
    const [e] = store.list();
    expect(e).toMatchObject({ end: '2026-12-12', source: 'file:학사일정.pdf' });
    expect(e!.batchId).toBeTruthy();
    expect(store.batchEventCount(e!.batchId!)).toBe(1);
  });

  test('deletes after confirmation and undoes with the toast or Ctrl+Z', () => {
    const { store } = setup([DS]);
    $('.agenda .row-btn').click();
    $<HTMLButtonElement>('dialog [data-del]').click();
    expect($('.danger-confirm').textContent).toContain('이 일정을 삭제할까요?');
    // Cancel comes first and takes focus.
    expect(active().textContent).toBe('취소');
    $<HTMLButtonElement>('dialog .d-f .btn-primary').click();
    expect(store.list()).toHaveLength(0);
    expect($('.toast').textContent).toContain('일정을 삭제했습니다: 자료구조');

    key('z', document.body, { ctrlKey: true });
    expect(store.list().map((e) => e.id)).toEqual(['ev1']);
    expect(document.querySelector('.toast')).toBeNull();

    $('.agenda .row-btn').click();
    $<HTMLButtonElement>('dialog [data-del]').click();
    $<HTMLButtonElement>('dialog .d-f .btn-primary').click();
    $<HTMLButtonElement>('.toast .btn').click();
    expect(store.get('ev1')?.title).toBe('자료구조');
  });
});

describe('keyboard', () => {
  test('moves the date with h/j/k/l, [ ] and t, keeping focus and the link in step', () => {
    setup();
    cell('2026-12-10').focus();
    key('l');
    expect(active().dataset.date).toBe('2026-12-11');
    key('j');
    expect(active().dataset.date).toBe('2026-12-18');
    key('k');
    key('h');
    expect(active().dataset.date).toBe('2026-12-10');
    key('ArrowRight');
    expect(active().dataset.date).toBe('2026-12-11');
    key(']');
    expect(active().dataset.date).toBe('2027-01-11');
    expect($('.num').textContent).toBe('1');
    expect(location.hash).toBe('#/2027-01-11');
    key('[');
    key('[');
    expect(active().dataset.date).toBe('2026-11-11');
    key('t');
    expect(active().dataset.date).toBe('2026-12-08');
    expect(cell('2026-12-08').querySelector('.n')!.classList.contains('today')).toBe(true);
  });

  test('clamps [ ] to the last day of a shorter month', () => {
    setup();
    history.replaceState(null, '', '#/2027-01-31');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    cell('2027-01-31').focus();
    key(']');
    expect(active().dataset.date).toBe('2027-02-28');
  });

  test('Enter steps into the day, arrows choose, E edits, Esc returns to the date', () => {
    setup([EXAM, ENG, DS]);
    cell('2026-12-10').focus();
    key('Enter');
    expect(active().getAttribute('aria-label')).toBe(
      '2학기 기말고사, 시험, 12월 9일부터 12월 11일까지',
    );
    expect(active().classList.contains('bar')).toBe(true);
    expect($('.status').textContent).toContain('일정 1/3 · 2학기 기말고사');

    key('ArrowDown');
    expect(active().getAttribute('aria-label')).toBe('자료구조, 시험, 12월 10일 08:50');
    key('j');
    key('j'); // stops at the end
    expect(active().getAttribute('aria-label')).toBe('영어, 시험, 12월 10일 10:40');
    expect($('.status').textContent).toContain('일정 3/3 · 영어');

    key('e');
    const dialog = $<HTMLDialogElement>('dialog');
    expect(dialog.open).toBe(true);
    expect($<HTMLInputElement>('#ed-title').value).toBe('영어');
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(dialog.open).toBe(false);
    // Focus goes back to the event it came from.
    expect(active().getAttribute('aria-label')).toBe('영어, 시험, 12월 10일 10:40');

    key('Escape');
    expect(active().dataset.date).toBe('2026-12-10');
    expect($('.status').textContent).toContain('일정 3개');
  });

  test('Backspace in event mode opens the delete confirmation', () => {
    setup([DS]);
    cell('2026-12-10').focus();
    key('Enter');
    key('Backspace');
    expect($<HTMLDialogElement>('dialog').open).toBe(true);
    expect($('.danger-confirm')).toBeTruthy();
  });

  test('Enter on an empty day opens a new event for that date', () => {
    setup();
    cell('2026-12-10').focus();
    key('Enter');
    expect($<HTMLDialogElement>('dialog').open).toBe(true);
    expect($('#ed-h').textContent).toBe('새 일정');
    expect($<HTMLInputElement>('#ed-start').value).toBe('2026-12-10');
  });

  test('shortcuts stay off while typing', () => {
    setup();
    const quick = $<HTMLInputElement>('.quick-in');
    quick.focus();
    key('l', quick);
    key('n', quick);
    expect(location.hash).toBe('#/2026-12-10');
    expect($<HTMLDialogElement>('dialog').open).toBe(false);
  });

  test('opens a deep link and follows hash changes', () => {
    setup();
    history.replaceState(null, '', '#/2027-03-02');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect($('.num').textContent).toBe('3');
    expect(cell('2027-03-02').getAttribute('aria-selected')).toBe('true');
  });
});
