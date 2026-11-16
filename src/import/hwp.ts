import { MAX_PART_BYTES, MAX_SECTIONS, MAX_TOTAL_BYTES, type InflateLimits } from './limits';
import { resultFromBlocks, type DocBlock, type DocumentImportOptions } from './document';
import type { ImportResult } from './types';

/**
 * HWP 5.0 (binary) text extraction.
 *
 * The file is an OLE compound file. `FileHeader` says whether streams are
 * compressed or encrypted; `BodyText/SectionN` streams hold records
 * (raw-deflated when compressed). Paragraph text is in PARA_TEXT records as
 * UTF-16LE with inline control codes. Table cells are LIST_HEADER records
 * carrying their row and column, so each table row comes out as one line.
 */

type Cfb = typeof import('cfb');

export const MAX_HWP_SECTION_BYTES = MAX_PART_BYTES;

const TAG_BEGIN = 0x10;
const TAG_PARA_TEXT = TAG_BEGIN + 51;
const TAG_CTRL_HEADER = TAG_BEGIN + 55;
const TAG_LIST_HEADER = TAG_BEGIN + 56;

/** 'tbl ' as HWP stores control ids: a big-endian four-character code read as little-endian UINT32. */
const CTRL_TABLE = (0x74 << 24) | (0x62 << 16) | (0x6c << 8) | 0x20;

export class HwpReadError extends Error {
  constructor(
    readonly code:
      'not-hwp' | 'old-version' | 'encrypted' | 'distribution' | 'too-large' | 'corrupt',
  ) {
    super(code);
    this.name = 'HwpReadError';
  }
}

export async function loadCfb(): Promise<Cfb> {
  const mod = (await import('cfb')) as unknown as { default?: Cfb } & Cfb;
  return mod.default ?? mod;
}

/** Inflates a raw deflate stream, refusing output larger than `limit`. */
export async function inflateRaw(
  data: Uint8Array,
  limit = MAX_HWP_SECTION_BYTES,
): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new HwpReadError('too-large');
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof HwpReadError) throw err;
    // Hangul pads section streams after the end of the deflate data. Browsers
    // and Node report that padding as an error only after delivering all the
    // data, so output received so far is the whole section.
    if (!size) throw new HwpReadError('corrupt');
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export interface HwpRecord {
  tag: number;
  level: number;
  data: Uint8Array;
}

export function readRecords(bytes: Uint8Array): HwpRecord[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records: HwpRecord[] = [];
  let at = 0;
  while (at + 4 <= bytes.length) {
    const header = view.getUint32(at, true);
    at += 4;
    const tag = header & 0x3ff;
    const level = (header >>> 10) & 0x3ff;
    let size = header >>> 20;
    if (size === 0xfff) {
      if (at + 4 > bytes.length) break;
      size = view.getUint32(at, true);
      at += 4;
    }
    if (at + size > bytes.length) break;
    records.push({ tag, level, data: bytes.subarray(at, at + size) });
    at += size;
  }
  return records;
}

/**
 * Text of a PARA_TEXT record. Codes below 32 are controls: 0, 10, 13 and
 * 24-31 take one unit; the others take eight (the code, six data units and
 * the code again). Tabs and line breaks become spaces.
 */
export function paraText(data: Uint8Array): string {
  const units = new Uint16Array(
    data.buffer.slice(data.byteOffset, data.byteOffset + (data.byteLength & ~1)),
  );
  let out = '';
  for (let i = 0; i < units.length; i++) {
    const c = units[i]!;
    if (c >= 32) {
      out += String.fromCharCode(c);
      continue;
    }
    if (c === 9) out += ' ';
    else if (c === 10) out += ' ';
    if (c === 0 || c === 10 || c === 13 || (c >= 24 && c <= 31)) continue;
    i += 7;
  }
  return out;
}

interface OpenTable {
  level: number;
  rows: Map<number, Map<number, string[]>>;
  cell: string[] | null;
}

/** Rows ordered by row address, cells placed at their column address (gaps stay empty). */
function tableRows(rows: Map<number, Map<number, string[]>>): string[][][] {
  return [...rows.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, cols]) => {
      const width = Math.max(...cols.keys()) + 1;
      return Array.from({ length: width }, (_, c) => cols.get(c) ?? []);
    });
}

/** Blocks of one section: paragraphs, and tables with their cells in place. */
export function sectionBlocks(records: readonly HwpRecord[]): DocBlock[] {
  const blocks: DocBlock[] = [];
  const tables: OpenTable[] = [];

  const closeTablesAbove = (level: number) => {
    while (tables.length && level <= tables[tables.length - 1]!.level) {
      const t = tables.pop()!;
      const rows = tableRows(t.rows);
      const outer = tables[tables.length - 1];
      if (outer?.cell) {
        // A table inside a cell becomes lines of that cell.
        for (const row of rows) {
          const line = row.map((c) => c.join(' ')).join(' | ');
          if (line.replace(/[\s|]/g, '')) outer.cell.push(line);
        }
      } else if (rows.length) {
        blocks.push({ kind: 'table', rows });
      }
    }
  };

  for (const r of records) {
    closeTablesAbove(r.level);
    if (r.tag === TAG_CTRL_HEADER && r.data.length >= 4) {
      const id = new DataView(r.data.buffer, r.data.byteOffset, 4).getUint32(0, true);
      if (id === CTRL_TABLE) tables.push({ level: r.level, rows: new Map(), cell: null });
      continue;
    }
    const table = tables[tables.length - 1];
    if (r.tag === TAG_LIST_HEADER && table && r.level === table.level + 1 && r.data.length >= 12) {
      // Paragraph count (2), unknown (2), list properties (4), then column (2) and row (2).
      const view = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength);
      const col = view.getUint16(8, true);
      const row = view.getUint16(10, true);
      const cols = table.rows.get(row) ?? new Map<number, string[]>();
      table.cell = cols.get(col) ?? [];
      cols.set(col, table.cell);
      table.rows.set(row, cols);
      continue;
    }
    if (r.tag === TAG_PARA_TEXT) {
      const text = paraText(r.data).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (table?.cell) table.cell.push(text);
      else blocks.push({ kind: 'para', text });
    }
  }
  closeTablesAbove(0);
  return blocks;
}

export async function hwpBlocks(
  data: Uint8Array,
  CFB: Cfb,
  limits: InflateLimits = {},
): Promise<DocBlock[]> {
  const maxPart = limits.maxPartBytes ?? MAX_PART_BYTES;
  let budget = limits.maxTotalBytes ?? MAX_TOTAL_BYTES;
  let container: ReturnType<Cfb['read']>;
  try {
    container = CFB.read(data, { type: 'array' });
  } catch {
    throw new HwpReadError('not-hwp');
  }
  const header = CFB.find(container, 'FileHeader');
  const head = header?.content ? Uint8Array.from(header.content as ArrayLike<number>) : null;
  if (!head || head.length < 40) throw new HwpReadError('not-hwp');
  const signature = new TextDecoder().decode(head.subarray(0, 17));
  if (signature !== 'HWP Document File') throw new HwpReadError('not-hwp');
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const version = view.getUint32(32, true);
  if (version >>> 24 < 5) throw new HwpReadError('old-version');
  const flags = view.getUint32(36, true);
  if (flags & 0b10) throw new HwpReadError('encrypted');
  if (flags & 0b100) throw new HwpReadError('distribution');
  const compressed = (flags & 1) === 1;

  const sections = container.FullPaths.map((path, i) => ({
    i,
    n: /\/BodyText\/Section(\d+)$/i.exec(path)?.[1],
  }))
    .filter((x): x is { i: number; n: string } => x.n !== undefined)
    .sort((a, b) => Number(a.n) - Number(b.n));
  if (sections.length > (limits.maxSections ?? MAX_SECTIONS)) throw new HwpReadError('too-large');
  const blocks: DocBlock[] = [];
  for (const { i } of sections) {
    const content = container.FileIndex[i]?.content;
    if (!content) continue;
    const raw = Uint8Array.from(content as ArrayLike<number>);
    const room = Math.min(maxPart, budget);
    if (raw.length > room) throw new HwpReadError('too-large');
    const bytes = compressed ? await inflateRaw(raw, room) : raw;
    budget -= bytes.length;
    blocks.push(...sectionBlocks(readRecords(bytes)));
  }
  return blocks;
}

const MESSAGES: Record<HwpReadError['code'], string> = {
  'not-hwp': 'HWP 파일이 아니거나 손상된 파일입니다.',
  'old-version':
    'HWP 3.0 이하 형식은 읽을 수 없습니다. 한글에서 HWP 5.0 이상이나 HWPX로 저장해 주세요.',
  encrypted: '암호가 걸린 한글 파일은 읽을 수 없습니다.',
  distribution: '배포용으로 저장된 한글 파일은 읽을 수 없습니다. PDF로 받아 주세요.',
  'too-large': '한글 파일의 본문이 너무 커서 읽지 않았습니다.',
  corrupt: '한글 파일의 본문을 풀지 못했습니다. 파일이 손상되었을 수 있습니다.',
};

export async function parseHwp(
  data: ArrayBuffer | Uint8Array,
  fileName: string,
  options: DocumentImportOptions & { cfb?: Cfb } = {},
): Promise<ImportResult> {
  const CFB = options.cfb ?? (await loadCfb());
  let blocks: DocBlock[];
  try {
    blocks = await hwpBlocks(new Uint8Array(data), CFB);
  } catch (err) {
    if (!(err instanceof HwpReadError)) throw err;
    return {
      kind: 'hwp',
      source: `file:${fileName}`,
      label: fileName,
      events: [],
      warnings: [
        {
          code:
            err.code === 'too-large'
              ? 'too-large'
              : err.code === 'not-hwp' || err.code === 'corrupt'
                ? 'read-failed'
                : 'unsupported',
          message: MESSAGES[err.code],
        },
      ],
    };
  }
  return resultFromBlocks('hwp', blocks, fileName, options);
}
