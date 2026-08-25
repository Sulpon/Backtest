import { beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import {
  _debugEntryCount,
  _resetForTests,
  getCachedPineResult,
  persistentCacheKey,
  setCachedPineResult,
  type CachedPineResult,
} from "./pineIndexedDbCache";
import type { PineIndicator } from "./pineIndicatorStore";
import type { CandleBar } from "../data/types";

function bars(n: number, startTime = 1000): CandleBar[] {
  return Array.from({ length: n }, (_, i) => ({ time: startTime + i * 3600, open: 1, high: 1, low: 1, close: 1 }));
}

function indicator(overrides: Partial<PineIndicator> = {}): PineIndicator {
  return { id: "pi-1", name: "Test", code: "indicator('x')", visible: true, inputOverrides: {}, startDate: null, ...overrides };
}

function fakeResult(symbol: string, timeframe: string, datasetVersion: string): CachedPineResult {
  return {
    outputs: { lines: [], boxes: [], labels: [], plots: [], trades: [], errors: [] },
    inputDefs: [],
    fatalError: null,
    symbol,
    timeframe,
    datasetVersion,
  };
}

// Fresh, empty IndexedDB per test - the module under test caches its DB
// connection at module scope (openDb's dbPromise), so recreating global
// indexedDB alone wouldn't be enough; each test instead uses its own
// unique key namespace (via a unique indicator id) to stay isolated
// without needing to reset module state.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  _resetForTests();
});

describe("persistentCacheKey", () => {
  it("includes symbol and timeframe - two different symbols never collide", () => {
    const b = bars(500);
    const ind = indicator();
    expect(persistentCacheKey(ind, "EURUSD", "1h", b)).not.toBe(persistentCacheKey(ind, "GBPUSD", "1h", b));
  });

  it("includes timeframe - same symbol, different timeframe never collides", () => {
    const b = bars(500);
    const ind = indicator();
    expect(persistentCacheKey(ind, "EURUSD", "1h", b)).not.toBe(persistentCacheKey(ind, "EURUSD", "15m", b));
  });

  it("changes when an input parameter changes", () => {
    const b = bars(500);
    expect(persistentCacheKey(indicator({ inputOverrides: {} }), "EURUSD", "1h", b)).not.toBe(
      persistentCacheKey(indicator({ inputOverrides: { length: 50 } }), "EURUSD", "1h", b)
    );
  });

  it("changes when the script code changes (script version invalidation)", () => {
    const b = bars(500);
    expect(persistentCacheKey(indicator({ code: "a" }), "EURUSD", "1h", b)).not.toBe(
      persistentCacheKey(indicator({ code: "b" }), "EURUSD", "1h", b)
    );
  });

  it("changes when the dataset changes underneath the same symbol/timeframe", () => {
    const ind = indicator();
    expect(persistentCacheKey(ind, "EURUSD", "1h", bars(500, 1000))).not.toBe(
      persistentCacheKey(ind, "EURUSD", "1h", bars(500, 999999))
    );
  });
});

describe("getCachedPineResult / setCachedPineResult", () => {
  it("a miss returns undefined", async () => {
    expect(await getCachedPineResult("nope")).toBeUndefined();
  });

  it("round-trips a stored value", async () => {
    const key = "k1";
    const value = fakeResult("EURUSD", "1h", "100:1:2");
    await setCachedPineResult(key, value);
    expect(await getCachedPineResult(key)).toEqual(value);
  });

  it("second visit to the exact same symbol+timeframe+indicator+parameters+dataset is a cache hit", async () => {
    const ind = indicator();
    const b = bars(1000);
    const key = persistentCacheKey(ind, "EURUSD", "1h", b);
    expect(await getCachedPineResult(key)).toBeUndefined(); // first visit: miss
    await setCachedPineResult(key, fakeResult("EURUSD", "1h", "x"));
    expect(await getCachedPineResult(key)).toBeDefined(); // second visit: hit
  });

  it("changing an indicator parameter produces a cache miss even though symbol/timeframe/dataset are unchanged", async () => {
    const b = bars(1000);
    const before = persistentCacheKey(indicator({ inputOverrides: {} }), "EURUSD", "1h", b);
    const after = persistentCacheKey(indicator({ inputOverrides: { length: 99 } }), "EURUSD", "1h", b);
    await setCachedPineResult(before, fakeResult("EURUSD", "1h", "x"));
    expect(await getCachedPineResult(after)).toBeUndefined();
  });

  it("evicts the least-recently-accessed entry once the bound is exceeded", async () => {
    // MAX_ENTRIES is 12 - write 15 distinct entries, touching entry 0 right
    // before the bound is crossed so it should survive despite being oldest
    // by insertion order.
    for (let i = 0; i < 12; i++) {
      await setCachedPineResult(`entry-${i}`, fakeResult("EURUSD", "1h", String(i)));
    }
    await getCachedPineResult("entry-0"); // touch -> bumps its recency
    for (let i = 12; i < 15; i++) {
      await setCachedPineResult(`entry-${i}`, fakeResult("EURUSD", "1h", String(i)));
    }

    const count = await _debugEntryCount();
    expect(count).toBeLessThanOrEqual(12);
    expect(await getCachedPineResult("entry-0")).toBeDefined(); // survived - recently touched
    expect(await getCachedPineResult("entry-14")).toBeDefined(); // survived - most recent write
    // entry-1 was neither touched nor recent - should be among the evicted.
    expect(await getCachedPineResult("entry-1")).toBeUndefined();
  });
});
