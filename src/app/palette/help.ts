import { h, isMac } from '../dom';
import { icon } from '../icons';

interface Group {
  title: string;
  rows: [label: string, keys: string[]][];
}

function groups(): Group[] {
  const mod = isMac() ? '⌘' : 'Ctrl';
  return [
    {
      title: '이동',
      rows: [
        ['하루 앞뒤', ['H', 'L']],
        ['한 주 앞뒤', ['K', 'J']],
        ['이전·다음 달', ['[', ']']],
        ['오늘', ['T']],
        ['날짜로 이동', ['G']],
      ],
    },
    {
      title: '일정',
      rows: [
        ['새 일정', ['N']],
        ['일정 고르기', ['Enter']],
        ['편집', ['E']],
        ['삭제', ['Delete']],
        ['되돌리기', [mod, 'Z']],
      ],
    },
    {
      title: '찾기와 명령',
      rows: [
        ['팔레트 열기', [mod, 'K']],
        ['일정 검색', ['/']],
        ['학사일정 가져오기', ['I']],
        ['설정', [',']],
        ['단축키 표', ['?']],
      ],
    },
    {
      title: '보기',
      rows: [
        ['라이트·다크', ['D']],
        ['이 날짜 링크 복사', ['Y']],
        ['걸러 보기 끄기', ['Esc']],
      ],
    },
  ];
}

const COMMAND_ROWS: [string, string][] = [
  ['>goto 2027-03', '날짜로 이동'],
  ['>export ics', '.ics로 내보내기'],
  ['>export json', 'JSON 백업 내보내기'],
  ['>import json', 'JSON 백업 가져오기'],
];

/** The shortcut sheet opened with `?`. */
export class HelpSheet {
  readonly element: HTMLDialogElement;
  private returnTo: HTMLElement | null = null;

  constructor() {
    const closeBtn = h(
      'button',
      { type: 'button', class: 'icon-btn', 'aria-label': '닫기', autofocus: true },
      icon('x'),
    );
    closeBtn.addEventListener('click', () => this.close());
    this.element = h(
      'dialog',
      { class: 'dialog help-sheet', 'aria-labelledby': 'help-title' },
      h('div', { class: 'd-h' }, h('h2', { id: 'help-title' }, '단축키'), closeBtn),
      h(
        'div',
        { class: 'd-b help-grid' },
        ...groups().map((g) =>
          h(
            'section',
            { class: 'help-g' },
            h('h3', {}, g.title),
            h(
              'dl',
              {},
              ...g.rows.map(([label, keys]) =>
                h('div', {}, h('dt', {}, label), h('dd', {}, ...keys.map((k) => h('kbd', {}, k)))),
              ),
            ),
          ),
        ),
        h(
          'section',
          { class: 'help-g help-cmds' },
          h('h3', {}, '팔레트 명령'),
          h(
            'dl',
            {},
            ...COMMAND_ROWS.map(([cmd, desc]) =>
              h('div', {}, h('dt', {}, h('code', {}, cmd)), h('dd', {}, desc)),
            ),
          ),
        ),
      ),
    );
    this.element.addEventListener('click', (e) => {
      if (e.target === this.element) this.close();
    });
    this.element.addEventListener('close', () => this.restoreFocus());
  }

  get isOpen(): boolean {
    return this.element.open;
  }

  open(): void {
    if (this.element.open) return;
    this.returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.element.showModal();
  }

  close(): void {
    if (this.element.open) this.element.close();
    this.restoreFocus();
  }

  private restoreFocus(): void {
    const el = this.returnTo;
    this.returnTo = null;
    if (el?.isConnected) el.focus();
  }
}
