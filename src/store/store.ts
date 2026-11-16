import { isIsoDate } from '../model/date';
import {
  LIMITS,
  MANUAL_SOURCE,
  EventValidationError,
  eventKey,
  normalizeTags,
  sanitizeInput,
  type CalendarEvent,
  type EventInput,
} from '../model/event';
import type { ImportedEvent } from '../import/types';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ImportBatch {
  id: string;
  source: string;
  label: string;
  importedAt: string;
  /** Events added by this import (fixed at import time). */
  count: number;
}

interface StoreData {
  version: 1;
  events: CalendarEvent[];
  batches: ImportBatch[];
}

export const STORAGE_KEY = 'datebook:v1';
const BACKUP_APP = 'datebook';
const MAX_BACKUP_CHARS = 10_000_000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** localStorage refused the write (quota, private mode). Nothing was changed. */
export class StoreWriteError extends Error {
  constructor(cause: unknown) {
    super('브라우저 저장 공간에 쓰지 못했습니다. 저장 공간이 가득 찼을 수 있습니다.', { cause });
    this.name = 'StoreWriteError';
  }
}

export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupFormatError';
  }
}

export interface StoreOptions {
  key?: string;
  now?: () => Date;
  newId?: () => string;
}

export interface RestoreResult {
  added: number;
  /** Already present (same id, or same title and dates). */
  skipped: number;
  /** Rows that failed validation. */
  invalid: number;
}

/** A preview row that did not pass validation; `index` is its place in the rows given. */
export interface InvalidImportRow {
  index: number;
  message: string;
}

export interface ImportCommitResult {
  batch: ImportBatch;
  added: CalendarEvent[];
  /** Already in the calendar (same title, dates and grades). */
  skipped: number;
  /** Rows left out because they failed validation; the others still go in. */
  invalid: InvalidImportRow[];
}

type Listener = () => void;

export function randomId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Events and import batches, persisted as one JSON document in localStorage.
 *
 * Every write serializes the next state and stores it before swapping it in,
 * so a failed write (quota) leaves both memory and storage unchanged.
 */
export class EventStore {
  private data: StoreData = { version: 1, events: [], batches: [] };
  private readonly listeners = new Set<Listener>();
  /** The stored text this.data was read from or written as; tells when another tab wrote. */
  private seen: string | null = null;
  private readonly key: string;
  private readonly now: () => Date;
  private readonly newId: () => string;
  /** Set when stored data could not be read; a copy was kept under another key. */
  readonly loadIssue: 'corrupt' | null = null;

  constructor(
    private readonly storage: StorageLike,
    options: StoreOptions = {},
  ) {
    this.key = options.key ?? STORAGE_KEY;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomId;
    const raw = storage.getItem(this.key);
    this.seen = raw;
    if (raw !== null) {
      const parsed = readStoreData(raw);
      if (parsed) {
        this.data = parsed;
      } else {
        this.loadIssue = 'corrupt';
        try {
          storage.setItem(`${this.key}:corrupt`, raw);
        } catch {
          // Keeping the copy is best effort; the original stays until the next write.
        }
      }
    }
  }

  /**
   * Reads storage again when another tab changed it, and tells subscribers.
   * Returns true when the data was replaced. Every write calls this first, so a
   * tab that was open for a while never overwrites what another tab saved.
   */
  syncFromStorage(): boolean {
    const raw = this.storage.getItem(this.key);
    if (raw === this.seen) return false;
    if (raw === null) {
      this.data = { version: 1, events: [], batches: [] };
    } else {
      const parsed = readStoreData(raw);
      // Unreadable text from another tab: keep what this tab has; the next write replaces it.
      if (!parsed) return false;
      this.data = parsed;
    }
    this.seen = raw;
    for (const fn of this.listeners) fn();
    return true;
  }

  /** Follows `storage` events of other tabs (pass `window`). Returns a stop function. */
  watchStorage(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>): () => void {
    const handler = (event: Event) => {
      const key = (event as Event & { key?: string | null }).key;
      if (key === undefined || key === null || key === this.key) this.syncFromStorage();
    };
    target.addEventListener('storage', handler);
    return () => target.removeEventListener('storage', handler);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): readonly CalendarEvent[] {
    return this.data.events;
  }

  get(id: string): CalendarEvent | undefined {
    return this.data.events.find((e) => e.id === id);
  }

  /** Events that touch the inclusive range [from, to]. */
  between(from: string, to: string): CalendarEvent[] {
    return this.data.events.filter((e) => e.start <= to && e.end >= from);
  }

  batches(): readonly ImportBatch[] {
    return this.data.batches;
  }

  /** Events of a batch still in the calendar (the user may have deleted some). */
  batchEventCount(batchId: string): number {
    return this.data.events.filter((e) => e.batchId === batchId).length;
  }

  /** Keys of every stored event, to mark preview rows that already exist. */
  existingKeys(): Set<string> {
    return new Set(this.data.events.map(eventKey));
  }

  add(input: unknown): CalendarEvent {
    this.syncFromStorage();
    const clean = sanitizeInput(input);
    this.ensureRoom(1);
    const stamp = this.now().toISOString();
    const event: CalendarEvent = {
      ...clean,
      id: this.newId(),
      source: clean.source ?? MANUAL_SOURCE,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.commit({ ...this.data, events: [...this.data.events, event] });
    return event;
  }

  /** Applies a partial change; id, source, batch and creation time stay. */
  update(id: string, patch: Partial<EventInput>): CalendarEvent {
    this.syncFromStorage();
    const current = this.get(id);
    if (!current) throw new EventValidationError('id', '일정을 찾을 수 없습니다.');
    const merged: Record<string, unknown> = { ...current, ...patch };
    // Switching to an all-day event drops the times.
    if (patch.allDay === true) {
      delete merged.time;
      delete merged.endTime;
    }
    const clean = sanitizeInput(merged);
    const next: CalendarEvent = {
      ...clean,
      id: current.id,
      source: current.source,
      createdAt: current.createdAt,
      updatedAt: this.now().toISOString(),
    };
    if (current.batchId) next.batchId = current.batchId;
    else delete next.batchId;
    this.commit({
      ...this.data,
      events: this.data.events.map((e) => (e.id === id ? next : e)),
    });
    return next;
  }

  remove(id: string): boolean {
    this.syncFromStorage();
    const events = this.data.events.filter((e) => e.id !== id);
    if (events.length === this.data.events.length) return false;
    this.commit({ ...this.data, events });
    return true;
  }

  /**
   * Adds checked preview rows as one batch. Rows whose title and dates
   * already exist are skipped, so importing the same file twice adds nothing.
   */
  commitImport(
    rows: readonly ImportedEvent[],
    meta: { source: string; label: string; tags?: readonly string[] },
  ): ImportCommitResult {
    this.syncFromStorage();
    const batchId = this.newId();
    const stamp = this.now().toISOString();
    const keys = this.existingKeys();
    const tags = normalizeTags(meta.tags ?? []);
    const added: CalendarEvent[] = [];
    const invalid: InvalidImportRow[] = [];
    let skipped = 0;
    for (const [index, row] of rows.entries()) {
      const clean = cleanImportRow(row, tags);
      if (!clean.ok) {
        invalid.push({ index, message: clean.message });
        continue;
      }
      const key = eventKey(clean.value);
      if (keys.has(key)) {
        skipped++;
        continue;
      }
      keys.add(key);
      added.push({
        ...clean.value,
        id: this.newId(),
        source: meta.source.slice(0, 200),
        batchId,
        createdAt: stamp,
        updatedAt: stamp,
      });
    }
    this.ensureRoom(added.length);
    const batch: ImportBatch = {
      id: batchId,
      source: meta.source.slice(0, 200),
      label: meta.label.slice(0, 200),
      importedAt: stamp,
      count: added.length,
    };
    this.commit({
      ...this.data,
      events: [...this.data.events, ...added],
      batches: added.length ? [...this.data.batches, batch] : this.data.batches,
    });
    return { batch, added, skipped, invalid };
  }

  /** Deletes every event of an import batch, edited ones included. Returns how many. */
  removeBatch(batchId: string): number {
    this.syncFromStorage();
    const events = this.data.events.filter((e) => e.batchId !== batchId);
    const removed = this.data.events.length - events.length;
    const batches = this.data.batches.filter((b) => b.id !== batchId);
    if (!removed && batches.length === this.data.batches.length) return 0;
    this.commit({ ...this.data, events, batches });
    return removed;
  }

  /** Deletes every event that came from a source (all imports of one file or school). */
  removeSource(source: string): number {
    this.syncFromStorage();
    const events = this.data.events.filter((e) => e.source !== source);
    const removed = this.data.events.length - events.length;
    const batches = this.data.batches.filter((b) => b.source !== source);
    if (!removed && batches.length === this.data.batches.length) return 0;
    this.commit({ ...this.data, events, batches });
    return removed;
  }

  exportBackup(): string {
    return JSON.stringify(
      {
        app: BACKUP_APP,
        version: 1,
        exportedAt: this.now().toISOString(),
        events: this.data.events,
        batches: this.data.batches,
      },
      null,
      2,
    );
  }

  /**
   * Reads a backup made by `exportBackup`. `merge` keeps current events and
   * adds the ones not present; `replace` swaps everything for the backup.
   */
  restoreBackup(text: string, mode: 'merge' | 'replace'): RestoreResult {
    if (text.length > MAX_BACKUP_CHARS) throw new BackupFormatError('백업 파일이 너무 큽니다.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new BackupFormatError('JSON 파일이 아닙니다.');
    }
    this.syncFromStorage();
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as Record<string, unknown>).app !== BACKUP_APP ||
      !Array.isArray((parsed as Record<string, unknown>).events)
    ) {
      throw new BackupFormatError('datebook 백업 파일이 아닙니다.');
    }
    const doc = parsed as { events: unknown[]; batches?: unknown };
    const stamp = this.now().toISOString();
    const base = mode === 'replace' ? [] : this.data.events;
    const ids = new Set(base.map((e) => e.id));
    const keys = new Set(base.map(eventKey));
    const result: RestoreResult = { added: 0, skipped: 0, invalid: 0 };
    const incoming: CalendarEvent[] = [];
    for (const row of doc.events) {
      const event = reviveEvent(row, stamp, this.newId);
      if (!event) {
        result.invalid++;
        continue;
      }
      const key = eventKey(event);
      if (ids.has(event.id) || keys.has(key)) {
        result.skipped++;
        continue;
      }
      ids.add(event.id);
      keys.add(key);
      incoming.push(event);
      result.added++;
    }
    const events = [...base, ...incoming];
    if (events.length > LIMITS.events) {
      throw new BackupFormatError(`일정은 ${LIMITS.events}개까지 저장할 수 있습니다.`);
    }
    const batchIds = new Set(events.map((e) => e.batchId).filter(Boolean));
    const knownBatches = mode === 'replace' ? [] : this.data.batches;
    const batches = [...knownBatches];
    for (const b of Array.isArray(doc.batches) ? doc.batches : []) {
      const batch = reviveBatch(b);
      if (batch && batchIds.has(batch.id) && !batches.some((x) => x.id === batch.id)) {
        batches.push(batch);
      }
    }
    this.commit({ version: 1, events, batches });
    return result;
  }

  private ensureRoom(adding: number): void {
    if (this.data.events.length + adding > LIMITS.events) {
      throw new EventValidationError('events', `일정은 ${LIMITS.events}개까지 저장할 수 있습니다.`);
    }
  }

  private commit(next: StoreData): void {
    const text = JSON.stringify(next);
    try {
      this.storage.setItem(this.key, text);
    } catch (err) {
      throw new StoreWriteError(err);
    }
    this.data = next;
    this.seen = text;
    for (const fn of this.listeners) fn();
  }
}

function cleanImportRow(
  row: ImportedEvent,
  tags: string[],
): { ok: true; value: EventInput } | { ok: false; message: string } {
  try {
    return {
      ok: true,
      value: sanitizeInput({
        title: row.title,
        start: row.start,
        end: row.end,
        allDay: row.allDay,
        time: row.time,
        endTime: row.endTime,
        category: row.category,
        grades: row.grades,
        notice: row.notice,
        tags,
      }),
    };
  } catch (err) {
    if (err instanceof EventValidationError) return { ok: false, message: err.message };
    throw err;
  }
}

function readStoreData(raw: string): StoreData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const doc = parsed as Record<string, unknown>;
  if (doc.version !== 1 || !Array.isArray(doc.events)) return null;
  const stamp = new Date().toISOString();
  const events: CalendarEvent[] = [];
  for (const row of doc.events) {
    const event = reviveEvent(row, stamp, randomId);
    if (event) events.push(event);
  }
  const batches: ImportBatch[] = [];
  for (const b of Array.isArray(doc.batches) ? doc.batches : []) {
    const batch = reviveBatch(b);
    if (batch) batches.push(batch);
  }
  return { version: 1, events, batches };
}

function reviveEvent(row: unknown, stamp: string, newId: () => string): CalendarEvent | null {
  let clean: EventInput;
  try {
    clean = sanitizeInput(row);
  } catch {
    return null;
  }
  const r = row as Record<string, unknown>;
  return {
    ...clean,
    id: typeof r.id === 'string' && ID.test(r.id) ? r.id : newId(),
    source: clean.source ?? MANUAL_SOURCE,
    createdAt: isTimestamp(r.createdAt) ? r.createdAt : stamp,
    updatedAt: isTimestamp(r.updatedAt) ? r.updatedAt : stamp,
  };
}

function reviveBatch(row: unknown): ImportBatch | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== 'string' || !ID.test(r.id)) return null;
  if (typeof r.source !== 'string' || typeof r.label !== 'string') return null;
  return {
    id: r.id,
    source: r.source.slice(0, 200),
    label: r.label.slice(0, 200),
    importedAt: isTimestamp(r.importedAt) ? r.importedAt : new Date(0).toISOString(),
    count: Number.isInteger(r.count) && (r.count as number) >= 0 ? (r.count as number) : 0,
  };
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 40 &&
    isIsoDate(value.slice(0, 10)) &&
    !Number.isNaN(Date.parse(value))
  );
}
