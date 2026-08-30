import type { IChartApi, ISeriesApi } from "lightweight-charts";
import type { DrawingObject } from "../types";
import { DrawingPrimitive, type DrawingPrimitiveSpec } from "./primitiveBase";
import { toPixel, rayEnd, type PixelPoint } from "./drawUtils";

/** Mirrors kinds.ts's `ray` DrawingKind.render() exactly. */
export interface RayState {
  a: PixelPoint;
  b: PixelPoint;
  color: string;
  lineWidth: number;
}

export const raySpec: DrawingPrimitiveSpec<RayState> = {
  computeState(obj: DrawingObject, chart: IChartApi, series: ISeriesApi<"Candlestick">): RayState | null {
    const [p1, p2] = obj.points;
    const a = toPixel(chart, series, p1);
    const b = toPixel(chart, series, p2);
    if (!a || !b) return null;
    return { a, b, color: obj.style.color, lineWidth: obj.style.lineWidth };
  },

  draw(target, state) {
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      const end = rayEnd(state.a, state.b, mediaSize.width, mediaSize.height);
      context.strokeStyle = state.color;
      context.lineWidth = state.lineWidth;
      context.beginPath();
      context.moveTo(state.a.x, state.a.y);
      context.lineTo(end.x, end.y);
      context.stroke();
    });
  },
};

export function createRayPrimitive(paneKey: string, drawingId: string): DrawingPrimitive<RayState> {
  return new DrawingPrimitive(paneKey, drawingId, raySpec);
}
