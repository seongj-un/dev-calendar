// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://localhost/#/2026-12-10"}
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '../src/app/app';
import { openImportDialog, type ImportDialogOptions } from '../src/app/import-ui/importDialog';
import { openSettingsDialog } from '../src/app/settings/settingsDialog';
import { EventStore, type StorageLike } from '../src/store/store';
import type { ImportResult, ImportedEvent } from '../src/import/types';
import { DEFAULT_PREFS } from '../src/app/prefs';

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
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const all = <T extends Element = HTMLElement>(sel: string) =>
  Array.from(document.querySelectorAll<T>(sel));
const tick = () => new Promise((r) => setTimeout(r, 0));

function row(title: string, start: string, over: Partial<ImportedEvent> = {}): ImportedEvent {
  return {
    title,
    rawTitle: title,
    start,
    end: start,
    allDay: true,
    category: 'academic',
    holiday: false,
    ...over,
  };
}

function result(events: ImportedEvent[], over: Partial<ImportResult> = {}): ImportResult {
  return {
    kind: 'pdf-grid',
    source: 'file:plan.pdf',
    label: 'plan.pdf',
    events,
    warnings: [],
    pages: 2,
    academicYear: 2026,
    ...over,
  };
}

const SAMPLE = [
  row('개학식', '2026-03-03', { grades: [2, 3] }),
  row('입학식', '2026-03-03', { grades: [1] }),
  row('3.1절', '2026-03-01', { holiday: true, category: 'holiday' }),
  row('추석', '2026-09-25', {
    holiday: true,
    category: 'holiday',
    review: '기간 쉬는 날과 겹칩니다: 추석연휴',
  }),
];

let root: HTMLElement;
let storage: MemoryStorage;
let store: EventStore;

beforeEach(() => {
  storage = new MemoryStorage();
  let n = 0;
  let t = 0;
  store = new EventStore(storage, {
    newId: () => `id${++n}`,
    now: () => new Date(NOW.getTime() + ++t * 1000),
  });
  root = document.createElement('div');
  document.body.replaceChildren(root);
});
afterEach(() => {
  document.body.replaceChildren();
});

function openImport(over: Partial<ImportDialogOptions> = {}) {
  const calls = {
    imported: [] as unknown[],
    closed: 0,
    grade: [] as (number | null)[],
    settings: 0,
  };
  const handle = openImportDialog(root, {
    store,
    grade: null,
    today: NOW,
    neisKey: '',
    school: null,
    onGrade: (g) => calls.grade.push(g),
    onSchool: () => {},
    onOpenSettings: () => void calls.settings++,
    onImported: (d) => calls.imported.push(d),
    onClose: () => void calls.closed++,
    importFile: async () => result(SAMPLE),
    ...over,
  });
  return { calls, handle };
}

async function pickFile() {
  const input = $<HTMLInputElement>('#import input[type=file]');
  const file = new File(['x'], 'plan.pdf');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
  await tick();
  await tick();
}

describe('import window', () => {
  test('opens on the file tab with the choose button focused and a label on every control', () => {
    openImport();
    expect($<HTMLDialogElement>('#import').open).toBe(true);
    expect(document.activeElement?.getAttribute('data-fk')).toBe('pick-file');
    for (const b of all('#import button'))
      expect((b.textContent ?? '').trim() || b.getAttribute('aria-label')).toBeTruthy();
  });

  test('a file becomes a preview; new rows are checked, others are not', async () => {
    openImport({ grade: 2 });
    await pickFile();
    expect($('.pv-src').textContent).toContain('plan.pdf');
    const rows = all('.pv-row');
    expect(rows).toHaveLength(4);
    const state = (r: HTMLElement) => r.getAttribute('data-status');
    // sorted as the parser sent them
    expect(rows.map(state)).toEqual(['new', 'grade', 'new', 'check']);
    expect(all<HTMLInputElement>('.pv-check').map((c) => c.checked)).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect($('[data-fk=confirm]').textContent).toBe('2개 달력에 반영');
  });

  test('confirming adds the checked rows as one batch with the tag', async () => {
    const { calls } = openImport({ grade: 2 });
    await pickFile();
    all<HTMLInputElement>('.pv-check')[3]!.click();
    $('[data-fk=confirm]').click();
    expect(
      store
        .list()
        .map((e) => e.title)
        .sort(),
    ).toEqual(['3.1절', '개학식', '추석']);
    expect(store.batches()).toHaveLength(1);
    expect(store.list()[0]!.tags).toEqual(['2026학년도']);
    expect(calls.imported).toHaveLength(1);
    expect(calls.closed).toBe(1);
    expect(document.querySelector('#import')).toBeNull();
  });

  test('importing the same file again marks everything as already there', async () => {
    openImport({ grade: 2 });
    await pickFile();
    $('[data-fk=confirm]').click();
    openImport({ grade: 2 });
    await pickFile();
    expect(all('.pv-row').every((r) => r.getAttribute('data-status') !== 'new')).toBe(true);
    expect($('[data-fk=confirm]').textContent).toBe('반영할 일정이 없습니다');
    expect(($('[data-fk=confirm]') as HTMLButtonElement).disabled).toBe(true);
    expect($('.notice-line').textContent).toContain('이미 가져온 일정');
  });

  test('a row can be edited in place and then counts as new', async () => {
    openImport();
    await pickFile();
    all('.pv-row .c-edit button')[3]!.click();
    const editing = $('.pv-row.editing');
    const [start, end] = Array.from(editing.querySelectorAll<HTMLInputElement>('.in-date'));
    const title = $<HTMLInputElement>('.pv-row.editing [data-fk^="ed-title"]');
    title.value = '추석 연휴';
    start!.value = '9.24';
    end!.value = '9.26';
    editing.querySelector<HTMLButtonElement>('.btn-primary')!.click();
    const edited = all('.pv-row')[3]!;
    expect(edited.textContent).toContain('추석 연휴');
    expect(edited.textContent).toContain('9.24 – 9.26');
    expect(edited.getAttribute('data-status')).toBe('new');
    expect(document.activeElement?.getAttribute('data-fk')).toBe('edit:3');
  });

  test('bad edit input shows an error and keeps the row open', async () => {
    openImport();
    await pickFile();
    all('.pv-row .c-edit button')[0]!.click();
    const start = $<HTMLInputElement>('.pv-row.editing .in-date');
    start.value = '2.30';
    $<HTMLButtonElement>('.pv-row.editing .btn-primary').click();
    expect($('.pv-row.editing .err').textContent).toContain('시작일');
    expect(start.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(start);
  });

  test('Escape closes the row editor first, then the window', async () => {
    const { calls } = openImport();
    await pickFile();
    all('.pv-row .c-edit button')[0]!.click();
    $('.pv-row.editing input').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(document.querySelector('.pv-row.editing')).toBeNull();
    expect(calls.closed).toBe(0);
    $('#import').dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(calls.closed).toBe(1);
  });

  test('a manual row is added with the add button and dropped on cancel', async () => {
    openImport();
    await pickFile();
    $('[data-fk=add-row]').click();
    expect(all('.pv-row')).toHaveLength(5);
    $('.pv-row.editing .btn-text').click();
    expect(all('.pv-row')).toHaveLength(4);
  });

  test('changing the grade re-checks rows and reports the grade', async () => {
    const { calls } = openImport();
    await pickFile();
    const grade = $<HTMLSelectElement>('#pv-grade');
    grade.value = '1';
    grade.dispatchEvent(new Event('change'));
    expect(calls.grade).toEqual([1]);
    expect(all<HTMLInputElement>('.pv-check').map((c) => c.checked)).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });

  test('a file with nothing readable goes back with the reason', async () => {
    openImport({
      importFile: async () =>
        result([], {
          warnings: [{ code: 'unsupported', message: 'PDF, 캘린더 파일만 가져올 수 있습니다.' }],
        }),
    });
    await pickFile();
    expect($('#import .form-err').textContent).toContain('가져올 수 있습니다');
    expect(document.querySelector('.preview')).toBeNull();
  });

  test('a read that never finishes is given up', async () => {
    vi.useFakeTimers();
    try {
      openImport({ importFile: () => new Promise(() => {}), timeoutMs: 50 });
      const input = $<HTMLInputElement>('#import input[type=file]');
      Object.defineProperty(input, 'files', {
        value: [new File(['x'], 'a.pdf')],
        configurable: true,
      });
      input.dispatchEvent(new Event('change'));
      expect($('.busy').textContent).toContain('a.pdf');
      await vi.advanceTimersByTimeAsync(100);
      expect($('#import .form-err').textContent).toContain('오래 걸려');
    } finally {
      vi.useRealTimers();
    }
  });

  test('the NEIS tab without a key offers the key button and opens settings', async () => {
    const { calls } = openImport({ tab: 'neis' });
    expect($('.notice-box').textContent).toContain('5건만');
    $('[data-fk=neis-key]').click();
    expect(calls.settings).toBe(1);
    expect(calls.closed).toBe(1);
  });

  test('a NEIS school is searched, chosen and loaded; the sample limit is shown', async () => {
    const school = {
      officeCode: 'G10',
      officeName: '대전광역시교육청',
      schoolCode: '7430310',
      name: '대덕소프트웨어마이스터고등학교',
      kind: '고등학교',
      region: '대전광역시',
      address: '',
    };
    const saved: unknown[] = [];
    const fetchSchedule = vi.fn(async () =>
      result([row('개학식', '2026-03-02')], {
        kind: 'neis',
        source: 'neis:G10/7430310',
        label: school.name,
        warnings: [
          {
            code: 'neis-sample-limit',
            message: 'NEIS 인증키가 없어 일정 253건 중 5건만 받았습니다.',
          },
        ],
      }),
    );
    openImport({
      tab: 'neis',
      onSchool: (s) => void saved.push(s),
      loadNeis: async () =>
        ({
          searchSchools: async () => ({ schools: [school], total: 1 }),
          fetchSchedule,
        }) as never,
    });
    const q = $<HTMLInputElement>('#neis-q');
    q.value = '대덕소프트웨어';
    $('.neis-search').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    await tick();
    expect(all('.school')).toHaveLength(1);
    expect(($('[data-fk=neis-load]') as HTMLButtonElement).disabled).toBe(true);
    $<HTMLInputElement>('.school input').click();
    $<HTMLInputElement>('.school input').dispatchEvent(new Event('change'));
    $('[data-fk=neis-load]').click();
    await tick();
    await tick();
    expect(fetchSchedule).toHaveBeenCalledOnce();
    expect($('.pv-src').textContent).toContain('대덕소프트웨어마이스터고등학교');
    expect($('.notice-line').textContent).toContain('253건 중 5건');
    expect(saved).toHaveLength(1);
  });

  test('a failing NEIS search shows the message instead of waiting', async () => {
    openImport({
      tab: 'neis',
      loadNeis: async () =>
        ({
          searchSchools: async () => {
            throw new Error('NEIS에 연결하지 못했습니다.');
          },
        }) as never,
    });
    $<HTMLInputElement>('#neis-q').value = '대덕';
    $('.neis-search').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    await tick();
    expect($('.schools [role=alert]').textContent).toContain('연결하지 못했습니다');
  });
});

describe('settings window', () => {
  function openSettings(over: Partial<Parameters<typeof openSettingsDialog>[1]> = {}) {
    const calls = {
      keys: [] as string[],
      prefs: [] as unknown[],
      deleted: [] as { message: string; undo: () => void }[],
      closed: 0,
      goto: [] as string[],
    };
    openSettingsDialog(root, {
      store,
      prefs: { ...DEFAULT_PREFS },
      neisKey: '',
      school: null,
      onKey: (k) => (calls.keys.push(k), true),
      onSchool: () => {},
      onPrefs: (p) => void calls.prefs.push(p),
      onGoto: (d) => void calls.goto.push(d),
      onDeleted: (message, undo) => void calls.deleted.push({ message, undo }),
      onClose: () => void calls.closed++,
      loadNeis: async () => ({ searchSchools: async () => ({ schools: [], total: 0 }) }) as never,
      ...over,
    });
    return calls;
  }

  const KEY = '0123456789abcdef0123456789abcdef';

  test('without a key it asks for one and checks the shape first', async () => {
    const calls = openSettings();
    expect(document.activeElement?.getAttribute('data-fk')).toBe('key-in');
    const input = $<HTMLInputElement>('#set-key');
    input.value = 'abc';
    $('#settings form.key-row').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    expect($('.key-msg').textContent).toContain('16~64자');
    expect(calls.keys).toEqual([]);
  });

  test('a good key is saved, shown masked and can be cleared', async () => {
    const calls = openSettings();
    $<HTMLInputElement>('#set-key').value = KEY;
    $('#settings form.key-row').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    await tick();
    expect(calls.keys).toEqual([KEY]);
    expect($('.key-msg').textContent).toContain('확인되었습니다');
    const mask = $('.key-mask');
    expect(mask.textContent!.endsWith('cdef')).toBe(true);
    expect(document.body.textContent).not.toContain(KEY);
    $('[data-fk=key-clear]').click();
    expect(calls.keys).toEqual([KEY, '']);
    expect(document.activeElement?.getAttribute('data-fk')).toBe('key-in');
  });

  test('a key NEIS refuses is not saved', async () => {
    const calls = openSettings({
      loadNeis: async () =>
        ({
          searchSchools: async () => {
            throw Object.assign(new Error('bad'), { code: 'invalid-key' });
          },
        }) as never,
    });
    $<HTMLInputElement>('#set-key').value = KEY;
    $('#settings form.key-row').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    await tick();
    expect(calls.keys).toEqual([]);
    expect($('.key-msg').textContent).toContain('받아 주지 않습니다');
  });

  test('view preferences are reported as they change', () => {
    const calls = openSettings();
    $<HTMLInputElement>('input[name=set-week][value="1"]').dispatchEvent(new Event('change'));
    $<HTMLInputElement>('input[name=set-grade][value="2"]').dispatchEvent(new Event('change'));
    $<HTMLInputElement>('input[name=set-theme][value=dark]').dispatchEvent(new Event('change'));
    expect(calls.prefs.at(-1)).toEqual({ theme: 'dark', grade: 2, weekStart: 1 });
  });

  test('batches list newest first; delete asks first, then removes, and undo brings them back', async () => {
    openImport({ grade: null });
    await pickFile();
    $('[data-fk=confirm]').click();
    store.update(store.list()[0]!.id, { title: '고친 제목' });
    const calls = openSettings();
    const li = $('.batches li');
    expect(li.textContent).toContain('plan.pdf');
    expect(li.textContent).toContain('고친 일정 1개');
    $('[data-fk^="del:"]').click();
    expect($('.batches li.confirm').textContent).toContain('직접 고친 1개');
    expect(document.activeElement?.textContent).toBe('취소');
    expect(store.list().length).toBeGreaterThan(0);
    const total = store.list().length;
    $<HTMLButtonElement>('.batches li.confirm .btn-primary').click();
    expect(store.list()).toHaveLength(0);
    expect(store.batches()).toHaveLength(0);
    expect(calls.deleted[0]!.message).toContain(`${total}개`);
    calls.deleted[0]!.undo();
    expect(store.list()).toHaveLength(total);
    expect(store.batches()).toHaveLength(1);
  });

  test('Escape in the delete question cancels only the question', async () => {
    openImport();
    await pickFile();
    $('[data-fk=confirm]').click();
    const calls = openSettings();
    $('[data-fk^="del:"]').click();
    $('#settings').dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(document.querySelector('.batches li.confirm')).toBeNull();
    expect(calls.closed).toBe(0);
    expect(store.list().length).toBeGreaterThan(0);
  });

  test('an empty list says how to add', () => {
    openSettings();
    expect($('#settings .hint-line').textContent).toContain('가져오기');
  });
});

describe('inside the app', () => {
  let app: App | null = null;
  afterEach(() => app?.destroy());

  function mount() {
    const r = document.createElement('div');
    document.body.replaceChildren(r);
    history.replaceState(null, '', '#/2026-12-10');
    app = new App({ root: r, store, prefsStorage: storage, now: () => NOW });
    root = r;
    return r;
  }

  test('the top bar buttons and the I and comma keys open the windows', () => {
    mount();
    $('[data-action=import]').click();
    expect($<HTMLDialogElement>('#import').open).toBe(true);
    $('#import .icon-btn').click();
    expect(document.querySelector('#import')).toBeNull();
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: ',', bubbles: true, cancelable: true }),
    );
    expect(document.querySelector('#settings')).not.toBeNull();
    $('#settings .icon-btn').click();
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'i', bubbles: true, cancelable: true }),
    );
    expect(document.querySelector('#import')).not.toBeNull();
  });

  test('typing in the import window does not trigger calendar shortcuts', () => {
    mount();
    $('[data-action=import]').click();
    const before = location.hash;
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }),
    );
    expect(location.hash).toBe(before);
  });

  test('settings changes apply at once and survive a reload of the preferences', () => {
    mount();
    $('[data-action=settings]').click();
    $<HTMLInputElement>('input[name=set-theme][value=dark]').dispatchEvent(new Event('change'));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(JSON.parse(storage.getItem('datebook:prefs')!)).toMatchObject({ theme: 'dark' });
  });
});
