import { describe, expect, it } from "vitest";
import { cacheKey, datasetVersion } from "./usePineIndicators";
import type { PineIndicator } from "./pineIndicatorStore";
import type { CandleBar } from "../data/types";

function bars(n: number, startTime = 1000): CandleBar[] {
  return Array.from({ length: n }, (_, i) => ({
    time: startTime + i * 3600,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
  }));
}

function indicator(overrides: Partial<PineIndicator> = {}): PineIndicator {
  return {
    id: "pi-1",
    name: "Test",
    code: "indicator('x')",
    visible: true,
    inputOverrides: {},
    startDate: null,
    ...overrides,
  };
}

describe("datasetVersion", () => {
  it("is stable for the same content across different array references", () => {
    const a = bars(100);
    const b = bars(100); // distinct array/objects, identical content
    expect(datasetVersion(a)).toBe(datasetVersion(b));
  });

  it("changes when bar count differs", () => {
    expect(datasetVersion(bars(100))).not.toBe(datasetVersion(bars(101)));
  });

  it("changes when the starting timestamp differs (same length)", () => {
    expect(datasetVersion(bars(100, 1000))).not.toBe(datasetVersion(bars(100, 2000)));
  });

  it("distinguishes EURUSD-shaped and GBPUSD-shaped datasets even at the same length", () => {
    // Simulates the actual race condition scenario: two different symbols'
    // bars happen to have the same bar count but different date ranges.
    const eurusd = bars(100000, 1_700_000_000);
    const gbpusd = bars(100000, 1_650_000_000);
    expect(datasetVersion(eurusd)).not.toBe(datasetVersion(gbpusd));
  });

  it("changes when an interior close value differs, even with identical length and first/last time", () => {
    // Regression test for the structural-only (length + endpoints) version
    // of datasetVersion: two datasets that only differ in the middle of
    // the array must not collide just because their shape matches.
    const a = bars(100);
    const b = bars(100).map((bar, i) => (i > 0 && i < 99 ? { ...bar, close: bar.close + 1 } : bar));
    expect(datasetVersion(a)).not.toBe(datasetVersion(b));
  });
});

describe("cacheKey", () => {
  const b = bars(500);

  it("is identical for the same indicator+bars content, even across different array references", () => {
    expect(cacheKey(indicator(), b)).toBe(cacheKey(indicator(), bars(500)));
  });

  it("changes when the indicator id differs", () => {
    expect(cacheKey(indicator({ id: "pi-1" }), b)).not.toBe(cacheKey(indicator({ id: "pi-2" }), b));
  });

  it("changes when the code differs", () => {
    expect(cacheKey(indicator({ code: "a" }), b)).not.toBe(cacheKey(indicator({ code: "b" }), b));
  });

  it("changes when an input override differs - the actual 'setting change' scenario", () => {
    const withDefault = indicator({ inputOverrides: {} });
    const withOverride = indicator({ inputOverrides: { length: 50 } });
    expect(cacheKey(withDefault, b)).not.toBe(cacheKey(withOverride, b));
  });

  it("changes when startDate differs", () => {
    expect(cacheKey(indicator({ startDate: null }), b)).not.toBe(cacheKey(indicator({ startDate: 123 }), b));
  });

  it("changes when the underlying dataset changes (symbol/timeframe switch)", () => {
    expect(cacheKey(indicator(), bars(500, 1000))).not.toBe(cacheKey(indicator(), bars(500, 999999)));
  });
});
