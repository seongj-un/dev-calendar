import type { CalendarEvent } from '../../model/event';
import type { EventStore, ImportBatch } from '../../store/store';

export interface BatchInfo {
  batch: ImportBatch;
  /** Events of this import still in the calendar. */
  count: number;
  /** Events the person changed after the import. */
  edited: number;
  firstDate: string | null;
  kind: 'file' | 'school';
  /** A NEIS import made without a key holds only a sample. */
  sample: boolean;
}

function isEdited(e: CalendarEvent): boolean {
  return e.updatedAt !== e.createdAt;
}

/** Import batches, newest first, with what is left of each. */
export function batchInfos(store: EventStore): BatchInfo[] {
  const events = store.list();
  return [...store.batches()]
    .sort((a, b) => b.importedAt.localeCompare(a.importedAt))
    .map((batch) => {
      const own = events.filter((e) => e.batchId === batch.id);
      const first = own.map((e) => e.start).sort()[0] ?? null;
      const school = batch.source.startsWith('neis:');
      return {
        batch,
        count: own.length,
        edited: own.filter(isEdited).length,
        firstDate: first,
        kind: school ? 'school' : 'file',
        // Without a key NEIS answers five rows; a batch that small from NEIS is a sample.
        sample: school && batch.count <= 5,
      };
    });
}

/** "12월 8일 21:14" in the browser's time zone. */
export function stampText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${hh}:${mm}`;
}

export function batchLine(info: BatchInfo): string {
  const parts = [
    info.kind === 'school' ? '나이스' : '파일',
    `일정 ${info.count}개`,
    stampText(info.batch.importedAt),
  ];
  if (info.edited) parts.push(`고친 일정 ${info.edited}개`);
  if (info.sample) parts.push('인증키 없이 가져옴');
  return parts.filter(Boolean).join(' · ');
}
