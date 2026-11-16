import { diffDays, parseIso, weekday, type IsoDate } from '../model/date';
import type { CalendarEvent } from '../model/event';
import { h, type Child } from './dom';
import { eventLabel, monthDayWeekday, spanDays } from './format';
import {
  dayEvents,
  isDayOff,
  isDue,
  marksOn,
  noticesOn,
  timedOn,
  timedRoom,
  type MonthLayout,
  type WeekLayout,
  type WeekStart,
} from './layout';

const WEEKDAYS = [
  ['SUN', 'S', '일요일'],
  ['MON', 'M', '월요일'],
  ['TUE', 'T', '화요일'],
  ['WED', 'W', '수요일'],
  ['THU', 'T', '목요일'],
  ['FRI', 'F', '금요일'],
  ['SAT', 'S', '토요일'],
] as const;

export interface MonthView {
  layout: MonthLayout;
  /** Visible events (grade and kind filters applied). */
  events: readonly CalendarEvent[];
  cursor: IsoDate;
  today: IsoDate;
  weekStart: WeekStart;
}

/** "[의무귀가]" is shown as "의무귀가" in its small outlined label. */
export function noticeText(title: string): string {
  return title.replace(/^\[(.+)\]$/, '$1');
}

function eventButton(
  e: CalendarEvent,
  className: string,
  children: Child[],
  style?: Record<string, string>,
) {
  return h(
    'button',
    {
      type: 'button',
      class: className,
      tabindex: -1,
      'data-id': e.id,
      'aria-label': eventLabel(e),
      style,
    },
    ...children,
  );
}

function barClass(e: CalendarEvent): string {
  if (e.category === 'holiday') return 'hol';
  if (e.category === 'exam') return 'exam';
  return isDue(e) ? 'due' : '';
}

function timedClass(e: CalendarEvent): string {
  if (e.category === 'exam') return 'exam';
  return isDue(e) ? 'due' : '';
}

function weekRow(view: MonthView, week: WeekLayout): HTMLElement {
  const { layout, events, cursor, today } = view;
  const row = h('div', {
    class: week.days.includes(cursor) ? 'week cur' : 'week',
    role: 'row',
    style: { '--lanes': String(week.lanes) },
  });
  row.appendChild(
    h(
      'div',
      { class: 'wkno', role: 'rowheader', 'aria-label': `${week.week}주차` },
      `W${week.week}`,
    ),
  );

  const room = timedRoom(week.lanes);
  week.days.forEach((date, i) => {
    const { day } = parseIso(date);
    const out = date < layout.first || date > layout.last;
    const marks = marksOn(events, date);
    const notices = noticesOn(events, date);
    const timed = timedOn(events, date);
    const all = dayEvents(events, week, date);
    const dayOff = isDayOff(events, date);

    const numClass = ['n'];
    if (weekday(date) === 0) numClass.push('sun');
    if (out) numClass.push('out');
    else if (marks.length) numClass.push('hol-day');
    else if (dayOff) numClass.push('hol');
    if (date === today) numClass.push('today');

    const labelParts = [monthDayWeekday(date)];
    if (date === today) labelParts.push('오늘');
    if (dayOff) labelParts.push('쉬는 날');
    labelParts.push(all.length ? `일정 ${all.length}개` : '일정 없음');

    const dots: Child[] = [
      ...notices.slice(0, 1).map(() => h('i', { class: 'ntd' })),
      ...timed.slice(0, 3).map((e) => h('i', { class: timedClass(e) })),
    ];

    const lanes = h('div', { class: 'lanes' });
    for (const s of week.segments.filter((seg) => seg.col === i)) {
      const days = spanDays(s.event);
      const showDays = days > 1 && !s.contL && s.span >= 2;
      const cls = ['bar', barClass(s.event), s.contL ? 'cont-l' : '', s.contR ? 'cont-r' : '']
        .filter(Boolean)
        .join(' ');
      lanes.appendChild(
        eventButton(
          s.event,
          cls,
          [
            h('span', { class: 'bt' }, s.event.title),
            showDays ? h('span', { class: 'sub' }, `${days}일`) : null,
          ],
          { '--span': String(s.span), '--lane': String(s.lane) },
        ),
      );
    }

    const shown = timed.slice(0, room);
    const evs = h(
      'div',
      { class: 'evs' },
      ...shown.map((e) =>
        eventButton(e, ['ev', timedClass(e)].filter(Boolean).join(' '), [
          h('time', {}, e.time ?? ''),
          h('span', {}, e.title),
        ]),
      ),
      timed.length > room ? h('div', { class: 'more' }, `+${timed.length - room}개 더`) : null,
    );

    const isCursor = date === cursor;
    row.appendChild(
      h(
        'div',
        {
          class: isCursor ? 'cell cursor' : 'cell',
          role: 'gridcell',
          tabindex: isCursor ? 0 : -1,
          'aria-selected': isCursor ? 'true' : 'false',
          'aria-label': labelParts.join(', '),
          'data-date': date,
          'data-fk': `cell:${date}`,
          style: { 'grid-column': String(i + 2) },
        },
        h(
          'div',
          { class: numClass.join(' ') },
          h('b', { 'aria-hidden': 'true' }, day),
          // Names of days off in the next or previous month stay in their own month.
          ...(out ? [] : marks.map((e) => eventButton(e, 'hname', [e.title]))),
          ...notices.map((e) => eventButton(e, 'nt', [noticeText(e.title)])),
          h('span', { class: 'dots', 'aria-hidden': 'true' }, ...dots),
        ),
        lanes,
        evs,
      ),
    );
  });
  return row;
}

export function renderGrid(view: MonthView): HTMLElement {
  const { layout, weekStart } = view;
  const order = Array.from({ length: 7 }, (_, i) => (i + weekStart) % 7);
  return h(
    'div',
    {
      class: 'grid',
      role: 'grid',
      'aria-label': `${layout.year}년 ${layout.month}월`,
      'aria-readonly': 'true',
    },
    h(
      'div',
      { class: 'weekdays', role: 'row' },
      h('span', { class: 'wk-h', role: 'columnheader', 'aria-label': '주차' }),
      ...order.map((d) => {
        const [long, short, ko] = WEEKDAYS[d]!;
        return h(
          'span',
          {
            class: d === 0 ? 'sun' : null,
            role: 'columnheader',
            'aria-label': ko,
            'data-s': short,
          },
          long,
        );
      }),
    ),
    h('div', { class: 'weeks', role: 'rowgroup' }, ...layout.weeks.map((w) => weekRow(view, w))),
  );
}

/** Day count of an event so far ("2일째") for the side panel. */
export function dayIndex(e: CalendarEvent, date: IsoDate): number {
  return diffDays(e.start, date) + 1;
}
