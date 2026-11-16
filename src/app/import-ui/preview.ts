import { CATEGORIES, CATEGORY_LABELS, isCategory, type Category } from '../../model/event';
import type { ImportedEvent } from '../../import/types';
import { h } from '../dom';
import { icon } from '../icons';
import {
  countBy,
  defaultInclude,
  groupByMonth,
  matchesFilter,
  readEditedDate,
  readEditedEnd,
  duplicateIds,
  refreshIncludes,
  rowsToImport,
  shortDate,
  statusOf,
  type PreviewRow,
  type RowContext,
  type RowFilter,
  type RowStatus,
} from './rows';

export interface PreviewProps {
  rows: PreviewRow[];
  ctx: RowContext;
  academicYear: number;
  /** Rows that came from NEIS get no "pages" wording and a school icon. */
  sourceKind: 'file' | 'school';
  sourceLabel: string;
  sourceMeta: string;
  /** Text after "다른" on the back button: 파일 or 학교. */
  changeWord: string;
  notices: string[];
  initialTag: string;
  onGrade(grade: number | null): void;
  onChange(included: number): void;
  onBack(): void;
}

export interface Preview {
  el: HTMLElement;
  /** Rows to import, as edited. */
  included(): ImportedEvent[];
  tags(): string[];
  /** True while a row is open for editing (Esc closes that first). */
  cancelEdit(): boolean;
  focus(): void;
}

const STATUS_WORD: Record<RowStatus, string> = {
  new: '새 일정',
  check: '확인 필요',
  grade: '다른 학년',
  exists: '이미 있음',
};
const FILTERS: [RowFilter, string][] = [
  ['all', '전체'],
  ['check', '확인 필요'],
  ['grade', '다른 학년'],
  ['holiday', '쉬는 날'],
  ['exists', '이미 있음'],
];

function dateText(e: ImportedEvent): string {
  return e.start === e.end ? shortDate(e.start) : `${shortDate(e.start)} – ${shortDate(e.end)}`;
}

export function createPreview(props: PreviewProps): Preview {
  const { rows, ctx } = props;
  let filter: RowFilter = 'all';
  let editing: number | null = null;
  let addedId: number | null = null;
  let nextId = rows.length;

  const heading = h('h3', { class: 'pv-h', tabindex: '-1', 'data-fk': 'preview-h' }, '미리보기');
  const seg = h('div', { class: 'seg seg-sm', role: 'radiogroup', 'aria-label': '보기' });
  const gradeSel = h(
    'select',
    { class: 'in in-sm', id: 'pv-grade' },
    h('option', { value: '' }, '모든 학년'),
    ...[1, 2, 3].map((g) => h('option', { value: g, selected: ctx.grade === g }, `${g}학년`)),
  );
  const tagIn = h('input', {
    class: 'in in-mono',
    id: 'pv-tag',
    type: 'text',
    value: props.initialTag,
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const table = h('table', { class: 'pv-table' });
  const empty = h('p', { class: 'hint-line pv-empty', role: 'status' });
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite' });

  const statusOfRow = (row: PreviewRow) => statusOf(row, ctx);
  const countIncluded = () => rowsToImport(rows, ctx).length;
  const changed = () => props.onChange(countIncluded());

  /** Focus the pencil of a row; when the filter no longer shows it, the next pencil or the filter. */
  const focusEdit = (id: number) => {
    const doc = table.ownerDocument;
    const own = doc.querySelector<HTMLElement>(`[data-fk="edit:${id}"]`);
    const fallback =
      doc.querySelector<HTMLElement>('.pv-table [data-fk^="edit:"]') ??
      doc.querySelector<HTMLElement>('input[name="pv-filter"]:checked') ??
      heading;
    (own ?? fallback).focus();
  };

  const focusFk = (fk: string) =>
    table.ownerDocument.querySelector<HTMLElement>(`[data-fk="${fk}"]`)?.focus();

  // ---------- filter segment ----------
  const drawSeg = () => {
    const counts = countBy(rows, ctx);
    seg.replaceChildren(
      ...FILTERS.filter(([f]) => f === 'all' || counts[f] > 0 || f === filter).map(([f, label]) => {
        const radio = h('input', {
          type: 'radio',
          name: 'pv-filter',
          value: f,
          checked: f === filter,
        });
        radio.addEventListener('change', () => {
          filter = f;
          editing = null;
          drawTable();
          live.textContent = `${label} ${counts[f]}건을 봅니다.`;
        });
        return h('label', {}, radio, h('span', {}, label, ' ', h('b', {}, counts[f])));
      }),
    );
  };

  // ---------- rows ----------
  const viewRow = (row: PreviewRow, dup: boolean): HTMLElement => {
    const e = row.event;
    const status = statusOfRow(row);
    const check = h('input', {
      type: 'checkbox',
      class: 'pv-check',
      checked: row.include,
      'aria-label': `${e.title} 반영`,
      'data-fk': `chk:${row.id}`,
    });
    check.addEventListener('change', () => {
      row.include = check.checked;
      row.touched = true;
      tr.classList.toggle('off', !row.include);
      changed();
    });
    const edit = h(
      'button',
      {
        type: 'button',
        class: 'icon-btn',
        'aria-label': `${e.title} 고치기`,
        'data-fk': `edit:${row.id}`,
      },
      icon('pencil'),
    );
    edit.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openEdit(row.id);
    });
    const tr = h(
      'tr',
      { class: `pv-row${row.include ? '' : ' off'}`, 'data-status': status },
      h('td', { class: 'c-chk' }, check),
      h('td', { class: 'c-date mono' }, dateText(e)),
      h(
        'td',
        { class: 'c-title' },
        h('span', { class: status === 'grade' ? 'strike' : '' }, e.title),
        e.holiday ? h('span', { class: 'badge badge-off' }, '쉬는 날') : null,
        e.notice ? h('span', { class: 'badge' }, '공지') : null,
        e.grades?.length ? h('span', { class: 'badge' }, `${e.grades.join(',')}학년`) : null,
      ),
      h('td', { class: 'c-kind' }, CATEGORY_LABELS[e.category]),
      h(
        'td',
        { class: 'c-state' },
        h(
          'span',
          { class: `st st-${status}` },
          h('i', { class: 'dot', 'aria-hidden': 'true' }),
          STATUS_WORD[status],
        ),
        status === 'check' && e.review ? h('span', { class: 'why' }, e.review) : null,
        dup ? h('span', { class: 'badge' }, '중복, 뺌') : null,
        e.mergedDays && e.mergedDays > 1
          ? h('span', { class: 'badge' }, `${e.mergedDays}일 합침`)
          : null,
      ),
      h('td', { class: 'c-edit' }, edit),
    );
    tr.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('input, button, label')) return;
      openEdit(row.id);
    });
    return tr;
  };

  const editRow = (row: PreviewRow): HTMLElement => {
    const e = row.event;
    const dateInput = (label: string, value: string, fk: string) =>
      h('input', {
        class: 'in in-date',
        type: 'text',
        value,
        inputmode: 'numeric',
        placeholder: 'M.DD',
        autocomplete: 'off',
        'aria-label': label,
        'data-fk': fk,
      });
    const start = dateInput('시작일', e.start ? shortDate(e.start) : '', `ed-start:${row.id}`);
    const end = dateInput('종료일', e.end ? shortDate(e.end) : '', `ed-end:${row.id}`);
    const title = h('input', {
      class: 'in',
      type: 'text',
      value: e.title,
      maxlength: '200',
      'aria-label': '일정 이름',
      'data-fk': `ed-title:${row.id}`,
    });
    const kind = h(
      'select',
      { class: 'in', 'aria-label': '종류' },
      ...CATEGORIES.map((c) =>
        h('option', { value: c, selected: c === e.category }, CATEGORY_LABELS[c]),
      ),
    );
    const err = h('p', { class: 'err', role: 'alert', hidden: true });
    const showErr = (msg: string, field: HTMLElement) => {
      err.textContent = msg;
      err.hidden = false;
      field.setAttribute('aria-invalid', 'true');
      field.focus();
    };
    const done = () => {
      for (const f of [start, end, title]) f.removeAttribute('aria-invalid');
      const name = title.value.trim().replace(/\s+/g, ' ');
      if (!name) return showErr('일정 이름을 입력해 주세요.', title);
      // Dates are read in the academic year of the date the field was filled with; a row the
      // person added is filled from the last row, so it follows that row, not the file's first.
      const s = readEditedDate(start.value, e.start, props.academicYear);
      if (!s) return showErr('시작일을 3.10 처럼 입력해 주세요.', start);
      const t = end.value.trim() ? readEditedEnd(end.value, e.end, s) : s;
      if (!t) return showErr('종료일을 3.10 처럼 입력해 주세요.', end);
      if (t < s) return showErr('종료일이 시작일보다 앞섭니다.', end);
      const category: Category = isCategory(kind.value) ? kind.value : e.category;
      row.event = {
        ...e,
        title: name,
        rawTitle: e.rawTitle || name,
        start: s,
        end: t,
        category,
        holiday: category === 'holiday',
      };
      if (e.review) delete row.event.review;
      row.edited = true;
      // A row that is already in the calendar stays unchecked after an edit.
      if (!row.touched) row.include = defaultInclude(row, ctx);
      editing = null;
      addedId = null;
      drawAll();
      focusEdit(row.id);
      live.textContent = '고쳤습니다.';
    };
    const cancel = () => {
      editing = null;
      if (addedId === row.id) {
        rows.splice(rows.indexOf(row), 1);
        addedId = null;
        drawAll();
        focusFk('add-row');
        return;
      }
      drawTable();
      focusFk(`edit:${row.id}`);
    };
    const tr = h(
      'tr',
      { class: 'pv-row editing', 'data-status': 'edit' },
      h('td', { class: 'c-chk' }),
      h(
        'td',
        { class: 'c-date' },
        start,
        h('span', { class: 'dash', 'aria-hidden': 'true' }, '–'),
        end,
      ),
      h('td', { class: 'c-title' }, title, err),
      h('td', { class: 'c-kind' }, kind),
      h(
        'td',
        { class: 'c-state' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: done }, '완료'),
        h('button', { type: 'button', class: 'btn btn-text', onclick: cancel }, '취소'),
      ),
      h('td', { class: 'c-edit' }),
    );
    tr.addEventListener('keydown', (ev) => {
      if (ev.isComposing || ev.keyCode === 229) return;
      if (ev.key === 'Enter' && (ev.target as HTMLElement).tagName === 'INPUT') {
        ev.preventDefault();
        ev.stopPropagation();
        done();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        cancel();
      }
    });
    (tr as HTMLElement & { cancelEdit?: () => void }).cancelEdit = cancel;
    return tr;
  };

  const openEdit = (id: number) => {
    editing = id;
    drawTable();
    focusFk(`ed-title:${id}`);
  };

  const drawTable = () => {
    // Sorted by start so a row whose date changed moves to its month; the sort is stable.
    const visible = rows
      .filter((r) => r.id === editing || matchesFilter(r, filter, ctx))
      .sort((a, b) => a.event.start.localeCompare(b.event.start));
    const dups = duplicateIds(rows, ctx);
    const head = h(
      'thead',
      { class: 'pv-head' },
      h(
        'tr',
        {},
        h('th', { class: 'c-chk' }, h('span', { class: 'sr-only' }, '반영')),
        h('th', { class: 'c-date' }, '날짜'),
        h('th', { class: 'c-title' }, '일정'),
        h('th', { class: 'c-kind' }, '종류'),
        h('th', { class: 'c-state' }, '상태'),
        h('th', { class: 'c-edit' }, h('span', { class: 'sr-only' }, '고치기')),
      ),
    );
    const bodies = groupByMonth(visible).map((g) =>
      h(
        'tbody',
        {},
        h(
          'tr',
          { class: 'pv-group' },
          h(
            'th',
            { colspan: '6', scope: 'colgroup' },
            `${g.month}월 `,
            h('b', {}, `${g.rows.length}건`),
          ),
        ),
        ...g.rows.map((r) => (r.id === editing ? editRow(r) : viewRow(r, dups.has(r.id)))),
      ),
    );
    table.replaceChildren(head, ...bodies);
    empty.textContent = visible.length ? '' : '이 보기에 해당하는 일정이 없습니다.';
    empty.hidden = visible.length > 0;
    changed();
  };

  const drawAll = () => {
    drawSeg();
    drawTable();
  };

  // ---------- controls ----------
  gradeSel.addEventListener('change', () => {
    const grade = gradeSel.value ? Number(gradeSel.value) : null;
    ctx.grade = grade;
    refreshIncludes(rows, ctx);
    props.onGrade(grade);
    editing = null;
    drawAll();
    live.textContent = grade ? `${grade}학년 일정만 체크했습니다.` : '모든 학년을 체크했습니다.';
  });

  const addRow = h(
    'button',
    { type: 'button', class: 'btn btn-text', 'data-fk': 'add-row' },
    icon('plus'),
    '빠진 일정 직접 추가',
  );
  addRow.addEventListener('click', () => {
    if (addedId !== null) return openEdit(addedId);
    const last = rows.at(-1)?.event.start ?? `${props.academicYear}-03-02`;
    const event: ImportedEvent = {
      title: '',
      rawTitle: '',
      start: last,
      end: last,
      allDay: true,
      category: 'academic',
      holiday: false,
    };
    const row: PreviewRow = { id: nextId++, event, include: true, touched: true, edited: true };
    rows.push(row);
    addedId = row.id;
    filter = 'all';
    drawSeg();
    openEdit(row.id);
  });

  const sourceCard = h(
    'div',
    { class: 'src pv-src' },
    icon(props.sourceKind === 'school' ? 'school' : 'file'),
    h('b', {}, props.sourceLabel),
    h('span', { class: 'src-meta' }, props.sourceMeta),
    h(
      'button',
      { type: 'button', class: 'btn btn-text', onclick: () => props.onBack() },
      `다른 ${props.changeWord}`,
    ),
  );

  const el = h(
    'div',
    { class: 'preview' },
    heading,
    sourceCard,
    ...props.notices.map((n) => h('p', { class: 'notice-line', role: 'note' }, n)),
    h(
      'div',
      { class: 'pv-tools' },
      seg,
      h(
        'div',
        { class: 'pv-opts' },
        h('label', { for: 'pv-grade', class: 'fl' }, '내 학년'),
        gradeSel,
        h('label', { for: 'pv-tag', class: 'fl' }, '태그'),
        tagIn,
      ),
    ),
    table,
    empty,
    h('div', { class: 'pv-add' }, addRow),
    live,
  );
  drawAll();

  return {
    el,
    included: () => rowsToImport(rows, ctx).map((r) => r.event),
    tags: () =>
      tagIn.value
        .split(/[,\s]+/)
        .map((t) => t.trim())
        .filter(Boolean),
    cancelEdit: () => {
      if (editing === null) return false;
      (
        table.querySelector('.editing') as (HTMLElement & { cancelEdit?: () => void }) | null
      )?.cancelEdit?.();
      return true;
    },
    focus: () => heading.focus(),
  };
}
