import type { SymbolTimeframeData, Timeframe, Trade } from "../data/types";
import { tradeKey } from "../journal/journalStore";
import type { ChartSnapshotWindow } from "../components/chartRegistry";
import type { PineRunResult } from "../pine/usePineIndicators";
import { barIndexToTime, avgBarInterval } from "../pine/PineIndicatorLayer";
import type { TradeReviewPayload } from "./telegramApi";

// "Enough candles before entry to understand context, enough after to
// understand the outcome" (per the original spec) - not exact science,
// just a generous default that keeps the trade's own entry/SL/TP zone
// comfortably inside frame alongside the structure that led into it.
const SNAPSHOT_BARS_BEFORE_ENTRY = 60;
const SNAPSHOT_BARS_AFTER_EXIT = 20;

/** The closest BOS/CHoCH event at or before the trade's own entry bar -
 * this IS the structural break the trade's fib-0.71 entry was measured
 * against, unlike the Pine-side label-proximity search (see
 * detectPineTradeConditions' doc comment on why that's unreliable): the
 * backend's bosEvents are typed rows with a real barEnd directly
 * comparable to entryBar, no label-midpoint-placement ambiguity. */
function nearestSetupLabel(data: SymbolTimeframeData, entryBar: number): "BOS" | "CHoCH" | null {
  let best: { barEnd: number; kind: "bos" | "choch" } | null = null;
  for (const b of data.bosEvents) {
    if (b.barEnd > entryBar) continue;
    if (!best || b.barEnd > best.barEnd) best = b;
  }
  if (!best) return null;
  return best.kind === "choch" ? "CHoCH" : "BOS";
}

export function computeSnapshotWindow(data: SymbolTimeframeData, trade: Trade): ChartSnapshotWindow {
  const fromBar = Math.max(0, trade.entryBar - SNAPSHOT_BARS_BEFORE_ENTRY);
  const toBar = Math.min(data.bars.length - 1, Math.max(trade.exitBar, trade.entryBar) + SNAPSHOT_BARS_AFTER_EXIT);
  return {
    fromTime: data.bars[fromBar].time,
    toTime: data.bars[toBar].time,
    reviewedTrade: {
      entryPrice: trade.entryPrice,
      sl: trade.sl,
      tp: trade.tp,
      entryTime: data.bars[trade.entryBar].time,
      exitTime: data.bars[trade.exitBar]?.time ?? data.bars[trade.entryBar].time,
      setup: nearestSetupLabel(data, trade.entryBar),
    },
  };
}

/** Same idea as computeSnapshotWindow, but for a trade recorded by a Pine
 * indicator - entryBar/exitBar index THAT indicator's own windowedBars,
 * never the full dataset's bars (see PineIndicatorLayer's own doc comment
 * on barIndexToTime - a script's "apply from" startDate slices its window
 * before the interpreter ever runs, so bar 0 there is NOT bar 0 of the
 * full history). setup reuses Trade.setup directly - see
 * detectPineTradeConditions' doc comment on why that's the reliable
 * signal for smc.pine specifically, unlike searching for a nearby label. */
export function computePineSnapshotWindow(result: PineRunResult, trade: Trade): ChartSnapshotWindow {
  const bars = result.windowedBars;
  const fromBar = Math.max(0, trade.entryBar - SNAPSHOT_BARS_BEFORE_ENTRY);
  const toBar = Math.min(bars.length - 1, Math.max(trade.exitBar, trade.entryBar) + SNAPSHOT_BARS_AFTER_EXIT);
  return {
    fromTime: bars[fromBar].time,
    toTime: bars[toBar].time,
    reviewedTrade: {
      entryPrice: trade.entryPrice,
      sl: trade.sl,
      tp: trade.tp,
      entryTime: bars[trade.entryBar].time,
      exitTime: bars[trade.exitBar]?.time ?? bars[trade.entryBar].time,
      setup: trade.setup === "BOS" || trade.setup === "CHoCH" ? trade.setup : null,
    },
  };
}

// Heuristic, not a rigorous structural analysis: "detected conditions" are
// events (BOS/CHoCH/FVG/liquidity sweep) whose bar falls within this many
// bars before the trade's entry. The backend has no per-trade link to the
// SMC event tables (a trade only stores entry_bar/exit_bar - see
// backend/build_db.py's trades table schema), so this can't be an exact
// "did this trade's own setup range contain an FVG" answer the way
// smc.pine's own requireImbalanceInRange filter can (that has the actual
// per-setup range to check against). 50 bars is a reasonable "recent
// structure leading into this entry" window on the 1H trades this app
// currently produces - revisit if trades start coming from a different
// timeframe.
const CONDITION_LOOKBACK_BARS = 50;

export interface TradeConditions {
  liquiditySweep: boolean;
  bos: boolean;
  choch: boolean;
  fvg: boolean;
}

export function detectTradeConditions(data: SymbolTimeframeData, trade: Trade): TradeConditions {
  const from = Math.max(0, trade.entryBar - CONDITION_LOOKBACK_BARS);
  const to = trade.entryBar;
  return {
    liquiditySweep: data.liquidityEvents.some((l) => l.barEnd >= from && l.barEnd <= to),
    bos: data.bosEvents.some((b) => b.kind === "bos" && b.barEnd >= from && b.barEnd <= to),
    choch: data.bosEvents.some((b) => b.kind === "choch" && b.barEnd >= from && b.barEnd <= to),
    fvg: data.fvgEvents.some((f) => f.bar >= from && f.bar <= to),
  };
}

/** Same idea as detectTradeConditions, but for a trade recorded by a Pine
 * indicator - a Pine indicator has no equivalent bosEvents/fvgEvents/
 * liquidityEvents tables to check, only whatever it recorded/drew.
 *
 * bos/choch come directly from Trade.setup, NOT a label-proximity search:
 * smc.pine's own backtest.recordTrade(...) call passes array.get(evType,
 * oidx) - "BOS" or "CHoCH" - as the setup argument (confirmed: every trade
 * across a full-history run has setup exactly "BOS" or "CHoCH", nothing
 * else), so this is a 100% reliable, non-heuristic answer for THIS field.
 * An earlier version of this function tried matching nearby "BOS"/"CHoCH"
 * text labels instead and was wrong in practice: smc.pine places those
 * labels at the MIDPOINT of the whole structural leg (see its
 * `x=int((time + structureLowStartTime) / 2)`), which can be many bars
 * before the actual breakout/entry for a long leg - reproduced directly
 * against the interpreter (a trade with setup="BOS" showed zero nearby
 * "BOS" labels within a 50-bar window) before switching to this.
 *
 * fvg has no equivalent per-trade field (smc.pine tracks it internally via
 * a leg-scoped flag but never exposes it outside the interpreter), so this
 * keeps the label-proximity approach for FVG specifically - unlike BOS/
 * CHoCH, an FVG label sits at its own box's midpoint (`(left+right)/2`),
 * which IS tightly localized to the actual 3-candle pattern, not a whole
 * structural leg away.
 *
 * This is a best-effort match against smc.pine's OWN label text ("BOS",
 * "CHoCH", "FVG" - see smc.pine's structureLabels/fvgLabel pushes), not a
 * generic solution for arbitrary Pine scripts - a script that doesn't use
 * this exact setup/label convention will just show no detected FVG rather
 * than a wrong guess (conditions are omitted from the message entirely
 * when none match - see format_trade_review_message on the backend).
 * smc.pine has no liquidity-sweep concept at all, so that's always false
 * here (never claim a condition the script doesn't even compute). */
export function detectPineTradeConditions(result: PineRunResult, trade: Trade): TradeConditions {
  const bars = result.windowedBars;
  const entryTime = bars[trade.entryBar]?.time;
  const fvg =
    entryTime == null
      ? false
      : (() => {
          const avgInterval = avgBarInterval(bars);
          const fromTime = entryTime - CONDITION_LOOKBACK_BARS * avgInterval;
          return result.outputs.labels.some((raw) => {
            const label = raw as Record<string, unknown>;
            if (String(label.text ?? "") !== "FVG") return false;
            const xloc = String(label.xloc ?? "bar_index");
            // Pine's own xloc.bar_time values are milliseconds (see
            // PineIndicatorLayer's identical conversion).
            const t = xloc === "bar_time" ? (label.x as number) / 1000 : barIndexToTime(label.x as number, bars, avgInterval);
            return t >= fromTime && t <= entryTime;
          });
        })();

  return {
    liquiditySweep: false,
    bos: trade.setup === "BOS",
    choch: trade.setup === "CHoCH",
    fvg,
  };
}

function formatClosedAt(unixSeconds: number): string {
  const iso = new Date(unixSeconds * 1000)
    .toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    })
    .replace(",", "");
  return `${iso} UTC`;
}

/** tradeId reuses journalStore's existing symbol:entryBar identity
 * convention (see tradeKey's own doc comment) rather than inventing a
 * second one - the backend trades table has no primary key of its own. */
export function buildTradeReviewPayload(data: SymbolTimeframeData, trade: Trade): TradeReviewPayload {
  const exitTime = data.bars[trade.exitBar]?.time;
  const risk = Math.abs(trade.entryPrice - trade.sl);
  const reward = Math.abs(trade.tp - trade.entryPrice);
  return {
    tradeId: tradeKey(data.symbol, trade.entryBar),
    symbol: data.symbol,
    timeframe: data.timeframe.toUpperCase(),
    direction: trade.dir === "long" ? "LONG" : "SHORT",
    setup: trade.setup,
    entry: trade.entryPrice,
    sl: trade.sl,
    tp: trade.tp,
    rr: risk > 0 ? reward / risk : 0,
    resultR: trade.r,
    closedAt: exitTime != null ? formatClosedAt(exitTime) : "unknown",
    conditions: detectTradeConditions(data, trade),
  };
}

/** Same idea as buildTradeReviewPayload, but for a trade recorded by a
 * Pine indicator - see computePineSnapshotWindow/detectPineTradeConditions
 * for why this needs the source PineRunResult rather than the dataset.
 *
 * tradeId is deliberately NOT tradeKey(symbol, entryBar): a Pine trade's
 * entryBar indexes that indicator's own windowedBars, not the full
 * dataset, so it could collide with an unrelated backend trade that
 * happens to share the same bar number (or with another Pine indicator's
 * own trade, if more than one is active) - both would silently share one
 * review record once Milestone 5 persists answers by tradeId. Including
 * the indicator's own id makes every Pine trade's identity unique on its
 * own, and the "pine" marker keeps it visually distinct from a backend
 * trade's plain "SYMBOL:bar" form. */
export function buildPineTradeReviewPayload(result: PineRunResult, symbol: string, timeframe: Timeframe, trade: Trade): TradeReviewPayload {
  const bars = result.windowedBars;
  const exitTime = bars[trade.exitBar]?.time;
  const risk = Math.abs(trade.entryPrice - trade.sl);
  const reward = Math.abs(trade.tp - trade.entryPrice);
  return {
    tradeId: `${symbol}:pine:${result.indicator.id}:${trade.entryBar}`,
    symbol,
    timeframe: timeframe.toUpperCase(),
    direction: trade.dir === "long" ? "LONG" : "SHORT",
    setup: trade.setup,
    entry: trade.entryPrice,
    sl: trade.sl,
    tp: trade.tp,
    rr: risk > 0 ? reward / risk : 0,
    resultR: trade.r,
    closedAt: exitTime != null ? formatClosedAt(exitTime) : "unknown",
    conditions: detectPineTradeConditions(result, trade),
  };
}
