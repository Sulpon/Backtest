import type { ScanTradeRecord } from "../types";

/**
 * Shared synthetic ScanTradeRecord builder for this module's pure-logic
 * tests (metrics/symbolRobustness/timeRobustness/stability/walkForward/
 * optimizationEngine) - never imported by production code, only by *.test.ts
 * files in this directory. Centralizing this avoids re-deriving the same
 * boilerplate trade shape in every test file, per the pattern already used
 * by this session's other synthetic-data-tested engines (Challenge, Monte
 * Carlo, Sensitivity Matrix).
 */
let counter = 0;

export function makeTrade(overrides: Partial<ScanTradeRecord> = {}): ScanTradeRecord {
  counter += 1;
  const exitTime = overrides.exitTime ?? counter * 3600;
  const entryTime = overrides.entryTime ?? exitTime - 1800;
  const r = overrides.r ?? 1;
  return {
    id: `test-${counter}`,
    strategyId: "test-strategy",
    indicatorId: "test-indicator",
    symbol: "EURUSD",
    timeframe: "1h",
    dir: "long",
    entryTime,
    entryPrice: 1.1,
    sl: 1.09,
    tp: 1.12,
    exitTime,
    result: r >= 0 ? "Win" : "Lose",
    r,
    setup: "test-setup",
    ...overrides,
  };
}

/** A run of `count` trades, one per `stepSec` seconds starting at
 * `startSec`, each with the given `r` outcome (or a per-index function of
 * it). Deterministic exitTime spacing makes date-bucketing tests (daily/
 * monthly/yearly/frequency) easy to reason about precisely. */
export function makeTradeSeries(
  count: number,
  startSec: number,
  stepSec: number,
  rFor: number | ((i: number) => number),
  overrides: Partial<ScanTradeRecord> = {}
): ScanTradeRecord[] {
  return Array.from({ length: count }, (_, i) => {
    const r = typeof rFor === "function" ? rFor(i) : rFor;
    const exitTime = startSec + i * stepSec;
    return makeTrade({ ...overrides, exitTime, entryTime: exitTime - Math.min(stepSec / 2, 1800), r });
  });
}
