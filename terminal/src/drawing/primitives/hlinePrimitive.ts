import type { IChartApi, ISeriesApi } from "lightweight-charts";
import type { DrawingObject } from "../types";
import { DrawingPrimitive, type DrawingPrimitiveSpec } from "./primitiveBase";

/** Mirrors kinds.ts's `hline` DrawingKind.render() exactly, including the
 * price-label text (right-aligned, 5 decimals, 10px IBM Plex Mono). */
export interface HLineState {
  y: number;
  price: number;
  color: string;
  lineWidth: number;
}

export const hlineSpec: DrawingPrimitiveSpec<HLineState> = {
  computeState(obj: DrawingObject, _chart: IChartApi, series: ISeriesApi<"Candlestick">): HLineState | null {
    const y = series.priceToCoordinate(obj.points[0].price);
    if (y == null) return null;
    return { y, price: obj.points[0].price, color: obj.style.color, lineWidth: obj.style.lineWidth };
  },

  draw(target, state) {
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      context.strokeStyle = state.color;
      context.lineWidth = state.lineWidth;
      context.setLineDash([6, 4]);
      context.beginPath();
      context.moveTo(0, state.y);
      context.lineTo(mediaSize.width, state.y);
      context.stroke();
      context.setLineDash([]);
      context.fillStyle = state.color;
      context.font = "10px 'IBM Plex Mono', monospace";
      context.textAlign = "right";
      context.fillText(state.price.toFixed(5), mediaSize.width - 6, state.y - 4);
      context.textAlign = "left";
    });
  },
};

export function createHLinePrimitive(paneKey: string, drawingId: string): DrawingPrimitive<HLineState> {
  return new DrawingPrimitive(paneKey, drawingId, hlineSpec);
}
