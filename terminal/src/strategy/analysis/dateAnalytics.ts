import type { ScanTradeRecord } from "../types";
import { computeLiveStats } from "../../replay/applyCursor";
import { scanTradesToStatsInput } from "../scanStats";

/**
 * GLOBAL RULE for this module and everything built on top of it (Detailed
 * Analysis): every date/time-based calculation - filtering, grouping,
 * chart ordering, "best/worst period" - uses the position's CLOSING
 * timestamp (exitTime), never entryTime. entryTime remains on
 * ScanTradeRecord as useful trade information (shown elsewhere, e.g. the
 * journal) but must never determine which day/month/year a trade belongs
 * to here. A trade entered 2025-01-31 23:00 and closed 2025-02-01 10:00
 * belongs to February 2025, not January - see this file's own tests for
 * the exact regression case, and ScanTradeRecord.entryTime's own doc
 * comment (strategy/types.ts) for the same warning at the data-model level.
 */

export interface ExitDateParts {
  year: number;
  /** 1-12. */
  month: number;
  /** 1-31. */
  day: number;
  /** "YYYY-MM-DD". */
  dateKey: string;
  /** "YYYY-MM". */
  monthKey: string;
}

/**
 * THE only sanctioned read of `.exitTime` for date bucketing in this
 * module - every grouping/filtering function below calls this and this
 * alone; none of them read `trade.exitTime` or `trade.entryTime` a second
 * time themselves. That makes "which day/month/year does this trade
 * belong to" have exactly one implementation to get right, and makes an
 * accidental future `trade.entryTime` read in a new aggregation function
 * structurally easy to catch (see this file's own source-scan test).
 * Uses UTC getters, matching this app's existing convention for date-key
 * math (see replay/ReplayCalendar.tsx).
 */
export function exitDateParts(trade: ScanTradeRecord): ExitDateParts {
  const d = new Date(trade.exitTime * 1000);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    year,
    month,
    day,
    dateKey: `${year}-${pad(month)}-${pad(day)}`,
    monthKey: `${year}-${pad(month)}`,
  };
}

/**
 * Filters by symbol/setup/exitTime range. `symbols`/`setup` of `"all"`
 * means no filtering on that dimension. `fromSec`/`toSec` (unix seconds,
 * inclusive) are compared against `exitTime` (via exitDateParts's own
 * source field, per this module's global rule) - NOT entryTime, so a
 * trade opened before a date-range's start but closed inside it is
 * included, and one opened inside the range but closed after it is
 * excluded. Plain positional primitive args (not a `filters` object) so a
 * caller's `useMemo` can list these same primitives in its own dependency
 * array without a fresh object literal silently defeating the memo.
 */
export function filterTrades(
  trades: ScanTradeRecord[],
  symbols: string[] | "all",
  setup: string | "all",
  fromSec: number | null,
  toSec: number | null
): ScanTradeRecord[] {
  return trades.filter((t) => {
    if (symbols !== "all" && !symbols.includes(t.symbol)) return false;
    if (setup !== "all" && t.setup !== setup) return false;
    if (fromSec != null && t.exitTime < fromSec) return false;
    if (toSec != null && t.exitTime > toSec) return false;
    return true;
  });
}

export interface PeriodStats {
  totalRR: number;
  count: number;
  wins: number;
  winRate: number;
  avgRR: number;
}

function accumulate(bucket: PeriodStats | undefined, trade: ScanTradeRecord): PeriodStats {
  const prev = bucket ?? { totalRR: 0, count: 0, wins: 0, winRate: 0, avgRR: 0 };
  const count = prev.count + 1;
  const totalRR = prev.totalRR + trade.r;
  const wins = prev.wins + (trade.result === "Win" ? 1 : 0);
  return { totalRR, count, wins, winRate: (wins / count) * 100, avgRR: totalRR / count };
}

/** Grouped by exit calendar day ("YYYY-MM-DD", exitDateParts.dateKey) -
 * only keys with at least one trade exist in the map (no zero-count
 * entries), matching Map's own natural shape; callers needing "0 trades"
 * for an empty day should treat a missing key as that, not look for a
 * zero-value entry. */
export function groupByExitDay(trades: ScanTradeRecord[]): Map<string, PeriodStats> {
  const map = new Map<string, PeriodStats>();
  for (const t of trades) {
    const { dateKey } = exitDateParts(t);
    map.set(dateKey, accumulate(map.get(dateKey), t));
  }
  return map;
}

/** Grouped by exit month ("YYYY-MM", exitDateParts.monthKey). */
export function groupByExitMonth(trades: ScanTradeRecord[]): Map<string, PeriodStats> {
  const map = new Map<string, PeriodStats>();
  for (const t of trades) {
    const { monthKey } = exitDateParts(t);
    map.set(monthKey, accumulate(map.get(monthKey), t));
  }
  return map;
}

/** Grouped by exit year (exitDateParts.year). */
export function groupByExitYear(trades: ScanTradeRecord[]): Map<number, PeriodStats> {
  const map = new Map<number, PeriodStats>();
  for (const t of trades) {
    const { year } = exitDateParts(t);
    map.set(year, accumulate(map.get(year), t));
  }
  return map;
}

export interface CumulativePoint {
  /** Unix seconds - the trade's exitTime (or the last of several trades
   * sharing that exact exitTime - see this function's doc comment). */
  time: number;
  cumulative: number;
}

/**
 * Trades sorted by exitTime ascending (never entryTime - a trade's
 * position in this series reflects when it CLOSED, per this module's
 * global rule), with a running sum of `r`. Two or more trades sharing the
 * exact same exitTime collapse into a single point carrying the
 * cumulative value AFTER all of them (rather than emitting duplicate
 * x-values), both because that's the only value from a "closing timestamp
 * ordering" point of view.
 */
export function cumulativeRRSeries(trades: ScanTradeRecord[]): CumulativePoint[] {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let running = 0;
  const points: CumulativePoint[] = [];
  for (const t of sorted) {
    running += t.r;
    const last = points[points.length - 1];
    if (last && last.time === t.exitTime) {
      points[points.length - 1] = { time: t.exitTime, cumulative: running };
    } else {
      points.push({ time: t.exitTime, cumulative: running });
    }
  }
  return points;
}

export interface DailyExtreme {
  dateKey: string;
  totalRR: number;
}

export interface DetailedKpis {
  total: number;
  wins: number;
  winRate: number;
  totalRR: number;
  /** Same value as avgRR - both are sum(r)/total, the standard R-multiple
   * expected-value formula, just shown under two labels per the Detailed
   * Analysis KPI spec. Computed once (via the existing computeLiveStats),
   * not twice. */
  expectancy: number;
  avgRR: number;
  /** Exit day with the highest totalRR, or null when there are no trades
   * (never a fabricated zero). */
  bestDay: DailyExtreme | null;
  /** Exit day with the lowest totalRR, or null when there are no trades. */
  worstDay: DailyExtreme | null;
}

/** Total/wins/winRate/expectancy reuse the existing computeLiveStats
 * (replay/applyCursor.ts) via the existing scanTradesToStatsInput adapter
 * (strategy/scanStats.ts) - not reimplemented. totalRR and best/worst day
 * are the only calculations added here, and best/worst day is derived
 * from groupByExitDay, so it's exitTime-based like everything else in
 * this module. */
export function computeKpis(trades: ScanTradeRecord[]): DetailedKpis {
  const stats = computeLiveStats(scanTradesToStatsInput(trades), 1);
  const totalRR = trades.reduce((sum, t) => sum + t.r, 0);

  let bestDay: DailyExtreme | null = null;
  let worstDay: DailyExtreme | null = null;
  for (const [dateKey, day] of groupByExitDay(trades)) {
    if (!bestDay || day.totalRR > bestDay.totalRR) bestDay = { dateKey, totalRR: day.totalRR };
    if (!worstDay || day.totalRR < worstDay.totalRR) worstDay = { dateKey, totalRR: day.totalRR };
  }

  return {
    total: stats.total,
    wins: stats.wins,
    winRate: stats.winRate,
    totalRR,
    expectancy: stats.expectancy,
    avgRR: stats.expectancy,
    bestDay,
    worstDay,
  };
}
