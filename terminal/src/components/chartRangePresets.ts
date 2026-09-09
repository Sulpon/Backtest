/**
 * Pure "which bars should be visible" logic behind the TradingView-style
 * range buttons (1D/5D/1M/3M/6M/YTD/1Y/5Y/ALL). Extracted the same way
 * chartVisibleRange.ts's defaultVisibleRangeIndices() already is - testable
 * without importing ChartPane.tsx (which pulls in drawing/interactionState.ts's
 * module-scope window.addEventListener, incompatible with this repo's
 * jsdom-less vitest environment).
 *
 * Anchored on the LAST bar actually available to the caller, never
 * Date.now() - this is what makes it replay-correct for free: ChartPane.tsx
 * already truncates the series data itself to the replay cursor during
 * replay (see its own [replayActive, cursorBar, jumpNonce] effect), so a
 * caller that passes dataRef.current's bar times automatically gets "1Y of
 * data up to the replay point" during replay, and "1Y up to the real last
 * bar" otherwise - no separate replay-awareness needed here.
 *
 * Calendar-based presets (1M/3M/6M/YTD/1Y/5Y) use the Date object's own
 * UTC setters (setUTCMonth/setUTCFullYear), which correctly normalize
 * variable month lengths and leap years - not a fixed-day approximation.
 * All bar timestamps in this app are UTC seconds (see replay/replayDate.ts's
 * own doc comment) - this reuses that exact convention, never the viewer's
 * local timezone.
 */
export const CHART_RANGE_PRESETS = ["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "5Y", "ALL"] as const;
export type ChartRangePreset = (typeof CHART_RANGE_PRESETS)[number];

function monthsAgo(lastTime: number, months: number): number {
  const d = new Date(lastTime * 1000);
  d.setUTCMonth(d.getUTCMonth() - months);
  return Math.floor(d.getTime() / 1000);
}

function yearsAgo(lastTime: number, years: number): number {
  const d = new Date(lastTime * 1000);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return Math.floor(d.getTime() / 1000);
}

function startOfYearUTC(lastTime: number): number {
  const d = new Date(lastTime * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), 0, 1) / 1000);
}

function fromTimeFor(preset: Exclude<ChartRangePreset, "ALL">, lastTime: number): number {
  switch (preset) {
    case "1D":
      return lastTime - 1 * 86400;
    case "5D":
      return lastTime - 5 * 86400;
    case "1M":
      return monthsAgo(lastTime, 1);
    case "3M":
      return monthsAgo(lastTime, 3);
    case "6M":
      return monthsAgo(lastTime, 6);
    case "YTD":
      return startOfYearUTC(lastTime);
    case "1Y":
      return yearsAgo(lastTime, 1);
    case "5Y":
      return yearsAgo(lastTime, 5);
  }
}

/**
 * `barTimes` must already be ascending (the order every bar array in this
 * app is already loaded/stored in). Returns bar INDICES, not raw
 * timestamps - the caller (ChartPane.tsx) already has an established
 * `asTime(bars[idx].time)` conversion for turning an index into what
 * `chart.timeScale().setVisibleRange()` needs.
 *
 * Returns null for an empty array - same "nothing meaningful to show"
 * convention defaultVisibleRangeIndices() already uses, for the same
 * reason (a pane can legitimately have zero bars).
 */
export function computeRangeIndices(barTimes: number[], preset: ChartRangePreset): { from: number; to: number } | null {
  const lastIdx = barTimes.length - 1;
  if (lastIdx < 0) return null;
  if (preset === "ALL") return { from: 0, to: lastIdx };

  const fromTime = fromTimeFor(preset, barTimes[lastIdx]);
  const from = barTimes.findIndex((t) => t >= fromTime);
  // Only reachable if fromTime somehow lands after every bar (it can't,
  // fromTime <= lastTime always) - kept as a defensive fallback so this
  // function never returns an invalid/inverted range rather than assuming
  // the arithmetic above is infallible.
  return { from: from >= 0 ? from : lastIdx, to: lastIdx };
}
