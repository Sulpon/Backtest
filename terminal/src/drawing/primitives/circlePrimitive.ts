import type { IChartApi, ISeriesApi } from "lightweight-charts";
import type { DrawingObject } from "../types";
import { DrawingPrimitive, type DrawingPrimitiveSpec } from "./primitiveBase";
import { toPixel, withAlpha, type PixelPoint } from "./drawUtils";

/** Mirrors kinds.ts's `circle` DrawingKind.render() exactly - center+edge
 * model, radius is the pixel distance between the two stored points. */
export interface CircleState {
  c: PixelPoint;
  r: number;
  color: string;
  lineWidth: number;
  fillOpacity: number;
}

export const circleSpec: DrawingPrimitiveSpec<CircleState> = {
  computeState(obj: DrawingObject, chart: IChartApi, series: ISeriesApi<"Candlestick">): CircleState | null {
    const [p1, p2] = obj.points;
    const c = toPixel(chart, series, p1);
    const e = toPixel(chart, series, p2);
    if (!c || !e) return null;
    return {
      c,
      r: Math.hypot(e.x - c.x, e.y - c.y),
      color: obj.style.color,
      lineWidth: obj.style.lineWidth,
      fillOpacity: typeof obj.props.fillOpacity === "number" ? (obj.props.fillOpacity as number) : 0.1,
    };
  },

  draw(target, state) {
    target.useMediaCoordinateSpace(({ context }) => {
      context.beginPath();
      context.arc(state.c.x, state.c.y, state.r, 0, Math.PI * 2);
      context.fillStyle = withAlpha(state.color, state.fillOpacity);
      context.fill();
      context.strokeStyle = state.color;
      context.lineWidth = state.lineWidth;
      context.stroke();
    });
  },
};

export function createCirclePrimitive(paneKey: string, drawingId: string): DrawingPrimitive<CircleState> {
  return new DrawingPrimitive(paneKey, drawingId, circleSpec);
}
