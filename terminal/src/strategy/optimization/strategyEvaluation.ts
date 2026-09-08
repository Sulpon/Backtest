import type { CandleBar, Timeframe } from "../../data/types";
import { dataLayer } from "../../data/DataLayer";
import type { PineIndicator } from "../../pine/pineIndicatorStore";
import { getOrComputeResult, runPineScript } from "../../pine/usePineIndicators";
import { pineResultToScanRecords } from "../historicalScanner";
import type { ScanTradeRecord } from "../types";
import type { ParameterCombination, ParameterDef } from "./types";

/**
 * The ONLY place this module invokes Pine - everything else in
 * strategy/optimization/ is pure computation over already-generated
 * ScanTradeRecord[]. Reuses getOrComputeResult/PineIndicator.inputOverrides
 * (the exact mechanism historicalScanner.ts already uses for the Strategy
 * Scan tab) and pineResultToScanRecords (extracted from that same file),
 * never a second trade-generation engine.
 */

/** Discovers this indicator's own optimizable (numeric) inputs by running
 * it once via the cheap, synchronous runPineScript (the same path already
 * used by "the settings dialog's single-bar input-metadata run" - see
 * usePineIndicators.ts's own doc comment on that function) - never the
 * heavier worker-based getOrComputeResult, since only inputDefs/current
 * values are needed here, not an accurate trade result.
 *
 * min/max default to the CURRENT value (a single-point, degenerate range)
 * when the script itself declares no minval/maxval - this is deliberate:
 * silently guessing a wide range the user never configured could produce
 * a huge, surprising grid. The user must explicitly widen a range in the
 * UI before it searches anything beyond the current value.
 */
export function discoverParameterDefs(indicator: PineIndicator, bars: CandleBar[]): ParameterDef[] {
  const result = runPineScript(indicator, bars);
  return result.inputDefs
    .filter((d) => d.kind === "int" || d.kind === "float")
    .map((d): ParameterDef => {
      const current = Number(indicator.inputOverrides[d.key] ?? d.defaultValue);
      const min = d.minval ?? current;
      const max = d.maxval ?? current;
      const step = d.kind === "int" ? 1 : 0.1;
      return { key: d.key, label: d.title || d.key, current, min, max, step };
    });
}

/**
 * Runs one parameter combination across every configured symbol,
 * sequentially - the SAME single-shared-Pine-worker discipline
 * historicalScanner.ts documents (parallel symbol runs would pile up
 * requests behind that one worker anyway). A symbol whose run fails is
 * skipped (matching historicalScanner's own per-symbol error tolerance),
 * not allowed to abort the whole combination.
 */
export async function runScanForCombination(
  indicator: PineIndicator,
  values: Record<string, number>,
  symbols: string[],
  timeframe: Timeframe,
  startDate: number,
  strategyId: string
): Promise<ScanTradeRecord[]> {
  const overridden: PineIndicator = { ...indicator, inputOverrides: { ...indicator.inputOverrides, ...values }, startDate };
  const allTrades: ScanTradeRecord[] = [];
  for (const symbol of symbols) {
    const data = await dataLayer.getSymbolData(symbol, timeframe);
    const result = await getOrComputeResult(overridden, data.bars, symbol, timeframe);
    if (result.fatalError) continue;
    allTrades.push(...pineResultToScanRecords(result, indicator.id, symbol, timeframe, strategyId));
  }
  return allTrades;
}

/**
 * Generates every combination's FULL trade history (across the whole
 * configured date range) exactly once, sequentially - this is the ONE
 * place a grid's trades are produced. Every downstream view (Train/Test
 * split, Walk-Forward folds, symbol/time robustness) later slices these
 * SAME trade sets purely by exitTime (see trainTestSplit.ts/walkForward.ts),
 * never re-invoking Pine per fold.
 */
export async function generateTradesForGrid(
  indicator: PineIndicator,
  combos: ParameterCombination[],
  symbols: string[],
  timeframe: Timeframe,
  startDate: number,
  onProgress?: (completed: number, total: number) => void,
  isCancelled?: () => boolean
): Promise<Map<string, ScanTradeRecord[]> | null> {
  const strategyId = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const tradesByCombo = new Map<string, ScanTradeRecord[]>();
  for (let i = 0; i < combos.length; i++) {
    if (isCancelled?.()) return null;
    const combo = combos[i];
    const trades = await runScanForCombination(indicator, combo.values, symbols, timeframe, startDate, strategyId);
    tradesByCombo.set(combo.key, trades);
    onProgress?.(i + 1, combos.length);
  }
  return tradesByCombo;
}
