/**
 * How much one imported file may unpack. A zip or compressed stream can claim
 * a few kilobytes and expand to gigabytes, so every parser that inflates data
 * draws from one budget per file, not one per part.
 */
export const MAX_PART_BYTES = 30 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_SECTIONS = 200;

export interface InflateLimits {
  /** One section or part. */
  maxPartBytes?: number;
  /** All sections of the file together. */
  maxTotalBytes?: number;
  maxSections?: number;
}
