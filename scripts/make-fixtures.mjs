// Builds the spreadsheet and Hangul test fixtures in tests/fixtures.
// Run with `node scripts/make-fixtures.mjs`; the outputs are committed.
import { writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import CFB from 'cfb';

const out = (name) => new URL(`../tests/fixtures/${name}`, import.meta.url);

// Excel serial day number (1900 system) for a calendar date.
const serial = (y, m, d, hh = 0, mm = 0) =>
  (Date.UTC(y, m - 1, d, hh, mm) - Date.UTC(1899, 11, 30)) / 86_400_000;
const dateCell = (y, m, d) => ({ t: 'n', v: serial(y, m, d), z: 'yyyy-mm-dd' });
const dateTimeCell = (y, m, d, hh, mm) => ({
  t: 'n',
  v: serial(y, m, d, hh, mm),
  z: 'yyyy-mm-dd hh:mm',
});

// 1. Table layout: a date column, an end-date column, a title column.
function tableWorkbook() {
  const ws = XLSX.utils.aoa_to_sheet([
    ['날짜', '종료일', '행사명', '대상'],
    [null, null, '입학식', '1학년'],
    [null, null, '개학식', '2, 3학년'],
    [null, null, '1학기 중간고사', ''],
    ['5. 5.(화)', null, '어린이날', ''],
    [null, null, '국제인공지능대전 참관', '2학년'],
    [null, null, '겨울방학', ''],
    [],
    [null, null, '비고: 일정은 학교 사정에 따라 바뀔 수 있습니다.', ''],
  ]);
  ws.A2 = dateCell(2026, 3, 2);
  ws.A3 = dateCell(2026, 3, 3);
  ws.A4 = dateCell(2026, 4, 20);
  ws.B4 = dateCell(2026, 4, 24);
  ws.A6 = dateTimeCell(2026, 5, 7, 14, 0);
  ws.A7 = dateCell(2027, 2, 10);
  ws.B7 = dateCell(2027, 2, 16);
  const notes = XLSX.utils.aoa_to_sheet([['메모'], ['학부모 상담 주간은 따로 안내합니다.']]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, notes, '메모');
  XLSX.utils.book_append_sheet(wb, ws, '2026학년도');
  return wb;
}
writeFileSync(
  out('schedule-table.xlsx'),
  XLSX.write(tableWorkbook(), { type: 'buffer', bookType: 'xlsx' }),
);
writeFileSync(
  out('schedule-table.xls'),
  XLSX.write(tableWorkbook(), { type: 'buffer', bookType: 'biff8' }),
);

// 2. Month-column grid, the layout the school PDF was printed from.
function gridWorkbook() {
  const rows = [['2026학년도 학사일정'], ['요일', '3월', null, '4월', null]];
  const events = {
    '3-1': '3.1절',
    '3-3': '입학식(1)\n개학식(2,3)',
    '3-10': '신입생전공멘토링\n(10일-19일)',
    '4-20': '1학기 중간고사',
    '4-21': '1학기 중간고사',
    '4-22': '1학기 중간고사',
    '4-24': '[의무귀가]',
  };
  for (let row = 0; row < 37; row++) {
    const march = row + 1; // 2026-03-01 is a Sunday
    const april = row - 2; // 2026-04-01 is a Wednesday
    const r = ['일월화수목금토'[row % 7], null, null, null, null];
    if (march <= 31) {
      r[1] = march;
      r[2] = events[`3-${march}`] ?? null;
    }
    if (april >= 1 && april <= 30) {
      r[3] = april;
      r[4] = events[`4-${april}`] ?? null;
    }
    rows.push(r);
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '1학기');
  return wb;
}
writeFileSync(
  out('schedule-grid.xlsx'),
  XLSX.write(gridWorkbook(), { type: 'buffer', bookType: 'xlsx' }),
);

// 3. HWPX: a heading, a table (날짜 | 행사 | 비고) inside a paragraph run, and a note.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const para = (text) => `<hp:p><hp:run><hp:t>${esc(text)}</hp:t></hp:run></hp:p>`;
const cell = (text) => `<hp:tc><hp:subList>${para(text)}</hp:subList></hp:tc>`;
const tableRows = [
  ['날짜', '행사', '비고'],
  ['3. 2.(월)', '입학식(1)', ''],
  ['3. 3.(화)', '개학식(2,3)', ''],
  ['4. 20.(월) ~ 4. 24.(금)', '1학기 중간고사', '오전만 수업'],
  ['5. 5.(화)', '어린이날', ''],
  ['7. 17.(금) ~ 8. 16.(일)', '여름방학', ''],
  ['2027. 1. 7.(목)', '졸업식 & 종업식', ''],
];
const sectionXml =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">' +
  para('2026학년도 학사일정') +
  '<hp:p><hp:run><hp:tbl rowCnt="7" colCnt="3">' +
  tableRows.map((r) => `<hp:tr>${r.map(cell).join('')}</hp:tr>`).join('') +
  '</hp:tbl></hp:run></hp:p>' +
  '<hp:p><hp:run><hp:t>※ 학사일정은 학교 사정에 따라<hp:tab/>바뀔 수 있습니다.</hp:t></hp:run></hp:p>' +
  '</hs:sec>';
const hwpx = new JSZip();
hwpx.file('mimetype', 'application/hwp+zip', { compression: 'STORE' });
hwpx.file(
  'META-INF/container.xml',
  '<?xml version="1.0" encoding="UTF-8"?><ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></ocf:rootfiles></ocf:container>',
);
hwpx.file(
  'Contents/content.hpf',
  '<?xml version="1.0" encoding="UTF-8"?><opf:package xmlns:opf="http://www.idpf.org/2007/opf/"><opf:manifest><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="section0"/></opf:spine></opf:package>',
);
hwpx.file('Contents/section0.xml', sectionXml);
writeFileSync(
  out('schedule.hwpx'),
  await hwpx.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
);

// 4. HWP 5.0: compressed BodyText with paragraphs and a table (월 | 일 | 요일 | 행사).
function record(tag, level, data) {
  const size = data.length;
  const big = size >= 0xfff;
  const head = Buffer.alloc(big ? 8 : 4);
  head.writeUInt32LE((tag & 0x3ff) | ((level & 0x3ff) << 10) | ((big ? 0xfff : size) << 20), 0);
  if (big) head.writeUInt32LE(size, 4);
  return Buffer.concat([head, data]);
}
const utf16 = (units) => {
  const b = Buffer.alloc(units.length * 2);
  units.forEach((u, i) => b.writeUInt16LE(u, i * 2));
  return b;
};
const textUnits = (s) => [...s].map((ch) => ch.charCodeAt(0));
const PARA_HEADER = 0x10 + 50;
const PARA_TEXT = 0x10 + 51;
const CTRL_HEADER = 0x10 + 55;
const LIST_HEADER = 0x10 + 56;
const TABLE = 0x10 + 61;
const TBL_ID = ((0x74 << 24) | (0x62 << 16) | (0x6c << 8) | 0x20) >>> 0;

function hwpParagraph(level, text) {
  return [
    record(PARA_HEADER, level, Buffer.alloc(22)),
    // A tab (inline control, 8 units) inside the text checks control skipping.
    record(PARA_TEXT, level + 1, utf16([...textUnits(text), 0x0d])),
  ];
}
function hwpTable(level, rows) {
  const ctrlUnits = [0x0b, TBL_ID & 0xffff, TBL_ID >>> 16, 0, 0, 0, 0, 0x0b, 0x0d];
  const ctrl = Buffer.alloc(44);
  ctrl.writeUInt32LE(TBL_ID, 0);
  const recs = [
    record(PARA_HEADER, level, Buffer.alloc(22)),
    record(PARA_TEXT, level + 1, utf16(ctrlUnits)),
    record(CTRL_HEADER, level + 1, ctrl),
    record(TABLE, level + 2, Buffer.alloc(30)),
  ];
  rows.forEach((cells, row) =>
    cells.forEach((text, col) => {
      const lh = Buffer.alloc(40);
      lh.writeUInt16LE(1, 0);
      lh.writeUInt16LE(col, 8);
      lh.writeUInt16LE(row, 10);
      lh.writeUInt16LE(1, 12);
      lh.writeUInt16LE(1, 14);
      recs.push(record(LIST_HEADER, level + 2, lh), ...hwpParagraph(level + 2, text));
    }),
  );
  return recs;
}
const body = Buffer.concat([
  ...hwpParagraph(0, '2026학년도 학사일정'),
  ...hwpTable(0, [
    ['월', '일', '요일', '행사'],
    ['3월', '2', '월', '입학식'],
    ['', '3', '화', '개학식'],
    ['4월', '20', '월', '1학기 중간고사'],
    ['', '21', '화', '1학기 중간고사'],
    ['', '', '', ''],
    ['5월', '5', '화', '어린이날'],
  ]),
  record(PARA_HEADER, 0, Buffer.alloc(22)),
  record(
    PARA_TEXT,
    1,
    utf16([
      ...textUnits('여름방학:'),
      9,
      0,
      0,
      0,
      0,
      0,
      0,
      9,
      ...textUnits('7. 17.(금) ~ 8. 16.(일)'),
      0x0d,
    ]),
  ),
]);
const fileHeader = Buffer.alloc(256);
fileHeader.write('HWP Document File', 0, 'latin1');
fileHeader.writeUInt32LE(0x05000300, 32); // 5.0.3.0
fileHeader.writeUInt32LE(1, 36); // compressed
const hwp = CFB.utils.cfb_new();
CFB.utils.cfb_add(hwp, '/FileHeader', fileHeader);
CFB.utils.cfb_add(hwp, '/DocInfo', deflateRawSync(Buffer.alloc(0)));
CFB.utils.cfb_add(hwp, '/BodyText/Section0', deflateRawSync(body));
writeFileSync(out('schedule.hwp'), CFB.write(hwp, { type: 'buffer' }));

console.log('fixtures written');
