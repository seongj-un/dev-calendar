import { weekday, type IsoDate } from '../model/date';
import type { CalendarEvent } from '../model/event';
import { h, type Child } from './dom';
import { WEEKDAY_KO, weekLabel, zoneLabel } from './format';
import { isDue, KIND_KEY_LABELS, type KindKey } from './layout';

export interface StatusView {
  cursor: IsoDate;
  day: CalendarEvent[];
  /** Selected event in event mode. */
  selected: CalendarEvent | null;
  filter: KindKey | null;
  now: Date;
  timeZone?: string;
}

const sep = () => h('i', { class: 'sep', 'aria-hidden': 'true' });
const key = (k: string) => h('kbd', {}, k);

/** Visual status bar. Screen readers get the same news from the live region. */
export function renderStatus(view: StatusView): Child[] {
  const { cursor, day, selected } = view;
  if (selected) {
    const index = day.findIndex((e) => e.id === selected.id) + 1;
    return [
      h('span', { class: 'mono' }, cursor),
      sep(),
      h('span', { class: 'st-ev' }, `일정 ${index}/${day.length} · ${selected.title}`),
      h(
        'span',
        { class: 'r' },
        h('span', {}, key('↑'), key('↓'), '고르기'),
        h('span', {}, key('E'), '편집'),
        h('span', {}, key('⌫'), '삭제'),
        h('span', {}, key('Esc'), '날짜로'),
      ),
    ];
  }
  const due = day.filter(isDue).length;
  return [
    h('span', { class: 'mono' }, cursor),
    h('span', {}, `${WEEKDAY_KO[weekday(cursor)]}요일`),
    sep(),
    h('span', { class: 'mono' }, weekLabel(cursor)),
    sep(),
    h('span', {}, `일정 ${day.length}개`),
    due ? h('span', { class: 'due' }, `마감 ${due}개`) : null,
    view.filter
      ? h('span', { class: 'filter' }, `${KIND_KEY_LABELS[view.filter]}만 보는 중`)
      : null,
    h(
      'span',
      { class: 'r' },
      h('span', { class: 'mono' }, `#/${cursor}`),
      sep(),
      h('span', {}, zoneLabel(view.now, view.timeZone)),
    ),
  ];
}

/** What the live region reads when event mode moves. */
export function eventModeAnnouncement(day: CalendarEvent[], selected: CalendarEvent): string {
  const index = day.findIndex((e) => e.id === selected.id) + 1;
  return `일정 ${index}/${day.length}. 위아래 화살표로 고르고, E로 편집, Delete로 삭제, Esc로 날짜로 돌아갑니다.`;
}
