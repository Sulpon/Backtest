import type { SymbolTimeframeData, Timeframe } from "./types";

/**
 * The only way any UI component is allowed to reach candle/structure data.
 * Two implementations exist behind this one interface - no component that
 * calls getSymbolData() needs to know or care which one is active.
 */
export interface DataLayer {
  listSymbols(): Promise<string[]>;
  getSymbolData(symbol: string, timeframe: Timeframe): Promise<SymbolTimeframeData>;
}

/** Milestone 1's implementation: fetches the pre-generated static JSON files
 * under /public/data. Kept around as an offline/no-backend fallback - opt
 * into it explicitly with VITE_DATA_LAYER=static, it's never silently used. */
export class StaticJsonDataLayer implements DataLayer {
  private cache = new Map<string, Promise<SymbolTimeframeData>>();

  async listSymbols(): Promise<string[]> {
    return ["EURUSD"];
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
}

/** Milestone 3's implementation: FastAPI backed by DuckDB (see terminal/backend).
 * The database is the single source of truth - this class does nothing but
 * fetch and cache; it never computes or shapes data itself. */
export class ApiDataLayer implements DataLayer {
  private cache = new Map<string, Promise<SymbolTimeframeData>>();
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private unreachable(status?: number): Error {
    return new Error(
      `Backend not reachable at ${this.baseUrl}${status ? ` (HTTP ${status})` : ""} - ` +
        `start it from terminal/backend: .venv/Scripts/python.exe -m uvicorn app.main:app --port 8000`
    );
  }

  async listSymbols(): Promise<string[]> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/symbols`);
    } catch {
      throw this.unreachable();
    }
    if (!res.ok) throw this.unreachable(res.status);
    const rows: { symbol: string }[] = await res.json();
    return rows.map((r) => r.symbol);
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
        });
      this.cache.set(key, pending);
    }
    return pending;
  }
}

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:8000";

export const dataLayer: DataLayer =
  import.meta.env.VITE_DATA_LAYER === "static" ? new StaticJsonDataLayer() : new ApiDataLayer(API_BASE);
