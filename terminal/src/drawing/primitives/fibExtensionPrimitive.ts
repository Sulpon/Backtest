import type { IChartApi, ISeriesApi } from "lightweight-charts";
import type { DrawingObject } from "../types";
import { DrawingPrimitive, type DrawingPrimitiveSpec } from "./primitiveBase";
import { toPixel } from "./drawUtils";
import { FIB_EXTENSION_LEVELS } from "../kinds";

/** Mirrors kinds.ts's `fibextension` DrawingKind.render() exactly (the
 * finished-object path - see trianglePrimitive.ts's note on why the
 * 2-point preview fallback isn't needed in a primitive). */
export interface FibExtensionLevel {
  f: number;
  isKey: boolean;
  y: number;
}

export interface FibExtensionState {
  x0: number;
  x1: number;
  levels: FibExtensionLevel[];
}

export const fibExtensionSpec: DrawingPrimitiveSpec<FibExtensionState> = {
  computeState(obj: DrawingObject, chart: IChartApi, series: ISeriesApi<"Candlestick">): FibExtensionState | null {
    if (obj.points.length < 3) return null;
    const [pA, pB, pC] = obj.points;
    const a = toPixel(chart, series, pA);
    const b = toPixel(chart, series, pB);
    const c = toPixel(chart, series, pC);
    if (!a || !b || !c) return null;
    const range = pB.price - pA.price;
    const rawX0 = c.x;
    const rawX1 = c.x + (b.x - a.x);
    const levels: FibExtensionLevel[] = [];
    for (const f of FIB_EXTENSION_LEVELS) {
      const price = pC.price + f * range;
      const y = series.priceToCoordinate(price);
      if (y == null) continue;
      levels.push({ f, isKey: f === 1.0 || f === 1.618, y });
    }
    return { x0: Math.min(rawX0, rawX1), x1: Math.max(rawX0, rawX1), levels };
  },

  draw(target, state) {
    target.useMediaCoordinateSpace(({ context }) => {
      const { x0, x1, levels } = state;
      for (const { f, isKey, y } of levels) {
        context.strokeStyle = isKey ? "#d4a24e" : "rgba(150,160,180,0.55)";
        context.lineWidth = isKey ? 2 : 1;
        if (!isKey) context.setLineDash([4, 3]);
        context.beginPath();
        context.moveTo(x0, y);
        context.lineTo(x1, y);
        context.stroke();
        context.setLineDash([]);
        context.fillStyle = isKey ? "#d4a24e" : "rgba(150,160,180,0.8)";
        context.font = "9px 'IBM Plex Mono', monospace";
        context.fillText(`${(f * 100).toFixed(1)}%`, x1 + 4, y + 3);
      }
    });
  },
};

export function createFibExtensionPrimitive(paneKey: string, drawingId: string): DrawingPrimitive<FibExtensionState> {
  return new DrawingPrimitive(paneKey, drawingId, fibExtensionSpec);
}
