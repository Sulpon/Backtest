import type { CandleBar } from "../data/types";
import type { DrawingPoint } from "../drawing/types";
import { nearestIndexByTime } from "../lib/bars";
import type { MarketStructurePoint } from "./types";

export interface StructureMeasurement {
  start: MarketStructurePoint;
  end: MarketStructurePoint;
  rangeCandles: number;
  rangePercent: number | null;
  rangePercentPerCandle: number | null;
  rangeHigh: MarketStructurePoint | null;
  rangeLow: MarketStructurePoint | null;
  absolutePriceDistance: number;
  directionalMovePercent: number;
  startTimestamp: number;
  endTimestamp: number;
  durationMinutes: number;
  durationCandles: number;
}

/** Turns the two raw chart points of a bosbull/bosbear/chochbull/chochbear
 * drawing into every measured field the dataset records. Purely arithmetic
 * over the real candle data between the two points - nothing here judges
 * whether the move is a "real" BOS/CHoCH, only measures the one the user
 * already drew. `start`/`end` are ordered by TIME (earlier point first),
 * independent of which one the user happened to click first. */
export function measureStructure(bars: CandleBar[], pointA: DrawingPoint, pointB: DrawingPoint): StructureMeasurement {
  const [p1, p2] = pointA.time <= pointB.time ? [pointA, pointB] : [pointB, pointA];

  const startCandleIndex = bars.length ? nearestIndexByTime(bars, p1.time, (b) => b.time) : -1;
  const endCandleIndex = bars.length ? nearestIndexByTime(bars, p2.time, (b) => b.time) : -1;

  const start: MarketStructurePoint = { candleIndex: startCandleIndex, timestamp: p1.time, price: p1.price };
  const end: MarketStructurePoint = { candleIndex: endCandleIndex, timestamp: p2.time, price: p2.price };

  const rangeCandles = startCandleIndex >= 0 && endCandleIndex >= 0 ? Math.max(0, endCandleIndex - startCandleIndex) : 0;

  let rangeHigh: MarketStructurePoint | null = null;
  let rangeLow: MarketStructurePoint | null = null;
  if (startCandleIndex >= 0 && endCandleIndex >= 0) {
    const lo = Math.min(startCandleIndex, endCandleIndex);
    const hi = Math.min(Math.max(startCandleIndex, endCandleIndex), bars.length - 1);
    for (let i = lo; i <= hi; i++) {
      const bar = bars[i];
      if (!rangeHigh || bar.high > rangeHigh.price) rangeHigh = { candleIndex: i, timestamp: bar.time, price: bar.high };
      if (!rangeLow || bar.low < rangeLow.price) rangeLow = { candleIndex: i, timestamp: bar.time, price: bar.low };
    }
  }

  const rangePercent = rangeHigh && rangeLow && rangeLow.price !== 0 ? ((rangeHigh.price - rangeLow.price) / rangeLow.price) * 100 : null;
  const rangePercentPerCandle = rangePercent != null && rangeCandles > 0 ? rangePercent / rangeCandles : null;

  const absolutePriceDistance = Math.abs(p2.price - p1.price);
  const directionalMovePercent = p1.price !== 0 ? ((p2.price - p1.price) / p1.price) * 100 : 0;
  const durationMinutes = (p2.time - p1.time) / 60;

  return {
    start,
    end,
    rangeCandles,
    rangePercent,
    rangePercentPerCandle,
    rangeHigh,
    rangeLow,
    absolutePriceDistance,
    directionalMovePercent,
    startTimestamp: p1.time,
    endTimestamp: p2.time,
    durationMinutes,
    durationCandles: rangeCandles,
  };
}
