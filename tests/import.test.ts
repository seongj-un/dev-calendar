import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { detectFormat, importFile, markExisting, type FileLike } from '../src/import';
import { eventKey } from '../src/model/event';

const fileFrom = (name: string, data: Uint8Array): FileLike => ({
  name,
  size: data.byteLength,
  arrayBuffer: async () =>
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
});
const fixture = (name: string) =>
  fileFrom(name, new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url))));
const opts = { today: new Date(2026, 10, 16) };

describe('importFile', () => {
  test('detects formats by content, not only by name', () => {
    const head = (s: string) => new TextEncoder().encode(s);
    expect(detectFormat('a.pdf', head('%PDF-1.7'))).toBe('pdf');
    expect(detectFormat('renamed.txt', head('%PDF-1.4'))).toBe('pdf');
    expect(detectFormat('cal.ics', head('\uFEFFBEGIN:VCALENDAR'))).toBe('ics');
    expect(detectFormat('a.hwp', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toBe('hwp');
    expect(detectFormat('a.xls', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toBe('xlsx');
    expect(detectFormat('a.hwpx', new Uint8Array([0x50, 0x4b, 3, 4]))).toBe('hwpx');
    expect(detectFormat('a.xlsx', new Uint8Array([0x50, 0x4b, 3, 4]))).toBe('xlsx');
    expect(detectFormat('a.docx', new Uint8Array([0x50, 0x4b, 3, 4]))).toBeNull();
    expect(detectFormat('a.pdf', head('<html>'))).toBeNull();
  });

  test.each([
    ['school-2026.ics', 'ics', 7],
    ['schedule-table.xlsx', 'xlsx', 6],
    ['schedule-table.xls', 'xlsx', 6],
    ['schedule-grid.xlsx', 'xlsx', 6],
    ['schedule.hwpx', 'hwpx', 6],
    ['schedule.hwp', 'hwp', 5],
  ])('reads %s', async (name, kind, count) => {
    const r = await importFile(fixture(name), opts);
    expect(r.kind).toBe(kind);
    expect(r.source).toBe(`file:${name}`);
    expect(r.events).toHaveLength(count);
  });

  test('refuses large, unknown and broken files without throwing', async () => {
    const big = {
      name: 'big.pdf',
      size: 30 * 1024 * 1024,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
    expect((await importFile(big)).warnings[0]?.code).toBe('too-large');
    const docx = fileFrom('a.docx', new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]));
    expect((await importFile(docx)).warnings[0]).toMatchObject({ code: 'unsupported' });
    const broken = fileFrom('broken.xlsx', new Uint8Array([0x50, 0x4b, 3, 4, 9, 9, 9]));
    const r = await importFile(broken);
    expect(r.events).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
    const unreadable = {
      name: 'x.pdf',
      size: 10,
      arrayBuffer: () => Promise.reject(new Error('gone')),
    };
    expect((await importFile(unreadable)).warnings[0]?.code).toBe('read-failed');
  });

  test('marks rows already in the calendar', async () => {
    const r = await importFile(fixture('school-2026.ics'), opts);
    const first = r.events[0]!;
    const marked = markExisting(r.events, new Set([eventKey(first)]));
    expect(marked.filter((e) => e.exists).map((e) => e.title)).toEqual([first.title]);
  });
});
