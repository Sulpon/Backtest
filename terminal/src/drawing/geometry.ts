import type { CandleBar } from "../data/types";
import { nearestIndexByTime } from "../lib/bars";

export interface PixelPoint {
  x: number;
  y: number;
}

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function pointInRect(px: number, py: number, x0: number, y0: number, x1: number, y1: number, pad = 0): boolean {
  const left = Math.min(x0, x1) - pad;
  const right = Math.max(x0, x1) + pad;
  const top = Math.min(y0, y1) - pad;
  const bottom = Math.max(y0, y1) + pad;
  return px >= left && px <= right && py >= top && py <= bottom;
}

/** Snaps a raw chart time to the exact time of its nearest bar - drawings
 * always anchor to real candles rather than floating between them, magnet
 * on or off. With the magnet ON, price is ALSO snapped to whichever of that
 * candle's open/high/low/close sits closest to the raw hovered price - the
 * same "strong magnet" behavior as TradingView's magnet mode: always the
 * nearest OHLC value of the nearest candle, not merely snapping when
 * already close (a "weak" magnet, which this doesn't implement - the ask
 * was to snap "by simply hovering", not to snap only near the body/wick). */
export function snapPoint(bars: CandleBar[], time: number, price: number, magnet: boolean): { time: number; price: number } {
  const idx = nearestIndexByTime(bars, time, (b) => b.time);
  if (idx < 0) return { time, price };
  const bar = bars[idx];
  if (!magnet) return { time: bar.time, price };
  const candidates = [bar.open, bar.high, bar.low, bar.close];
  let snappedPrice = candidates[0];
  let bestDist = Math.abs(price - snappedPrice);
  for (let i = 1; i < candidates.length; i++) {
    const d = Math.abs(price - candidates[i]);
    if (d < bestDist) {
      bestDist = d;
      snappedPrice = candidates[i];
    }
  }
  return { time: bar.time, price: snappedPrice };
}
