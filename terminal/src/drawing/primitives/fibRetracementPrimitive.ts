import type { IChartApi, ISeriesApi } from "lightweight-charts";
import type { DrawingObject } from "../types";
import { DrawingPrimitive, type DrawingPrimitiveSpec } from "./primitiveBase";
import { toPixel } from "./drawUtils";
import { FIB_LEVELS } from "../kinds";

/** Mirrors kinds.ts's `fibretracement` DrawingKind.render() exactly. Reuses
 * the already-exported FIB_LEVELS constant (kinds.ts exports it
 * specifically so nothing has to duplicate the level list - see that
 * file's own comment on it) rather than duplicating the array; everything
 * else about the old renderer is duplicated the same way every other
 * migrated tool does it. No extend-left/right handling here because the
 * old renderer doesn't support it for this tool either. */
export interface FibLevelLine {
  f: number;
  isOte: boolean;
  y: number;
}

export interface FibRetracementState {
  x0: number;
  x1: number;
  yTop: number;
  yBottom: number;
  levels: FibLevelLine[];
}

export const fibRetracementSpec: DrawingPrimitiveSpec<FibRetracementState> = {
  computeState(obj: DrawingObject, chart: IChartApi, series: ISeriesApi<"Candlestick">): FibRetracementState | null {
    const [p1, p2] = obj.points;
    const a = toPixel(chart, series, p1);
    const b = toPixel(chart, series, p2);
    if (!a || !b) return null;
    const hi = Math.max(p1.price, p2.price);
    const lo = Math.min(p1.price, p2.price);
    const range = hi - lo;
    const levels: FibLevelLine[] = [];
    for (const f of FIB_LEVELS) {
      const price = hi - f * range;
      const y = series.priceToCoordinate(price);
      if (y == null) continue;
      levels.push({ f, isOte: f === 0.71, y });
    }
    return {
      x0: Math.min(a.x, b.x),
      x1: Math.max(a.x, b.x),
      yTop: Math.min(a.y, b.y),
      yBottom: Math.max(a.y, b.y),
      levels,
    };
  },

  draw(target, state) {
    target.useMediaCoordinateSpace(({ context }) => {
      const { x0, x1, yTop, yBottom, levels } = state;
      context.fillStyle = "rgba(212,162,78,0.06)";
      context.fillRect(x0, yTop, x1 - x0, yBottom - yTop);
      for (const { f, isOte, y } of levels) {
        context.strokeStyle = isOte ? "#d4a24e" : "rgba(150,160,180,0.55)";
        context.lineWidth = isOte ? 2 : 1;
        if (!isOte) context.setLineDash([4, 3]);
        context.beginPath();
        context.moveTo(x0, y);
        context.lineTo(x1, y);
        context.stroke();
        context.setLineDash([]);
        context.fillStyle = isOte ? "#d4a24e" : "rgba(150,160,180,0.8)";
        context.font = "9px 'IBM Plex Mono', monospace";
        context.fillText(`${(f * 100).toFixed(1)}%`, x1 + 4, y + 3);
      }
    });
  },
};

export function createFibRetracementPrimitive(paneKey: string, drawingId: string): DrawingPrimitive<FibRetracementState> {
  return new DrawingPrimitive(paneKey, drawingId, fibRetracementSpec);
}
