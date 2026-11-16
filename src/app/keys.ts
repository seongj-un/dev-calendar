/**
 * The key a shortcut should act on. With a Korean input method on, `event.key`
 * can be a jamo ("ㅓ") while `event.code` still names the physical key
 * ("KeyJ"), so letters are read from `code` when `key` is not ASCII.
 * Returns null while an input method is composing text: the key belongs to it.
 */
export function shortcutKey(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'isComposing' | 'keyCode'>,
): string | null {
  if (e.isComposing || e.keyCode === 229 || e.key === 'Process') return null;
  if (e.key.length === 1 && e.key.charCodeAt(0) > 0x7f) {
    const m = /^Key([A-Z])$/.exec(e.code);
    if (m) return m[1]!.toLowerCase();
  }
  return e.key;
}
