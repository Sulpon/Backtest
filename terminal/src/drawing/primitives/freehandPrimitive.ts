import type { IChartApi, ISeriesApi } from "lightweight-charts";
import type { DrawingObject } from "../types";
import { DrawingPrimitive, type DrawingPrimitiveSpec } from "./primitiveBase";
import { toPixel, type PixelPoint } from "./drawUtils";

/** Mirrors kinds.ts's `freehandKind()` factory (shared by brush/
 * highlighter) exactly, including the alpha param that gives highlighter
 * its translucent look. An arbitrary-length `points` array works exactly
 * the same way here as any other tool's - the primitive's own attach/
 * subscribe machinery (primitiveBase.ts) doesn't care how many points an
 * object has, only whether its store entry changed reference. */
export interface FreehandState {
  points: PixelPoint[];
  color: string;
  lineWidth: number;
  alpha: number;
}

function makeSpec(alpha: number): DrawingPrimitiveSpec<FreehandState> {
  return {
    computeState(obj: DrawingObject, chart: IChartApi, series: ISeriesApi<"Candlestick">): FreehandState | null {
      const points = obj.points.map((p) => toPixel(chart, series, p)).filter((p): p is PixelPoint => p != null);
      if (points.length < 2) return null;
      return { points, color: obj.style.color, lineWidth: obj.style.lineWidth, alpha };
    },

    draw(target, state) {
      target.useMediaCoordinateSpace(({ context }) => {
        context.save();
        context.globalAlpha = state.alpha;
        context.strokeStyle = state.color;
        context.lineWidth = state.lineWidth;
        context.lineJoin = "round";
        context.lineCap = "round";
        context.beginPath();
        context.moveTo(state.points[0].x, state.points[0].y);
        for (let i = 1; i < state.points.length; i++) context.lineTo(state.points[i].x, state.points[i].y);
        context.stroke();
        context.restore();
      });
    },
  };
}

export const brushSpec = makeSpec(1);
export const highlighterSpec = makeSpec(0.35);

export function createFreehandPrimitive(paneKey: string, drawingId: string, type: "brush" | "highlighter"): DrawingPrimitive<FreehandState> {
  return new DrawingPrimitive(paneKey, drawingId, type === "brush" ? brushSpec : highlighterSpec);
}
