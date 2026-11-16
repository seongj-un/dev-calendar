import { h, isMac } from './dom';
import { icon } from './icons';

export interface ToastOptions {
  message: string;
  /** Undo action; shown as a button and run by Cmd/Ctrl+Z while the toast is up. */
  undo?: () => void;
  duration?: number;
}

/**
 * One toast at a time in a polite live region. The timer pauses while the
 * pointer or focus is on the toast, so the undo button can always be reached.
 */
export class Toaster {
  private current: { el: HTMLElement; undo?: () => void } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private remaining = 0;
  private startedAt = 0;

  constructor(private readonly region: HTMLElement) {}

  show(options: ToastOptions): void {
    this.dismiss();
    const duration = options.duration ?? 5000;
    const undoButton = options.undo
      ? h(
          'button',
          { type: 'button', class: 'btn', onclick: () => this.runUndo() },
          '되돌리기',
          h(
            'kbd',
            { class: 'kbd-inv', 'aria-hidden': 'true' },
            isMac() ? icon('cmd', 'kc') : 'Ctrl',
          ),
          h('kbd', { class: 'kbd-inv', 'aria-hidden': 'true' }, 'Z'),
        )
      : null;
    const el = h('div', { class: 'toast' }, h('span', {}, options.message), undoButton);
    el.addEventListener('pointerenter', () => this.pause());
    el.addEventListener('pointerleave', () => this.resume());
    el.addEventListener('focusin', () => this.pause());
    el.addEventListener('focusout', (e) => {
      if (!el.contains(e.relatedTarget as Node | null)) this.resume();
    });
    this.region.appendChild(el);
    this.current = { el, undo: options.undo };
    this.remaining = duration;
    this.resume();
  }

  /** Runs the shown toast's undo (Cmd/Ctrl+Z). Returns false when there is none. */
  runUndo(): boolean {
    const undo = this.current?.undo;
    if (!undo) return false;
    this.dismiss();
    undo();
    return true;
  }

  get hasUndo(): boolean {
    return Boolean(this.current?.undo);
  }

  dismiss(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.current?.el.remove();
    this.current = null;
  }

  private pause(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.remaining -= Date.now() - this.startedAt;
  }

  private resume(): void {
    if (!this.current || this.timer) return;
    this.startedAt = Date.now();
    this.timer = setTimeout(() => this.dismiss(), Math.max(1500, this.remaining));
  }
}
