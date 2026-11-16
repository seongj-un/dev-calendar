/** Tiny DOM builder. Text always goes in as text nodes, never as HTML. */

export type Child = Node | string | number | null | undefined | false;

type Handler = (event: Event) => void;
export type Props = Record<
  string,
  string | number | boolean | null | undefined | Handler | Record<string, string>
>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') {
      el.className = String(value);
    } else if (key === 'style' && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value)) el.style.setProperty(prop, v);
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

/** Appends real nodes only; `null`/`false` children are skipped instead of printing "null". */
export function append(parent: Node, children: readonly Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'string' || typeof c === 'number' ? text(String(c)) : c);
  }
}

export function text(value: string): Text {
  return document.createTextNode(value);
}

/** True when keys typed here belong to the field, not to the calendar shortcuts. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(target.type);
  }
  return false;
}

/** Elements hidden with display:none (mobile-only or desktop-only parts) have no boxes. */
export function isShown(el: Element | null | undefined): el is HTMLElement {
  return el instanceof HTMLElement && el.getClientRects().length > 0;
}

export function isMac(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? navigator.platform ?? '';
  return /mac|iphone|ipad/i.test(platform);
}

/** Selector-safe value; CSS.escape where the environment has it. */
export function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\\][]/g, '\\$&');
}
