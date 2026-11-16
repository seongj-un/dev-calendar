import type { StorageLike } from '../../store/store';

/**
 * NEIS settings, kept apart from the event data and the view preferences.
 * The key stays in this browser and is only sent to open.neis.go.kr.
 */

export const NEIS_KEY = 'datebook:neis-key';
export const NEIS_SCHOOL_KEY = 'datebook:neis-school';

export interface SavedSchool {
  officeCode: string;
  schoolCode: string;
  name: string;
  /** "고등학교 · 대전" style line for the list. */
  detail: string;
}

/** Same shape check as the NEIS client; kept here so settings does not load that chunk. */
export function isKeyShape(key: string): boolean {
  return /^[A-Za-z0-9]{16,64}$/.test(key);
}

export function loadNeisKey(storage: StorageLike): string {
  try {
    const key = storage.getItem(NEIS_KEY) ?? '';
    return isKeyShape(key) ? key : '';
  } catch {
    return '';
  }
}

/** Returns false when the browser refused the write. */
export function saveNeisKey(storage: StorageLike, key: string): boolean {
  try {
    storage.setItem(NEIS_KEY, key);
    return true;
  } catch {
    return false;
  }
}

/** Dots with the last four characters, so the person can tell keys apart. */
export function maskKey(key: string): string {
  if (!key) return '';
  return `${'•'.repeat(Math.max(4, key.length - 4))}${key.slice(-4)}`;
}

export function loadSchool(storage: StorageLike): SavedSchool | null {
  let raw: unknown;
  try {
    raw = JSON.parse(storage.getItem(NEIS_SCHOOL_KEY) ?? 'null');
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const ok = (v: unknown, max: number): v is string =>
    typeof v === 'string' && v.length > 0 && v.length <= max;
  if (!ok(r.officeCode, 10) || !ok(r.schoolCode, 20) || !ok(r.name, 100)) return null;
  return {
    officeCode: r.officeCode,
    schoolCode: r.schoolCode,
    name: r.name,
    detail: typeof r.detail === 'string' ? r.detail.slice(0, 100) : '',
  };
}

export function saveSchool(storage: StorageLike, school: SavedSchool | null): boolean {
  try {
    storage.setItem(NEIS_SCHOOL_KEY, school ? JSON.stringify(school) : '');
    return true;
  } catch {
    return false;
  }
}
