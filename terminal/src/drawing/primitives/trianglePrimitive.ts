import type { IChartApi, ISeriesApi } from "lightweight-charts";
import type { DrawingObject } from "../types";
import { DrawingPrimitive, type DrawingPrimitiveSpec } from "./primitiveBase";
import { toPixel, withAlpha, type PixelPoint } from "./drawUtils";

/** Mirrors kinds.ts's `triangle` DrawingKind.render() exactly. Unlike
 * kinds.ts's version, no 2-point partial-preview fallback is needed here -
 * a primitive is only ever attached to an already-finished (3-point)
 * stored object; the in-progress preview always renders via the old
 * canvas path (see DrawingLayer.tsx and Phase 1's report on this
 * boundary). */
export interface TriangleState {
  a: PixelPoint;
  b: PixelPoint;
  c: PixelPoint;
  color: string;
  lineWidth: number;
  fillOpacity: number;
}

export const triangleSpec: DrawingPrimitiveSpec<TriangleState> = {
  computeState(obj: DrawingObject, chart: IChartApi, series: ISeriesApi<"Candlestick">): TriangleState | null {
    if (obj.points.length < 3) return null;
    const [p1, p2, p3] = obj.points;
    const a = toPixel(chart, series, p1);
    const b = toPixel(chart, series, p2);
    const c = toPixel(chart, series, p3);
    if (!a || !b || !c) return null;
    return {
      a,
      b,
      c,
      color: obj.style.color,
      lineWidth: obj.style.lineWidth,
      fillOpacity: typeof obj.props.fillOpacity === "number" ? (obj.props.fillOpacity as number) : 0.12,
    };
  },

  draw(target, state) {
    target.useMediaCoordinateSpace(({ context }) => {
      // Same property-set order as kinds.ts's render() (strokeStyle/
      // lineWidth before fillStyle) - the final pixels are identical
      // either way, but matching order keeps the two implementations
      // trivially diffable against each other.
      context.strokeStyle = state.color;
      context.lineWidth = state.lineWidth;
      context.beginPath();
      context.moveTo(state.a.x, state.a.y);
      context.lineTo(state.b.x, state.b.y);
      context.lineTo(state.c.x, state.c.y);
      context.closePath();
      context.fillStyle = withAlpha(state.color, state.fillOpacity);
      context.fill();
      context.stroke();
    });
  },
};

export function createTrianglePrimitive(paneKey: string, drawingId: string): DrawingPrimitive<TriangleState> {
  return new DrawingPrimitive(paneKey, drawingId, triangleSpec);
}
