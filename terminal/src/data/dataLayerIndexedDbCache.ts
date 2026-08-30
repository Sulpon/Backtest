import type { SymbolTimeframeData } from "./types";

/**
 * Persists full raw OHLC datasets across page reloads - DataLayer.ts's own
 * `cache` is an in-memory Map, lost on every refresh, so a cold page load
 * for a previously-visited symbol/timeframe always re-fetched the full
 * ~1-12MB dataset from the network before anything could paint. This module
 * stores that same response one level further out (IndexedDB), so a warm
 * reload can paint from a ~1-5ms disk read while the real network fetch
 * (always issued, always authoritative) is still in flight.
 *
 * Deliberately its OWN separate IndexedDB database (`terminal.datasetCache`),
 * NOT sharing pineIndexedDbCache.ts's `terminal.pineCache` - the two caches
 * store unrelated shapes with unrelated schema-evolution timelines, and
 * mixing them into one database would couple their version-bump lifecycles
 * for no benefit.
 */
export interface StoredDataset {
  key: string;
  data: SymbolTimeframeData;
  schemaVersion: number;
  cachedAt: number;
  lastAccessed: number;
}

const DB_NAME = "terminal.datasetCache";
const DB_VERSION = 1;
const STORE_NAME = "datasets";
// A bound on ENTRY COUNT, not bytes. Each entry here is a full raw dataset
// (~1-12MB), not a few KB of Pine result metadata, so this is deliberately
// much smaller than pineIndexedDbCache's MAX_ENTRIES (12) - 6 comfortably
// covers a user's typical daily rotation of symbol/timeframe combos without
// letting IndexedDB usage grow unbounded.
const MAX_ENTRIES = 6;
// Bump this if SymbolTimeframeData's shape ever changes - a mismatched
// value at read time is treated as a plain cache miss (never an error), the
// same fail-open philosophy as everything else in this module. Purely a
// frontend safety net, independent of any backend versioning.
const SCHEMA_VERSION = 1;
// Soft TTL only, checked at READ time - correctness never depends on this:
// the real network fetch always runs and always supersedes whatever this
// cache returns. It only avoids briefly flashing a months-stale value for a
// rarely-revisited symbol before the network response corrects it moments
// later. No background sweep needed - a stale-but-unread entry just sits
// there until LRU eviction or a schema bump reclaims it.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function cacheKey(symbol: string, timeframe: string): string {
  return `${symbol}:${timeframe}`;
}

let dbPromise: Promise<IDBDatabase> | null = null;

// A monotonic counter, not Date.now(), for lastAccessed ordering - see
// pineIndexedDbCache.ts's identical reasoning: several entries written or
// touched in the same millisecond would otherwise tie on wall-clock time,
// and the eviction cursor's tiebreak has nothing to do with actual recency.
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

/** Fails open (resolves undefined) on any IndexedDB error, a schema-version
 * mismatch, or staleness beyond MAX_AGE_MS - private browsing, a disabled/
 * full store, an unsupported environment, whatever. A persistent-cache miss
 * here just means falling back to the real network fetch, exactly as if
 * this module didn't exist; it must never be the reason a chart fails to
 * load. */
export async function getCachedDataset(symbol: string, timeframe: string): Promise<SymbolTimeframeData | undefined> {
  try {
    const db = await openDb();
    const key = cacheKey(symbol, timeframe);
    return await new Promise<SymbolTimeframeData | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(key);
      getReq.onsuccess = () => {
        const record = getReq.result as StoredDataset | undefined;
        if (!record) {
          resolve(undefined);
          return;
        }
        if (record.schemaVersion !== SCHEMA_VERSION || Date.now() - record.cachedAt > MAX_AGE_MS) {
          resolve(undefined);
          return;
        }
        record.lastAccessed = nextAccessStamp();
        store.put(record); // bump LRU recency on read
        resolve(record.data);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  } catch {
    return undefined;
  }
}

/** Also fails silently - a failed write only means this dataset won't be
 * persisted for next time; the caller already has it in hand from the
 * network response that just landed. */
export async function setCachedDataset(symbol: string, timeframe: string, data: SymbolTimeframeData): Promise<void> {
  try {
    const db = await openDb();
    const record: StoredDataset = {
      key: cacheKey(symbol, timeframe),
      data,
      schemaVersion: SCHEMA_VERSION,
      cachedAt: Date.now(),
      lastAccessed: nextAccessStamp(),
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(record);
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
