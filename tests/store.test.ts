import { describe, expect, test } from 'vitest';
import { EventValidationError, eventKey } from '../src/model/event';
import type { ImportedEvent } from '../src/import/types';
import {
  BackupFormatError,
  EventStore,
  STORAGE_KEY,
  StoreWriteError,
  type StorageLike,
} from '../src/store/store';

class MemoryStorage implements StorageLike {
  map = new Map<string, string>();
  failWrites = false;
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new DOMException('quota', 'QuotaExceededError');
    this.map.set(key, value);
  }
}

function makeStore(storage = new MemoryStorage()) {
  let n = 0;
  const store = new EventStore(storage, {
    now: () => new Date('2026-11-16T09:00:00Z'),
    newId: () => `id-${++n}`,
  });
  return { store, storage };
}

function row(title: string, start: string, end = start, extra: Partial<ImportedEvent> = {}) {
  return {
    title,
    rawTitle: title,
    start,
    end,
    allDay: true,
    category: 'academic',
    holiday: false,
    ...extra,
  } satisfies ImportedEvent;
}

describe('EventStore', () => {
  test('restores a removed event with its id, source and batch for undo', () => {
    const { store } = makeStore();
    const { added } = store.commitImport([row('2학기 기말고사', '2026-12-09', '2026-12-11')], {
      source: 'file:plan.pdf',
      label: 'plan.pdf',
    });
    const original = added[0]!;
    store.remove(original.id);
    expect(store.get(original.id)).toBeUndefined();

    expect(store.restore(original)).toBe(true);
    expect(store.get(original.id)).toEqual(original);
    expect(store.batchEventCount(original.batchId!)).toBe(1);
    // A second restore of the same event changes nothing.
    expect(store.restore(original)).toBe(false);
    expect(store.list()).toHaveLength(1);
  });

  test('refuses to restore an event that fails validation', () => {
    const { store } = makeStore();
    const e = store.add({ title: 'a', start: '2026-12-01' });
    store.remove(e.id);
    expect(() => store.restore({ ...e, start: 'nope' })).toThrow(EventValidationError);
    expect(store.list()).toHaveLength(0);
  });

  test('adds, updates and removes events and persists them', () => {
    const { store, storage } = makeStore();
    const e = store.add({
      title: '  운영체제 과제 ',
      start: '2026-12-09',
      category: 'assignment',
      tags: ['#os', 'OS ', 'os'],
      deadline: true,
    });
    expect(e).toMatchObject({
      id: 'id-1',
      title: '운영체제 과제',
      end: '2026-12-09',
      allDay: true,
      tags: ['os', 'OS'],
      deadline: true,
      source: 'manual',
    });

    const timed = store.update(e.id, { allDay: false, time: '14:00', endTime: '15:30' });
    expect(timed).toMatchObject({ allDay: false, time: '14:00', endTime: '15:30' });
    const back = store.update(e.id, { allDay: true });
    expect(back.time).toBeUndefined();
    expect(back.allDay).toBe(true);

    const reopened = new EventStore(storage);
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.get('id-1')?.title).toBe('운영체제 과제');

    expect(store.remove(e.id)).toBe(true);
    expect(store.remove(e.id)).toBe(false);
    expect(new EventStore(storage).list()).toHaveLength(0);
  });

  test('rejects invalid input with a field name', () => {
    const { store } = makeStore();
    expect(() => store.add({ title: '', start: '2026-01-01' })).toThrow(EventValidationError);
    expect(() => store.add({ title: 'x', start: '2026-02-30' })).toThrow(/시작일/);
    expect(() => store.add({ title: 'x', start: '2026-03-02', end: '2026-03-01' })).toThrow(
      /종료일이 시작일보다/,
    );
    const e = store.add({ title: 'x', start: '2026-03-02', category: 'nope', time: '25:00' });
    expect(e.category).toBe('other');
    expect(e.allDay).toBe(true);
  });

  test('keeps memory and storage unchanged when a write fails', () => {
    const { store, storage } = makeStore();
    store.add({ title: 'a', start: '2026-03-02' });
    storage.failWrites = true;
    expect(() => store.add({ title: 'b', start: '2026-03-03' })).toThrow(StoreWriteError);
    expect(store.list()).toHaveLength(1);
    storage.failWrites = false;
    expect(new EventStore(storage).list().map((e) => e.title)).toEqual(['a']);
  });

  test('commits an import as a batch, skips duplicates and removes the batch', () => {
    const { store } = makeStore();
    store.add({ title: '내 일정', start: '2026-03-03' });
    const rows = [
      row('입학식', '2026-03-03', '2026-03-03', { grades: [1] }),
      row('1학기 중간고사', '2026-04-30', '2026-05-01', { category: 'exam' }),
      row('1학기 중간고사', '2026-04-30', '2026-05-01', { category: 'exam' }),
    ];
    const first = store.commitImport(rows, {
      source: 'file:school-2026.pdf',
      label: 'school-2026.pdf',
      tags: ['2026학년도'],
    });
    expect(first.added).toHaveLength(2);
    expect(first.skipped).toBe(1);
    expect(first.batch).toMatchObject({ source: 'file:school-2026.pdf', count: 2 });
    expect(first.added[0]).toMatchObject({
      batchId: first.batch.id,
      tags: ['2026학년도'],
      grades: [1],
    });

    const again = store.commitImport(rows, { source: 'file:school-2026.pdf', label: 'x' });
    expect(again.added).toHaveLength(0);
    expect(again.skipped).toBe(3);
    expect(store.batches()).toHaveLength(1);

    // An edited imported event still belongs to its batch.
    const exam = first.added[1]!;
    store.update(exam.id, { title: '중간고사 (수정)' });
    expect(store.batchEventCount(first.batch.id)).toBe(2);
    expect(store.removeBatch(first.batch.id)).toBe(2);
    expect(store.list().map((e) => e.title)).toEqual(['내 일정']);
    expect(store.batches()).toHaveLength(0);
  });

  test('keeps rows that differ only by grade, and old keys stay the same', () => {
    const { store } = makeStore();
    const rows = [
      row('현장체험학습', '2026-05-20', '2026-05-20', { grades: [1] }),
      row('현장체험학습', '2026-05-20', '2026-05-20', { grades: [2] }),
      row('개교기념일', '2026-05-21'),
    ];
    const first = store.commitImport(rows, { source: 'file:a.pdf', label: 'a.pdf' });
    expect(first.added.map((e) => e.grades)).toEqual([[1], [2], undefined]);
    expect(first.skipped).toBe(0);
    expect(eventKey({ title: '개교기념일', start: '2026-05-21', end: '2026-05-21' })).toBe(
      '2026-05-21|2026-05-21|개교기념일',
    );
    expect(eventKey({ ...rows[1]!, grades: [2, 1] })).toBe(
      eventKey({ ...rows[1]!, grades: [1, 2] }),
    );
    const again = store.commitImport(rows, { source: 'file:a.pdf', label: 'a.pdf' });
    expect(again).toMatchObject({ added: [], skipped: 3 });
  });

  test('skips rows that fail validation and reports them instead of failing the import', () => {
    const { store } = makeStore();
    const rows = [
      row('입학식 '.repeat(60), '2026-03-02'),
      row('개학식', '2026-03-03'),
      row('   ', '2026-03-04'),
    ];
    const r = store.commitImport(rows, { source: 'file:x.hwp', label: 'x.hwp' });
    expect(r.added.map((e) => e.title)).toEqual(['개학식']);
    expect(r.invalid).toEqual([
      { index: 0, message: '제목은 200자까지 쓸 수 있습니다.' },
      { index: 2, message: expect.any(String) },
    ]);
    expect(r.batch.count).toBe(1);
    expect(store.list()).toHaveLength(1);
  });

  describe('two tabs on one storage', () => {
    const twoTabs = () => {
      const storage = new MemoryStorage();
      let n = 0;
      const mk = (prefix: string) =>
        new EventStore(storage, {
          now: () => new Date('2026-11-16T09:00:00Z'),
          newId: () => `${prefix}-${++n}`,
        });
      return { storage, a: mk('a'), b: mk('b') };
    };

    test('a write keeps what the other tab saved in between', () => {
      const { storage, a, b } = twoTabs();
      a.add({ title: 'A탭 일정', start: '2026-11-17' });
      b.add({ title: 'B탭 일정', start: '2026-11-18' });
      expect(new EventStore(storage).list().map((e) => e.title)).toEqual(['A탭 일정', 'B탭 일정']);
      expect(b.list().map((e) => e.title)).toEqual(['A탭 일정', 'B탭 일정']);
    });

    test('update, remove, import and backup restore start from the stored state', () => {
      const { storage, a, b } = twoTabs();
      const x = a.add({ title: 'x', start: '2026-11-17' });
      const y = a.add({ title: 'y', start: '2026-11-18' });
      // b has not seen x or y yet.
      expect(b.update(x.id, { title: 'x2' }).title).toBe('x2');
      a.remove(y.id);
      expect(b.remove(y.id)).toBe(false);
      b.commitImport([row('가', '2026-03-02')], { source: 'file:a.pdf', label: 'a' });
      a.restoreBackup(b.exportBackup(), 'merge');
      a.removeSource('file:a.pdf');
      const titles = new EventStore(storage).list().map((e) => e.title);
      expect(titles).toEqual(['x2']);
    });

    test('a tab that did not write sees the other data after syncing', () => {
      const { a, b } = twoTabs();
      a.add({ title: '1', start: '2026-11-17' });
      b.add({ title: '2', start: '2026-11-17' });
      // A tab that did not write only learns of it from the storage event.
      expect(a.list()).toHaveLength(1);
      expect(a.syncFromStorage()).toBe(true);
      expect(a.list()).toHaveLength(2);
      expect(a.syncFromStorage()).toBe(false);
      expect(b.list()).toHaveLength(2);
    });

    test('a storage event from another tab reloads the data and tells subscribers', () => {
      const { a, b } = twoTabs();
      const target = new EventTarget();
      let calls = 0;
      b.subscribe(() => calls++);
      const stop = b.watchStorage(target);
      a.add({ title: '다른 탭', start: '2026-11-17' });
      target.dispatchEvent(Object.assign(new Event('storage'), { key: STORAGE_KEY }));
      expect(b.list().map((e) => e.title)).toEqual(['다른 탭']);
      expect(calls).toBe(1);
      // Another key, or nothing new in storage: nothing to tell.
      target.dispatchEvent(Object.assign(new Event('storage'), { key: 'other' }));
      target.dispatchEvent(Object.assign(new Event('storage'), { key: STORAGE_KEY }));
      expect(calls).toBe(1);
      stop();
      a.add({ title: '또 다른', start: '2026-11-18' });
      target.dispatchEvent(Object.assign(new Event('storage'), { key: STORAGE_KEY }));
      expect(b.list()).toHaveLength(1);
    });

    test('another tab clearing storage empties the list instead of resurrecting old events', () => {
      const { storage, a, b } = twoTabs();
      a.add({ title: 'x', start: '2026-11-17' });
      b.syncFromStorage();
      storage.map.delete(STORAGE_KEY);
      b.add({ title: 'y', start: '2026-11-18' });
      expect(new EventStore(storage).list().map((e) => e.title)).toEqual(['y']);
    });
  });

  test('removes every event of a source', () => {
    const { store } = makeStore();
    store.commitImport([row('a', '2026-03-02')], { source: 'neis:G10/7430310', label: 's' });
    store.commitImport([row('b', '2026-03-03')], { source: 'neis:G10/7430310', label: 's' });
    store.commitImport([row('c', '2026-03-04')], { source: 'file:x.pdf', label: 'x' });
    expect(store.removeSource('neis:G10/7430310')).toBe(2);
    expect(store.list().map((e) => e.title)).toEqual(['c']);
    expect(store.batches().map((b) => b.source)).toEqual(['file:x.pdf']);
  });

  test('exports and restores a backup in merge and replace modes', () => {
    const { store } = makeStore();
    store.add({ title: 'a', start: '2026-03-02', tags: ['x'] });
    store.commitImport([row('b', '2026-03-03')], { source: 'file:x.pdf', label: 'x.pdf' });
    const backup = store.exportBackup();

    const other = makeStore().store;
    other.add({ title: 'a', start: '2026-03-02' });
    expect(other.restoreBackup(backup, 'merge')).toEqual({ added: 1, skipped: 1, invalid: 0 });
    expect(other.batches()).toHaveLength(1);

    const fresh = makeStore().store;
    fresh.add({ title: 'z', start: '2026-01-01' });
    expect(fresh.restoreBackup(backup, 'replace')).toEqual({ added: 2, skipped: 0, invalid: 0 });
    expect(fresh.list().map((e) => e.title)).toEqual(['a', 'b']);
  });

  test('rejects foreign files and drops invalid or crafted rows', () => {
    const { store } = makeStore();
    expect(() => store.restoreBackup('nope', 'merge')).toThrow(BackupFormatError);
    expect(() => store.restoreBackup('{"events":[]}', 'merge')).toThrow(/datebook 백업/);
    const crafted = JSON.stringify({
      app: 'datebook',
      version: 1,
      events: [
        { title: 'ok', start: '2026-03-02', id: 'good-id', PROTO: { polluted: true } },
        { title: 'bad id', start: '2026-03-03', id: '<img src=x>' },
        { title: '', start: '2026-03-04' },
        { title: 'bad date', start: '2026-13-04' },
      ],
    }).replace('"PROTO"', '"__proto__"');
    expect(crafted).toContain('"__proto__":{"polluted":true}');
    const result = store.restoreBackup(crafted, 'merge');
    expect(result).toEqual({ added: 2, skipped: 0, invalid: 2 });
    const ids = store.list().map((e) => e.id);
    expect(ids[0]).toBe('good-id');
    expect(ids[1]).not.toBe('<img src=x>');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(store.list()[0]!)).not.toContain('polluted');
  });

  test('keeps a copy of unreadable data and starts empty', () => {
    const storage = new MemoryStorage();
    storage.map.set(STORAGE_KEY, '{broken');
    const store = new EventStore(storage);
    expect(store.loadIssue).toBe('corrupt');
    expect(store.list()).toHaveLength(0);
    expect(storage.map.get(`${STORAGE_KEY}:corrupt`)).toBe('{broken');
  });

  test('notifies subscribers after each write', () => {
    const { store } = makeStore();
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.add({ title: 'a', start: '2026-03-02' });
    off();
    store.add({ title: 'b', start: '2026-03-02' });
    expect(calls).toBe(1);
  });
});
