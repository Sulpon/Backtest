import type { IChartApi, ISeriesApi } from "lightweight-charts";
import type { DrawingObject } from "../types";
import { DrawingPrimitive, type DrawingPrimitiveSpec } from "./primitiveBase";
import { toPixel, drawArrowhead, type PixelPoint } from "./drawUtils";

/** Mirrors kinds.ts's `arrow` DrawingKind.render() exactly - a plain
 * segment with one arrowhead at the end point, no extend option. */
export interface ArrowState {
  a: PixelPoint;
  b: PixelPoint;
  color: string;
  lineWidth: number;
}

export const arrowSpec: DrawingPrimitiveSpec<ArrowState> = {
  computeState(obj: DrawingObject, chart: IChartApi, series: ISeriesApi<"Candlestick">): ArrowState | null {
    const [p1, p2] = obj.points;
    const a = toPixel(chart, series, p1);
    const b = toPixel(chart, series, p2);
    if (!a || !b) return null;
    return { a, b, color: obj.style.color, lineWidth: obj.style.lineWidth };
  },

  draw(target, state) {
    target.useMediaCoordinateSpace(({ context }) => {
      context.strokeStyle = state.color;
      context.lineWidth = state.lineWidth;
      context.beginPath();
      context.moveTo(state.a.x, state.a.y);
      context.lineTo(state.b.x, state.b.y);
      context.stroke();
      drawArrowhead(context, state.b, state.a, state.color);
    });
  },
};

export function createArrowPrimitive(paneKey: string, drawingId: string): DrawingPrimitive<ArrowState> {
  return new DrawingPrimitive(paneKey, drawingId, arrowSpec);
}
