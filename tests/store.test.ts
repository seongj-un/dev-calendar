import { describe, expect, test } from 'vitest';
import { EventValidationError } from '../src/model/event';
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
