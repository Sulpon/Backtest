import type { IChartApi, ISeriesApi } from "lightweight-charts";
import type { DrawingObject } from "../types";
import { DrawingPrimitive, type DrawingPrimitiveSpec } from "./primitiveBase";
import { toPixel, withAlpha, type PixelPoint } from "./drawUtils";
import { FIB_LEVELS } from "../kinds";

/** Shared by parallelchannel and fibchannel - mirrors kinds.ts's private
 * `channelGeometry` exactly. Only ever computed for a finished (3-point)
 * stored object here (see trianglePrimitive.ts's note on why primitives
 * don't need the 2-point partial-preview fallback kinds.ts's version has). */
interface ChannelGeometry {
  a: PixelPoint;
  b: PixelPoint;
  a2: PixelPoint;
  b2: PixelPoint;
}

function channelGeometry(obj: DrawingObject, chart: IChartApi, series: ISeriesApi<"Candlestick">): ChannelGeometry | null {
  if (obj.points.length < 3) return null;
  const [p0, p1, p2] = obj.points;
  const a = toPixel(chart, series, p0);
  const b = toPixel(chart, series, p1);
  const c = toPixel(chart, series, p2);
  if (!a || !b || !c) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const offset = (c.x - a.x) * nx + (c.y - a.y) * ny;
  return { a, b, a2: { x: a.x + nx * offset, y: a.y + ny * offset }, b2: { x: b.x + nx * offset, y: b.y + ny * offset } };
}

export interface ParallelChannelState {
  geo: ChannelGeometry;
  color: string;
  lineWidth: number;
  fillOpacity: number;
}

export const parallelChannelSpec: DrawingPrimitiveSpec<ParallelChannelState> = {
  computeState(obj: DrawingObject, chart: IChartApi, series: ISeriesApi<"Candlestick">): ParallelChannelState | null {
    const geo = channelGeometry(obj, chart, series);
    if (!geo) return null;
    return {
      geo,
      color: obj.style.color,
      lineWidth: obj.style.lineWidth,
      fillOpacity: typeof obj.props.fillOpacity === "number" ? (obj.props.fillOpacity as number) : 0.1,
    };
  },

  draw(target, state) {
    target.useMediaCoordinateSpace(({ context }) => {
      const { a, b, a2, b2 } = state.geo;
      context.strokeStyle = state.color;
      context.lineWidth = state.lineWidth;
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.lineTo(b2.x, b2.y);
      context.lineTo(a2.x, a2.y);
      context.closePath();
      context.fillStyle = withAlpha(state.color, state.fillOpacity);
      context.fill();
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.stroke();
      context.beginPath();
      context.moveTo(a2.x, a2.y);
      context.lineTo(b2.x, b2.y);
      context.stroke();
    });
  },
};

export function createParallelChannelPrimitive(paneKey: string, drawingId: string): DrawingPrimitive<ParallelChannelState> {
  return new DrawingPrimitive(paneKey, drawingId, parallelChannelSpec);
}

export interface FibChannelState {
  geo: ChannelGeometry;
  lineWidth: number;
  color: string;
}

export const fibChannelSpec: DrawingPrimitiveSpec<FibChannelState> = {
  computeState(obj: DrawingObject, chart: IChartApi, series: ISeriesApi<"Candlestick">): FibChannelState | null {
    const geo = channelGeometry(obj, chart, series);
    if (!geo) return null;
    return { geo, lineWidth: obj.style.lineWidth, color: obj.style.color };
  },

  draw(target, state) {
    target.useMediaCoordinateSpace(({ context }) => {
      const { a, b, a2, b2 } = state.geo;
      // Reuses FIB_LEVELS (imported from kinds.ts, the same array
      // fibretracement/fibchannel's old renderer both use) rather than a
      // second copy - matches kinds.ts's own fibchannel render() exactly.
      for (const f of FIB_LEVELS) {
        const isEdge = f === 0 || f === 1;
        const p1 = { x: a.x + (a2.x - a.x) * f, y: a.y + (a2.y - a.y) * f };
        const p2 = { x: b.x + (b2.x - b.x) * f, y: b.y + (b2.y - b.y) * f };
        context.strokeStyle = isEdge ? state.color : "rgba(150,160,180,0.55)";
        context.lineWidth = isEdge ? state.lineWidth : 1;
        if (!isEdge) context.setLineDash([4, 3]);
        context.beginPath();
        context.moveTo(p1.x, p1.y);
        context.lineTo(p2.x, p2.y);
        context.stroke();
        context.setLineDash([]);
      }
    });
  },
};

export function createFibChannelPrimitive(paneKey: string, drawingId: string): DrawingPrimitive<FibChannelState> {
  return new DrawingPrimitive(paneKey, drawingId, fibChannelSpec);
}
