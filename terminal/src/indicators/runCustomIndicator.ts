import type { CandleBar } from "../data/types";

export interface CustomIndicatorPoint {
  time: number;
  value: number;
}

export interface CustomIndicatorResult {
  points: CustomIndicatorPoint[];
  error: string | null;
}

/**
 * Runs user-authored indicator code against a window of bars. `new
 * Function` (not eval) scopes the code to a single `bars` parameter and
 * nothing else in this closure - it still runs with the page's full JS
 * privileges, same as any inline script, but this is a single-user local
 * tool where the only person who can ever reach this textarea is the
 * person running the app, so that's an acceptable trust boundary (unlike a
 * multi-tenant product, where this would need a real sandbox - a Worker
 * with a hard timeout, or server-side execution).
 */
export function runCustomIndicator(code: string, bars: CandleBar[]): CustomIndicatorResult {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function("bars", code);
    const result = fn(bars);
    if (!Array.isArray(result)) {
      return { points: [], error: "Code must return an array of { time, value } points." };
    }
    const points = result.filter(
      (p): p is CustomIndicatorPoint => p && typeof p.time === "number" && typeof p.value === "number" && Number.isFinite(p.value)
    );
    return { points, error: null };
  } catch (e) {
    return { points: [], error: e instanceof Error ? e.message : String(e) };
  }
}
