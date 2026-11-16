import { ACCEPTED_EXTENSIONS } from '../../import';
import { h } from '../dom';
import { icon } from '../icons';

export interface PickFileProps {
  onFile(file: File): void;
  /** Why the last file could not be read, shown above the drop zone. */
  error: string | null;
}

/** Drop zone and file chooser. On phones only the chooser works, so it leads. */
export function pickFileView(props: PickFileProps): HTMLElement {
  const input = h('input', {
    type: 'file',
    accept: ACCEPTED_EXTENSIONS.join(','),
    hidden: true,
    tabindex: '-1',
    'aria-hidden': 'true',
  });
  const pick = h(
    'button',
    { type: 'button', class: 'btn btn-ghost pick', 'data-fk': 'pick-file' },
    '파일 선택',
  );
  const zone = h(
    'div',
    { class: 'drop' },
    h('div', { class: 'di' }, icon('import')),
    h(
      'h3',
      {},
      h('span', { class: 'only-wide' }, '학사일정 파일을 끌어다 놓으세요'),
      h('span', { class: 'only-narrow' }, '학사일정 파일을 고르세요'),
    ),
    h('p', {}, '날짜, 기간, 쉬는 날을 나눠 읽습니다. 반영 전에 고칠 수 있습니다.'),
    pick,
    h(
      'ul',
      { class: 'fmt', 'aria-label': '지원하는 형식' },
      ...['PDF', '.ics', '.xlsx', '.xls', '.hwp', '.hwpx'].map((f, i) =>
        h('li', { class: i === 0 ? 'chip-fmt on' : 'chip-fmt' }, f),
      ),
    ),
  );

  pick.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (file) props.onFile(file);
  });

  let depth = 0;
  const setOver = (on: boolean) => zone.classList.toggle('over', on);
  zone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth++;
    setOver(true);
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  zone.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) setOver(false);
  });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    setOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) props.onFile(file);
  });

  return h(
    'div',
    { class: 'pick-file' },
    props.error ? h('p', { class: 'form-err', role: 'alert' }, props.error) : null,
    zone,
    input,
    h('p', { class: 'privacy' }, '파일은 이 브라우저 안에서만 읽습니다. 서버로 보내지 않습니다.'),
  );
}
