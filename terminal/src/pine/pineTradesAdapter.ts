import type { Trade } from "../data/types";
import type { PineRunResult } from "./usePineIndicators";
import type { PineIndicator } from "./pineIndicatorStore";
import type { PineTradeRecord } from "./interpreter";

/** A Pine trade's own `id` (`t${entryBar}_${exitBar}` - see
 * interpreter.ts's recordTrade) is only unique WITHIN one script's own
 * run: two different indicators can easily produce the same entryBar/
 * exitBar for entirely unrelated trades (each one's bar indices are local
 * to that indicator's own windowedBars - see PineRunResult's doc comment),
 * so anything downstream of this adapter that needs a stable, collision-
 * free identity (journal keys, the "remove trade" override store, React
 * list keys) must incorporate the owning indicator's id too. This is the
 * one place that composition happens - the interpreter/stdlib's own
 * trade.id is never changed, only wrapped. Mirrors the same
 * `${indicator.id}:${rawId}`-style scoping tradeReviewPayload.ts already
 * uses for its own Telegram tradeId. */
export function pineTradeCompositeId(indicatorId: string, rawTradeId: string): string {
  return `${indicatorId}:${rawTradeId}`;
}

export interface PineTradeWithSource {
  trade: Trade;
  /** Composite, collision-free identity for this trade - see
   * pineTradeCompositeId's doc comment. Use this (not `trade` alone, which
   * has no id of its own) for journal keys, override-store keys, and React
   * list keys. */
  id: string;
  /** The exact PineRunResult this trade came from - needed for anything
   * that must convert this trade's entryBar/exitBar to a real time (they're
   * indices into THIS result's own windowedBars, not any shared/full-
   * dataset array - see PineIndicatorLayer's barIndexToTime doc comment)
   * or inspect this indicator's own drawing output (e.g. deriving "detected
   * conditions" for a Telegram trade review from its BOS/CHoCH/FVG labels -
   * see telegram/tradeReviewPayload.ts). Lost by collectPineTrades' plain
   * Trade[] return, which is why this variant exists. */
  source: PineRunResult;
}

function toTradeWithSource(result: PineRunResult, t: PineTradeRecord): PineTradeWithSource {
  return {
    trade: {
      dir: t.dir,
      entryBar: t.entryBar,
      entryPrice: t.entryPrice,
      sl: t.sl,
      tp: t.tp,
      exitBar: t.exitBar,
      result: t.result,
      r: t.r,
      setup: t.setup,
    },
    id: pineTradeCompositeId(result.indicator.id, t.id),
    source: result,
  };
}

/** Flattens every visible Pine indicator's recorded trades into
 * {trade, source} pairs, skipping anything the user removed via the
 * chart's right-click menu, sorted by entry time across all indicators
 * together (comparing entryBar directly would be wrong once more than one
 * indicator is active, since each one's entryBar indexes its own
 * windowedBars - comparing the real bar time instead is what makes this
 * a genuine chronological merge).
 *
 * `removed` must come from a reactive `usePineTradeOverridesStore((s) =>
 * s.removed)` subscription in the caller (not `.getState()`) - this is a
 * plain function, not a hook, specifically so callers control when it
 * re-runs (inside their own useMemo) rather than this module silently
 * reading stale state. Keyed by the composite id (see pineTradeCompositeId)
 * so removing one indicator's trade never hides another indicator's
 * same-shaped trade. */
export function collectPineTradesWithSource(results: PineRunResult[], removed: Record<string, true>): PineTradeWithSource[] {
  if (results.length === 0) return [];
  const pairs: PineTradeWithSource[] = [];
  for (const result of results) {
    for (const t of result.outputs.trades) {
      const pair = toTradeWithSource(result, t);
      if (removed[pair.id]) continue;
      pairs.push(pair);
    }
  }
  return pairs.sort((a, b) => {
    const ta = a.source.windowedBars[a.trade.entryBar]?.time ?? 0;
    const tb = b.source.windowedBars[b.trade.entryBar]?.time ?? 0;
    return ta - tb;
  });
}

export interface PineTradeGroup {
  indicator: PineIndicator;
  trades: PineTradeWithSource[];
}

/** Same source data as collectPineTradesWithSource, but bucketed per
 * indicator instead of flattened into one chronological list - this is
 * what lets the Trades & Journal panel give each active Pine indicator its
 * own distinct journal view rather than one shared/flattened table. One
 * group per currently-visible indicator in `results`, in the same order
 * `results` arrives in (i.e. usePineIndicators' own visible-indicator
 * order), even if that indicator has recorded zero trades so far - a
 * journal tab for it can still exist and simply show "No trades" until it
 * does. */
export function groupPineTradesByIndicator(results: PineRunResult[], removed: Record<string, true>): PineTradeGroup[] {
  return results.map((result) => {
    const trades = result.outputs.trades.map((t) => toTradeWithSource(result, t)).filter((pair) => !removed[pair.id]);
    trades.sort((a, b) => (a.source.windowedBars[a.trade.entryBar]?.time ?? 0) - (b.source.windowedBars[b.trade.entryBar]?.time ?? 0));
    return { indicator: result.indicator, trades };
  });
}

/** Stable key for a Pine indicator's own journal "tab" in the Trades &
 * Journal panel's source selector - namespaced so it can never collide
 * with the literal "backend" key the EURUSD/1h backend journal uses. */
export function pineJournalSourceKey(indicatorId: string): string {
  return `pine:${indicatorId}`;
}

/** Flattens every visible Pine indicator's recorded trades into the app's
 * own `Trade` shape (dropping the Pine-only `id`, which only exists so a
 * removed trade can be excluded here). Shared by ChartPane (pane-header
 * stats) and TradesPanel so "trades from a Pine indicator" means the same
 * thing in both places - TradesPanel's own Telegram-review buttons need
 * the source result too, so they use collectPineTradesWithSource directly
 * instead of this. */
export function collectPineTrades(results: PineRunResult[], removed: Record<string, true>): Trade[] {
  return collectPineTradesWithSource(results, removed).map((p) => p.trade);
}
