import { resultFromBlocks, type DocBlock, type DocumentImportOptions } from './document';
import { MAX_PART_BYTES, MAX_SECTIONS, MAX_TOTAL_BYTES, type InflateLimits } from './limits';
import type { ImportResult } from './types';

/**
 * HWPX (OWPML): a zip of XML parts. Body text lives in
 * Contents/section0.xml, section1.xml, ... as <hp:p> paragraphs with <hp:t>
 * runs; tables are <hp:tbl> > <hp:tr> > <hp:tc>, and each cell names its
 * position in <hp:cellAddr colAddr rowAddr>.
 */

export const MAX_HWPX_PART_BYTES = MAX_PART_BYTES;

/** The part of JSZip this module uses. */
export interface JSZipLike {
  loadAsync(data: Uint8Array): Promise<{
    files: Record<string, { async(type: 'string'): Promise<string> }>;
  }>;
}

interface ZipStreamLike {
  on(event: 'data', fn: (chunk: Uint8Array) => void): ZipStreamLike;
  on(event: 'error', fn: (err: Error) => void): ZipStreamLike;
  on(event: 'end', fn: () => void): ZipStreamLike;
  pause(): ZipStreamLike;
  resume(): ZipStreamLike;
}

interface ZipEntryLike {
  internalStream(type: 'uint8array'): ZipStreamLike;
}

/**
 * Inflates one zip entry while counting the bytes it really produces, and stops
 * as soon as they pass `limit`. The size in the zip header is written by the
 * file's author, so it only serves as a quick first check.
 */
function inflateEntry(entry: object, limit: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let done = false;
    // JSZip's typings leave internalStream out, but it is part of the 3.x API.
    const stream = (entry as ZipEntryLike).internalStream('uint8array');
    stream
      .on('data', (chunk) => {
        if (done) return;
        size += chunk.length;
        if (size > limit) {
          done = true;
          stream.pause();
          reject(new Error('too-large'));
          return;
        }
        chunks.push(chunk);
      })
      .on('error', (err) => {
        if (done) return;
        done = true;
        reject(err);
      })
      .on('end', () => {
        if (done) return;
        done = true;
        const out = new Uint8Array(size);
        let at = 0;
        for (const c of chunks) {
          out.set(c, at);
          at += c.length;
        }
        resolve(out);
      })
      .resume();
  });
}

export async function loadJsZip(): Promise<JSZipLike> {
  const mod = (await import('jszip')) as unknown as { default?: JSZipLike } & JSZipLike;
  return mod.default ?? mod;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeXmlText(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
    if (ent[0] === '#') {
      const code =
        ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : Number(ent.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[ent.toLowerCase()] ?? whole;
  });
}

interface OpenTable {
  rows: string[][][];
  row: string[][] | null;
  cell: string[] | null;
  /** Column of the open cell: its cellAddr, or the next free column. */
  col: number;
}

const numberAttr = (attrs: string, name: string): number | null => {
  const m = new RegExp(`\\b${name}="(\\d+)"`).exec(attrs);
  return m ? Number(m[1]) : null;
};

/**
 * Turns section XML into paragraphs and tables. A streaming tag scan, so it
 * needs no DOM and ignores elements it does not know.
 */
export function sectionBlocks(xml: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  const tables: OpenTable[] = [];
  let paragraph = '';
  let inText = 0;

  const flushParagraph = () => {
    const text = paragraph.replace(/\s+/g, ' ').trim();
    paragraph = '';
    if (!text) return;
    const t = tables[tables.length - 1];
    if (t?.cell) t.cell.push(text);
    else blocks.push({ kind: 'para', text });
  };

  const tag = /<(\/?)(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)([^>]*?)(\/?)>|([^<]+)/g;
  for (const m of xml.matchAll(tag)) {
    const [, closing, name, attrs = '', selfClosing, text] = m;
    if (text !== undefined) {
      if (inText) paragraph += decodeXmlText(text);
      continue;
    }
    const t = tables[tables.length - 1];
    if (!closing) {
      if (name === 't' && !selfClosing) inText++;
      else if (name === 'tab' || name === 'lineBreak') paragraph += ' ';
      else if (name === 'tbl' && !selfClosing) {
        flushParagraph();
        tables.push({ rows: [], row: null, cell: null, col: 0 });
      } else if (name === 'tr' && t) {
        t.row = [];
      } else if (name === 'tc' && t) {
        t.cell = [];
        t.col = t.row?.length ?? 0;
      } else if (name === 'cellAddr' && t?.cell) {
        t.col = numberAttr(attrs, 'colAddr') ?? t.col;
      }
      continue;
    }
    if (name === 't') inText = Math.max(0, inText - 1);
    else if (name === 'p') flushParagraph();
    else if (name === 'tc' && t) {
      flushParagraph();
      if (t.row) {
        while (t.row.length < t.col) t.row.push([]);
        t.row[t.col] = t.cell ?? [];
      }
      t.cell = null;
    } else if (name === 'tr' && t) {
      if (t.row) t.rows.push(t.row);
      t.row = null;
    } else if (name === 'tbl' && t) {
      tables.pop();
      const outer = tables[tables.length - 1];
      if (outer?.cell) {
        // A table inside a cell becomes lines of that cell.
        for (const row of t.rows) {
          const line = row.map((c) => c.join(' ')).join(' | ');
          if (line.replace(/[\s|]/g, '')) outer.cell.push(line);
        }
      } else if (t.rows.length) {
        blocks.push({ kind: 'table', rows: t.rows });
      }
    }
  }
  flushParagraph();
  return blocks;
}

export async function hwpxBlocks(
  data: Uint8Array,
  JSZip: JSZipLike,
  limits: InflateLimits = {},
): Promise<DocBlock[]> {
  const maxPart = limits.maxPartBytes ?? MAX_PART_BYTES;
  let budget = limits.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const zip = await JSZip.loadAsync(data);
  const sections = Object.keys(zip.files)
    .map((name) => ({ name, n: /^Contents\/section(\d+)\.xml$/i.exec(name)?.[1] }))
    .filter((x): x is { name: string; n: string } => x.n !== undefined)
    .sort((a, b) => Number(a.n) - Number(b.n));
  if (!sections.length) throw new Error('not-hwpx');
  if (sections.length > (limits.maxSections ?? MAX_SECTIONS)) throw new Error('too-large');
  const blocks: DocBlock[] = [];
  for (const { name } of sections) {
    const file = zip.files[name]!;
    const size = (file as unknown as { _data?: { uncompressedSize?: number } })._data
      ?.uncompressedSize;
    if (typeof size === 'number' && size > Math.min(maxPart, budget)) throw new Error('too-large');
    const bytes = await inflateEntry(file, Math.min(maxPart, budget));
    budget -= bytes.length;
    blocks.push(...sectionBlocks(new TextDecoder().decode(bytes)));
  }
  return blocks;
}

export async function parseHwpx(
  data: ArrayBuffer | Uint8Array,
  fileName: string,
  options: DocumentImportOptions & { jszip?: JSZipLike } = {},
): Promise<ImportResult> {
  const JSZip = options.jszip ?? (await loadJsZip());
  let blocks: DocBlock[];
  try {
    blocks = await hwpxBlocks(new Uint8Array(data), JSZip);
  } catch (err) {
    const tooLarge = err instanceof Error && err.message === 'too-large';
    return {
      kind: 'hwpx',
      source: `file:${fileName}`,
      label: fileName,
      events: [],
      warnings: [
        tooLarge
          ? { code: 'too-large', message: '한글 파일의 본문이 너무 커서 읽지 않았습니다.' }
          : {
              code: 'read-failed',
              message: 'HWPX 파일을 열지 못했습니다. 파일이 손상되었을 수 있습니다.',
            },
      ],
    };
  }
  return resultFromBlocks('hwpx', blocks, fileName, options);
}
