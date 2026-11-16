import type { IsoDate } from '../model/date';
import type { Category } from '../model/event';

/** One row of an import preview. Every parser returns these. */
export interface ImportedEvent {
  /** Title without the grade suffix: "입학식" for "입학식(1)". */
  title: string;
  /** Text as it appeared in the source, kept for the preview and for matching. */
  rawTitle: string;
  start: IsoDate;
  end: IsoDate;
  allDay: boolean;
  time?: string;
  endTime?: string;
  category: Category;
  grades?: number[];
  notice?: boolean;
  /** Day off (public holiday, school closure). */
  holiday: boolean;
  /** Why this row needs a look before it goes in; the preview unchecks it. */
  review?: string;
  /** How many source rows were merged into this one (NEIS sends one row per day). */
  mergedDays?: number;
}

export type ImportKind =
  'pdf-grid' | 'pdf-text' | 'ics' | 'xlsx' | 'hwpx' | 'hwp' | 'text' | 'neis';

export type ImportWarningCode =
  | 'no-text'
  | 'no-dates'
  | 'unsupported'
  | 'too-large'
  | 'read-failed'
  | 'neis-sample-limit'
  | 'skipped-rows';

export interface ImportWarning {
  code: ImportWarningCode;
  message: string;
}

export interface ImportResult {
  kind: ImportKind;
  /** Stored on every event: `file:<name>` or `neis:<office>/<school>`. */
  source: string;
  /** Human label for the batch list ("school-2026.pdf", "대덕소프트웨어마이스터고"). */
  label: string;
  events: ImportedEvent[];
  /** Academic year the dates were placed in, when the source had no full dates. */
  academicYear?: number;
  pages?: number;
  warnings: ImportWarning[];
}
