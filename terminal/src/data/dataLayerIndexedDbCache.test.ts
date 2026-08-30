import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { _debugEntryCount, _resetForTests, getCachedDataset, setCachedDataset } from "./dataLayerIndexedDbCache";
import type { SymbolTimeframeData } from "./types";

function fakeDataset(symbol = "EURUSD", timeframe: SymbolTimeframeData["timeframe"] = "1h"): SymbolTimeframeData {
  return {
    symbol,
    timeframe,
    bars: [{ time: 1000, open: 1, high: 1, low: 1, close: 1 }],
    swingPoints: [],
    bosEvents: [],
    fvgEvents: [],
    orderBlocks: [],
    volumeImbalanceEvents: [],
    liquidityEvents: [],
    trades: [],
    stats: null,
  };
}

// Fresh, empty IndexedDB per test - the module under test caches its DB
// connection at module scope (openDb's dbPromise), so recreating global
// indexedDB alone isn't enough; _resetForTests() drops that cached
// connection so the next call reopens against the fresh IDBFactory.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  _resetForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getCachedDataset / setCachedDataset", () => {
  it("a miss returns undefined", async () => {
    expect(await getCachedDataset("EURUSD", "1h")).toBeUndefined();
  });

  it("round-trips a stored value", async () => {
    const data = fakeDataset();
    await setCachedDataset("EURUSD", "1h", data);
    expect(await getCachedDataset("EURUSD", "1h")).toEqual(data);
  });

  it("different symbol/timeframe combos never collide", async () => {
    await setCachedDataset("EURUSD", "1h", fakeDataset("EURUSD", "1h"));
    expect(await getCachedDataset("GBPUSD", "1h")).toBeUndefined();
    expect(await getCachedDataset("EURUSD", "15m")).toBeUndefined();
  });

  it("evicts the least-recently-accessed entry once MAX_ENTRIES (6) is exceeded", async () => {
    for (let i = 0; i < 6; i++) {
      await setCachedDataset(`SYM${i}`, "1h", fakeDataset(`SYM${i}`, "1h"));
    }
    // Touch entry 0 so it bumps recency right before the bound is crossed.
    await getCachedDataset("SYM0", "1h");
    await setCachedDataset("SYM6", "1h", fakeDataset("SYM6", "1h"));

    const count = await _debugEntryCount();
    expect(count).toBeLessThanOrEqual(6);
    expect(await getCachedDataset("SYM0", "1h")).toBeDefined(); // survived - recently touched
    expect(await getCachedDataset("SYM6", "1h")).toBeDefined(); // survived - most recent write
    // SYM1 was neither touched nor recent - should be among the evicted.
    expect(await getCachedDataset("SYM1", "1h")).toBeUndefined();
  });

  it("treats a mismatched schemaVersion as a miss, not an error", async () => {
    await setCachedDataset("EURUSD", "1h", fakeDataset());
    // Reach into the store directly to corrupt the schemaVersion, simulating
    // a stale record left over from before a shape change.
    const dbReq = indexedDB.open("terminal.datasetCache", 1);
    await new Promise<void>((resolve, reject) => {
      dbReq.onsuccess = () => {
        const db = dbReq.result;
        const tx = db.transaction("datasets", "readwrite");
        const store = tx.objectStore("datasets");
        const getReq = store.get("EURUSD:1h");
        getReq.onsuccess = () => {
          const record = getReq.result;
          record.schemaVersion = 999;
          store.put(record);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
      dbReq.onerror = () => reject(dbReq.error);
    });
    _resetForTests();
    expect(await getCachedDataset("EURUSD", "1h")).toBeUndefined();
  });

  it("treats a record older than MAX_AGE_MS (7 days) as a miss", async () => {
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(realNow);
    await setCachedDataset("EURUSD", "1h", fakeDataset());
    // Fast-forward past the 7-day TTL.
    nowSpy.mockReturnValue(realNow + 7 * 24 * 60 * 60 * 1000 + 1);
    expect(await getCachedDataset("EURUSD", "1h")).toBeUndefined();
  });

  it("a fresh record within MAX_AGE_MS is still a hit", async () => {
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(realNow);
    await setCachedDataset("EURUSD", "1h", fakeDataset());
    nowSpy.mockReturnValue(realNow + 6 * 24 * 60 * 60 * 1000);
    expect(await getCachedDataset("EURUSD", "1h")).toBeDefined();
  });

  it("getCachedDataset fails open (resolves undefined) when IndexedDB errors", async () => {
    const brokenFactory = {
      open: () => {
        throw new Error("boom");
      },
    } as unknown as IDBFactory;
    globalThis.indexedDB = brokenFactory;
    _resetForTests();
    await expect(getCachedDataset("EURUSD", "1h")).resolves.toBeUndefined();
  });

  it("setCachedDataset fails open (resolves, doesn't throw) when IndexedDB errors", async () => {
    const brokenFactory = {
      open: () => {
        throw new Error("boom");
      },
    } as unknown as IDBFactory;
    globalThis.indexedDB = brokenFactory;
    _resetForTests();
    await expect(setCachedDataset("EURUSD", "1h", fakeDataset())).resolves.toBeUndefined();
  });
});
