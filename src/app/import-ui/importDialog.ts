import { StoreWriteError, type EventStore, type ImportBatch } from '../../store/store';
import { EventValidationError, type CalendarEvent } from '../../model/event';
import { importFile as defaultImportFile, loadNeis as defaultLoadNeis } from '../../import';
import type { ImportResult } from '../../import/types';
import type { NeisOptions } from '../../import/neis';
import { h } from '../dom';
import { icon } from '../icons';
import { batchInfos } from '../settings/batches';
import type { SavedSchool } from '../settings/neisPrefs';
import { pickFileView } from './pickFile';
import { pickNeisView } from './pickNeis';
import { createPreview, type Preview } from './preview';
import { buildRows, rowsAcademicYear, type RowContext } from './rows';

export type ImportTab = 'file' | 'neis';

export interface ImportDone {
  batch: ImportBatch;
  added: CalendarEvent[];
  skipped: number;
}

export interface ImportDialogOptions {
  store: EventStore;
  grade: number | null;
  today: Date;
  neisKey: string;
  school: SavedSchool | null;
  tab?: ImportTab;
  onGrade(grade: number | null): void;
  onSchool(school: SavedSchool): void;
  onOpenSettings(): void;
  onImported(done: ImportDone): void;
  /** Called once after the dialog is gone. */
  onClose(): void;
  importFile?: typeof defaultImportFile;
  loadNeis?: typeof defaultLoadNeis;
  /** A read that takes longer than this is given up (ms). */
  timeoutMs?: number;
}

type Step = 'pick' | 'busy' | 'preview';

const STEPS = ['파일 선택', '미리보기', '반영'];

/** The import window: pick a file or a school, check the rows, put them in the calendar. */
export function openImportDialog(root: HTMLElement, opts: ImportDialogOptions): { close(): void } {
  const importFile = opts.importFile ?? defaultImportFile;
  const loadNeis = opts.loadNeis ?? defaultLoadNeis;
  const timeoutMs = opts.timeoutMs ?? 90_000;

  const dialog = h('dialog', {
    class: 'dialog dlg-import',
    'aria-labelledby': 'imp-h',
    id: 'import',
  });
  root.appendChild(dialog);

  let tab: ImportTab = opts.tab ?? 'file';
  let step: Step = 'pick';
  let pickError: string | null = null;
  let busyLabel = '';
  let token = 0;
  let preview: Preview | null = null;
  let result: ImportResult | null = null;
  let commitError: string | null = null;
  let included = 0;
  let closed = false;
  let abort: AbortController | null = null;
  const ctx: RowContext = { grade: opts.grade, existing: opts.store.existingKeys() };

  const finish = () => {
    if (closed) return;
    closed = true;
    token++;
    abort?.abort();
    if (dialog.open) dialog.close();
    dialog.remove();
    opts.onClose();
  };

  const toPick = (error: string | null = null) => {
    token++;
    abort?.abort();
    step = 'pick';
    preview = null;
    result = null;
    pickError = error;
    commitError = null;
    render();
  };

  /** Waits for `work`, but not longer than the limit; later answers are ignored. */
  const guarded = async <T>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('시간이 너무 오래 걸려 중단했습니다. 다시 시도해 주세요.')),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([work, limit]);
    } finally {
      clearTimeout(timer);
    }
  };

  const showResult = (res: ImportResult) => {
    if (!res.events.length) {
      toPick(res.warnings[0]?.message ?? '일정을 찾지 못했습니다.');
      return;
    }
    result = res;
    ctx.existing = opts.store.existingKeys();
    const rows = buildRows(res.events, ctx);
    const year = rowsAcademicYear(res.events, res.academicYear);
    // Only batches that still have events in the calendar can be deleted in settings.
    const previous = batchInfos(opts.store)
      .map((i) => i.batch)
      .filter((b) => b.source === res.source);
    const notices = res.warnings.map((w) => w.message);
    if (previous.length) {
      const last = previous[0]!;
      notices.push(
        `이 출처에서 이미 가져온 일정이 있습니다(${last.importedAt.slice(0, 10)}, ${last.count}개). 같은 일정은 "이미 있음"으로 빼 두었습니다. 처음부터 다시 가져오려면 설정에서 이전 묶음을 지워 주세요.`,
      );
    }
    const isNeis = res.kind === 'neis';
    preview = createPreview({
      rows,
      ctx,
      academicYear: year,
      sourceKind: isNeis ? 'school' : 'file',
      sourceLabel: res.label,
      sourceMeta: [
        isNeis ? `${year}학년도` : res.pages ? `${res.pages}쪽` : null,
        `일정 ${res.events.length}개`,
      ]
        .filter(Boolean)
        .join(' · '),
      changeWord: isNeis ? '학교' : '파일',
      notices,
      initialTag: `${year}학년도`,
      onGrade: opts.onGrade,
      onChange: (n) => {
        included = n;
        syncConfirm();
      },
      onBack: () => toPick(),
    });
    step = 'preview';
    commitError = null;
    render();
    preview.focus();
  };

  const runFile = async (file: File) => {
    const mine = ++token;
    step = 'busy';
    busyLabel = file.name;
    pickError = null;
    render();
    const mineAbort = new AbortController();
    abort = mineAbort;
    let res: ImportResult;
    try {
      res = await guarded(importFile(file, { today: opts.today, signal: mineAbort.signal }));
    } catch (err) {
      // A time-out leaves the parse running; tell it to stop at its next stage and drop its answer.
      mineAbort.abort();
      if (mine !== token || closed) return;
      toPick(err instanceof Error ? err.message : '파일을 읽지 못했습니다.');
      return;
    }
    if (mine !== token || closed) return;
    showResult(res);
  };

  const runNeis = async (school: SavedSchool, academicYear: number) => {
    const mine = ++token;
    step = 'busy';
    busyLabel = school.name;
    pickError = null;
    render();
    const mineAbort = new AbortController();
    abort = mineAbort;
    try {
      const neis = await guarded(loadNeis());
      const options: NeisOptions = { signal: mineAbort.signal };
      if (opts.neisKey) options.key = opts.neisKey;
      const res = await guarded(neis.fetchSchedule(school, academicYear, options));
      if (mine !== token || closed) return;
      opts.onSchool(school);
      showResult(res);
    } catch (err) {
      if (mine !== token || closed) return;
      toPick(err instanceof Error ? err.message : '학사일정을 받지 못했습니다.');
    }
  };

  const searchSchools = async (name: string, signal: AbortSignal) => {
    const neis = await loadNeis();
    const options: NeisOptions = { signal };
    if (opts.neisKey) options.key = opts.neisKey;
    return neis.searchSchools(name, options);
  };

  const commit = () => {
    if (!preview || !result) return;
    const rows = preview.included();
    if (!rows.length) return;
    try {
      const done = opts.store.commitImport(rows, {
        source: result.source,
        label: result.label,
        tags: preview.tags(),
      });
      finish();
      opts.onImported(done);
    } catch (err) {
      if (err instanceof StoreWriteError || err instanceof EventValidationError) {
        commitError = err.message;
        render();
        dialog.querySelector<HTMLElement>('.foot-err')?.focus();
        return;
      }
      throw err;
    }
  };

  // ---------- drawing ----------
  const confirmBtn = h('button', {
    type: 'button',
    class: 'btn btn-primary',
    'data-fk': 'confirm',
    onclick: commit,
  });
  const syncConfirm = () => {
    confirmBtn.disabled = included === 0;
    confirmBtn.textContent = included ? `${included}개 달력에 반영` : '반영할 일정이 없습니다';
  };

  const stepNav = () => {
    const at = step === 'preview' ? 1 : 0;
    return h(
      'ol',
      { class: 'steps', 'aria-label': '진행 단계' },
      ...STEPS.map((label, i) =>
        h(
          'li',
          { class: i === at ? 'on' : '', 'aria-current': i === at ? 'step' : null },
          `${i + 1}  `,
          i === 0 && tab === 'neis' ? '학교 선택' : label,
        ),
      ),
    );
  };

  const routeSeg = () => {
    const radios = (['file', 'neis'] as const).map((t) => {
      const radio = h('input', {
        type: 'radio',
        name: 'imp-tab',
        value: t,
        checked: tab === t,
        'data-fk': `tab:${t}`,
      });
      radio.addEventListener('change', () => {
        tab = t;
        pickError = null;
        render();
        dialog.querySelector<HTMLElement>(`[data-fk="tab:${t}"]`)?.focus();
      });
      return h(
        'label',
        {},
        radio,
        h(
          'span',
          {},
          icon(t === 'file' ? 'file' : 'school'),
          t === 'file' ? '파일' : '나이스 학사일정',
        ),
      );
    });
    return h(
      'div',
      { class: 'route' },
      h('div', { class: 'seg', role: 'radiogroup', 'aria-label': '가져오는 방법' }, ...radios),
    );
  };

  const render = () => {
    const head = h(
      'div',
      { class: 'd-h' },
      h('h2', { id: 'imp-h' }, '학사일정 가져오기'),
      h(
        'button',
        { type: 'button', class: 'icon-btn', 'aria-label': '닫기', onclick: finish },
        icon('x'),
      ),
    );
    let body: HTMLElement;
    let footer: HTMLElement;
    if (step === 'busy') {
      body = h(
        'div',
        { class: 'busy', role: 'status' },
        h('p', { class: 'busy-t' }, '읽는 중입니다'),
        h('p', { class: 'busy-s' }, busyLabel),
      );
      footer = h(
        'div',
        { class: 'd-f' },
        h('span', { class: 'sp' }),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => toPick() }, '취소'),
      );
    } else if (step === 'preview' && preview) {
      body = preview.el;
      syncConfirm();
      footer = h(
        'div',
        { class: 'd-f' },
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => toPick() }, '이전'),
        h('span', { class: 'sp' }),
        confirmBtn,
      );
    } else {
      body =
        tab === 'file'
          ? pickFileView({ onFile: (f) => void runFile(f), error: pickError })
          : pickNeisView({
              hasKey: Boolean(opts.neisKey),
              saved: opts.school,
              today: opts.today,
              search: searchSchools,
              onOpenSettings: () => {
                finish();
                opts.onOpenSettings();
              },
              onLoad: (s, y) => void runNeis(s, y),
              error: pickError,
            });
      footer = h(
        'div',
        { class: 'd-f' },
        h('span', { class: 'hint' }, '반영하기 전에 미리보기에서 고칠 수 있습니다.'),
        h('span', { class: 'sp' }),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: finish }, '닫기'),
      );
    }
    const parts: Node[] = [head];
    if (step !== 'preview') parts.push(routeSeg());
    parts.push(stepNav(), h('div', { class: 'd-b' }, body));
    if (commitError) {
      parts.push(
        h('p', { class: 'form-err foot-err', role: 'alert', tabindex: '-1' }, commitError),
      );
    }
    parts.push(footer);
    dialog.replaceChildren(...parts);
    if (step === 'pick' && pickError) {
      const err = dialog.querySelector<HTMLElement>('.form-err');
      err?.setAttribute('tabindex', '-1');
      err?.focus();
    } else if (step === 'pick') {
      const key = tab === 'file' ? 'pick-file' : 'neis-q';
      dialog.querySelector<HTMLElement>(`[data-fk="${key}"]`)?.focus();
    } else if (step === 'busy') {
      dialog.querySelector<HTMLElement>('.d-f .btn')?.focus();
    }
  };

  dialog.oncancel = (e) => {
    e.preventDefault();
    if (step === 'preview' && preview?.cancelEdit()) return;
    finish();
  };
  dialog.onclose = () => finish();
  dialog.showModal();
  render();
  return { close: finish };
}
