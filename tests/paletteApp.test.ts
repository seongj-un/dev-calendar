// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://localhost/#/2026-12-10"}
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '../src/app/app';
import { exportEvents, importBackupFile } from '../src/app/export/actions';
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
  return { store, root, storage };
}

function key(k: string, target: EventTarget = document.activeElement ?? document.body, init = {}) {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }),
  );
}

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const palette = () => $<HTMLDialogElement>('dialog.palette');
const input = () => $<HTMLInputElement>('.p-input');

function type(value: string) {
  input().value = value;
  input().dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([
    new DOMRect(0, 0, 10, 10),
  ] as unknown as DOMRectList);
});

afterEach(() => {
  app?.destroy();
  app = null;
  vi.restoreAllMocks();
});

describe('command palette', () => {
  test('Ctrl+K opens it with the field focused, and again closes it', () => {
    setup();
    key('k', document.body, { ctrlKey: true });
    expect(palette().open).toBe(true);
    expect(document.activeElement).toBe(input());
    key('k', input(), { ctrlKey: true });
    expect(palette().open).toBe(false);
  });

  test('/ opens it and the shortcut does nothing while typing in a field', () => {
    setup();
    key('/', document.body);
    expect(palette().open).toBe(true);
    input().focus();
    type('a');
    key('/', input());
    expect(input().value).toBe('a');
  });

  test('the top bar button opens it for touch users', () => {
    setup();
    const btn = $<HTMLButtonElement>('[data-action="palette"]');
    expect(btn.getAttribute('aria-label')).toBe('검색과 명령 열기');
    btn.click();
    expect(palette().open).toBe(true);
  });

  test('a one-line entry adds the event and moves to its day', () => {
    const { store } = setup();
    key('k', document.body, { ctrlKey: true });
    type('v1.2 배포 12/20 14:00 #release');
    expect(document.querySelector('.opt .ot')?.textContent).toBe('v1.2 배포');
    key('Enter', input());
    const added = store.list().find((e) => e.title === 'v1.2 배포');
    expect(added).toMatchObject({ start: '2026-12-20', time: '14:00', tags: ['release'] });
    expect(palette().open).toBe(false);
    expect(location.hash).toBe('#/2026-12-20');
  });

  test('a search word and Enter goes to the match and adds nothing', () => {
    const { store } = setup([{ title: '배포 회의', start: '2026-12-21' }]);
    key('/', document.body);
    type('배포');
    key('Enter', input());
    expect(store.list()).toHaveLength(1);
    expect(location.hash).toBe('#/2026-12-21');
    // No date and no time, and nothing found: still nothing is created.
    key('/', document.body);
    type('없는 단어');
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
    key('Enter', input());
    expect(store.list()).toHaveLength(1);
  });

  test('Enter during IME composition does nothing', () => {
    const { store } = setup();
    key('k', document.body, { ctrlKey: true });
    type('배포');
    input().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(store.list()).toHaveLength(0);
    expect(palette().open).toBe(true);
  });

  test('arrow keys move the active row and keep aria-activedescendant in step', () => {
    setup([
      { title: '배포 회의', start: '2026-12-21' },
      { title: '배포 점검', start: '2026-12-23' },
    ]);
    key('k', document.body, { ctrlKey: true });
    type('배포');
    const rows = [...document.querySelectorAll('[role="option"]')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute('aria-selected')).toBe('true');
    key('ArrowDown', input());
    expect(rows[1]?.getAttribute('aria-selected')).toBe('true');
    expect(input().getAttribute('aria-activedescendant')).toBe(rows[1]?.id);
    key('Enter', input());
    expect(location.hash).toBe('#/2026-12-23');
  });

  test('>goto moves to the month; a half-typed goto is completed, not run', () => {
    setup();
    key('g', document.body);
    expect(input().value).toBe('>goto ');
    type('>goto 2027-03');
    key('Enter', input());
    expect(location.hash).toBe('#/2027-03-01');
    key('k', document.body, { ctrlKey: true });
    type('>goto');
    key('Enter', input());
    expect(palette().open).toBe(true);
    expect(input().value).toBe('>goto ');
  });

  test('>theme dark saves the preference', () => {
    const { storage } = setup();
    key('k', document.body, { ctrlKey: true });
    type('>theme dark');
    key('Enter', input());
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(JSON.parse(storage.map.get('datebook:prefs') ?? '{}').theme).toBe('dark');
  });

  test('i and , open the import and settings windows directly', () => {
    setup();
    key('i', document.body);
    expect(document.querySelector('.dlg-import')).not.toBeNull();
    expect($('.toasts').textContent).not.toContain('연결되지 않았습니다');
  });

  test(', opens the settings window', () => {
    setup();
    key(',', document.body);
    expect(document.querySelector('.dlg-settings')).not.toBeNull();
    expect($('.toasts').textContent).not.toContain('연결되지 않았습니다');
  });

  test('Escape closes it and focus goes back where it was', () => {
    setup();
    const add = $<HTMLButtonElement>('[data-action="add"]');
    add.focus();
    key('k', add, { ctrlKey: true });
    palette().close();
    expect(document.activeElement).toBe(add);
  });
});

describe('shortcut sheet', () => {
  test('? opens it, background shortcuts are ignored while open, and closing restores focus', () => {
    setup();
    const cell = $('.cell[data-date="2026-12-10"]');
    cell.focus();
    key('?', cell);
    const sheet = $<HTMLDialogElement>('dialog.help-sheet');
    expect(sheet.open).toBe(true);
    key('l', document.body);
    expect(location.hash).toBe('#/2026-12-10');
    expect(sheet.querySelectorAll('kbd').length).toBeGreaterThan(10);
    sheet.querySelector<HTMLButtonElement>('button[aria-label="닫기"]')!.click();
    expect(sheet.open).toBe(false);
    expect(document.activeElement).toBe(cell);
  });
});

describe('export', () => {
  test('.ics and JSON downloads carry every event, even ones the grade filter hides', () => {
    const { store } = setup([
      { title: '입학식', start: '2026-03-03', grades: [1] },
      { title: '배포', start: '2026-12-20' },
    ]);
    const blobs: Blob[] = [];
    URL.createObjectURL = (b: Blob | MediaSource) => {
      blobs.push(b as Blob);
      return 'blob:x';
    };
    URL.revokeObjectURL = () => {};
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    expect(exportEvents(store, 'ics', NOW)).toBe('일정 2개를 .ics 파일로 내보냈습니다.');
    expect(exportEvents(store, 'json', NOW)).toBe('일정 2개를 JSON 백업으로 내보냈습니다.');
    expect(click).toHaveBeenCalledTimes(2);
    expect(blobs.map((b) => b.type)).toEqual(['text/calendar;charset=utf-8', 'application/json']);
  });

  test('an empty calendar downloads nothing', () => {
    const { store } = setup();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    expect(exportEvents(store, 'ics', NOW)).toBe('내보낼 일정이 없습니다.');
    expect(click).not.toHaveBeenCalled();
  });
});

describe('JSON backup import', () => {
  /** Makes the file picker answer with `content` (or nothing) without a real dialog. */
  function pick(content: string | null, size?: number) {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      if (content === null) {
        this.dispatchEvent(new Event('cancel'));
        return;
      }
      Object.defineProperty(this, 'files', {
        value: [{ name: 'backup.json', size, text: () => Promise.resolve(content) }],
      });
      this.dispatchEvent(new Event('change'));
    });
  }

  test('merges a backup and reports added, skipped and unreadable rows', async () => {
    const { store } = setup([{ title: '배포', start: '2026-12-20' }]);
    const backup = store.exportBackup();
    store.add({ title: '새 일정', start: '2026-12-22' });
    const doc = JSON.parse(backup);
    doc.events.push({ title: '', start: 'x' });
    doc.events.push({
      ...doc.events[0],
      id: 'other',
      title: '다른 일정',
      start: '2026-12-23',
      end: '2026-12-23',
    });
    pick(JSON.stringify(doc));
    const message = await importBackupFile(store);
    expect(message).toBe('백업을 가져왔습니다. 새 일정 1개, 이미 있어서 건너뜀 1개, 읽지 못함 1개');
    expect(
      store
        .list()
        .map((e) => e.title)
        .sort(),
    ).toEqual(['다른 일정', '배포', '새 일정']);
  });

  test('says what is wrong with a file that is not a backup, and keeps the data', async () => {
    const { store } = setup([{ title: '배포', start: '2026-12-20' }]);
    pick('BEGIN:VCALENDAR');
    expect(await importBackupFile(store)).toBe('JSON 파일이 아닙니다.');
    pick('{"app":"other","events":[]}');
    expect(await importBackupFile(store)).toBe('datebook 백업 파일이 아닙니다.');
    expect(store.list()).toHaveLength(1);
  });

  test('refuses a backup over the size limit without reading it', async () => {
    const { store } = setup([{ title: '배포', start: '2026-12-20' }]);
    const read = vi.fn(() => Promise.resolve('{}'));
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      Object.defineProperty(this, 'files', {
        value: [{ name: 'big.json', size: 30_000_001, text: read }],
      });
      this.dispatchEvent(new Event('change'));
    });
    expect(await importBackupFile(store)).toBe('백업 파일이 너무 큽니다.');
    expect(read).not.toHaveBeenCalled();
    expect(store.list()).toHaveLength(1);
  });

  test('cancelling the picker changes nothing and shows nothing', async () => {
    const { store } = setup();
    pick(null);
    expect(await importBackupFile(store)).toBeNull();
  });
});
