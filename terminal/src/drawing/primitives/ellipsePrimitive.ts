import type { IChartApi, ISeriesApi } from "lightweight-charts";
import type { DrawingObject } from "../types";
import { DrawingPrimitive, type DrawingPrimitiveSpec } from "./primitiveBase";
import { toPixel, withAlpha } from "./drawUtils";

/** Mirrors kinds.ts's `ellipse` DrawingKind.render() exactly - bounding box
 * from the two stored corner points, same model as rectangle. */
export interface EllipseState {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  color: string;
  lineWidth: number;
  fillOpacity: number;
}

export const ellipseSpec: DrawingPrimitiveSpec<EllipseState> = {
  computeState(obj: DrawingObject, chart: IChartApi, series: ISeriesApi<"Candlestick">): EllipseState | null {
    const [p1, p2] = obj.points;
    const a = toPixel(chart, series, p1);
    const b = toPixel(chart, series, p2);
    if (!a || !b) return null;
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    return {
      cx: (x0 + x1) / 2,
      cy: (y0 + y1) / 2,
      rx: Math.max((x1 - x0) / 2, 0.01),
      ry: Math.max((y1 - y0) / 2, 0.01),
      color: obj.style.color,
      lineWidth: obj.style.lineWidth,
      fillOpacity: typeof obj.props.fillOpacity === "number" ? (obj.props.fillOpacity as number) : 0.12,
    };
  },

  draw(target, state) {
    target.useMediaCoordinateSpace(({ context }) => {
      context.beginPath();
      context.ellipse(state.cx, state.cy, state.rx, state.ry, 0, 0, Math.PI * 2);
      context.fillStyle = withAlpha(state.color, state.fillOpacity);
      context.fill();
      context.strokeStyle = state.color;
      context.lineWidth = state.lineWidth;
      context.stroke();
    });
  },
};

export function createEllipsePrimitive(paneKey: string, drawingId: string): DrawingPrimitive<EllipseState> {
  return new DrawingPrimitive(paneKey, drawingId, ellipseSpec);
}
