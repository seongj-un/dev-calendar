import { BackupFormatError, StoreWriteError, type EventStore } from '../../store/store';
import { eventsToIcs } from './ics';
import { downloadText, exportFileName, FileTooLargeError, pickTextFile } from './files';

/** Checked on the file's size before reading it; the store checks the text again. */
const MAX_BACKUP_BYTES = 10_000_000;

export type ExportFormat = 'ics' | 'json';

/** Saves every event (not only the ones the grade filter shows) and says what happened. */
export function exportEvents(store: EventStore, format: ExportFormat, now: Date): string {
  const events = store.list();
  if (!events.length) return '내보낼 일정이 없습니다.';
  if (format === 'ics') {
    downloadText(
      exportFileName(now, 'ics'),
      eventsToIcs(events, { now }),
      'text/calendar;charset=utf-8',
    );
    return `일정 ${events.length}개를 .ics 파일로 내보냈습니다.`;
  }
  downloadText(exportFileName(now, 'json'), store.exportBackup(), 'application/json');
  return `일정 ${events.length}개를 JSON 백업으로 내보냈습니다.`;
}

/**
 * Lets the person pick a backup and merges it in. Events already present are
 * kept as they are. Returns the sentence to show.
 */
export async function importBackupFile(store: EventStore): Promise<string | null> {
  let file: { name: string; text: string } | null;
  try {
    file = await pickTextFile('.json,application/json', MAX_BACKUP_BYTES);
  } catch (err) {
    if (err instanceof FileTooLargeError) return '백업 파일이 너무 큽니다.';
    return '파일을 읽지 못했습니다.';
  }
  if (!file) return null;
  try {
    const r = store.restoreBackup(file.text, 'merge');
    const parts = [`새 일정 ${r.added}개`];
    if (r.skipped) parts.push(`이미 있어서 건너뜀 ${r.skipped}개`);
    if (r.invalid) parts.push(`읽지 못함 ${r.invalid}개`);
    return `백업을 가져왔습니다. ${parts.join(', ')}`;
  } catch (err) {
    if (err instanceof BackupFormatError || err instanceof StoreWriteError) return err.message;
    throw err;
  }
}
