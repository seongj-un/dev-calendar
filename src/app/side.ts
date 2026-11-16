import { addDays, daysInMonth, parseIso, weekday, ymd, type IsoDate } from '../model/date';
import type { CalendarEvent } from '../model/event';
import { h, type Child } from './dom';
import { icon } from './icons';
import {
  dday,
  dotDate,
  dotRange,
  eventLabel,
  kindWord,
  MONTH_EN,
  monthDay,
  monthDayWeekday,
  spanDays,
  weekLabel,
} from './format';
import {
  isDayOff,
  isDue,
  KIND_KEY_LABELS,
  KIND_KEYS,
  kindKeyOf,
  shapeOf,
  type KindKey,
  type WeekStart,
} from './layout';
import { dayIndex, noticeText } from './month';

export interface SideView {
  cursor: IsoDate;
  today: IsoDate;
  weekStart: WeekStart;
  /** Events of the cursor date in event-mode order. */
  day: CalendarEvent[];
  upcoming: CalendarEvent[];
  /** Grade-filtered events touching the shown month, for the legend counts. */
  monthEvents: readonly CalendarEvent[];
  /** Grade-filtered events, to mark days off in the mini calendars. */
  allEvents: readonly CalendarEvent[];
  filter: KindKey | null;
}

const SWATCH: Record<KindKey, string> = {
  academic: 'academic',
  exam: 'exam',
  due: 'due',
  plain: 'plain',
  holiday: 'hol',
  notice: 'nt',
};

function miniCalendar(year: number, month: number, view: SideView): HTMLElement {
  const first = ymd(year, month, 1)!;
  const lead = (weekday(first) - view.weekStart + 7) % 7;
  const heads = view.weekStart === 1 ? 'MTWTFSS' : 'SMTWTFS';
  const cells: Child[] = [...heads].map((c, i) =>
    h('b', { class: (i + view.weekStart) % 7 === 0 ? 's' : null }, c),
  );
  for (let i = 0; i < lead; i++) cells.push(h('span'));
  for (let d = 1; d <= daysInMonth(year, month); d++) {
    const date = addDays(first, d - 1);
    const red = weekday(date) === 0 || isDayOff(view.allEvents, date);
    cells.push(h('span', { class: red ? 's' : null }, d));
  }
  return h(
    'div',
    { class: 'mini' },
    h('div', { class: 'mini-t' }, MONTH_EN[month - 1]!),
    h('div', { class: 'mini-g' }, ...cells),
  );
}

function swatchFor(e: CalendarEvent): string {
  const key = kindKeyOf(e);
  if (key === 'exam' && shapeOf(e) === 'bar') return 'exam-span';
  return SWATCH[key];
}

function agendaRow(e: CalendarEvent, date: IsoDate): HTMLElement {
  const total = spanDays(e);
  const meta: Child[] = [
    h(
      'span',
      { class: 'kind' },
      h('i', { class: `sw ${swatchFor(e)}`, 'aria-hidden': 'true' }),
      e.category === 'exam' && total > 1 ? '시험 기간' : kindWord(e),
    ),
  ];
  if (total > 1) meta.push(h('span', {}, `${dotRange(e)} · ${dayIndex(e, date)}일째`));
  if (!e.allDay && e.endTime) meta.push(h('span', {}, `${e.endTime}까지`));
  for (const tag of e.tags) meta.push(h('span', { class: 'tag' }, `#${tag}`));
  return h(
    'li',
    { class: isDue(e) || e.category === 'holiday' ? 'due' : null },
    h(
      'button',
      {
        type: 'button',
        class: 'row-btn',
        'data-id': e.id,
        'data-fk': `side:${e.id}`,
        'aria-label': eventLabel(e),
      },
      h('span', { class: 't' }, e.allDay || !e.time ? '종일' : e.time),
      h(
        'span',
        {},
        h('span', { class: 'w' }, e.notice ? noticeText(e.title) : e.title),
        h('span', { class: 'm' }, ...meta),
      ),
    ),
  );
}

export function renderSide(view: SideView, kbdN: () => HTMLElement): HTMLElement[] {
  const { year, month } = parseIso(view.cursor);
  const prev = month === 1 ? [year - 1, 12] : [year, month - 1];
  const next = month === 12 ? [year + 1, 1] : [year, month + 1];

  const minis = h(
    'div',
    { class: 'minis', 'aria-hidden': 'true' },
    miniCalendar(prev[0]!, prev[1]!, view),
    miniCalendar(next[0]!, next[1]!, view),
  );

  const day = h(
    'section',
    { class: 'day', 'aria-labelledby': 'day-title' },
    h(
      'div',
      { class: 'day-h' },
      h('h2', { id: 'day-title' }, monthDayWeekday(view.cursor)),
      h('span', { class: 'day-meta' }, weekLabel(view.cursor)),
    ),
    h(
      'ul',
      { class: 'agenda' },
      ...(view.day.length
        ? view.day.map((e) => agendaRow(e, view.cursor))
        : [
            h(
              'li',
              { class: 'empty' },
              '일정이 없습니다.',
              h('span', { class: 'desk-only' }, ' Enter로 추가할 수 있습니다.'),
            ),
          ]),
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-ghost add-row',
        'data-action': 'add',
        'data-fk': 'add-row',
      },
      h('span', {}, icon('plus'), '이 날짜에 일정 추가'),
      kbdN(),
    ),
  );

  const upcoming = h(
    'section',
    { class: 'block', 'aria-labelledby': 'up-title' },
    h(
      'div',
      { class: 'block-h' },
      h('h2', { id: 'up-title' }, '다가오는 시험·마감'),
      h('small', {}, `오늘 ${monthDay(view.today)} 기준`),
    ),
    view.upcoming.length
      ? h(
          'ul',
          { class: 'dl' },
          ...view.upcoming.map((e) =>
            h(
              'li',
              { class: isDue(e) ? 'due' : null },
              h(
                'button',
                {
                  type: 'button',
                  class: 'row-btn',
                  'data-id': e.id,
                  'data-fk': `up:${e.id}`,
                  'aria-label': `${eventLabel(e)}, ${e.start < view.today ? '진행 중' : dday(view.today, e.start)}`,
                },
                h('span', { class: 'd' }, dotDate(e.start)),
                h('span', { class: 'w' }, e.title),
                h(
                  'span',
                  { class: 'dd' },
                  e.start < view.today ? '진행 중' : dday(view.today, e.start),
                ),
              ),
            ),
          ),
        )
      : h('p', { class: 'dl-empty' }, '다가오는 시험과 마감이 없습니다.'),
  );

  const counts = new Map<KindKey, number>();
  for (const e of view.monthEvents) counts.set(kindKeyOf(e), (counts.get(kindKeyOf(e)) ?? 0) + 1);
  const legend = h(
    'section',
    { class: 'block tags-block', 'aria-labelledby': 'kind-title' },
    h(
      'div',
      { class: 'block-h' },
      h('h2', { id: 'kind-title' }, '종류'),
      view.filter
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn btn-text',
              'data-action': 'clear-filter',
              'data-fk': 'clear-filter',
            },
            '모두 보기',
          )
        : h('small', {}, '눌러서 걸러 보기'),
    ),
    h(
      'ul',
      { class: 'legend' },
      ...KIND_KEYS.map((key) =>
        h(
          'li',
          {},
          h(
            'button',
            {
              type: 'button',
              'data-filter': key,
              'data-fk': `legend:${key}`,
              'aria-pressed': view.filter === key ? 'true' : 'false',
            },
            h('i', { class: `sw ${SWATCH[key]}`, 'aria-hidden': 'true' }),
            key === 'exam'
              ? h('i', {
                  class: 'sw exam-span',
                  'aria-hidden': 'true',
                  style: { 'margin-left': '-4px' },
                })
              : null,
            KIND_KEY_LABELS[key],
            h('em', {}, counts.get(key) ?? 0),
          ),
        ),
      ),
    ),
  );

  return [minis, day, upcoming, legend];
}
