import { addDays, isIsoDate, localIsoDate, parseIso, ymd, type IsoDate } from '../model/date';
import type { CalendarEvent } from '../model/event';
import { EventStore, StoreWriteError, type StorageLike } from '../store/store';
import { exportEvents, importBackupFile } from './export/actions';
import { HelpSheet } from './palette/help';
import { Palette, type NewEventDraft } from './palette/palette';
import type { PaletteCommand } from './palette/parse';
import { append, cssEscape, h, isMac, isShown, isTypingTarget } from './dom';
import { openEditor, type EditorOptions, type EventForm } from './editor';
import { MONTH_EN, monthDayWeekday } from './format';
import { icon } from './icons';
import {
  dayEvents,
  monthLayout,
  shiftMonth,
  upcoming,
  visibleEvents,
  weekOf,
  type KindKey,
} from './layout';
import { openImportDialog, type ImportDone, type ImportTab } from './import-ui/importDialog';
import { shortcutKey } from './keys';
import { parseLine } from './lineParse';
import { renderGrid } from './month';
import { effectiveTheme, loadPrefs, savePrefs, type Prefs } from './prefs';
import { openSettingsDialog } from './settings/settingsDialog';
import { loadNeisKey, loadSchool, saveNeisKey, saveSchool } from './settings/neisPrefs';
import { renderSide } from './side';
import { eventModeAnnouncement, renderStatus } from './status';
import { Toaster } from './toast';

export interface AppDeps {
  root: HTMLElement;
  store: EventStore;
  prefsStorage: StorageLike;
  now?: () => Date;
  /** The data could not be saved in this browser (storage blocked). */
  memoryOnly?: boolean;
}

const HASH = /^#\/(\d{4}-\d{2}-\d{2}|\d{4}-\d{2})$/;

/** Date from a "#/2026-12-10" or "#/2026-12" link, or null. */
export function dateFromHash(hash: string): IsoDate | null {
  const m = HASH.exec(hash);
  if (!m?.[1]) return null;
  const value = m[1].length === 7 ? `${m[1]}-01` : m[1];
  return isIsoDate(value) ? value : null;
}

function sourceOf(e: CalendarEvent, store: EventStore): EditorOptions['source'] {
  if (!e.source || e.source === 'manual') return null;
  const batch = e.batchId ? store.batches().find((b) => b.id === e.batchId) : undefined;
  if (e.source.startsWith('neis:')) return { kind: 'neis', label: batch?.label ?? '나이스' };
  const label = batch?.label ?? e.source.replace(/^file:/, '');
  return { kind: 'file', label };
}

export class App {
  private readonly store: EventStore;
  private readonly now: () => Date;
  private prefs: Prefs;
  private cursor: IsoDate;
  private today: IsoDate;
  /** Selected event in event mode; null in date mode. */
  private evId: string | null = null;
  private filter: KindKey | null = null;
  private editorOpen = false;
  private readonly abort = new AbortController();
  private readonly timer: ReturnType<typeof setInterval>;

  private readonly main: HTMLElement;
  private readonly side: HTMLElement;
  private readonly status: HTMLElement;
  private readonly live: HTMLElement;
  private readonly dialog: HTMLDialogElement;
  private readonly toaster: Toaster;
  private readonly palette: Palette;
  private readonly help = new HelpSheet();
  private readonly themeBtn: HTMLButtonElement;
  private readonly quickInput: HTMLInputElement;
  private readonly media = window.matchMedia('(prefers-color-scheme: dark)');

  constructor(private readonly deps: AppDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
    this.prefs = loadPrefs(deps.prefsStorage);
    this.today = localIsoDate(this.now());
    this.cursor = dateFromHash(location.hash) ?? this.today;

    this.themeBtn = h(
      'button',
      { type: 'button', class: 'icon-btn', 'data-action': 'theme' },
      icon('moon', 'ic ic-moon'),
      icon('sun', 'ic ic-sun'),
    );
    const top = h(
      'header',
      { class: 'top' },
      h('a', { class: 'brand', href: '#/', 'aria-label': 'datebook, 오늘로 가기' }, 'datebook'),
      h(
        'div',
        { class: 'top-r' },
        h(
          'button',
          {
            type: 'button',
            class: 'icon-btn top-search',
            'data-action': 'palette',
            'aria-label': '검색과 명령 열기',
            'aria-keyshortcuts': 'Control+K Meta+K',
          },
          icon('search'),
          h('kbd', { 'aria-hidden': 'true' }, isMac() ? '⌘K' : 'Ctrl K'),
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'icon-btn',
            'data-action': 'import',
            'aria-label': '학사일정 가져오기 (I)',
            'aria-keyshortcuts': 'I',
          },
          icon('import'),
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'icon-btn',
            'data-action': 'settings',
            'aria-label': '설정 (,)',
            'aria-keyshortcuts': ',',
          },
          icon('sliders'),
        ),
        this.themeBtn,
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-primary',
            'data-action': 'add',
            'aria-keyshortcuts': 'N',
          },
          icon('plus'),
          '새 일정',
          h('kbd', { class: 'kbd-inv', 'aria-hidden': 'true' }, 'N'),
        ),
      ),
    );
    this.main = h('main', { class: 'main', id: 'main' });
    this.side = h('aside', { class: 'side', 'aria-label': '선택한 날짜와 다가오는 일정' });
    this.status = h('footer', { class: 'status' });
    this.live = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
    this.quickInput = h('input', {
      class: 'quick-in',
      type: 'text',
      enterkeyhint: 'done',
      autocomplete: 'off',
      placeholder: '빠른 추가  배포 12/22 14:00 #release',
      'aria-label': '빠른 추가',
    });
    const quick = h(
      'form',
      { class: 'quick', 'aria-label': '빠른 추가' },
      this.quickInput,
      h('button', { type: 'submit', class: 'quick-btn', 'aria-label': '일정 추가' }, icon('plus')),
    );
    this.dialog = h('dialog', { class: 'dialog' });
    this.palette = new Palette({
      events: () => this.store.list(),
      cursor: () => this.cursor,
      addEvent: (draft) => this.addDraft(draft),
      openEvent: (event) =>
        this.moveTo(
          event.start > this.cursor || event.end < this.cursor ? event.start : this.cursor,
          { focus: true },
        ),
      run: (command) => this.runCommand(command),
    });
    const toasts = h('div', { class: 'toasts', 'aria-live': 'polite' });
    this.toaster = new Toaster(toasts);

    deps.root.replaceChildren(
      h(
        'div',
        { class: 'app' },
        top,
        h('div', { class: 'body' }, this.main, this.side),
        this.status,
        quick,
      ),
      this.live,
      toasts,
      this.dialog,
      this.palette.element,
      this.help.element,
    );

    quick.addEventListener('submit', (e) => {
      e.preventDefault();
      this.quickAdd();
    });
    deps.root.addEventListener('click', (e) => this.onClick(e));
    const signal = this.abort.signal;
    document.addEventListener('keydown', (e) => this.onKey(e), { signal });
    // Event mode ends when focus goes anywhere but the selected day's events.
    // Only the status bar changes, so the element being clicked is not replaced.
    document.addEventListener(
      'focusin',
      (e) => {
        const to = e.target as Node;
        if (!this.evId || this.editorOpen || this.dialog.contains(to)) return;
        const agenda = this.side.querySelector('.agenda');
        if (this.main.contains(to) && !(to as HTMLElement).classList.contains('cell')) return;
        if (agenda?.contains(to)) return;
        this.evId = null;
        this.renderStatus([]);
      },
      { signal },
    );
    window.addEventListener(
      'hashchange',
      () => {
        const date = dateFromHash(location.hash) ?? (location.hash === '#/' ? this.today : null);
        if (date && date !== this.cursor) this.moveTo(date, { announce: true });
        else if (location.hash === '#/') this.writeHash();
      },
      { signal },
    );
    this.media.addEventListener('change', () => this.applyTheme(), { signal });
    // Pick up a new day after midnight or when the tab comes back.
    const tick = () => {
      const today = localIsoDate(this.now());
      if (today !== this.today) {
        this.today = today;
        this.render();
      }
    };
    this.timer = setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick, { signal });
    const unsubscribe = this.store.subscribe(() => this.render());
    // Another tab's change shows up here without waiting for a write in this tab.
    const stopWatching = this.store.watchStorage(window);
    signal.addEventListener('abort', () => {
      unsubscribe();
      stopWatching();
      clearInterval(this.timer);
      this.toaster.dismiss();
    });

    this.applyTheme();
    this.writeHash();
    this.render();

    if (this.store.loadIssue === 'corrupt') {
      this.toaster.show({
        message:
          '저장된 일정을 읽지 못해 빈 달력으로 시작했습니다. 원래 데이터는 브라우저에 따로 남겨 두었습니다.',
        duration: 12_000,
      });
    } else if (deps.memoryOnly) {
      this.toaster.show({
        message: '이 브라우저에서는 일정을 저장할 수 없습니다. 창을 닫으면 사라집니다.',
        duration: 12_000,
      });
    }
  }

  /** Removes global listeners and timers (tests mount several apps). */
  destroy(): void {
    this.abort.abort();
  }

  // ---------- state helpers ----------

  private visible(): CalendarEvent[] {
    return visibleEvents(this.store.list(), { grade: this.prefs.grade, kind: this.filter });
  }

  private layoutNow() {
    const { year, month } = parseIso(this.cursor);
    const events = this.visible();
    const layout = monthLayout(year, month, events, this.prefs.weekStart);
    const first = layout.weeks[0]!.days[0]!;
    const last = layout.weeks.at(-1)!.days[6]!;
    const inGrid = events.filter((e) => e.start <= last && e.end >= first);
    return { layout, events: inGrid, all: events };
  }

  private dayList(): CalendarEvent[] {
    const { layout, events } = this.layoutNow();
    return dayEvents(events, weekOf(layout, this.cursor), this.cursor);
  }

  private say(message: string): void {
    // Clear first so the same sentence is read again.
    this.live.textContent = '';
    window.setTimeout(() => {
      this.live.textContent = message;
    }, 30);
  }

  private writeHash(): void {
    const hash = `#/${this.cursor}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  private applyTheme(): void {
    const theme = effectiveTheme(this.prefs.theme, this.media.matches);
    document.documentElement.dataset.theme = theme;
    this.themeBtn.setAttribute(
      'aria-label',
      theme === 'dark' ? '라이트 테마로 바꾸기 (D)' : '다크 테마로 바꾸기 (D)',
    );
  }

  private toggleTheme(): void {
    const theme = effectiveTheme(this.prefs.theme, this.media.matches);
    this.prefs = { ...this.prefs, theme: theme === 'dark' ? 'light' : 'dark' };
    savePrefs(this.deps.prefsStorage, this.prefs);
    this.applyTheme();
    this.say(theme === 'dark' ? '라이트 테마' : '다크 테마');
  }

  // ---------- render ----------

  render(): void {
    const active = document.activeElement as HTMLElement | null;
    const focusKey = active?.dataset.fk ?? null;
    const focusId = active?.closest('#main') ? (active.dataset.id ?? null) : null;
    const hadFocus = Boolean(active && this.deps.root.contains(active) && active !== document.body);

    const { layout, events, all } = this.layoutNow();
    const { year, month } = parseIso(this.cursor);
    const day = dayEvents(events, weekOf(layout, this.cursor), this.cursor);
    if (this.evId && !day.some((e) => e.id === this.evId)) this.evId = null;
    const selected = this.evId ? (day.find((e) => e.id === this.evId) ?? null) : null;

    document.title = `${MONTH_EN[month - 1]} ${year} · datebook`;
    const kbdKey = (k: string) => h('kbd', { 'aria-hidden': 'true' }, k);
    this.main.replaceChildren(
      h(
        'div',
        { class: 'head' },
        h(
          'div',
          { class: 'head-l' },
          h('div', { class: 'num', 'aria-hidden': 'true' }, month),
          h(
            'div',
            { class: 'title' },
            h('h1', { 'aria-label': `${year}년 ${month}월` }, MONTH_EN[month - 1]!),
            h('span', { class: 'yr', 'aria-hidden': 'true' }, year),
          ),
        ),
        h(
          'div',
          { class: 'nav' },
          h(
            'button',
            {
              type: 'button',
              class: 'icon-btn',
              'data-action': 'prev',
              'data-fk': 'nav:prev',
              'aria-label': '이전 달 ([)',
            },
            icon('prev'),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-ghost',
              'data-action': 'today',
              'data-fk': 'nav:today',
            },
            '오늘',
            kbdKey('T'),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'icon-btn',
              'data-action': 'next',
              'data-fk': 'nav:next',
              'aria-label': '다음 달 (])',
            },
            icon('next'),
          ),
        ),
      ),
      renderGrid({
        layout,
        events,
        cursor: this.cursor,
        today: this.today,
        weekStart: this.prefs.weekStart,
      }),
    );

    const graded = visibleEvents(this.store.list(), { grade: this.prefs.grade, kind: null });
    this.side.replaceChildren(
      ...renderSide(
        {
          cursor: this.cursor,
          today: this.today,
          weekStart: this.prefs.weekStart,
          day,
          upcoming: upcoming(all, this.today),
          monthEvents: graded.filter((e) => e.start <= layout.last && e.end >= layout.first),
          allEvents: graded,
          filter: this.filter,
        },
        () => kbdKey('N'),
      ),
    );
    this.renderStatus(day, selected);

    // Re-rendering replaced the focused element: put focus back on its twin.
    if (hadFocus && !this.deps.root.contains(active)) {
      if (selected) this.focusEvent(selected.id);
      else if (focusId || focusKey?.startsWith('cell:')) this.focusCell();
      else if (focusKey) {
        this.deps.root.querySelector<HTMLElement>(`[data-fk="${cssEscape(focusKey)}"]`)?.focus();
      }
    }
  }

  private renderStatus(day: CalendarEvent[] | null, selected: CalendarEvent | null = null): void {
    this.status.replaceChildren();
    append(
      this.status,
      renderStatus({
        cursor: this.cursor,
        day: day && day.length ? day : this.dayList(),
        selected,
        filter: this.filter,
        now: this.now(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    );
  }

  // ---------- focus ----------

  private cellEl(): HTMLElement | null {
    return this.main.querySelector<HTMLElement>(`.cell[data-date="${this.cursor}"]`);
  }

  private focusCell(): void {
    this.cellEl()?.focus();
  }

  /** Focuses the event in the cursor's week, or its side panel row when the grid hides it. */
  private focusEvent(id: string): void {
    const week = this.main.querySelector('.week.cur');
    const sel = `[data-id="${cssEscape(id)}"]`;
    const inGrid = week?.querySelector<HTMLElement>(sel);
    if (isShown(inGrid)) {
      inGrid.focus();
      return;
    }
    this.side.querySelector<HTMLElement>(`.agenda ${sel}`)?.focus();
  }

  private gridHasFocus(): boolean {
    return this.main.querySelector('.grid')?.contains(document.activeElement) ?? false;
  }

  // ---------- navigation ----------

  private moveTo(date: IsoDate, opts: { focus?: boolean; announce?: boolean } = {}): void {
    if (!ymd(parseIso(date).year, 1, 1)) return;
    this.cursor = date;
    this.evId = null;
    this.writeHash();
    this.render();
    if (opts.focus) this.focusCell();
    else if (opts.announce) {
      const n = this.dayList().length;
      this.say(`${monthDayWeekday(date)}, ${n ? `일정 ${n}개` : '일정 없음'}`);
    }
  }

  private moveBy(days: number): void {
    const focus = this.gridHasFocus();
    this.moveTo(addDays(this.cursor, days), { focus, announce: !focus });
  }

  private moveMonth(delta: number): void {
    const focus = this.gridHasFocus();
    this.moveTo(shiftMonth(this.cursor, delta), { focus, announce: !focus });
  }

  // ---------- event mode ----------

  private enterEventMode(): void {
    const list = this.dayList();
    if (!list.length) {
      this.openAdd();
      return;
    }
    this.selectEvent(list[0]!.id, list);
  }

  private selectEvent(id: string, list = this.dayList()): void {
    this.evId = id;
    this.render();
    this.focusEvent(id);
    const selected = list.find((e) => e.id === id);
    if (selected) this.say(eventModeAnnouncement(list, selected));
  }

  private stepEvent(delta: number): void {
    const list = this.dayList();
    const index = list.findIndex((e) => e.id === this.evId);
    const next = list[Math.min(list.length - 1, Math.max(0, index + delta))];
    if (next && next.id !== this.evId) this.selectEvent(next.id, list);
  }

  private leaveEventMode(focusCell: boolean): void {
    this.evId = null;
    this.render();
    if (focusCell) this.focusCell();
  }

  // ---------- keyboard ----------

  private onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented) return;
    const pressed = shortcutKey(e);
    if (pressed === null) return;
    const typing = isTypingTarget(e.target);
    const mod = e.metaKey || e.ctrlKey;
    // Cmd/Ctrl+K works from anywhere, even inside a field, except over the editor.
    if (mod && !e.altKey && !e.shiftKey && pressed.toLowerCase() === 'k') {
      if (this.editorOpen || this.help.isOpen) return;
      e.preventDefault();
      if (this.palette.isOpen) this.palette.close();
      else this.openPalette();
      return;
    }
    if (this.editorOpen || this.palette.isOpen || this.help.isOpen) return;
    if (mod && !e.altKey && !e.shiftKey && pressed.toLowerCase() === 'z') {
      if (!typing && this.toaster.runUndo()) e.preventDefault();
      return;
    }
    if (typing || mod || e.altKey) return;

    if (this.evId) {
      this.onEventModeKey(e, pressed);
      return;
    }
    const target = e.target as HTMLElement;
    const onCalendar = target === document.body || target.classList.contains('cell');
    const key = pressed;
    const handled = (() => {
      switch (key) {
        case 'h':
        case 'H':
          this.moveBy(-1);
          return true;
        case 'l':
        case 'L':
          this.moveBy(1);
          return true;
        case 'k':
        case 'K':
          this.moveBy(-7);
          return true;
        case 'j':
        case 'J':
          this.moveBy(7);
          return true;
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown':
          if (!onCalendar) return false;
          this.moveBy({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[key]);
          return true;
        case '[':
          this.moveMonth(-1);
          return true;
        case ']':
          this.moveMonth(1);
          return true;
        case 't':
        case 'T':
          this.moveTo(this.today, { focus: this.gridHasFocus(), announce: !this.gridHasFocus() });
          return true;
        case 'n':
        case 'N':
          this.openAdd();
          return true;
        case 'Enter':
          if (!onCalendar) return false;
          this.enterEventMode();
          return true;
        case 'd':
        case 'D':
          this.toggleTheme();
          return true;
        case 'i':
        case 'I':
          this.openImport();
          return true;
        case ',':
          this.openSettings();
          return true;
        case 'y':
        case 'Y':
          void this.copyLink();
          return true;
        case '/':
          this.openPalette();
          return true;
        case '?':
          this.help.open();
          return true;
        case 'g':
        case 'G':
          this.openPalette('>goto ');
          return true;
        case 'Escape':
          if (!this.filter) return false;
          this.setFilter(null);
          return true;
        default:
          return false;
      }
    })();
    if (handled) e.preventDefault();
  }

  private onEventModeKey(e: KeyboardEvent, key: string): void {
    const handled = (() => {
      switch (key) {
        case 'ArrowUp':
        case 'k':
        case 'K':
          this.stepEvent(-1);
          return true;
        case 'ArrowDown':
        case 'j':
        case 'J':
          this.stepEvent(1);
          return true;
        case 'e':
        case 'E':
        case 'Enter':
          this.openEdit(this.evId!, false);
          return true;
        case 'Backspace':
        case 'Delete':
          this.openEdit(this.evId!, true);
          return true;
        case 'Escape':
          this.leaveEventMode(true);
          return true;
        default:
          return false;
      }
    })();
    if (handled) e.preventDefault();
  }

  // ---------- mouse ----------

  private onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action) {
      if (action === 'add') this.openAdd();
      else if (action === 'theme') this.toggleTheme();
      else if (action === 'palette') this.openPalette();
      else if (action === 'import') this.openImport();
      else if (action === 'settings') this.openSettings();
      else if (action === 'prev') this.moveMonth(-1);
      else if (action === 'next') this.moveMonth(1);
      else if (action === 'today') this.moveTo(this.today, { announce: true });
      else if (action === 'clear-filter') this.setFilter(null);
      return;
    }
    const filter = target.closest<HTMLElement>('[data-filter]')?.dataset.filter as
      KindKey | undefined;
    if (filter) {
      this.setFilter(this.filter === filter ? null : filter);
      return;
    }
    const brand = target.closest('.brand');
    if (brand) {
      e.preventDefault();
      this.moveTo(this.today, { announce: true });
      return;
    }
    const evEl = target.closest<HTMLElement>('[data-id]');
    if (evEl?.dataset.id) {
      const cell = evEl.closest<HTMLElement>('.cell');
      if (cell?.dataset.date && this.main.contains(cell)) {
        // Keep the clicked day selected so focus can come back to this event.
        const date = cell.dataset.date;
        const ev = this.store.get(evEl.dataset.id);
        this.cursor = ev && date < ev.start ? ev.start : date;
        if (ev && this.cursor > ev.end) this.cursor = ev.end;
        this.writeHash();
        this.evId = evEl.dataset.id;
        this.render();
      }
      this.openEdit(evEl.dataset.id, false);
      return;
    }
    const cell = target.closest<HTMLElement>('.cell');
    if (cell?.dataset.date) {
      this.moveTo(cell.dataset.date as IsoDate, { focus: true });
    }
  }

  private setFilter(filter: KindKey | null): void {
    this.filter = filter;
    this.evId = null;
    this.render();
    this.say(filter ? '걸러 보는 중입니다. 다시 누르면 모두 봅니다.' : '모든 일정을 봅니다.');
  }

  // ---------- editor ----------

  private afterEditor(returnTo: () => void): (result: string) => void {
    return () => {
      this.editorOpen = false;
      // The store change already re-rendered; put focus where the person was.
      returnTo();
    };
  }

  private openAdd(prefill?: Partial<EventForm>): void {
    const returnEl = document.activeElement as HTMLElement | null;
    const returnKey = returnEl?.dataset.fk ?? null;
    const fromQuick = returnEl === this.quickInput;
    this.editorOpen = true;
    openEditor(this.dialog, {
      mode: 'add',
      date: this.cursor,
      prefill,
      onSave: (form) => {
        const added = this.store.add(form);
        if (added.start > this.cursor || added.end < this.cursor) {
          this.cursor = added.start;
          this.writeHash();
          this.render();
        }
        this.toaster.show({
          message: `일정을 추가했습니다: ${added.title}`,
          undo: () => this.undoAdd(added.id),
        });
      },
      onClose: this.afterEditor(() => {
        if (fromQuick) this.quickInput.focus();
        else if (returnKey?.startsWith('cell:') || !returnKey) this.focusCell();
        else
          this.deps.root.querySelector<HTMLElement>(`[data-fk="${cssEscape(returnKey)}"]`)?.focus();
      }),
    });
  }

  private openEdit(id: string, confirmDelete: boolean): void {
    const event = this.store.get(id);
    if (!event) return;
    const returnEl = document.activeElement as HTMLElement | null;
    const returnKey = returnEl?.dataset.fk ?? null;
    const fromGrid = Boolean(returnEl && this.main.contains(returnEl));
    this.editorOpen = true;
    openEditor(this.dialog, {
      mode: 'edit',
      date: this.cursor,
      event,
      confirmDelete,
      source: sourceOf(event, this.store),
      onSave: (form) => {
        const saved = this.store.update(id, form);
        if (saved.start > this.cursor || saved.end < this.cursor) {
          this.cursor = saved.start;
          this.writeHash();
          this.render();
        }
        this.say('저장했습니다.');
      },
      onDelete: () => {
        this.store.remove(id);
        this.evId = null;
        this.toaster.show({
          message: `일정을 삭제했습니다: ${event.title}`,
          undo: () => this.undoDelete(event),
        });
      },
      onClose: this.afterEditor(() => {
        if (this.store.get(id) && (fromGrid || this.evId === id)) {
          const list = this.dayList();
          if (list.some((e) => e.id === id)) {
            this.evId = id;
            this.render();
            this.focusEvent(id);
            return;
          }
        }
        this.evId = null;
        this.render();
        if (returnKey && !returnKey.startsWith('cell:')) {
          const el = this.deps.root.querySelector<HTMLElement>(
            `[data-fk="${cssEscape(returnKey)}"]`,
          );
          if (el) {
            el.focus();
            return;
          }
        }
        this.focusCell();
      }),
    });
  }

  // ---------- import and settings ----------

  private afterModal(returnEl: HTMLElement | null): void {
    this.editorOpen = false;
    if (returnEl && returnEl.isConnected) returnEl.focus();
    else this.focusCell();
  }

  private openImport(tab?: ImportTab): void {
    const returnEl = document.activeElement as HTMLElement | null;
    const storage = this.deps.prefsStorage;
    this.editorOpen = true;
    openImportDialog(this.deps.root, {
      store: this.store,
      grade: this.prefs.grade,
      today: this.now(),
      neisKey: loadNeisKey(storage),
      school: loadSchool(storage),
      tab,
      onGrade: (grade) => {
        this.prefs = { ...this.prefs, grade };
        savePrefs(storage, this.prefs);
        this.render();
      },
      onSchool: (school) => void saveSchool(storage, school),
      onOpenSettings: () => this.openSettings(),
      onImported: (done) => this.afterImport(done),
      onClose: () => this.afterModal(returnEl),
    });
  }

  private afterImport({ batch, added }: ImportDone): void {
    if (!added.length) {
      this.toaster.show({
        message: '새로 넣은 일정이 없습니다. 모두 이미 달력에 있는 일정입니다.',
        duration: 8000,
      });
      return;
    }
    // Show the month that holds the first event on or after today, else the last one.
    const starts = added.map((e) => e.start).sort();
    this.cursor = starts.find((d) => d >= this.today) ?? starts.at(-1)!;
    this.evId = null;
    this.writeHash();
    this.render();
    this.toaster.show({
      message: `학사일정 ${added.length}개를 달력에 넣었습니다.`,
      undo: () => {
        this.guardWrite(() => this.store.removeBatch(batch.id));
        this.say('가져오기를 되돌렸습니다.');
      },
      duration: 8000,
    });
  }

  private openSettings(): void {
    const returnEl = document.activeElement as HTMLElement | null;
    const storage = this.deps.prefsStorage;
    this.editorOpen = true;
    openSettingsDialog(this.deps.root, {
      store: this.store,
      prefs: this.prefs,
      neisKey: loadNeisKey(storage),
      school: loadSchool(storage),
      onKey: (key) => saveNeisKey(storage, key),
      onSchool: (school) => void saveSchool(storage, school),
      onPrefs: (prefs) => {
        this.prefs = prefs;
        savePrefs(storage, prefs);
        this.applyTheme();
        this.render();
      },
      onGoto: (date) => this.moveTo(date as IsoDate, { focus: true }),
      onDeleted: (message, undo) =>
        this.toaster.show({
          message,
          undo: () => {
            this.guardWrite(undo);
            this.say('삭제를 되돌렸습니다.');
          },
          duration: 8000,
        }),
      onClose: () => this.afterModal(returnEl),
    });
  }

  private undoAdd(id: string): void {
    this.guardWrite(() => this.store.remove(id));
    this.say('추가를 되돌렸습니다.');
  }

  private undoDelete(event: CalendarEvent): void {
    this.guardWrite(() => this.store.restore(event));
    this.say('삭제를 되돌렸습니다.');
  }

  private guardWrite(write: () => unknown): void {
    try {
      write();
    } catch (err) {
      if (err instanceof StoreWriteError) {
        this.toaster.show({ message: err.message });
        return;
      }
      throw err;
    }
  }

  // ---------- quick add and link ----------

  private quickAdd(): void {
    const value = this.quickInput.value.trim();
    if (!value) {
      this.openAdd();
      return;
    }
    const p = parseLine(value, this.cursor);
    const form: Partial<EventForm> = {
      title: p.title,
      start: p.start ?? this.cursor,
      end: p.end ?? p.start ?? this.cursor,
      allDay: !p.time,
      time: p.time,
      endTime: p.endTime,
      category: p.category ?? 'other',
      tags: p.tags,
    };
    if (!p.title) {
      this.openAdd(form);
      return;
    }
    try {
      const added = this.store.add(form);
      this.quickInput.value = '';
      this.cursor = added.start;
      this.writeHash();
      this.render();
      this.toaster.show({
        message: `일정을 추가했습니다: ${added.title}`,
        undo: () => this.undoAdd(added.id),
      });
    } catch (err) {
      if (err instanceof StoreWriteError) this.toaster.show({ message: err.message });
      else this.openAdd(form);
    }
  }

  // ---------- palette, export ----------

  private openPalette(prefill = ''): void {
    this.palette.open(prefill);
  }

  private addDraft(draft: NewEventDraft): void {
    const form: Partial<EventForm> = {
      title: draft.title,
      start: draft.start,
      end: draft.end,
      allDay: !draft.time,
      time: draft.time,
      endTime: draft.endTime,
      category: draft.category ?? 'other',
      tags: draft.tags,
    };
    try {
      const added = this.store.add(form);
      this.cursor = added.start;
      this.writeHash();
      this.render();
      this.focusCell();
      this.toaster.show({
        message: `일정을 추가했습니다: ${added.title}`,
        undo: () => this.undoAdd(added.id),
      });
    } catch (err) {
      if (err instanceof StoreWriteError) this.toaster.show({ message: err.message });
      else this.openAdd(form);
    }
  }

  private setPrefs(change: Partial<Prefs>): void {
    this.prefs = { ...this.prefs, ...change };
    savePrefs(this.deps.prefsStorage, this.prefs);
    this.applyTheme();
    this.render();
  }

  /**
   * Runs a palette command. Import and settings belong to other screens: they
   * are announced as a cancelable `datebook:command` event, and a listener
   * that handles one calls `preventDefault()`.
   */
  private runCommand(command: PaletteCommand): void {
    switch (command.type) {
      case 'goto':
        this.moveTo(command.date, { focus: true });
        return;
      case 'export':
        this.toaster.show({ message: exportEvents(this.store, command.format, this.now()) });
        return;
      case 'import-json':
        void importBackupFile(this.store).then((message) => {
          if (message) this.toaster.show({ message });
        });
        return;
      case 'theme':
        this.setPrefs({ theme: command.theme });
        this.say(`테마: ${{ dark: '다크', light: '라이트', system: '시스템' }[command.theme]}`);
        return;
      case 'weekstart':
        this.setPrefs({ weekStart: command.weekStart });
        return;
      case 'copy-link':
        void this.copyLink();
        return;
      case 'help':
        this.help.open();
        return;
      case 'import':
        this.openImport();
        return;
      case 'settings':
        this.openSettings();
        return;
      default: {
        const handled = !document.dispatchEvent(
          new CustomEvent('datebook:command', { detail: command, cancelable: true }),
        );
        if (!handled) this.toaster.show({ message: '이 기능은 아직 연결되지 않았습니다.' });
      }
    }
  }

  private async copyLink(): Promise<void> {
    const url = `${location.origin}${location.pathname}#/${this.cursor}`;
    try {
      await navigator.clipboard.writeText(url);
      this.toaster.show({ message: '이 날짜 링크를 복사했습니다.' });
    } catch {
      this.toaster.show({ message: '링크를 복사하지 못했습니다. 주소창의 주소를 써 주세요.' });
    }
  }
}
