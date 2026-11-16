import { StoreWriteError, type EventStore } from '../../store/store';
import { loadNeis as defaultLoadNeis } from '../../import';
import { h } from '../dom';
import { icon } from '../icons';
import type { Prefs, Theme } from '../prefs';
import type { WeekStart } from '../layout';
import { batchInfos, batchLine, type BatchInfo } from './batches';
import { isKeyShape, maskKey, type SavedSchool } from './neisPrefs';

export interface SettingsOptions {
  store: EventStore;
  prefs: Prefs;
  neisKey: string;
  school: SavedSchool | null;
  /** Saves the key; returns false when the browser refused. */
  onKey(key: string): boolean;
  onSchool(school: SavedSchool | null): void;
  onPrefs(prefs: Prefs): void;
  onGoto(date: string): void;
  /** After a batch is deleted; `undo` puts it back. */
  onDeleted(message: string, undo: () => void): void;
  onClose(): void;
  loadNeis?: typeof defaultLoadNeis;
  /** The key check gives up after this many ms. */
  timeoutMs?: number;
}

/** Settings window: NEIS key and school, view preferences, imported batches. */
export function openSettingsDialog(root: HTMLElement, opts: SettingsOptions): { close(): void } {
  const load = opts.loadNeis ?? defaultLoadNeis;
  const dialog = h('dialog', {
    class: 'dialog dlg-settings',
    id: 'settings',
    'aria-labelledby': 'set-h',
  });
  root.appendChild(dialog);

  let prefs = opts.prefs;
  let neisKey = opts.neisKey;
  let school = opts.school;
  let editingKey = !neisKey;
  let keyMsg: { kind: 'ok' | 'err' | 'note'; text: string } | null = null;
  let checking = false;
  let confirmId: string | null = null;
  let closed = false;
  let batchErr: string | null = null;
  /** Deletes the person can still undo; shown in the window because a toast behind it cannot be reached. */
  let pending: { message: string; undo: () => void }[] = [];
  let undoNote: string | null = null;

  const finish = () => {
    if (closed) return;
    closed = true;
    // Hand the last undo to the calendar's toast once the window is gone.
    const last = pending.at(-1);
    if (last) opts.onDeleted(last.message, last.undo);
    if (dialog.open) dialog.close();
    dialog.remove();
    opts.onClose();
  };

  const focusFk = (fk: string) => dialog.querySelector<HTMLElement>(`[data-fk="${fk}"]`)?.focus();

  // ---------- NEIS key ----------
  const checkKey = async (value: string) => {
    const key = value.trim();
    if (!isKeyShape(key)) {
      keyMsg = { kind: 'err', text: '인증키는 영문과 숫자 16~64자입니다. 다시 확인해 주세요.' };
      draw();
      focusFk('key-in');
      return;
    }
    checking = true;
    keyMsg = { kind: 'note', text: '확인하는 중입니다…' };
    draw();
    const timeout = opts.timeoutMs ?? 15_000;
    let result: 'ok' | 'invalid' | 'unknown';
    try {
      const neis = await load();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      try {
        await neis.searchSchools('서울', { key, signal: ctl.signal });
        result = 'ok';
      } catch (err) {
        result =
          err instanceof Error && 'code' in err && (err as { code: string }).code === 'invalid-key'
            ? 'invalid'
            : 'unknown';
      } finally {
        clearTimeout(timer);
      }
    } catch {
      result = 'unknown';
    }
    checking = false;
    if (closed) return;
    if (result === 'invalid') {
      keyMsg = {
        kind: 'err',
        text: 'NEIS가 이 인증키를 받아 주지 않습니다. 키를 다시 확인해 주세요.',
      };
      draw();
      focusFk('key-in');
      return;
    }
    if (!opts.onKey(key)) {
      keyMsg = { kind: 'err', text: '브라우저에 저장하지 못했습니다. 저장 공간을 확인해 주세요.' };
      draw();
      return;
    }
    neisKey = key;
    editingKey = false;
    keyMsg =
      result === 'ok'
        ? { kind: 'ok', text: '키가 확인되었습니다.' }
        : { kind: 'note', text: '저장했지만 NEIS에 연결하지 못해 확인하지는 못했습니다.' };
    draw();
    focusFk('key-change');
  };

  const keyField = (): HTMLElement => {
    if (!editingKey) {
      return h(
        'div',
        { class: 'f' },
        h('span', { class: 'fl' }, 'NEIS 인증키'),
        h(
          'div',
          { class: 'key-row' },
          h(
            'code',
            { class: 'key-mask', 'aria-label': '저장된 인증키, 마지막 네 자리만 보입니다' },
            maskKey(neisKey),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-ghost',
              'data-fk': 'key-change',
              onclick: () => {
                editingKey = true;
                keyMsg = null;
                draw();
                focusFk('key-in');
              },
            },
            '바꾸기',
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-text',
              'data-fk': 'key-clear',
              onclick: () => {
                if (!opts.onKey('')) return;
                neisKey = '';
                editingKey = true;
                keyMsg = { kind: 'note', text: '인증키를 지웠습니다.' };
                draw();
                focusFk('key-in');
              },
            },
            '지우기',
          ),
        ),
      );
    }
    const input = h('input', {
      class: 'in in-mono',
      id: 'set-key',
      type: 'password',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: '인증키 붙여넣기',
      'data-fk': 'key-in',
      'aria-describedby': 'set-key-help',
    });
    const form = h(
      'form',
      { class: 'key-row' },
      input,
      h('button', { type: 'submit', class: 'btn btn-primary', disabled: checking }, '확인'),
      neisKey
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn btn-text',
              onclick: () => {
                editingKey = false;
                keyMsg = null;
                draw();
                focusFk('key-change');
              },
            },
            '취소',
          )
        : null,
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!checking) void checkKey(input.value);
    });
    return h(
      'div',
      { class: 'f f-top' },
      h('label', { class: 'fl', for: 'set-key' }, 'NEIS 인증키'),
      h(
        'div',
        { class: 'key-col' },
        form,
        h(
          'p',
          { class: 'help', id: 'set-key-help' },
          '인증키가 없으면 나이스에서 일정이 5건만 받아집니다. ',
          h(
            'a',
            { href: 'https://open.neis.go.kr', target: '_blank', rel: 'noopener noreferrer' },
            'open.neis.go.kr',
          ),
          '에서 무료로 발급받을 수 있습니다. 키는 이 브라우저에만 저장하고 NEIS 요청에만 씁니다.',
        ),
      ),
    );
  };

  // ---------- preferences ----------
  const radios = <T extends string | number | null>(
    name: string,
    label: string,
    options: [T, string][],
    current: T,
    set: (v: T) => void,
  ): HTMLElement =>
    h(
      'fieldset',
      { class: 'f' },
      h('legend', {}, label),
      h(
        'div',
        { class: 'seg' },
        ...options.map(([value, text]) => {
          const input = h('input', {
            type: 'radio',
            name,
            value: String(value),
            checked: value === current,
          });
          input.addEventListener('change', () => set(value));
          return h('label', {}, input, h('span', {}, text));
        }),
      ),
    );

  const setPrefs = (next: Prefs) => {
    prefs = next;
    opts.onPrefs(next);
  };

  // ---------- batches ----------
  const deleteBatch = (info: BatchInfo) => {
    // A backup of only this batch, so undoing one delete never brings back another.
    const doc = JSON.parse(opts.store.exportBackup()) as {
      events: { batchId?: string }[];
      batches: { id: string }[];
    };
    doc.events = doc.events.filter((e) => e.batchId === info.batch.id);
    doc.batches = doc.batches.filter((b) => b.id === info.batch.id);
    const snapshot = JSON.stringify(doc);
    let removed: number;
    try {
      removed = opts.store.removeBatch(info.batch.id);
    } catch (err) {
      if (err instanceof StoreWriteError) {
        confirmId = null;
        batchErr = err.message;
        draw();
        return;
      }
      throw err;
    }
    confirmId = null;
    batchErr = null;
    undoNote = null;
    const entry = {
      message: `${removed}개를 지웠습니다.`,
      // The backup holds this batch's events and record; merging puts back what is missing.
      undo: () => {
        opts.store.restoreBackup(snapshot, 'merge');
      },
    };
    pending.push(entry);
    draw();
    focusFk('undo-last');
  };

  const undoLast = () => {
    const entry = pending.pop();
    if (!entry) return;
    try {
      entry.undo();
      undoNote = '되돌렸습니다.';
      batchErr = null;
    } catch (err) {
      pending.push(entry);
      batchErr = err instanceof Error ? err.message : '되돌리지 못했습니다.';
    }
    draw();
    focusFk(pending.length ? 'undo-last' : 'batches-h');
  };

  const undoLine = (): HTMLElement | null => {
    const last = pending.at(-1);
    if (!last && !undoNote) return null;
    return h(
      'div',
      { class: 'undo-line', role: 'status' },
      h('span', {}, last ? last.message : undoNote),
      last
        ? h(
            'button',
            { type: 'button', class: 'btn btn-text', 'data-fk': 'undo-last', onclick: undoLast },
            '되돌리기',
          )
        : null,
    );
  };

  const batchRow = (info: BatchInfo): HTMLElement => {
    const { batch } = info;
    if (confirmId === batch.id) {
      return h(
        'li',
        { class: 'confirm' },
        h('span', { class: 'bi' }, icon(info.kind === 'school' ? 'school' : 'file')),
        h(
          'div',
          { class: 'bt', role: 'group', 'aria-label': `${batch.label} 삭제 확인` },
          h('b', {}, `${info.count}개 일정을 모두 지울까요?`),
          h(
            'span',
            {},
            `'${batch.label}'에서 가져온 일정입니다.`,
            info.edited ? ` 가져온 뒤 직접 고친 ${info.edited}개도 함께 지워집니다.` : '',
          ),
        ),
        h(
          'div',
          { class: 'ba' },
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-ghost',
              'data-fk': `cancel:${batch.id}`,
              onclick: () => {
                confirmId = null;
                draw();
                focusFk(`del:${batch.id}`);
              },
            },
            '취소',
          ),
          h(
            'button',
            { type: 'button', class: 'btn btn-primary', onclick: () => deleteBatch(info) },
            `${info.count}개 삭제`,
          ),
        ),
      );
    }
    return h(
      'li',
      {},
      h('span', { class: 'bi' }, icon(info.kind === 'school' ? 'school' : 'file')),
      h('div', { class: 'bt' }, h('b', {}, batch.label), h('span', {}, batchLine(info))),
      h(
        'div',
        { class: 'ba' },
        info.firstDate
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn btn-text',
                'aria-label': `${batch.label} 달력에서 보기`,
                onclick: () => {
                  finish();
                  opts.onGoto(info.firstDate!);
                },
              },
              '달력에서 보기',
            )
          : null,
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-ghost',
            'data-fk': `del:${batch.id}`,
            'aria-label': `${batch.label} 모두 삭제`,
            onclick: () => {
              confirmId = batch.id;
              draw();
              focusFk(`cancel:${batch.id}`);
            },
          },
          icon('trash'),
          '모두 삭제',
        ),
      ),
    );
  };

  const draw = () => {
    const infos = batchInfos(opts.store);
    const schoolLine = school
      ? h(
          'div',
          { class: 'key-row' },
          h('span', { class: 'school-name' }, school.name),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-text',
              onclick: () => {
                school = null;
                opts.onSchool(null);
                draw();
              },
            },
            '지우기',
          ),
        )
      : h('span', { class: 'days-n' }, '나이스에서 학교를 고르면 여기에 저장됩니다.');

    dialog.replaceChildren(
      h(
        'div',
        { class: 'd-h' },
        h('h2', { id: 'set-h' }, '설정'),
        h(
          'button',
          { type: 'button', class: 'icon-btn', 'aria-label': '닫기', onclick: finish },
          icon('x'),
        ),
      ),
      h(
        'div',
        { class: 'd-b' },
        h('h3', { class: 'sec-h' }, '학사일정'),
        h(
          'div',
          { class: 'fields' },
          keyField(),
          keyMsg
            ? h(
                'p',
                {
                  class: `key-msg ${keyMsg.kind}`,
                  role: keyMsg.kind === 'err' ? 'alert' : 'status',
                },
                keyMsg.text,
              )
            : null,
          h('div', { class: 'f' }, h('span', { class: 'fl' }, '기본 학교'), schoolLine),
          radios<number | null>(
            'set-grade',
            '내 학년',
            [
              [null, '전체'],
              [1, '1학년'],
              [2, '2학년'],
              [3, '3학년'],
            ],
            prefs.grade,
            (grade) => setPrefs({ ...prefs, grade }),
          ),
        ),
        h('h3', { class: 'sec-h' }, '보기'),
        h(
          'div',
          { class: 'fields' },
          radios<WeekStart>(
            'set-week',
            '한 주 시작',
            [
              [0, '일요일'],
              [1, '월요일'],
            ],
            prefs.weekStart,
            (weekStart) => setPrefs({ ...prefs, weekStart }),
          ),
          radios<Theme>(
            'set-theme',
            '테마',
            [
              ['system', '시스템'],
              ['light', '라이트'],
              ['dark', '다크'],
            ],
            prefs.theme,
            (theme) => setPrefs({ ...prefs, theme }),
          ),
        ),
        h('h3', { class: 'sec-h', tabindex: '-1', 'data-fk': 'batches-h' }, '가져온 일정'),
        batchErr ? h('p', { class: 'form-err', role: 'alert' }, batchErr) : null,
        undoLine(),
        infos.length
          ? h('ul', { class: 'batches' }, ...infos.map(batchRow))
          : h(
              'p',
              { class: 'hint-line' },
              '아직 가져온 일정이 없습니다. 상단의 가져오기 버튼으로 학사일정을 넣어 보세요.',
            ),
      ),
      h(
        'div',
        { class: 'd-f' },
        h('span', { class: 'sp' }),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: finish }, '닫기'),
      ),
    );
  };

  dialog.oncancel = (e) => {
    e.preventDefault();
    if (confirmId) {
      const id = confirmId;
      confirmId = null;
      draw();
      focusFk(`del:${id}`);
      return;
    }
    finish();
  };
  dialog.onclose = () => finish();
  dialog.showModal();
  draw();
  focusFk(editingKey ? 'key-in' : 'key-change');
  return { close: finish };
}
