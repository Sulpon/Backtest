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

/**
 * Longest run of consecutive wins, in exitTime order (never entryTime,
 * per this module's global rule). Reuses the trade's own `result` field
 * verbatim ("Win"/"Lose", the same representation the Strategy Scanner
 * already writes to every ScanTradeRecord) - no second definition of what
 * counts as a win. 0 for an empty input or a set with no wins at all.
 */
export function maximumWinningStreak(trades: ScanTradeRecord[]): number {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let current = 0;
  let max = 0;
  for (const t of sorted) {
    if (t.result === "Win") {
      current += 1;
      if (current > max) max = current;
    } else {
      current = 0;
    }
  }
  return max;
}

/** Longest run of consecutive losses, in exitTime order - mirrors
 * maximumWinningStreak exactly, see that function's doc comment. */
export function maximumLosingStreak(trades: ScanTradeRecord[]): number {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let current = 0;
  let max = 0;
  for (const t of sorted) {
    if (t.result === "Lose") {
      current += 1;
      if (current > max) max = current;
    } else {
      current = 0;
    }
  }
  return max;
}

/**
 * Maximum drawdown (in R, never monetary/account-balance terms - the
 * Strategy Scanner only ever records R-multiples, and this module has no
 * position-sizing/leverage concept to convert with) observed on the
 * cumulative-R equity curve, starting from 0R.
 *
 * Deliberately built ON TOP OF cumulativeRRSeries() rather than
 * re-deriving its own sorted/summed sequence - the user's own spec is
 * explicit that this must never diverge from the Cumulative RR chart's
 * own curve, and reusing the exact same function is what makes that true
 * by construction rather than by coincidence (both consume the same
 * exitTime-ordered, same-timestamp-collapsed points).
 */
export function maximumDrawdown(trades: ScanTradeRecord[]): number {
  const series = cumulativeRRSeries(trades);
  let peak = 0;
  let worst = 0;
  for (const point of series) {
    if (point.cumulative > peak) peak = point.cumulative;
    const drawdown = point.cumulative - peak;
    if (drawdown < worst) worst = drawdown;
  }
  return worst;
}

/** Monday-anchored week key ("YYYY-MM-DD" of that ISO week's Monday, UTC) -
 * groups any two dates in the same Monday-Sunday week under the same key,
 * exactly the equivalence classes ISO-8601 weeks define. Anchoring to the
 * Monday date (rather than computing a canonical ISO week NUMBER) sidesteps
 * ISO week-numbering's own edge cases (week 53, a week's ISO year
 * sometimes differing from the calendar year right around Jan 1/Dec 31) -
 * this module only ever needs a stable grouping key for a denominator
 * count, never a displayed week number, so the two approaches are
 * equivalent for every actual use here. Always derived from exitTime via
 * exitDateParts, per this module's global rule - never entryTime. */
function weekKeyOf(trade: ScanTradeRecord): string {
  const { year, month, day } = exitDateParts(trade);
  const d = new Date(Date.UTC(year, month - 1, day));
  const mondayFirstWeekday = (d.getUTCDay() + 6) % 7; // 0=Mon..6=Sun
  d.setUTCDate(d.getUTCDate() - mondayFirstWeekday);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export interface TradeFrequencyAnalytics {
  avgTradesPerDay: number;
  avgTradesPerWeek: number;
  avgTradesPerMonth: number;
  avgTradesPerYear: number;
}

/**
 * Average trades per ACTIVE period only - total filtered trades divided by
 * the number of unique exit-time day/week/month/year periods that contain
 * at least one trade, never by every calendar period spanned between the
 * earliest and latest trade (a period with zero trades is not part of the
 * denominator). All period membership derived via exitDateParts/weekKeyOf
 * (exitTime), per this module's global rule. Returns all-zero (never
 * NaN/Infinity) for an empty input - one shared function rather than four
 * separate ones, since all four denominators are built from the same
 * single pass over `trades`.
 */
export function tradeFrequencyAnalytics(trades: ScanTradeRecord[]): TradeFrequencyAnalytics {
  const total = trades.length;
  if (total === 0) {
    return { avgTradesPerDay: 0, avgTradesPerWeek: 0, avgTradesPerMonth: 0, avgTradesPerYear: 0 };
  }
  const days = new Set<string>();
  const weeks = new Set<string>();
  const months = new Set<string>();
  const years = new Set<number>();
  for (const t of trades) {
    const parts = exitDateParts(t);
    days.add(parts.dateKey);
    weeks.add(weekKeyOf(t));
    months.add(parts.monthKey);
    years.add(parts.year);
  }
  return {
    avgTradesPerDay: total / days.size,
    avgTradesPerWeek: total / weeks.size,
    avgTradesPerMonth: total / months.size,
    avgTradesPerYear: total / years.size,
  };
}
