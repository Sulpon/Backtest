/**
 * Pure symbol -> category classifier for the watchlist's two collapsible
 * sections (Forex / Metals). Deliberately name-based, not backed by a new
 * asset-class data model: `useSymbols()`/`dataLayer.listSymbols()` returns a
 * flat `string[]` with no asset-class field anywhere in the app today (see
 * `terminal/src/data/useSymbols.ts`, `DataLayer.ts`), and this app's only
 * two non-forex instruments are the metals XAUUSD/XAGUSD (confirmed via
 * `terminal/backend/data_ingestion/symbols_point_values.py`, which is the
 * one place point values are hand-enumerated per symbol). Everything else
 * is a forex pair. If a real asset-class field is ever added to the symbol
 * catalog, this function should be replaced by reading it directly rather
 * than extended with more prefix rules.
 */
export type WatchlistCategory = "Metals" | "Forex";

export function categorizeSymbol(symbol: string): WatchlistCategory {
  return symbol.startsWith("XAU") || symbol.startsWith("XAG") ? "Metals" : "Forex";
}

/** Groups a flat symbol list into category buckets, preserving each
 * category's relative symbol order and omitting empty categories entirely -
 * WatchlistPanel renders one collapsible section per key this returns, in
 * this fixed order (Forex before Metals) so the section order doesn't
 * shuffle around based on whatever happened to load first. */
export function groupSymbolsByCategory<T extends { symbol: string }>(rows: T[]): Array<[WatchlistCategory, T[]]> {
  const buckets: Record<WatchlistCategory, T[]> = { Forex: [], Metals: [] };
  for (const row of rows) buckets[categorizeSymbol(row.symbol)].push(row);
  return (["Forex", "Metals"] as const).filter((cat) => buckets[cat].length > 0).map((cat) => [cat, buckets[cat]]);
}
