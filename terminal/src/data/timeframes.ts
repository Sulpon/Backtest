import type { Timeframe } from "./types";

/** Every timeframe the backend can serve, lowest to highest - the single
 * list every timeframe selector (TopToolbar, ChartPane, command palette)
 * renders from, so adding a timeframe later is a one-line change here. */
export const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"];

export const TIMEFRAME_LABELS: Record<Timeframe, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1H",
  "4h": "4H",
  "1d": "1D",
};

/** The multi-timeframe split's "other" pane: daily context when viewing
 * anything intraday, one step in from daily otherwise. */
export function secondaryTimeframe(tf: Timeframe): Timeframe {
  return tf === "1d" ? "4h" : "1d";
}
