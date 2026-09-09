import { CrosshairMode, LineStyle, type DeepPartial, type ChartOptions } from "lightweight-charts";
import type { ThemeName } from "../theme/ThemeProvider";

/**
 * Lightweight Charts paints to <canvas>, so it can't consume CSS custom
 * properties live - it needs concrete color strings at the moment options
 * are applied. Reading getComputedStyle() for this is a trap: it raced
 * against ThemeProvider's own effect (React fires child effects before
 * parent effects, so ChartPane's re-theme effect ran one step behind the
 * DOM attribute ThemeProvider had just set). Keeping a small JS-side copy
 * of the palette, keyed directly off the theme string, sidesteps the race
 * entirely - it's not RE-DERIVED from anything that lags a render behind.
 */
const PALETTE: Record<ThemeName, {
  bgPanel: string;
  bgElevated: string;
  textDim: string;
  border: string;
  borderStrong: string;
  gridLine: string;
  bull: string;
  bear: string;
  highlight: string;
}> = {
  dark: {
    // Near-black, not the panel-chrome bg-panel navy - the chart canvas
    // itself should read closer to TradingView's bare-black plot area,
    // distinct from (darker than) the UI chrome around it.
    bgPanel: "#070809",
    bgElevated: "#1c222d",
    textDim: "#838d9e",
    border: "rgba(255,255,255,0.08)",
    borderStrong: "rgba(255,255,255,0.16)",
    // Dimmer than `border` deliberately - the TradingView reference this
    // was compared against shows no visibly distinct grid lines at all;
    // near-invisible (rather than fully removed) keeps a faint reference
    // grid for reading price/time without it competing with candles.
    gridLine: "rgba(255,255,255,0.035)",
    bull: "#26a69a",
    bear: "#ef5350",
    highlight: "#e0a64c",
  },
  light: {
    bgPanel: "#ffffff",
    bgElevated: "#e7eaf0",
    textDim: "#565f70",
    border: "rgba(10,13,18,0.1)",
    borderStrong: "rgba(10,13,18,0.2)",
    gridLine: "rgba(10,13,18,0.1)", // unchanged from `border` - light theme wasn't part of this comparison
    bull: "#0f8f83",
    bear: "#d4453f",
    highlight: "#a8752a",
  },
};

export function chartOptions(theme: ThemeName, fontSize = 11): DeepPartial<ChartOptions> {
  const p = PALETTE[theme];
  return {
    layout: {
      background: { color: p.bgPanel },
      textColor: p.textDim,
      fontFamily: "-apple-system, 'Segoe UI', Arial, sans-serif",
      fontSize,
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: p.gridLine },
      horzLines: { color: p.gridLine },
    },
    rightPriceScale: { borderColor: p.borderStrong },
    timeScale: { borderColor: p.borderStrong, timeVisible: true },
    // Thin, low-contrast dashed lines and a compact label chip - the
    // library's own defaults (mid-gray, unthemed) don't track light/dark
    // mode. Matches the rest of the chart's subtle-hairline language
    // (grid lines already use `p.border`) rather than standing out.
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: p.borderStrong, width: 1, style: LineStyle.Dashed, labelBackgroundColor: p.bgElevated },
      horzLine: { color: p.borderStrong, width: 1, style: LineStyle.Dashed, labelBackgroundColor: p.bgElevated },
    },
  };
}

export function candleOptions(theme: ThemeName) {
  const p = PALETTE[theme];
  return {
    upColor: p.bull,
    downColor: p.bear,
    borderVisible: false,
    wickUpColor: p.bull,
    wickDownColor: p.bear,
  };
}

export function paletteColor(theme: ThemeName, key: "bull" | "bear" | "highlight"): string {
  return PALETTE[theme][key];
}

/** The exact panel background color lightweight-charts paints itself with
 * (see chartOptions' layout.background above) - used to letterbox chart
 * snapshots (see chartSnapshot.ts) so a non-16:9 chart doesn't get bars of
 * a jarring, unthemed color around it. */
export function panelBackgroundColor(theme: ThemeName): string {
  return PALETTE[theme].bgPanel;
}
