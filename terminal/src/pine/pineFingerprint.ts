import type { CandleBar } from "../data/types";

/** A cheap, deterministic fingerprint of a bars array's actual content -
 * length + first/last timestamp. Two different symbol/timeframe datasets
 * essentially never collide on this; the SAME dataset always produces the
 * same fingerprint regardless of array identity/reference, which is what
 * makes it safe to use as both a cache key component and a tag a consumer
 * can compare against its own current data without holding a reference to
 * the exact array a result was computed from. */
export function datasetVersion(bars: CandleBar[]): string {
  const first = bars[0]?.time ?? 0;
  const last = bars[bars.length - 1]?.time ?? 0;
  return `${bars.length}:${first}:${last}`;
}

export function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
