import { getCachedDataset, setCachedDataset } from "./dataLayerIndexedDbCache";
import type { SymbolTimeframeData, Timeframe } from "./types";

export interface Quote {
  symbol: string;
  last: number | null;
  prev: number | null;
}

/** One provider-synced OHLC bar from /api/marketdata/candles - deliberately
 * a smaller shape than SymbolTimeframeData's `bars` + events: the provider
 * layer computes no SMC structure, only candles. */
export interface ProviderCandleBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ProviderCandles {
  symbol: string;
  timeframe: string;
  provider: string;
  bars: ProviderCandleBar[];
}

export interface ProviderStatus {
  provider: string;
  configured: boolean;
  error: string | null;
}

/**
 * The only way any UI component is allowed to reach candle/structure data.
 * Two implementations exist behind this one interface - no component that
 * calls getSymbolData() needs to know or care which one is active.
 */
export interface DataLayer {
  listSymbols(): Promise<string[]>;
  getSymbolData(symbol: string, timeframe: Timeframe): Promise<SymbolTimeframeData>;
  /** Same data, windowed to the most recent `limit` bars (see the backend's
   * own doc comment on the `limit` param) - for the fast initial paint
   * only. bar_index fields in the result are local to this windowed
   * response, NOT the same indices getSymbolData's full result would use -
   * callers must never mix a windowed result's event/trade bar indices
   * with a full result's `bars` array, or vice versa. Never cached: it's a
   * one-shot, quickly-superseded fetch, not something a caller would ever
   * want to revisit. */
  getSymbolDataWindowed(symbol: string, timeframe: Timeframe, limit: number): Promise<SymbolTimeframeData>;
  /** Synchronous: would getSymbolData(symbol, timeframe) resolve from an
   * already-issued request right now, with no new network round-trip?
   * Lets a caller skip the fast-paint windowed fetch entirely when the
   * full dataset is already in flight or settled - firing the windowed
   * fetch anyway would cost a real (if small) network request AND a
   * second wasted render pass moments before the (already-available)
   * full data replaces it, for zero benefit. This is what makes "switch
   * back to a symbol/timeframe already visited" actually near-instant
   * rather than merely fast. */
  hasCachedSymbolData(symbol: string, timeframe: Timeframe): boolean;
  /** Best-effort read of a full dataset PERSISTED FROM A PRIOR SESSION -
   * unlike everything else on this interface, this is NOT network-backed and
   * NOT authoritative. It exists purely to paint something (chart candles)
   * faster than even the windowed network fetch on a cold page load for a
   * symbol/timeframe visited before - IndexedDB reads are ~1-5ms, no network
   * round-trip at all. The caller MUST still issue the real getSymbolData()
   * call unconditionally and MUST let its result unconditionally replace
   * whatever this returned, whenever it lands - this method's result may be
   * hours or days stale. Returns undefined on any cache miss, schema
   * mismatch, staleness, or IndexedDB error - failing open exactly like
   * pineIndexedDbCache's getCachedPineResult. */
  getCachedSymbolDataFromDisk(symbol: string, timeframe: Timeframe): Promise<SymbolTimeframeData | undefined>;
  /** Last/previous close per symbol - e.g. for the watchlist. Deliberately
   * NOT built from getSymbolData(): that returns the full multi-MB candle +
   * SMC event history per symbol, which a watchlist row (two numbers) never
   * needs. */
  getQuotes(timeframe: Timeframe): Promise<Quote[]>;
  /** Roadmap Phase 2: is a live market-data provider (OANDA/FXCM) configured
   * on the backend right now? Never throws - a missing/misconfigured
   * provider is a normal, expected state (`configured: false` + `error`),
   * not a failure of this call itself. */
  getProviderStatus(): Promise<ProviderStatus>;
  /** Roadmap Phase 2: provider-synced OHLC candles for [start, end) unix
   * seconds, via the backend's /api/marketdata/candles - entirely separate
   * from getSymbolData()'s static, build_db.py-derived dataset. Never
   * cached: a manual, explicit sync action, not a background prefetch. */
  getProviderCandles(symbol: string, timeframe: string, start: number, end: number): Promise<ProviderCandles>;
}

/** Milestone 1's implementation: fetches the pre-generated static JSON files
 * under /public/data. Kept around as an offline/no-backend fallback - opt
 * into it explicitly with VITE_DATA_LAYER=static, it's never silently used. */
export class StaticJsonDataLayer implements DataLayer {
  private cache = new Map<string, Promise<SymbolTimeframeData>>();
  private quotesCache = new Map<string, Promise<Quote[]>>();

  async listSymbols(): Promise<string[]> {
    return ["EURUSD"];
  }

  hasCachedSymbolData(symbol: string, timeframe: Timeframe): boolean {
    return this.cache.has(`${symbol}:${timeframe}`);
  }

  getSymbolData(symbol: string, timeframe: Timeframe): Promise<SymbolTimeframeData> {
    const key = `${symbol}:${timeframe}`;
    let pending = this.cache.get(key);
    if (!pending) {
      pending = fetch(`/data/${symbol}/${timeframe}.json`).then((res) => {
        if (!res.ok) throw new Error(`No static data for ${symbol} ${timeframe}`);
        return res.json() as Promise<SymbolTimeframeData>;
      });
      this.cache.set(key, pending);
    }
    return pending;
  }

  // Static/offline mode has no server-side slicing to windowto - the JSON
  // files are pre-generated in full. Falls back to the regular (full,
  // cached) fetch: correct, just without the fast-paint speedup, and never
  // slower than this mode's own existing behavior.
  getSymbolDataWindowed(symbol: string, timeframe: Timeframe): Promise<SymbolTimeframeData> {
    return this.getSymbolData(symbol, timeframe);
  }

  // Offline/static mode already has everything it needs locally (the JSON
  // files themselves), so there's no network round-trip to shortcut here -
  // this tier adds no value in this mode.
  async getCachedSymbolDataFromDisk(): Promise<SymbolTimeframeData | undefined> {
    return undefined;
  }

  // No lightweight quote endpoint in static/offline mode - falls back to
  // the full per-symbol fetch (still benefits from the cache above, so this
  // only costs full downloads on the very first watchlist paint). Cached
  // by timeframe the same way getSymbolData is, so two callers asking for
  // quotes at once (or React StrictMode's double-invoked effect in dev)
  // share one in-flight computation instead of building two Promise.all
  // trees over the same cached per-symbol data.
  getQuotes(timeframe: Timeframe): Promise<Quote[]> {
    let pending = this.quotesCache.get(timeframe);
    if (!pending) {
      pending = this.listSymbols().then((symbols) =>
        Promise.all(
          symbols.map(async (symbol): Promise<Quote> => {
            try {
              const d = await this.getSymbolData(symbol, timeframe);
              const bars = d.bars;
              return {
                symbol,
                last: bars.length ? bars[bars.length - 1].close : null,
                prev: bars.length > 1 ? bars[bars.length - 2].close : null,
              };
            } catch {
              return { symbol, last: null, prev: null };
            }
          })
        )
      );
      this.quotesCache.set(timeframe, pending);
    }
    return pending;
  }

  // Static/offline mode has no provider layer at all (no backend to talk
  // to) - fails loudly with a clear message rather than silently returning
  // a fake "not configured" status, same reasoning as getSymbolData's
  // unreachable() message elsewhere in this file.
  getProviderStatus(): Promise<ProviderStatus> {
    return Promise.reject(new Error("Market-data provider sync is not available in static/offline mode"));
  }

  getProviderCandles(): Promise<ProviderCandles> {
    return Promise.reject(new Error("Market-data provider sync is not available in static/offline mode"));
  }
}

/** Milestone 3's implementation: FastAPI backed by DuckDB (see terminal/backend).
 * The database is the single source of truth - this class does nothing but
 * fetch and cache; it never computes or shapes data itself. */
export class ApiDataLayer implements DataLayer {
  private cache = new Map<string, Promise<SymbolTimeframeData>>();
  private quotesCache = new Map<string, Promise<Quote[]>>();
  private symbolsCache: Promise<string[]> | null = null;
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  hasCachedSymbolData(symbol: string, timeframe: Timeframe): boolean {
    return this.cache.has(`${symbol}:${timeframe}`);
  }

  private unreachable(status?: number): Error {
    return new Error(
      `Backend not reachable at ${this.baseUrl}${status ? ` (HTTP ${status})` : ""} - ` +
        `start it from terminal/backend: .venv/Scripts/python.exe -m uvicorn app.main:app --port 8000`
    );
  }

  // Cached for the same reason getQuotes/getSymbolData are: React
  // StrictMode double-invokes effects in dev (mount, cleanup, mount again),
  // and without this every caller of listSymbols() during that second
  // mount fired a second real /api/symbols request. One in-flight/settled
  // promise shared by every caller for the life of the page.
  listSymbols(): Promise<string[]> {
    if (!this.symbolsCache) {
      this.symbolsCache = fetch(`${this.baseUrl}/api/symbols`)
        .catch(() => {
          throw this.unreachable();
        })
        .then((res) => {
          if (!res.ok) throw this.unreachable(res.status);
          return res.json() as Promise<{ symbol: string }[]>;
        })
        .then((rows) => rows.map((r) => r.symbol));
    }
    return this.symbolsCache;
  }

  // Cached by timeframe, same reasoning as listSymbols above - this is the
  // exact endpoint that was observed firing twice on a single initial page
  // load (see terminal/README.md#performance).
  getQuotes(timeframe: Timeframe): Promise<Quote[]> {
    let pending = this.quotesCache.get(timeframe);
    if (!pending) {
      pending = fetch(`${this.baseUrl}/api/quotes?timeframe=${timeframe}`)
        .catch(() => {
          throw this.unreachable();
        })
        .then((res) => {
          if (!res.ok) throw this.unreachable(res.status);
          return res.json() as Promise<Quote[]>;
        });
      this.quotesCache.set(timeframe, pending);
    }
    return pending;
  }

  getSymbolData(symbol: string, timeframe: Timeframe): Promise<SymbolTimeframeData> {
    const key = `${symbol}:${timeframe}`;
    let pending = this.cache.get(key);
    if (!pending) {
      const url = `${this.baseUrl}/api/dataset?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}`;
      pending = fetch(url)
        .catch(() => {
          throw this.unreachable();
        })
        .then((res) => {
          if (!res.ok) throw this.unreachable(res.status);
          return res.json() as Promise<SymbolTimeframeData>;
        })
        .then((d) => {
          // Fire-and-forget: persist for next time. Never awaited/blocking
          // and never allowed to affect this call's own result - a failed
          // or slow disk write must never delay or break the real fetch.
          void setCachedDataset(symbol, timeframe, d);
          return d;
        });
      this.cache.set(key, pending);
    }
    return pending;
  }

  // Best-effort disk read, see the interface doc comment. Never a
  // replacement for getSymbolData() - just a possibly-stale head start.
  getCachedSymbolDataFromDisk(symbol: string, timeframe: Timeframe): Promise<SymbolTimeframeData | undefined> {
    return getCachedDataset(symbol, timeframe);
  }

  // Not cached - see the interface doc comment. Reuses the same
  // unreachable()/response-shape handling as getSymbolData; the only
  // difference is the `limit` query param.
  async getSymbolDataWindowed(symbol: string, timeframe: Timeframe, limit: number): Promise<SymbolTimeframeData> {
    const url = `${this.baseUrl}/api/dataset?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}&limit=${limit}`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      throw this.unreachable();
    }
    if (!res.ok) throw this.unreachable(res.status);
    return res.json();
  }

  // Not cached - see the interface doc comment on getProviderStatus.
  async getProviderStatus(): Promise<ProviderStatus> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/marketdata/status`);
    } catch {
      throw this.unreachable();
    }
    if (!res.ok) throw this.unreachable(res.status);
    return res.json();
  }

  // Not cached - see the interface doc comment on getProviderCandles. A
  // non-2xx here (503 not-configured, 502 provider failure, 404/400 bad
  // symbol/timeframe/range) carries a real `detail` message from the
  // backend worth surfacing verbatim, unlike the generic unreachable()
  // used when the backend itself can't be reached at all.
  async getProviderCandles(symbol: string, timeframe: string, start: number, end: number): Promise<ProviderCandles> {
    const url =
      `${this.baseUrl}/api/marketdata/candles?symbol=${encodeURIComponent(symbol)}` +
      `&timeframe=${encodeURIComponent(timeframe)}&start=${start}&end=${end}`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      throw this.unreachable();
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.detail ?? `Market-data provider request failed (HTTP ${res.status})`);
    }
    return res.json();
  }
}

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:8000";

export const dataLayer: DataLayer =
  import.meta.env.VITE_DATA_LAYER === "static" ? new StaticJsonDataLayer() : new ApiDataLayer(API_BASE);
