import { isoWeek, type IsoDate } from '../../model/date';
import { CATEGORY_LABELS, type CalendarEvent } from '../../model/event';
import { h, isMac, type Child } from '../dom';
import { monthDayWeekday } from '../format';
import { icon } from '../icons';
import type { LineParse } from '../lineParse';
import {
  COMMANDS,
  matchCommands,
  parseCommand,
  parsePaletteInput,
  sameSlot,
  searchEvents,
  type CommandSpec,
  type PaletteCommand,
} from './parse';

export type NewEventDraft = LineParse & { start: IsoDate; end: IsoDate };

/** What the palette needs from the app. Kept small so it can be tested alone. */
export interface PaletteHost {
  events(): readonly CalendarEvent[];
  cursor(): IsoDate;
  addEvent(draft: NewEventDraft): void;
  openEvent(event: CalendarEvent): void;
  run(command: PaletteCommand): void;
}

type Row =
  | { kind: 'new'; draft: NewEventDraft; clash: boolean }
  | { kind: 'event'; event: CalendarEvent }
  | { kind: 'command'; spec: CommandSpec; command: PaletteCommand | null };

type Entry = { section: string } | { row: Row };

/** The commands listed first when the input is empty. */
const COMMON = ['goto', 'import', 'export ics', 'theme dark', 'settings', 'help'];

function commonCommands(): CommandSpec[] {
  return COMMON.map((t) => COMMANDS.find((c) => c.text === t)).filter(
    (c): c is CommandSpec => c !== undefined,
  );
}

/** Rows for the current input. Pure apart from reading the lists it is given. */
export function buildEntries(
  input: string,
  events: readonly CalendarEvent[],
  base: IsoDate,
): Entry[] {
  const parsed = parsePaletteInput(input, base);
  const out: Entry[] = [];
  if (parsed.kind === 'empty') {
    const recent = [...events].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4);
    if (recent.length) {
      out.push({ section: '최근 일정' });
      for (const event of recent) out.push({ row: { kind: 'event', event } });
    }
    out.push({ section: '명령' });
    for (const spec of commonCommands()) {
      out.push({ row: { kind: 'command', spec, command: parseCommand(spec.text) } });
    }
    return out;
  }
  if (parsed.kind === 'command') {
    const body = input.trim().slice(1);
    out.push({ section: '명령' });
    if (parsed.command) {
      const spec = parsed.matches[0];
      if (spec) out.push({ row: { kind: 'command', spec, command: parsed.command } });
      for (const m of parsed.matches.slice(1)) {
        out.push({ row: { kind: 'command', spec: m, command: parseCommand(m.text) } });
      }
    } else {
      for (const spec of matchCommands(body)) {
        out.push({ row: { kind: 'command', spec, command: parseCommand(spec.text) } });
      }
    }
    return out;
  }
  if (parsed.event) {
    const clash =
      sameSlot(events, { start: parsed.event.start, time: parsed.event.time }).length > 0;
    out.push({ section: '새 일정' });
    out.push({ row: { kind: 'new', draft: parsed.event, clash } });
  }
  const found = searchEvents(events, parsed.query);
  if (found.length) {
    out.push({ section: '일정' });
    for (const event of found) out.push({ row: { kind: 'event', event } });
  }
  return out;
}

function isRow(entry: Entry): entry is { row: Row } {
  return 'row' in entry;
}

function describeEvent(e: CalendarEvent): string {
  const when =
    e.end > e.start
      ? `${monthDayWeekday(e.start)} - ${monthDayWeekday(e.end)}`
      : monthDayWeekday(e.start);
  return e.time ? `${when} ${e.time}` : when;
}

function describeDraft(d: NewEventDraft): Child[] {
  const parts: string[] = [
    d.end > d.start
      ? `${monthDayWeekday(d.start)} - ${monthDayWeekday(d.end)}`
      : monthDayWeekday(d.start),
  ];
  if (d.time) parts.push(d.endTime ? `${d.time}-${d.endTime}` : d.time);
  if (d.category) parts.push(CATEGORY_LABELS[d.category]);
  for (const t of d.tags) parts.push(`#${t}`);
  parts.push(`${isoWeek(d.start).week}주차`);
  return parts.map((p) => h('span', { class: 'tok' }, p));
}

/** The command palette: one input, a listbox of rows, run with Enter. */
export class Palette {
  readonly element: HTMLDialogElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLElement;
  private readonly status: HTMLElement;
  private entries: Entry[] = [];
  private rows: Row[] = [];
  private active = 0;
  private returnTo: HTMLElement | null = null;

  constructor(private readonly host: PaletteHost) {
    this.input = h('input', {
      class: 'p-input',
      type: 'text',
      role: 'combobox',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      enterkeyhint: 'go',
      'aria-label': '명령 팔레트',
      'aria-expanded': 'true',
      'aria-controls': 'p-list',
      'aria-autocomplete': 'list',
      placeholder: '일정 입력, 검색, 또는 > 로 명령',
    });
    this.list = h('div', { class: 'p-list', id: 'p-list', role: 'listbox', 'aria-label': '결과' });
    this.status = h('div', { class: 'sr-only', 'aria-live': 'polite' });
    const closeBtn = h(
      'button',
      { type: 'button', class: 'icon-btn p-close', 'aria-label': '팔레트 닫기' },
      icon('x'),
    );
    closeBtn.addEventListener('click', () => this.close());
    this.element = h(
      'dialog',
      { class: 'palette', 'aria-label': '명령 팔레트' },
      h('div', { class: 'p-in' }, icon('search'), this.input, closeBtn),
      this.list,
      this.status,
      h(
        'div',
        { class: 'p-foot', 'aria-hidden': 'true' },
        h('span', {}, h('kbd', {}, '↑'), h('kbd', {}, '↓'), '이동'),
        h('span', {}, h('kbd', {}, '↵'), '실행'),
        h('span', {}, h('kbd', {}, '>'), '명령'),
        h('span', {}, h('kbd', {}, '#'), '태그'),
        h('span', { class: 'p-foot-r' }, h('kbd', {}, 'Esc'), '닫기'),
      ),
    );
    this.input.addEventListener('input', () => {
      this.active = 0;
      this.refresh();
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.list.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-row]');
      if (!el) return;
      this.active = Number(el.dataset.row);
      this.activate();
    });
    // Esc closes a modal dialog natively; clicking the backdrop lands on the dialog itself.
    this.element.addEventListener('click', (e) => {
      if (e.target === this.element) this.close();
    });
    this.element.addEventListener('close', () => this.restoreFocus());
  }

  get isOpen(): boolean {
    return this.element.open;
  }

  open(prefill = ''): void {
    if (this.element.open) {
      this.input.value = prefill;
      this.active = 0;
      this.refresh();
      this.input.focus();
      return;
    }
    this.returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.input.value = prefill;
    this.active = 0;
    this.refresh();
    this.element.showModal();
    this.input.focus();
    this.input.setSelectionRange(prefill.length, prefill.length);
  }

  close(): void {
    if (this.element.open) this.element.close();
    this.restoreFocus();
  }

  private restoreFocus(): void {
    const el = this.returnTo;
    this.returnTo = null;
    if (el?.isConnected) el.focus();
  }

  private refresh(): void {
    this.entries = buildEntries(this.input.value, this.host.events(), this.host.cursor());
    this.rows = this.entries.filter(isRow).map((e) => e.row);
    if (this.active >= this.rows.length) this.active = Math.max(0, this.rows.length - 1);
    let index = 0;
    const nodes: Child[] = [];
    for (const entry of this.entries) {
      if (!isRow(entry)) {
        nodes.push(h('div', { class: 'p-sec', role: 'presentation' }, entry.section));
        continue;
      }
      nodes.push(this.renderRow(entry.row, index));
      index++;
    }
    if (!this.rows.length) {
      nodes.push(
        h(
          'p',
          { class: 'p-empty' },
          '맞는 결과가 없습니다. 제목과 날짜를 적으면 새 일정으로 추가합니다.',
        ),
      );
    }
    this.list.replaceChildren(...(nodes.filter((n) => n) as Node[]));
    this.syncActive();
    this.status.textContent = this.rows.length ? `결과 ${this.rows.length}개` : '결과 없음';
  }

  private renderRow(row: Row, index: number): HTMLElement {
    const common = { role: 'option', id: `p-opt-${index}`, 'data-row': index, class: 'opt' };
    if (row.kind === 'new') {
      return h(
        'div',
        common,
        h('span', { class: 'oi' }, icon('plus')),
        h(
          'div',
          { class: 'ob' },
          h('div', { class: 'ot' }, row.draft.title),
          h('div', { class: 'od' }, ...describeDraft(row.draft)),
        ),
        row.clash
          ? h('span', { class: 'hint' }, '같은 시간 일정 있음')
          : h('span', { class: 'hint' }, h('kbd', {}, '↵')),
      );
    }
    if (row.kind === 'event') {
      return h(
        'div',
        common,
        h('span', { class: 'oi' }, icon('file')),
        h(
          'div',
          { class: 'ob' },
          h('div', { class: 'ot' }, row.event.title),
          h('div', { class: 'od' }, describeEvent(row.event)),
        ),
        h('span', { class: 'hint' }, '이동'),
      );
    }
    const label =
      row.command?.type === 'goto'
        ? `${row.spec.description}: ${row.command.date}`
        : row.spec.description;
    return h(
      'div',
      common,
      h('span', { class: 'oi' }, '>'),
      h(
        'div',
        { class: 'ob' },
        h('div', { class: 'ot' }, label),
        h('div', { class: 'od' }, h('code', {}, `>${row.spec.hint ?? row.spec.text}`)),
      ),
      row.command
        ? h('span', { class: 'hint' }, h('kbd', {}, '↵'))
        : h('span', { class: 'hint' }, '이어서 입력'),
    );
  }

  private syncActive(): void {
    this.list.querySelectorAll<HTMLElement>('[role="option"]').forEach((el) => {
      const on = Number(el.dataset.row) === this.active;
      el.classList.toggle('on', on);
      el.setAttribute('aria-selected', String(on));
      if (on) {
        this.input.setAttribute('aria-activedescendant', el.id);
        el.scrollIntoView?.({ block: 'nearest' });
      }
    });
    if (!this.rows.length) this.input.removeAttribute('aria-activedescendant');
  }

  private onKey(e: KeyboardEvent): void {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this.rows.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      this.active = (this.active + step + this.rows.length) % this.rows.length;
      this.syncActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.activate();
    }
  }

  private activate(): void {
    const row = this.rows[this.active];
    if (!row) return;
    if (row.kind === 'command' && !row.command) {
      // Needs an argument: fill in the verb and let the person finish it.
      this.input.value = `>${row.spec.text.split(' ')[0] ?? ''} `;
      this.active = 0;
      this.refresh();
      this.input.focus();
      return;
    }
    // Close first so focus goes back before the action moves it somewhere else.
    this.close();
    if (row.kind === 'new') this.host.addEvent(row.draft);
    else if (row.kind === 'event') this.host.openEvent(row.event);
    else if (row.command) this.host.run(row.command);
  }
}

/** Cmd on a Mac, Ctrl elsewhere; for labels. */
export function modLabel(): string {
  return isMac() ? '⌘' : 'Ctrl';
}
