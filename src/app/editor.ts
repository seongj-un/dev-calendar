import { diffDays, isIsoDate, type IsoDate } from '../model/date';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  EventValidationError,
  LIMITS,
  isTime,
  normalizeTags,
  type CalendarEvent,
  type Category,
} from '../model/event';
import { StoreWriteError } from '../store/store';
import { h, isMac, type Child } from './dom';
import { icon } from './icons';
import { parseLine } from './lineParse';

/** Everything the form edits. Passed to `store.add` or `store.update` as is. */
export interface EventForm {
  title: string;
  start: IsoDate;
  end: IsoDate;
  allDay: boolean;
  time?: string;
  endTime?: string;
  category: Category;
  tags: string[];
  grades: number[];
  deadline: boolean;
  memo: string;
}

export type EditorResult = 'saved' | 'deleted' | 'cancel';

export interface EditorOptions {
  mode: 'add' | 'edit';
  /** Selected date; the default day of a new event. */
  date: IsoDate;
  event?: CalendarEvent;
  prefill?: Partial<EventForm>;
  /** Open with the delete confirmation already showing (⌫ in event mode). */
  confirmDelete?: boolean;
  /** Where an imported event came from: "파일명" or the school. */
  source?: { kind: 'file' | 'neis'; label: string } | null;
  onSave: (form: EventForm) => void;
  onDelete?: () => void;
  onClose: (result: EditorResult) => void;
}

const FIELD_IDS: Record<string, string> = {
  title: 'ed-title',
  start: 'ed-start',
  end: 'ed-end',
  time: 'ed-time',
  endTime: 'ed-endtime',
};

function initialForm(opts: EditorOptions): EventForm {
  const e = opts.event;
  const base: EventForm = e
    ? {
        title: e.title,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
        time: e.time,
        endTime: e.endTime,
        category: e.category,
        tags: [...e.tags],
        grades: [...(e.grades ?? [])],
        deadline: e.deadline === true,
        memo: e.memo ?? '',
      }
    : {
        title: '',
        start: opts.date,
        end: opts.date,
        allDay: true,
        category: 'other',
        tags: [],
        grades: [],
        deadline: false,
        memo: '',
      };
  return { ...base, ...opts.prefill };
}

/** Field errors before the store sees the value; the store checks again. */
export function validateForm(form: EventForm): { field: string; message: string } | null {
  if (!form.title.trim()) return { field: 'title', message: '제목을 입력해 주세요.' };
  if (form.title.trim().length > LIMITS.title) {
    return { field: 'title', message: `제목은 ${LIMITS.title}자까지 쓸 수 있습니다.` };
  }
  if (!isIsoDate(form.start)) return { field: 'start', message: '날짜를 입력해 주세요.' };
  if (!isIsoDate(form.end)) return { field: 'end', message: '종료일이 올바르지 않습니다.' };
  if (form.end < form.start) return { field: 'end', message: '종료일이 시작일보다 앞섭니다.' };
  if (!form.allDay) {
    if (!isTime(form.time)) {
      return { field: 'time', message: '시간을 입력하거나 하루 종일을 고르세요.' };
    }
    if (form.endTime && form.start === form.end && form.endTime <= form.time) {
      return { field: 'endTime', message: '끝 시간이 시작 시간보다 앞섭니다.' };
    }
  }
  return null;
}

function cmdKey(): Child {
  return h('kbd', {}, isMac() ? icon('cmd', 'kc') : 'Ctrl');
}

export function openEditor(dialog: HTMLDialogElement, opts: EditorOptions): void {
  const form = initialForm(opts);
  let done = false;
  let confirming = false;

  const finish = (result: EditorResult) => {
    if (done) return;
    done = true;
    if (dialog.open) dialog.close();
    opts.onClose(result);
  };

  // ---- fields ----
  const title = h('input', {
    class: 'in',
    id: 'ed-title',
    type: 'text',
    value: form.title,
    maxlength: LIMITS.title,
    autocomplete: 'off',
    required: true,
  });
  const radios = CATEGORIES.map((c) =>
    h(
      'label',
      {},
      h('input', {
        type: 'radio',
        name: 'ed-cat',
        value: c,
        checked: c === form.category,
      }),
      h('span', {}, CATEGORY_LABELS[c]),
    ),
  );
  const start = h('input', {
    class: 'in',
    id: 'ed-start',
    type: 'date',
    value: form.start,
    required: true,
  });
  const end = h('input', {
    class: 'in',
    id: 'ed-end',
    type: 'date',
    value: form.end === form.start ? '' : form.end,
    min: form.start,
    'aria-label': '종료일',
  });
  const daysN = h('span', { class: 'days-n', 'aria-live': 'polite' });
  const time = h('input', {
    class: 'in',
    id: 'ed-time',
    type: 'time',
    value: form.time ?? '',
    'aria-label': '시작 시간',
  });
  const endTime = h('input', {
    class: 'in',
    id: 'ed-endtime',
    type: 'time',
    value: form.endTime ?? '',
    'aria-label': '끝 시간',
  });
  const allDay = h('input', { type: 'checkbox', id: 'ed-allday', checked: form.allDay });
  const deadline = h('input', { type: 'checkbox', id: 'ed-deadline', checked: form.deadline });
  const deadlineLabel = h('label', { class: 'check' }, deadline, '마감으로 표시');
  const gradeChoices = [...new Set([1, 2, 3, ...form.grades])].sort((a, b) => a - b);
  const grades = gradeChoices.map((g) =>
    h('input', { type: 'checkbox', value: g, checked: form.grades.includes(g) }),
  );
  const memo = h('textarea', {
    class: 'in',
    id: 'ed-memo',
    maxlength: LIMITS.memo,
    placeholder: '장소, 링크, 메모',
  });
  memo.value = form.memo;

  let tags = [...form.tags];
  const chips = h('div', { class: 'chips' });
  const tagInput = h('input', {
    type: 'text',
    id: 'ed-tags',
    placeholder: '태그 추가',
    autocomplete: 'off',
    'aria-describedby': 'ed-tags-help',
  });
  const renderChips = () => {
    chips.replaceChildren(
      ...tags.map((t) =>
        h(
          'span',
          { class: 'chip' },
          `#${t}`,
          h(
            'button',
            {
              type: 'button',
              'aria-label': `태그 ${t} 삭제`,
              onclick: () => {
                tags = tags.filter((x) => x !== t);
                renderChips();
                tagInput.focus();
              },
            },
            icon('x'),
          ),
        ),
      ),
      tagInput,
    );
  };
  const commitTag = () => {
    const next = normalizeTags([...tags, tagInput.value]);
    tagInput.value = '';
    if (next.length !== tags.length) {
      tags = next;
      renderChips();
      tagInput.focus();
    }
  };
  tagInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
      if (tagInput.value.trim()) {
        e.preventDefault();
        commitTag();
      } else if (e.key !== 'Enter') {
        e.preventDefault();
      }
    } else if (e.key === 'Backspace' && !tagInput.value && tags.length) {
      tags = tags.slice(0, -1);
      renderChips();
      tagInput.focus();
    }
  });
  tagInput.addEventListener('blur', () => {
    if (tagInput.value.trim()) commitTag();
  });
  renderChips();

  const category = (): Category =>
    (radios.map((l) => l.querySelector('input')!).find((r) => r.checked)?.value as Category) ??
    'other';

  const sync = () => {
    time.disabled = allDay.checked;
    endTime.disabled = allDay.checked;
    deadlineLabel.hidden = category() === 'assignment';
    end.min = start.value;
    const to = end.value || start.value;
    const n =
      isIsoDate(start.value) && isIsoDate(to) && to >= start.value
        ? diffDays(start.value, to) + 1
        : 0;
    daysN.textContent = n > 1 ? `${n}일` : '';
  };
  for (const el of [allDay, start, end]) el.addEventListener('input', sync);
  for (const r of radios) r.addEventListener('change', sync);
  // Typing a time means the event is not all day.
  time.addEventListener('input', () => {
    if (time.value && allDay.checked) allDay.checked = false;
  });

  // ---- one-line entry (add only) ----
  const line =
    opts.mode === 'add'
      ? h('input', {
          type: 'text',
          id: 'ed-line',
          autocomplete: 'off',
          spellcheck: 'false',
          'aria-label': '한 줄로 입력',
          'aria-describedby': 'ed-line-help',
          placeholder: '자료구조 과제 4 12/21 23:59 #ds !과제',
        })
      : null;
  line?.addEventListener('input', () => {
    const p = parseLine(line.value, opts.date);
    title.value = p.title;
    start.value = p.start ?? opts.date;
    end.value = p.end && p.end !== p.start ? p.end : '';
    time.value = p.time ?? '';
    endTime.value = p.endTime ?? '';
    allDay.checked = !p.time;
    if (p.category) {
      for (const l of radios) {
        const r = l.querySelector('input')!;
        r.checked = r.value === p.category;
      }
    }
    tags = normalizeTags(p.tags);
    renderChips();
    sync();
  });

  // ---- errors ----
  const formErr = h('p', { class: 'form-err', role: 'alert', hidden: true });
  const clearErrors = () => {
    formErr.hidden = true;
    for (const el of dialog.querySelectorAll('.err')) el.remove();
    for (const el of dialog.querySelectorAll('[aria-invalid]')) {
      el.removeAttribute('aria-invalid');
      el.removeAttribute('aria-errormessage');
    }
  };
  const showError = (field: string, message: string) => {
    const id = FIELD_IDS[field];
    const input = id ? dialog.querySelector<HTMLInputElement>(`#${id}`) : null;
    if (!input) {
      formErr.textContent = message;
      formErr.hidden = false;
      return;
    }
    const err = h('p', { class: 'err', id: `${id}-err` }, message);
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-errormessage', err.id);
    input.closest('.f')?.appendChild(err);
    input.focus();
  };

  const read = (): EventForm => {
    const value: EventForm = {
      title: title.value.trim(),
      start: start.value,
      end: end.value || start.value,
      allDay: allDay.checked,
      category: category(),
      tags: normalizeTags([...tags, tagInput.value]),
      grades: grades.filter((g) => g.checked).map((g) => Number(g.value)),
      deadline: category() !== 'assignment' && deadline.checked,
      memo: memo.value.trim(),
    };
    if (!allDay.checked) {
      value.time = time.value;
      if (endTime.value) value.endTime = endTime.value;
    }
    return value;
  };

  const save = () => {
    clearErrors();
    const value = read();
    const problem = validateForm(value);
    if (problem) {
      showError(problem.field, problem.message);
      return;
    }
    try {
      opts.onSave(value);
    } catch (err) {
      if (err instanceof EventValidationError) {
        showError(err.field, err.message);
        return;
      }
      if (err instanceof StoreWriteError) {
        showError('form', err.message);
        return;
      }
      throw err;
    }
    finish('saved');
  };

  // ---- footer ----
  const footer = h('div', { class: 'd-f' });
  const cancelBtn = () =>
    h(
      'button',
      { type: 'button', class: 'btn btn-ghost', onclick: () => finish('cancel') },
      '취소',
    );
  const renderFooter = () => {
    if (confirming) {
      const keep = h(
        'button',
        {
          type: 'button',
          class: 'btn btn-ghost',
          onclick: () => {
            confirming = false;
            renderFooter();
            (footer.querySelector('[data-del]') as HTMLElement | null)?.focus();
          },
        },
        '취소',
      );
      footer.replaceChildren(
        h(
          'div',
          { class: 'danger-confirm', id: 'ed-del-q' },
          '이 일정을 삭제할까요?',
          h('small', {}, '삭제 후 5초 동안 되돌릴 수 있습니다.'),
        ),
        keep,
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-primary',
            'aria-describedby': 'ed-del-q',
            onclick: () => {
              if (done) return;
              try {
                opts.onDelete?.();
              } catch (err) {
                if (err instanceof StoreWriteError) {
                  showError('form', err.message);
                  return;
                }
                throw err;
              }
              finish('deleted');
            },
          },
          icon('trash'),
          '삭제',
        ),
      );
      keep.focus();
      return;
    }
    footer.replaceChildren(
      opts.mode === 'edit'
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn btn-text',
              'data-del': '',
              onclick: () => {
                confirming = true;
                renderFooter();
              },
            },
            icon('trash'),
            '삭제',
            h('kbd', { 'aria-hidden': 'true' }, '⌫'),
          )
        : h('span', { class: 'hint', 'aria-hidden': 'true' }, cmdKey(), h('kbd', {}, '↵'), ' 저장'),
      h('span', { class: 'sp' }),
      cancelBtn(),
      h('button', { type: 'submit', class: 'btn btn-primary' }, '저장'),
    );
  };

  // ---- layout ----
  const src = opts.source
    ? h(
        'div',
        { class: 'src' },
        icon(opts.source.kind === 'neis' ? 'school' : 'file'),
        h(
          'span',
          {},
          opts.source.kind === 'neis' ? '나이스에서 가져온 학사일정' : '가져온 학사일정',
        ),
        h('code', {}, opts.source.label),
      )
    : null;

  const field = (label: Child, control: Child, top = false, forId?: string) =>
    h(
      'div',
      { class: top ? 'f f-top' : 'f' },
      forId ? h('label', { for: forId }, label) : h('span', { class: 'fl' }, label),
      control,
    );

  const body = h(
    'div',
    { class: 'd-b' },
    line ? h('div', { class: 'line-in' }, line) : null,
    line
      ? h(
          'p',
          { class: 'line-help', id: 'ed-line-help' },
          '한 줄로 쓰면 아래 칸이 채워집니다. ',
          h('code', {}, '12/21'),
          ' 날짜, ',
          h('code', {}, '23:59'),
          ' 시간, ',
          h('code', {}, '12/14~12/17'),
          ' 기간, ',
          h('code', {}, '#태그'),
          ', ',
          h('code', {}, '!과제'),
          ' 종류',
        )
      : null,
    h(
      'div',
      { class: 'fields' },
      field('제목', title, false, 'ed-title'),
      h('fieldset', { class: 'f' }, h('legend', {}, '종류'), h('div', { class: 'seg' }, ...radios)),
      field(
        '날짜',
        h(
          'div',
          { class: 'row' },
          start,
          h('span', { class: 'dash', 'aria-hidden': 'true' }, '–'),
          end,
          daysN,
        ),
        false,
        'ed-start',
      ),
      field(
        '시간',
        h(
          'div',
          { class: 'row' },
          time,
          h('span', { class: 'dash', 'aria-hidden': 'true' }, '–'),
          endTime,
        ),
      ),
      field(
        '',
        h(
          'div',
          { class: 'row checks' },
          h('label', { class: 'check' }, allDay, '하루 종일'),
          deadlineLabel,
        ),
      ),
      h(
        'fieldset',
        { class: 'f' },
        h('legend', {}, '대상 학년'),
        h(
          'div',
          { class: 'row checks' },
          ...grades.map((g) => h('label', { class: 'check' }, g, `${g.value}학년`)),
          h('span', { class: 'days-n' }, '비우면 모든 학년'),
        ),
      ),
      field(
        '태그',
        h(
          'div',
          {},
          chips,
          h('span', { class: 'sr-only', id: 'ed-tags-help' }, 'Enter나 쉼표로 태그를 넣습니다.'),
        ),
        false,
        'ed-tags',
      ),
      field('메모', memo, true, 'ed-memo'),
    ),
  );

  const formEl = h(
    'form',
    { method: 'dialog', novalidate: true },
    h(
      'div',
      { class: 'd-h' },
      h('h2', { id: 'ed-h' }, opts.mode === 'add' ? '새 일정' : '일정 편집'),
      h('kbd', { 'aria-hidden': 'true' }, 'Esc'),
    ),
    src,
    body,
    formErr,
    footer,
  );
  formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    save();
  });
  formEl.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) {
      // Enter that commits a Korean syllable must not submit the form.
      if (e.key === 'Enter') e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    } else if (e.key === 'Enter' && e.target instanceof HTMLTextAreaElement) {
      // New line in the memo.
    } else if (
      (e.key === 'Backspace' || e.key === 'Delete') &&
      opts.mode === 'edit' &&
      !confirming &&
      e.target instanceof HTMLButtonElement
    ) {
      e.preventDefault();
      confirming = true;
      renderFooter();
    }
  });

  dialog.replaceChildren(formEl);
  dialog.setAttribute('aria-labelledby', 'ed-h');
  dialog.oncancel = (e) => {
    e.preventDefault();
    finish('cancel');
  };
  dialog.onclose = () => finish('cancel');

  confirming = opts.mode === 'edit' && opts.confirmDelete === true;
  renderFooter();
  sync();
  dialog.showModal();
  if (confirming) (footer.querySelector('.btn-ghost') as HTMLElement | null)?.focus();
  else if (line) line.focus();
  else title.focus();
}
