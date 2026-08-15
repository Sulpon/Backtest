import type { BacktestStats, SymbolTimeframeData, Trade } from "../data/types";

/**
 * The "what's visible as of this bar" view of a dataset - the client-side
 * half of the Replay Engine. Bars beyond the cursor don't exist yet; swings
 * and BOS events aren't shown until the bar that confirmed them; an open
 * trade's zone is drawn only up to "now," not into bars that haven't
 * happened. Nothing here mutates the underlying dataset - ChartPane always
 * keeps the full fetched data too, this is a derived read-only slice.
 */
export function applyReplayCursor(data: SymbolTimeframeData, cursorBar: number): SymbolTimeframeData {
  const bars = data.bars.slice(0, cursorBar + 1);
  const swingPoints = data.swingPoints.filter((s) => s.bar <= cursorBar);
  const bosEvents = data.bosEvents.filter((b) => b.barEnd <= cursorBar);
  // an FVG at bar i isn't knowable until candle i+1 closes (detect_fvg needs
  // it to confirm the gap); an order block isn't confirmed until its fib
  // leg's BOS bar - both match how bosEvents is gated on barEnd, not barStart,
  // so replay never leaks a concept the engine wouldn't have detected yet.
  const fvgEvents = data.fvgEvents.filter((f) => f.bar + 1 <= cursorBar);
  const orderBlocks = data.orderBlocks.filter((o) => o.barEnd <= cursorBar);
  // volume imbalance's "bar" is already the second (confirming) candle of
  // the pair, unlike FVG's middle-candle convention, so no +1 needed here;
  // a liquidity pool is gated on its last swing bar, same as orderBlocks.
  const volumeImbalanceEvents = data.volumeImbalanceEvents.filter((v) => v.bar <= cursorBar);
  const liquidityEvents = data.liquidityEvents.filter((l) => l.barEnd <= cursorBar);
  const trades: Trade[] = data.trades
    .filter((t) => t.entryBar <= cursorBar)
    .map((t) => (t.exitBar <= cursorBar ? t : { ...t, exitBar: cursorBar }));

  return { ...data, bars, swingPoints, bosEvents, fvgEvents, orderBlocks, volumeImbalanceEvents, liquidityEvents, trades };
}

export function computeLiveStats(resolvedTrades: Trade[], rr: number): BacktestStats {
  const total = resolvedTrades.length;
  const wins = resolvedTrades.filter((t) => t.result === "Win").length;
  const losses = total - wins;
  const winRate = total ? (wins / total) * 100 : 0;
  const expectancy = total ? resolvedTrades.reduce((sum, t) => sum + t.r, 0) / total : 0;

  const bySetup: BacktestStats["bySetup"] = {};
  const bucket: Record<string, { n: number; w: number; r: number }> = {};
  for (const t of resolvedTrades) {
    const b = (bucket[t.setup] ??= { n: 0, w: 0, r: 0 });
    b.n += 1;
    b.r += t.r;
    if (t.result === "Win") b.w += 1;
  }
  for (const [setup, b] of Object.entries(bucket)) {
    bySetup[setup] = { n: b.n, wr: (b.w / b.n) * 100, exp: b.r / b.n };
  }

  return {
    total,
    wins,
    losses,
    winRate,
    expectancy,
    rr,
    breakevenWr: (100 / (1 + rr)) || 0,
    bySetup,
  };
}
