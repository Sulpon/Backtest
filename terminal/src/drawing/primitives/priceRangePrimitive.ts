import type { IChartApi, ISeriesApi } from "lightweight-charts";
import type { DrawingObject } from "../types";
import { DrawingPrimitive, type DrawingPrimitiveSpec } from "./primitiveBase";
import { toPixel, withAlpha } from "./drawUtils";

/** Mirrors kinds.ts's `pricerange` DrawingKind.render() exactly. */
export interface PriceRangeState {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  baseColor: string;
  lineWidth: number;
  fillOpacity: number;
  label: string;
}

export const priceRangeSpec: DrawingPrimitiveSpec<PriceRangeState> = {
  computeState(obj: DrawingObject, chart: IChartApi, series: ISeriesApi<"Candlestick">): PriceRangeState | null {
    const [p1, p2] = obj.points;
    const a = toPixel(chart, series, p1);
    const b = toPixel(chart, series, p2);
    if (!a || !b) return null;
    const up = p2.price >= p1.price;
    const delta = p2.price - p1.price;
    const pct = p1.price !== 0 ? (delta / p1.price) * 100 : 0;
    return {
      x0: Math.min(a.x, b.x),
      x1: Math.max(a.x, b.x),
      y0: Math.min(a.y, b.y),
      y1: Math.max(a.y, b.y),
      baseColor: up ? "#26a69a" : "#ef5350",
      lineWidth: obj.style.lineWidth,
      fillOpacity: typeof obj.props.fillOpacity === "number" ? (obj.props.fillOpacity as number) : 0.14,
      label: `${delta >= 0 ? "+" : ""}${delta.toFixed(5)}  (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`,
    };
  },

  draw(target, state) {
    target.useMediaCoordinateSpace(({ context }) => {
      const { x0, x1, y0, y1, baseColor, lineWidth, fillOpacity, label } = state;
      context.fillStyle = withAlpha(baseColor, fillOpacity);
      context.fillRect(x0, y0, x1 - x0, y1 - y0);
      context.strokeStyle = baseColor;
      context.lineWidth = lineWidth;
      context.strokeRect(x0, y0, x1 - x0, y1 - y0);
      context.fillStyle = baseColor;
      context.font = "10px 'IBM Plex Mono', monospace";
      context.textAlign = "center";
      context.fillText(label, (x0 + x1) / 2, y0 - 6);
      context.textAlign = "left";
    });
  },
};

export function createPriceRangePrimitive(paneKey: string, drawingId: string): DrawingPrimitive<PriceRangeState> {
  return new DrawingPrimitive(paneKey, drawingId, priceRangeSpec);
}
