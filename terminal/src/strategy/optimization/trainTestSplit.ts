import type { ScanTradeRecord } from "../types";
import type { DateRange, SplitTrades, TrainTestSplitConfig } from "./types";

/**
 * Chronological train/test split - pure, no Pine/RNG involvement. The
 * split boundary is a TIME cut of the configured date range, never a
 * trade-count cut: this is what makes it leakage-free regardless of how
 * trade density varies across the range (a count-based split could put a
 * test-period's trades on the train side simply because they cluster
 * earlier, which is a subtler form of the exact leakage this feature
 * exists to prevent). Trades are assigned by exitTime, per this project's
 * established global rule (see strategy/analysis/dateAnalytics.ts's own
 * doc comment) - a trade whose entryTime is on one side of the boundary
 * but whose exitTime is on the other belongs strictly to the exitTime side.
 */
export function splitTrainTest(trades: ScanTradeRecord[], range: DateRange, config: TrainTestSplitConfig): SplitTrades {
  const boundary = range.fromSec + (range.toSec - range.fromSec) * (config.trainPct / 100);
  const train = trades.filter((t) => t.exitTime <= boundary);
  const test = trades.filter((t) => t.exitTime > boundary);
  return {
    train,
    test,
    trainRange: { fromSec: range.fromSec, toSec: boundary },
    testRange: { fromSec: boundary, toSec: range.toSec },
  };
}

/**
 * % change from `trainValue` to `testValue` - used to display Train->Test
 * degradation (e.g. Expected Value, Total R) as an overfitting SIGNAL, not
 * an auto-reject gate (per spec: "displayed as a warning signal"). Returns
 * null when trainValue is exactly 0 (the % change is undefined, not
 * infinite or zero - never fabricated).
 */
export function computeDegradationPct(trainValue: number, testValue: number): number | null {
  if (trainValue === 0) return null;
  return ((testValue - trainValue) / Math.abs(trainValue)) * 100;
}
