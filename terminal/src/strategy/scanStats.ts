import type { Trade } from "../data/types";
import type { ScanTradeRecord } from "./types";

/**
 * Adapts ScanTradeRecord[] to the minimal Trade[] shape
 * replay/applyCursor.ts's computeLiveStats() needs. That function only ever
 * reads `.result`/`.r`/`.setup` (confirmed by reading its implementation) -
 * never entryBar/exitBar/entryPrice/sl/tp - so this exists purely to
 * satisfy Trade's type shape without an unsafe cast and without inventing a
 * second stats implementation. Reused by both TradesPanel's Journal Summary
 * tiles and StatsPanel's Strategy Scan view, so "Journal and Performance
 * derive from the same trade records" holds for this adapter too, not just
 * for computeLiveStats itself.
 */
export function scanTradesToStatsInput(trades: ScanTradeRecord[]): Trade[] {
  return trades.map((t) => ({
    dir: t.dir,
    entryBar: 0,
    entryPrice: t.entryPrice,
    sl: t.sl,
    tp: t.tp,
    exitBar: 0,
    result: t.result,
    r: t.r,
    setup: t.setup,
  }));
}
