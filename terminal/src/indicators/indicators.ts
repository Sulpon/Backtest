import type { CandleBar } from "../data/types";

export interface IndicatorPoint {
  time: number;
  value: number;
}

/** Simple moving average of close price. */
export function sma(bars: CandleBar[], period: number): IndicatorPoint[] {
  if (bars.length < period) return [];
  const out: IndicatorPoint[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= period) sum -= bars[i - period].close;
    if (i >= period - 1) out.push({ time: bars[i].time, value: sum / period });
  }
  return out;
}

/** Exponential moving average of close price, seeded with the SMA of the first `period` bars. */
export function ema(bars: CandleBar[], period: number): IndicatorPoint[] {
  if (bars.length < period) return [];
  const k = 2 / (period + 1);
  const out: IndicatorPoint[] = [];
  let seedSum = 0;
  for (let i = 0; i < period; i++) seedSum += bars[i].close;
  let prev = seedSum / period;
  out.push({ time: bars[period - 1].time, value: prev });
  for (let i = period; i < bars.length; i++) {
    prev = bars[i].close * k + prev * (1 - k);
    out.push({ time: bars[i].time, value: prev });
  }
  return out;
}

export interface BollingerBands {
  middle: IndicatorPoint[];
  upper: IndicatorPoint[];
  lower: IndicatorPoint[];
}

/** SMA of close price, +/- `mult` standard deviations over the same window. */
export function bollingerBands(bars: CandleBar[], period: number, mult: number): BollingerBands {
  const middle: IndicatorPoint[] = [];
  const upper: IndicatorPoint[] = [];
  const lower: IndicatorPoint[] = [];
  for (let i = period - 1; i < bars.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += bars[j].close;
    const mean = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (bars[j].close - mean) ** 2;
    const sd = Math.sqrt(variance / period);
    const time = bars[i].time;
    middle.push({ time, value: mean });
    upper.push({ time, value: mean + mult * sd });
    lower.push({ time, value: mean - mult * sd });
  }
  return { middle, upper, lower };
}
