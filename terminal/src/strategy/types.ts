import type { Timeframe } from "../data/types";

/**
 * One trade produced by the historical Strategy scanner (see
 * historicalScanner.ts). Reuses the same core fields as the app's plain
 * `Trade` type (dir/entryPrice/sl/tp/result/r/setup), but a scan
 * fundamentally differs from a single-symbol Pine run in two ways that
 * force a distinct shape rather than reusing `Trade` directly:
 *  - `entryBar`/`exitBar` on a PineTradeRecord index THAT run's own
 *    windowedBars (see PineRunResult's doc comment in usePineIndicators.ts) -
 *    meaningless once merged across many independent per-symbol runs, so
 *    they're converted to absolute `entryTime`/`exitTime` (unix seconds)
 *    immediately after each symbol's run, mirroring pineTradesAdapter.ts's
 *    own bar-index-to-time conversion for merging multiple indicators.
 *  - every existing trade source is implicitly single-symbol; a scan
 *    combines many, so `symbol` (and `timeframe`/`indicatorId`, needed for
 *    dedup identity and journal keys) must travel with the trade itself.
 */
export interface ScanTradeRecord {
  /** `${indicatorId}:${symbol}:${timeframe}:${entryTime}:${exitTime}` -
   * stable identity used both for de-duplicating a re-run of the same scan
   * config (see strategyScanStore's mergeTrades, which overwrites-by-id,
   * the same pattern interpreter.ts's own tradeRegistry uses) and as the
   * React list key. Includes exitTime, not just entryTime: a single bar can
   * legitimately open more than one distinct trade (e.g. one whose entry
   * candle's own wick already reached SL/TP - closing same-bar - alongside
   * a separate, still-running one from another leg) - the underlying
   * PineTradeRecord already disambiguates these via its own
   * `t${entryBar}_${exitBar}` id (see interpreter.ts's recordTrade), and an
   * entryTime-only id here would silently collapse them into one stored
   * trade. Confirmed empirically: a real scan produced 107 distinct
   * interpreter trades sharing only 90 unique entryTimes - entryTime alone
   * lost 17 real trades before this field was added. */
  id: string;
  /** Which scan run produced this record - audit-only, never part of the
   * dedup identity above (two runs of the identical config must still
   * collapse to one trade). */
  strategyId: string;
  indicatorId: string;
  symbol: string;
  timeframe: Timeframe;
  dir: "long" | "short";
  /** Unix seconds - NOT a bar index, see this interface's doc comment.
   * Real, useful trade information (kept and shown, e.g. in the journal) -
   * but NEVER use this to decide which day/month/year a trade belongs to.
   * All date/period bucketing (Detailed Analysis's daily/monthly/yearly
   * breakdowns, date-range filters, cumulative-RR ordering, best/worst
   * period) uses `exitTime` exclusively - see
   * strategy/analysis/dateAnalytics.ts's `exitDateParts()`, the single
   * sanctioned place that logic lives. */
  entryTime: number;
  entryPrice: number;
  sl: number;
  tp: number;
  /** Unix seconds. */
  exitTime: number;
  result: "Win" | "Lose";
  r: number;
  setup: string;
}

export interface ScanConfig {
  /** Unix seconds. Bars before this are never handed to the interpreter for
   * a given symbol - same semantics as PineIndicator.startDate. */
  startDate: number;
  symbolMode: "all" | "custom";
  /** Only meaningful when symbolMode === "custom". */
  customSymbols: string[];
  timeframe: Timeframe;
  indicatorId: string;
}

export type ScanSymbolStatus = "pending" | "running" | "done" | "error";

export interface ScanProgressEntry {
  symbol: string;
  status: ScanSymbolStatus;
  tradeCount?: number;
  error?: string;
}

export type ScanStatus = "idle" | "scanning" | "done" | "error" | "cancelled";
