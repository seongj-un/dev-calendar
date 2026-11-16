import { eventKey } from '../model/event';
import type { ImportedEvent, ImportResult } from './types';

/**
 * Entry point for imports. Every parser is a separate chunk loaded only when
 * a file of its type arrives, so the calendar itself stays small.
 */

export type { ImportedEvent, ImportResult, ImportWarning } from './types';

export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

export const ACCEPTED_EXTENSIONS = ['.pdf', '.ics', '.xlsx', '.xls', '.hwp', '.hwpx'] as const;

export interface ImportFileOptions {
  /** Academic year for dates without a year (the preview can change it). */
  academicYear?: number;
  today?: Date;
  /**
   * Set when the person gave up. Parsers run on the main thread and cannot be
   * stopped half way, so this only keeps a cancelled file from starting its
   * next stage (reading, then parsing); the caller drops any answer.
   */
  signal?: AbortSignal;
}

export interface FileLike {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

type Format = 'pdf' | 'ics' | 'xlsx' | 'hwp' | 'hwpx';

/** Format from the first bytes, falling back to the extension. */
export function detectFormat(name: string, head: Uint8Array): Format | null {
  const ascii = String.fromCharCode(...head.subarray(0, 16));
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  if (ascii.startsWith('%PDF')) return 'pdf';
  // OLE compound file: legacy .xls or .hwp.
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) {
    return ext === 'xls' ? 'xlsx' : ext === 'hwp' ? 'hwp' : null;
  }
  // Zip: .xlsx or .hwpx.
  if (head[0] === 0x50 && head[1] === 0x4b) {
    return ext === 'hwpx' ? 'hwpx' : ext === 'xlsx' ? 'xlsx' : null;
  }
  const text = new TextDecoder()
    .decode(head)
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (text.toUpperCase().startsWith('BEGIN:VCALENDAR')) return 'ics';
  return null;
}

function failed(
  name: string,
  code: 'unsupported' | 'too-large' | 'read-failed' | 'cancelled',
  message: string,
): ImportResult {
  return {
    kind: 'text',
    source: `file:${name}`,
    label: name,
    events: [],
    warnings: [{ code, message }],
  };
}

/** Reads a dropped or chosen file into preview rows. Never throws for bad files. */
export async function importFile(
  file: FileLike,
  options: ImportFileOptions = {},
): Promise<ImportResult> {
  const name = file.name.slice(0, 200);
  if (file.size > MAX_IMPORT_BYTES) {
    return failed(name, 'too-large', '20MB보다 큰 파일은 가져올 수 없습니다.');
  }
  let data: ArrayBuffer;
  try {
    data = await file.arrayBuffer();
  } catch {
    return failed(name, 'read-failed', '파일을 읽지 못했습니다.');
  }
  const cancelled = () => failed(name, 'cancelled', '가져오기를 취소했습니다.');
  if (options.signal?.aborted) return cancelled();
  const format = detectFormat(name, new Uint8Array(data.slice(0, 64)));
  try {
    switch (format) {
      case 'pdf': {
        const parser = await import('./pdf');
        return options.signal?.aborted ? cancelled() : await parser.parsePdf(data, name, options);
      }
      case 'ics': {
        const parser = await import('./ics');
        if (options.signal?.aborted) return cancelled();
        return parser.parseIcsText(new TextDecoder().decode(data), name);
      }
      case 'xlsx': {
        const parser = await import('./xlsx');
        return options.signal?.aborted ? cancelled() : await parser.parseXlsx(data, name, options);
      }
      case 'hwp': {
        const parser = await import('./hwp');
        return options.signal?.aborted ? cancelled() : await parser.parseHwp(data, name, options);
      }
      case 'hwpx': {
        const parser = await import('./hwpx');
        return options.signal?.aborted ? cancelled() : await parser.parseHwpx(data, name, options);
      }
      default:
        return failed(
          name,
          'unsupported',
          'PDF, 캘린더(.ics), 엑셀(.xlsx, .xls), 한글(.hwp, .hwpx) 파일만 가져올 수 있습니다.',
        );
    }
  } catch (err) {
    console.error('import failed', err);
    return failed(
      name,
      'read-failed',
      '파일을 읽는 중에 문제가 생겼습니다. 파일이 손상되었을 수 있습니다.',
    );
  }
}

/** Loads the NEIS client (school search and schedule) on demand. */
export function loadNeis() {
  return import('./neis');
}

/** Marks preview rows whose title and dates are already in the calendar. */
export function markExisting(
  events: readonly ImportedEvent[],
  existing: ReadonlySet<string>,
): (ImportedEvent & { exists: boolean })[] {
  return events.map((e) => ({ ...e, exists: existing.has(eventKey(e)) }));
}
