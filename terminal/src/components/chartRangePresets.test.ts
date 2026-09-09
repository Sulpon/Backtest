import { describe, expect, it } from "vitest";
import { computeRangeIndices } from "./chartRangePresets";

function ts(y: number, m: number, d: number, h = 0, mi = 0): number {
  return Date.UTC(y, m - 1, d, h, mi, 0) / 1000;
}

describe("computeRangeIndices", () => {
  it("1D: finds the first bar within 1 day of the last bar", () => {
    const bars = [ts(2026, 9, 7), ts(2026, 9, 8, 12), ts(2026, 9, 9)];
    expect(computeRangeIndices(bars, "1D")).toEqual({ from: 1, to: 2 });
  });

  it("5D: finds the first bar within 5 days of the last bar", () => {
    const bars = [ts(2026, 8, 30), ts(2026, 9, 3), ts(2026, 9, 4), ts(2026, 9, 9)];
    expect(computeRangeIndices(bars, "5D")).toEqual({ from: 2, to: 3 });
  });

  it("1M: uses real calendar-month subtraction, not a fixed day count", () => {
    const bars = [ts(2026, 7, 1), ts(2026, 8, 9), ts(2026, 8, 10), ts(2026, 9, 9)];
    expect(computeRangeIndices(bars, "1M")).toEqual({ from: 1, to: 3 });
  });

  it("3M: real calendar-month subtraction", () => {
    const bars = [ts(2026, 5, 1), ts(2026, 6, 9), ts(2026, 6, 10), ts(2026, 9, 9)];
    expect(computeRangeIndices(bars, "3M")).toEqual({ from: 1, to: 3 });
  });

  it("6M: real calendar-month subtraction", () => {
    const bars = [ts(2026, 2, 1), ts(2026, 3, 9), ts(2026, 3, 10), ts(2026, 9, 9)];
    expect(computeRangeIndices(bars, "6M")).toEqual({ from: 1, to: 3 });
  });

  it("YTD: start of the last bar's own calendar year (UTC), not the viewer's", () => {
    const bars = [ts(2025, 12, 31), ts(2026, 1, 1), ts(2026, 1, 2), ts(2026, 9, 9)];
    expect(computeRangeIndices(bars, "YTD")).toEqual({ from: 1, to: 3 });
  });

  it("1Y: real calendar-year subtraction", () => {
    const bars = [ts(2024, 1, 1), ts(2025, 9, 9), ts(2025, 9, 10), ts(2026, 9, 9)];
    expect(computeRangeIndices(bars, "1Y")).toEqual({ from: 1, to: 3 });
  });

  it("5Y: real calendar-year subtraction", () => {
    const bars = [ts(2019, 1, 1), ts(2021, 9, 9), ts(2021, 9, 10), ts(2026, 9, 9)];
    expect(computeRangeIndices(bars, "5Y")).toEqual({ from: 1, to: 3 });
  });

  it("ALL: the entire array regardless of span", () => {
    const bars = [ts(2010, 1, 1), ts(2018, 6, 15), ts(2026, 9, 9)];
    expect(computeRangeIndices(bars, "ALL")).toEqual({ from: 0, to: 2 });
  });

  it("empty dataset: null for every preset, matching defaultVisibleRangeIndices' own convention", () => {
    expect(computeRangeIndices([], "1D")).toBeNull();
    expect(computeRangeIndices([], "ALL")).toBeNull();
  });

  it("a single candle: every preset resolves to that one bar, never an out-of-bounds index", () => {
    const bars = [ts(2026, 9, 9)];
    expect(computeRangeIndices(bars, "5Y")).toEqual({ from: 0, to: 0 });
    expect(computeRangeIndices(bars, "1D")).toEqual({ from: 0, to: 0 });
  });

  it("a preset lookback longer than the whole dataset degrades to showing everything, not an empty/invalid range", () => {
    const bars = [ts(2026, 8, 1), ts(2026, 9, 9)]; // only ~5 weeks of data
    expect(computeRangeIndices(bars, "5Y")).toEqual({ from: 0, to: 1 });
  });

  it("replay-limited data: anchors on the LAST bar actually passed in, not real time - the caller passing a replay-truncated array is what makes this replay-correct", () => {
    // Simulates ChartPane.tsx's dataRef.current already being sliced to the
    // replay cursor (see this file's own doc comment) - "1Y" here means 1
    // year up to the replay point, never revealing bars beyond it, because
    // this function never sees them in the first place.
    const replayTruncatedBars = [ts(2024, 1, 1), ts(2024, 6, 1), ts(2024, 12, 31)]; // replay stopped in 2024
    const result = computeRangeIndices(replayTruncatedBars, "1Y");
    expect(result).not.toBeNull();
    expect(result!.to).toBe(2); // the replay cursor's own last bar, never index 3+ (bars that don't exist here)
  });
});
