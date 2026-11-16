import { academicYearOf, localIsoDate } from '../../model/date';
import type { NeisSchool, SchoolSearchResult } from '../../import/neis';
import { h } from '../dom';
import type { SavedSchool } from '../settings/neisPrefs';

export interface PickNeisProps {
  hasKey: boolean;
  saved: SavedSchool | null;
  today: Date;
  search(name: string, signal: AbortSignal): Promise<SchoolSearchResult>;
  onOpenSettings(): void;
  onLoad(school: SavedSchool, academicYear: number): void;
  /** Why the last load failed, shown at the top. */
  error: string | null;
}

export function schoolDetail(s: NeisSchool): string {
  return [s.kind, s.region].filter(Boolean).join(' · ');
}

function errorText(err: unknown): string {
  if (err instanceof Error && err.name === 'AbortError') return '';
  if (err instanceof Error && err.message) return err.message;
  return '학교를 찾지 못했습니다. 잠시 뒤에 다시 시도해 주세요.';
}

/** School search, school and year choice. Redraws only its own result list while typing. */
export function pickNeisView(props: PickNeisProps): HTMLElement {
  let schools: SavedSchool[] = props.saved ? [props.saved] : [];
  let offices = new Map<string, string>();
  let selected: SavedSchool | null = props.saved;
  let status: { kind: 'idle' | 'busy' | 'empty' | 'error'; text: string } = {
    kind: 'idle',
    text: '',
  };
  let total = 0;
  let controller: AbortController | null = null;

  const thisYear = academicYearOf(localIsoDate(props.today));
  const years = [thisYear + 1, thisYear, thisYear - 1, thisYear - 2];
  const query = h('input', {
    type: 'search',
    id: 'neis-q',
    autocomplete: 'off',
    enterkeyhint: 'search',
    placeholder: '학교 이름 (두 글자 이상)',
    'data-fk': 'neis-q',
  });
  const searchBtn = h('button', { type: 'submit', class: 'btn btn-ghost' }, '검색');
  const results = h('div', { class: 'schools', 'aria-live': 'polite' });
  const year = h(
    'select',
    { class: 'in in-year', id: 'neis-year' },
    ...years.map((y) => h('option', { value: y, selected: y === thisYear }, `${y}학년도`)),
  );
  const range = h('span', { class: 'days-n' });
  const load = h(
    'button',
    { type: 'button', class: 'btn btn-primary', 'data-fk': 'neis-load' },
    '학사일정 불러오기',
  );

  const syncYear = () => {
    const y = Number(year.value);
    range.textContent = `${y}.03.01 – ${y + 1}.02.28`;
  };
  const syncLoad = () => {
    load.disabled = !selected;
  };

  const drawResults = () => {
    const children: (Node | string)[] = [];
    if (status.kind === 'busy') children.push(h('p', { class: 'hint-line' }, status.text));
    else if (status.kind === 'error')
      children.push(h('p', { class: 'form-err', role: 'alert' }, status.text));
    else if (status.kind === 'empty') children.push(h('p', { class: 'hint-line' }, status.text));
    if (schools.length) {
      const list = h(
        'fieldset',
        { class: 'school-list' },
        h('legend', { class: 'sr-only' }, '학교'),
      );
      for (const s of schools) {
        const radio = h('input', {
          type: 'radio',
          name: 'neis-school',
          value: s.schoolCode,
          checked: selected?.schoolCode === s.schoolCode && selected.officeCode === s.officeCode,
        });
        radio.addEventListener('change', () => {
          selected = s;
          syncLoad();
        });
        const office = offices.get(s.officeCode);
        list.appendChild(
          h(
            'label',
            { class: 'school' },
            radio,
            h(
              'span',
              { class: 'school-t' },
              h('b', {}, s.name),
              h('span', {}, [s.detail, office].filter(Boolean).join(' · ')),
            ),
          ),
        );
      }
      children.push(list);
      if (total > schools.length) {
        children.push(
          h(
            'p',
            { class: 'hint-line' },
            props.hasKey
              ? `검색 결과 ${total}곳 중 ${schools.length}곳을 보여 드립니다. 이름을 더 길게 써 보세요.`
              : `인증키가 없어 검색 결과 ${total}곳 중 ${schools.length}곳만 보입니다.`,
          ),
        );
      }
    }
    results.replaceChildren(...children.map((c) => (typeof c === 'string' ? h('span', {}, c) : c)));
  };

  const runSearch = async () => {
    const q = query.value.trim();
    controller?.abort();
    if (q.length < 2) {
      status = { kind: 'idle', text: '' };
      drawResults();
      return;
    }
    const mine = new AbortController();
    controller = mine;
    status = { kind: 'busy', text: '찾는 중입니다…' };
    drawResults();
    // A request that never answers must not leave "찾는 중" on screen.
    const giveUp = setTimeout(() => mine.abort(new Error('timeout')), 20_000);
    try {
      const res = await props.search(q, mine.signal);
      if (controller !== mine) return;
      offices = new Map(res.schools.map((s) => [s.officeCode, s.officeName]));
      schools = res.schools.map((s) => ({
        officeCode: s.officeCode,
        schoolCode: s.schoolCode,
        name: s.name,
        detail: schoolDetail(s),
      }));
      total = res.total;
      status = schools.length
        ? { kind: 'idle', text: '' }
        : { kind: 'empty', text: '찾는 학교가 없습니다. 이름을 다시 확인해 주세요.' };
    } catch (err) {
      if (controller !== mine) return;
      const msg = mine.signal.aborted
        ? '응답이 늦어 중단했습니다. 다시 검색해 주세요.'
        : errorText(err);
      status = { kind: 'error', text: msg };
    } finally {
      clearTimeout(giveUp);
    }
    if (selected && !schools.some((s) => s.schoolCode === selected?.schoolCode)) selected = null;
    syncLoad();
    drawResults();
  };

  const form = h(
    'form',
    { class: 'neis-search', role: 'search', 'aria-label': '학교 검색' },
    h('label', { for: 'neis-q', class: 'sr-only' }, '학교 이름'),
    h('div', { class: 'line-in' }, query, searchBtn),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void runSearch();
  });
  query.addEventListener('keydown', (e) => {
    // Enter that commits a Korean syllable must not start the search.
    if (e.isComposing || e.keyCode === 229) e.stopPropagation();
  });

  const notice = props.hasKey
    ? null
    : h(
        'div',
        { class: 'notice-box', role: 'note' },
        h('b', {}, 'NEIS 인증키가 없어 일정이 5건만 받아집니다.'),
        h('p', {}, '설정에 인증키를 넣으면 한 해 일정을 모두 받을 수 있습니다.'),
        h(
          'div',
          { class: 'row' },
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-primary',
              'data-fk': 'neis-key',
              onclick: () => props.onOpenSettings(),
            },
            'NEIS 인증키 입력',
          ),
          h(
            'button',
            { type: 'button', class: 'btn btn-text', onclick: () => query.focus() },
            '키 없이 5건만',
          ),
        ),
      );

  load.addEventListener('click', () => {
    if (selected) props.onLoad(selected, Number(year.value));
  });
  year.addEventListener('change', syncYear);
  syncYear();
  syncLoad();
  drawResults();

  return h(
    'div',
    { class: 'pick-neis' },
    props.error ? h('p', { class: 'form-err', role: 'alert' }, props.error) : null,
    notice,
    form,
    results,
    h(
      'div',
      { class: 'neis-year' },
      h('label', { for: 'neis-year', class: 'fl' }, '학년도'),
      year,
      range,
    ),
    h('div', { class: 'row neis-go' }, load),
  );
}
