import type { StorageLike } from '../store/store';
import type { WeekStart } from './layout';

export type Theme = 'system' | 'light' | 'dark';

/**
 * View preferences, kept apart from the event data. The settings screen
 * (next PR) edits them; this PR only switches the theme.
 */
export interface Prefs {
  theme: Theme;
  /** Grade whose events are shown; null shows every grade. */
  grade: number | null;
  weekStart: WeekStart;
}

export const PREFS_KEY = 'datebook:prefs';
export const DEFAULT_PREFS: Prefs = { theme: 'system', grade: null, weekStart: 0 };

export function loadPrefs(storage: StorageLike): Prefs {
  let raw: unknown;
  try {
    raw = JSON.parse(storage.getItem(PREFS_KEY) ?? 'null');
  } catch {
    return { ...DEFAULT_PREFS };
  }
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_PREFS };
  const r = raw as Record<string, unknown>;
  return {
    theme: r.theme === 'light' || r.theme === 'dark' ? r.theme : 'system',
    grade:
      typeof r.grade === 'number' && Number.isInteger(r.grade) && r.grade >= 1 && r.grade <= 6
        ? r.grade
        : null,
    weekStart: r.weekStart === 1 ? 1 : 0,
  };
}

/** Returns false when the browser refused the write (the change still applies to this tab). */
export function savePrefs(storage: StorageLike, prefs: Prefs): boolean {
  try {
    storage.setItem(PREFS_KEY, JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}

export function effectiveTheme(theme: Theme, systemDark: boolean): 'light' | 'dark' {
  if (theme === 'system') return systemDark ? 'dark' : 'light';
  return theme;
}
