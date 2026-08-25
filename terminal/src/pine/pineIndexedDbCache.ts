import type { CandleBar } from "../data/types";
import type { InputDef, PineOutputs } from "./interpreter";
import type { PineIndicator } from "./pineIndicatorStore";
import { datasetVersion, hashCode } from "./pineFingerprint";

/**
 * Persists computed Pine results across page reloads - the in-memory
 * resultCache in usePineIndicators.ts only survives the current session,
 * so a full page refresh (or coming back tomorrow) always paid the full
 * ~20s recompute again even for a symbol/timeframe/indicator/parameter
 * combo already computed once before. This is the same result, stored one
 * level further out.
 *
 * windowedBars is deliberately NOT persisted: it's just a slice of `bars`
 * (already sitting in memory / DataLayer's own cache), reconstructible
 * for free from bars + startDate at read time, so storing a second full
 * copy of up to 100k-200k candles per cache entry would roughly double
 * the disk footprint for no benefit.
 */
export interface CachedPineResult {
  outputs: PineOutputs;
  inputDefs: InputDef[];
  fatalError: string | null;
  symbol: string;
  timeframe: string;
  datasetVersion: string;
}

interface StoredRecord {
  key: string;
  value: CachedPineResult;
  lastAccessed: number;
}

const DB_NAME = "terminal.pineCache";
const DB_VERSION = 1;
const STORE_NAME = "results";
// A bound on ENTRY COUNT, not bytes - IndexedDB doesn't expose per-entry
// size cheaply, but each entry is already scoped to one indicator's output
// for one specific symbol+timeframe+parameter combo (lines/boxes/labels/
// trades, not candles - see above), so entry count is a reasonable proxy.
// 12 matches the in-memory RESULT_CACHE_MAX's order of magnitude: enough
// for a user's typical daily rotation of a handful of chart combos.
const MAX_ENTRIES = 12;

/** Symbol/timeframe are required (not optional) here on purpose - the
 * persistent cache is meaningless without them (two different symbols
 * must never share a disk-cache entry), unlike the in-memory cacheKey in
 * usePineIndicators.ts, which can fall back to dataset-content-only
 * fingerprinting for the symbol-less preview call sites. */
export function persistentCacheKey(ind: PineIndicator, symbol: string, timeframe: string, bars: CandleBar[]): string {
  return `${symbol}:${timeframe}:${ind.id}:${hashCode(ind.code)}:${JSON.stringify(ind.inputOverrides)}:${ind.startDate ?? ""}:${datasetVersion(bars)}`;
}

let dbPromise: Promise<IDBDatabase> | null = null;

// A monotonic counter, not Date.now(), for lastAccessed ordering: several
// entries written or touched in the same millisecond (a warm cache-hit
// burst, or fast successive writes) would otherwise tie on wall-clock time,
// and the eviction cursor's tiebreak (primary key STRING order, e.g.
// "entry-0" < "entry-10" < "entry-2") has nothing to do with actual
// recency - a real tie could evict something just touched. A counter can
// never tie.
let accessCounter = Date.now();
function nextAccessStamp(): number {
  return ++accessCounter;
}

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
          store.createIndex("lastAccessed", "lastAccessed");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

/** Fails open (resolves undefined) on any IndexedDB error - private
 * browsing, a disabled/full store, an unsupported environment, whatever.
 * A persistent-cache miss just means falling back to the worker, same as
 * if this module didn't exist; it must never be the reason a chart fails
 * to load. */
export async function getCachedPineResult(key: string): Promise<CachedPineResult | undefined> {
  try {
    const db = await openDb();
    return await new Promise<CachedPineResult | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(key);
      getReq.onsuccess = () => {
        const record = getReq.result as StoredRecord | undefined;
        if (!record) {
          resolve(undefined);
          return;
        }
        record.lastAccessed = nextAccessStamp();
        store.put(record); // bump LRU recency on read
        resolve(record.value);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  } catch {
    return undefined;
  }
}

/** Also fails silently - a failed write only means this result won't be
 * persisted; the caller already has it in hand from the worker run that
 * just completed. */
export async function setCachedPineResult(key: string, value: CachedPineResult): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put({ key, value, lastAccessed: nextAccessStamp() } satisfies StoredRecord);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await evictOverflow(db);
  } catch {
    // best-effort, see doc comment above
  }
}

/** Deletes the least-recently-accessed entries once the store exceeds
 * MAX_ENTRIES, oldest first, via the lastAccessed index. */
async function evictOverflow(db: IDBDatabase): Promise<void> {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const countReq = store.count();
    countReq.onsuccess = () => {
      const overflow = countReq.result - MAX_ENTRIES;
      if (overflow <= 0) {
        resolve();
        return;
      }
      const cursorReq = store.index("lastAccessed").openCursor();
      let deleted = 0;
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor && deleted < overflow) {
          cursor.delete();
          deleted++;
          cursor.continue();
        } else {
          resolve();
        }
      };
      cursorReq.onerror = () => resolve();
    };
    countReq.onerror = () => resolve();
  });
}

/** Test-only: drops the cached DB connection so the next call reopens
 * against whatever `indexedDB` currently points at - needed because tests
 * swap in a fresh in-memory IDBFactory per test, but this module's own
 * `dbPromise` would otherwise keep pointing at the previous test's DB
 * connection object for the rest of the suite. */
export function _resetForTests(): void {
  dbPromise = null;
}

/** Test-only: gives tests a way to inspect entry count without reaching
 * into IndexedDB internals directly. */
export async function _debugEntryCount(): Promise<number> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
