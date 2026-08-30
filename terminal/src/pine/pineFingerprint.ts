import type { CandleBar } from "../data/types";

const SAMPLE_COUNT = 32;

/** A cheap, deterministic fingerprint of a bars array's actual content -
 * length + first/last timestamp, plus a fixed-cost (O(1) regardless of
 * dataset size) sampled hash over up to 32 evenly-spaced close prices.
 * Length + endpoints alone is structural metadata, not content - two
 * datasets with the same length and endpoints but different interior
 * values would otherwise silently collide. The sampled hash is O(1) so it
 * does NOT hash every bar (that would reintroduce real per-call cost on a
 * 100k-bar array). The SAME dataset always produces the same fingerprint
 * regardless of array identity/reference, which is what makes it safe to
 * use as both a cache key component and a tag a consumer can compare
 * against its own current data without holding a reference to the exact
 * array a result was computed from. Close prices are rounded to 5 decimal
 * places (FX pip precision) to avoid spurious version churn from float
 * noise between otherwise-identical datasets. */
export function datasetVersion(bars: CandleBar[]): string {
  const n = bars.length;
  if (n === 0) return "0:0:0:0";
  const first = bars[0].time;
  const last = bars[n - 1].time;
  const samples = Math.min(n, SAMPLE_COUNT);
  let h = 0;
  for (let i = 0; i < samples; i++) {
    const idx = samples === 1 ? 0 : Math.round((i * (n - 1)) / (samples - 1));
    h = (Math.imul(31, h) + Math.round(bars[idx].close * 100000)) | 0;
  }
  return `${n}:${first}:${last}:${h}`;
}

export function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
