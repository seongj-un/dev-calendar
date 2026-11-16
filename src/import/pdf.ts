import { detectAcademicYear, parseDateText } from './text';
import { finalizeRows } from './finalize';
import { parseMonthGrid, pdfTextLines, type PdfPageText, type PdfTextItem } from './pdfGrid';
import type { ImportResult } from './types';

type Pdfjs = typeof import('pdfjs-dist');

export const MAX_PDF_PAGES = 40;

/** Loads pdf.js and points it at its worker file (a separate chunk). */
export async function loadPdfjs(): Promise<Pdfjs> {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
}

/**
 * Fill color of every text item. pdf.js gives colors only in the operator
 * list, so this walks `showText` glyphs in drawing order and lines their
 * characters up with the text items, which come in the same order. Returns
 * null when the two streams do not line up.
 */
export function colorsForItems(
  ops: { fnArray: number[]; argsArray: unknown[][] },
  OPS: Record<string, number>,
  items: TextItemLike[],
): (string | undefined)[] | null {
  const chars: string[] = [];
  const colors: string[] = [];
  let color = '#000000';
  const stack: string[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(color);
    else if (fn === OPS.restore) color = stack.pop() ?? color;
    else if (fn === OPS.setFillRGBColor && typeof args?.[0] === 'string') color = args[0];
    else if (fn === OPS.showText && Array.isArray(args?.[0])) {
      for (const glyph of args[0] as unknown[]) {
        const unicode = (glyph as { unicode?: unknown } | null)?.unicode;
        if (typeof unicode !== 'string') continue;
        for (const ch of unicode) {
          if (/\s/.test(ch)) continue;
          chars.push(ch);
          colors.push(color);
        }
      }
    }
  }
  const out: (string | undefined)[] = [];
  let k = 0;
  for (const it of items) {
    let first: string | undefined;
    for (const ch of it.str) {
      if (/\s/.test(ch)) continue;
      if (chars[k] !== ch) return null;
      first ??= colors[k];
      k++;
    }
    out.push(first);
  }
  return out;
}

export interface PdfReadResult {
  pages: PdfPageText[];
  numPages: number;
  /** False when colors could not be matched to text on some page. */
  colorsKnown: boolean;
}

export async function readPdfText(
  data: Uint8Array,
  pdfjs: Pdfjs,
  options: { cMapUrl?: string } = {},
): Promise<PdfReadResult> {
  const task = pdfjs.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    ...(options.cMapUrl ? { cMapUrl: options.cMapUrl, cMapPacked: true } : {}),
  });
  try {
    const doc = await task.promise;
    const numPages = doc.numPages;
    const pages: PdfPageText[] = [];
    let colorsKnown = true;
    for (let p = 1; p <= Math.min(numPages, MAX_PDF_PAGES); p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent({ disableNormalization: true });
      const textItems = content.items.filter(
        (it): it is (typeof content.items)[number] & TextItemLike => 'str' in it,
      );
      const ops = await page.getOperatorList();
      const colors = colorsForItems(
        ops as unknown as { fnArray: number[]; argsArray: unknown[][] },
        pdfjs.OPS as unknown as Record<string, number>,
        textItems,
      );
      if (!colors) colorsKnown = false;
      const items: PdfTextItem[] = textItems.map((it, i) => {
        const [a = 1, b = 0, , , e = 0, f = 0] = it.transform;
        const item: PdfTextItem = {
          str: it.str,
          x: e,
          y: f,
          width: it.width,
          size: Math.hypot(a, b),
        };
        const c = colors?.[i];
        if (c) item.color = c;
        return item;
      });
      pages.push({ items });
      page.cleanup();
    }
    return { pages, numPages, colorsKnown };
  } finally {
    await task.destroy();
  }
}

export interface PdfImportOptions {
  academicYear?: number;
  today?: Date;
  pdfjs?: Pdfjs;
  cMapUrl?: string;
}

export async function parsePdf(
  data: ArrayBuffer | Uint8Array,
  fileName: string,
  options: PdfImportOptions = {},
): Promise<ImportResult> {
  const pdfjs = options.pdfjs ?? (await loadPdfjs());
  // A plain copy: pdf.js rejects Node Buffers and may detach the array it gets.
  const bytes = new Uint8Array(data);
  const read = await readPdfText(bytes, pdfjs, { cMapUrl: options.cMapUrl });
  const base = {
    source: `file:${fileName}`,
    label: fileName,
    pages: read.numPages,
  };
  const allText = read.pages.flatMap((p) => p.items.map((it) => it.str)).join(' ');
  if (!allText.replace(/\s/g, '')) {
    return {
      ...base,
      kind: 'pdf-text',
      events: [],
      warnings: [
        {
          code: 'no-text',
          message: 'PDF에서 글자를 찾지 못했습니다. 스캔한 PDF는 읽을 수 없습니다.',
        },
      ],
    };
  }
  const warnings: ImportResult['warnings'] = [];
  if (read.numPages > MAX_PDF_PAGES) {
    warnings.push({
      code: 'too-large',
      message: `앞의 ${MAX_PDF_PAGES}쪽만 읽었습니다.`,
    });
  }
  const fallbackYear = detectAcademicYear(allText, options.today);

  const grid = parseMonthGrid(read.pages, { academicYear: options.academicYear, fallbackYear });
  if (grid && grid.events.length) {
    return {
      ...base,
      kind: 'pdf-grid',
      academicYear: grid.academicYear,
      events: finalizeRows(grid.events, {
        holidayByName: !read.colorsKnown,
        bridgeOccupied: true,
      }),
      warnings,
    };
  }

  const parsed = parseDateText(pdfTextLines(read.pages), {
    academicYear: options.academicYear ?? fallbackYear,
  });
  const events = finalizeRows(parsed.events, { holidayByName: true });
  if (!events.length) {
    warnings.push({ code: 'no-dates', message: 'PDF에서 날짜가 있는 일정을 찾지 못했습니다.' });
  }
  return { ...base, kind: 'pdf-text', academicYear: parsed.academicYear, events, warnings };
}
