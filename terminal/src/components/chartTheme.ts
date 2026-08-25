import { CrosshairMode, type DeepPartial, type ChartOptions } from "lightweight-charts";
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
  textDim: string;
  border: string;
  borderStrong: string;
  bull: string;
  bear: string;
  highlight: string;
}> = {
  dark: {
    bgPanel: "#10141b",
    textDim: "#838d9e",
    border: "rgba(255,255,255,0.08)",
    borderStrong: "rgba(255,255,255,0.16)",
    bull: "#26a69a",
    bear: "#ef5350",
    highlight: "#e0a64c",
  },
  light: {
    bgPanel: "#ffffff",
    textDim: "#565f70",
    border: "rgba(10,13,18,0.1)",
    borderStrong: "rgba(10,13,18,0.2)",
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
      vertLines: { color: p.border },
      horzLines: { color: p.border },
    },
    rightPriceScale: { borderColor: p.borderStrong },
    timeScale: { borderColor: p.borderStrong, timeVisible: true },
    crosshair: { mode: CrosshairMode.Normal },
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
