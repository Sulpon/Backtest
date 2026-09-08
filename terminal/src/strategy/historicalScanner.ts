import { dataLayer } from "../data/DataLayer";
import type { PineIndicator } from "../pine/pineIndicatorStore";
import { getOrComputeResult, type PineRunResult } from "../pine/usePineIndicators";
import { useStrategyScanStore } from "./strategyScanStore";
import type { ScanConfig, ScanTradeRecord } from "./types";

/**
 * Converts one symbol's Pine run result into ScanTradeRecord[] - extracted
 * from runHistoricalScan's own per-symbol loop (behavior-preserving, see
 * historicalScanner.test.ts, unchanged by this extraction) so the
 * Strategy Optimization module's strategyEvaluation.ts can reuse the exact
 * same conversion for its own per-parameter-combination runs, rather than
 * a second, drifting reimplementation. This remains the ONLY place a
 * PineTradeRecord's bar indices are converted to absolute timestamps.
 */
export function pineResultToScanRecords(
  result: PineRunResult,
  indicatorId: string,
  symbol: string,
  timeframe: ScanConfig["timeframe"],
  strategyId: string
): ScanTradeRecord[] {
  return result.outputs.trades.map((t) => {
    // entryBar/exitBar index THIS run's own windowedBars - convert to
    // absolute unix seconds immediately, before this record ever leaves
    // this per-symbol scope (see ScanTradeRecord's doc comment).
    const entryTime = result.windowedBars[t.entryBar]?.time ?? 0;
    const exitTime = result.windowedBars[t.exitBar]?.time ?? entryTime;
    return {
      // Includes exitTime, not just entryTime - see ScanTradeRecord's doc
      // comment (types.ts): a single bar can open more than one distinct
      // trade, and an entryTime-only id silently collapsed them.
      id: `${indicatorId}:${symbol}:${timeframe}:${entryTime}:${exitTime}`,
      strategyId,
      indicatorId,
      symbol,
      timeframe,
      dir: t.dir,
      entryTime,
      entryPrice: t.entryPrice,
      sl: t.sl,
      tp: t.tp,
      exitTime,
      result: t.result,
      r: t.r,
      setup: t.setup,
    };
  });
}

/**
 * Runs `indicator`'s own trade-generation logic (backtest.recordTrade(),
 * whatever the script itself implements - never a second/approximate
 * reimplementation) once per symbol in `symbols`, sequentially, and merges
 * every symbol's trades into the shared strategyScanStore.
 *
 * Sequential, not Promise.all: there is exactly ONE shared Pine Web Worker
 * in this app (see usePineIndicators.ts's `sharedWorker`), reused here
 * rather than duplicated - running many symbols in parallel would either
 * pile up requests behind that one worker anyway or require spinning up N
 * new workers, multiplying the ~830MB peak heap a single 100k-bar run
 * already costs (see terminal/README.md's measured numbers). One symbol at
 * a time keeps this scanner's memory footprint identical to today's
 * single-chart footprint.
 *
 * Reuses getOrComputeResult (usePineIndicators.ts) verbatim for the actual
 * per-symbol run - same startDate bar-slicing, same persistent IndexedDB
 * cache (so re-running an identical scan config skips recomputation for
 * whatever's still cached), same interpreter/worker path the live chart
 * uses. The only thing this function adds is the per-symbol loop, progress
 * reporting, and converting each run's bar-indexed trades to the absolute-
 * timestamped, symbol-tagged ScanTradeRecord shape a multi-symbol merge
 * requires (mirrors pine/pineTradesAdapter.ts's own bar-index-to-time
 * conversion for merging multiple indicators on one chart).
 */
export async function runHistoricalScan(config: ScanConfig, indicator: PineIndicator, symbols: string[]): Promise<void> {
  const store = useStrategyScanStore.getState();
  const strategyId = `scan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  store.startScan(config, symbols);

  for (const symbol of symbols) {
    if (useStrategyScanStore.getState().status === "cancelled") break;

    useStrategyScanStore.getState().updateProgress(symbol, { status: "running" });
    try {
      const data = await dataLayer.getSymbolData(symbol, config.timeframe);
      // Local override only - never mutates the user's saved indicator in
      // pineIndicatorStore. Reuses getOrComputeResult's own startDate
      // slicing (usePineIndicators.ts:159-165) so "scan from this date"
      // needs zero new slicing logic here.
      const overridden: PineIndicator = { ...indicator, startDate: config.startDate };
      const result = await getOrComputeResult(overridden, data.bars, symbol, config.timeframe);

      if (result.fatalError) {
        useStrategyScanStore.getState().updateProgress(symbol, { status: "error", error: result.fatalError });
        continue;
      }

      const records: ScanTradeRecord[] = pineResultToScanRecords(result, indicator.id, symbol, config.timeframe, strategyId);

      useStrategyScanStore.getState().mergeTrades(records);
      useStrategyScanStore.getState().updateProgress(symbol, { status: "done", tradeCount: records.length });
    } catch (e) {
      // One bad symbol (network failure, no data, interpreter throwing)
      // must never abort the rest of the scan.
      const message = e instanceof Error ? e.message : String(e);
      useStrategyScanStore.getState().updateProgress(symbol, { status: "error", error: message });
    }
  }

  const cancelled = useStrategyScanStore.getState().status === "cancelled";
  useStrategyScanStore.getState().finishScan(cancelled ? "cancelled" : "done");
}
