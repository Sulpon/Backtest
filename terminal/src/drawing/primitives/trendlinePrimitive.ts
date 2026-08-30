import type { IChartApi, ISeriesApi } from "lightweight-charts";
import type { DrawingObject } from "../types";
import { DrawingPrimitive, type DrawingPrimitiveSpec } from "./primitiveBase";
import { toPixel, extendToEdges, drawArrowhead, type PixelPoint } from "./drawUtils";

/** Mirrors kinds.ts's `trendline` DrawingKind.render() exactly, including
 * the detail that arrowheads are drawn from the RAW (un-extended) points,
 * not the edge-extended ones. */
export interface TrendlineState {
  rawA: PixelPoint;
  rawB: PixelPoint;
  color: string;
  lineWidth: number;
  extendLeft: boolean;
  extendRight: boolean;
  arrowStart: boolean;
  arrowEnd: boolean;
}

export const trendlineSpec: DrawingPrimitiveSpec<TrendlineState> = {
  computeState(obj: DrawingObject, chart: IChartApi, series: ISeriesApi<"Candlestick">): TrendlineState | null {
    const [p1, p2] = obj.points;
    const rawA = toPixel(chart, series, p1);
    const rawB = toPixel(chart, series, p2);
    if (!rawA || !rawB) return null;
    return {
      rawA,
      rawB,
      color: obj.style.color,
      lineWidth: obj.style.lineWidth,
      extendLeft: !!obj.props.extendLeft,
      extendRight: !!obj.props.extendRight,
      arrowStart: !!obj.props.arrowStart,
      arrowEnd: !!obj.props.arrowEnd,
    };
  },

  draw(target, state) {
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      const { a, b } = extendToEdges(state.rawA, state.rawB, mediaSize.width, state.extendLeft, state.extendRight);
      context.strokeStyle = state.color;
      context.lineWidth = state.lineWidth;
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.stroke();
      if (state.arrowStart) drawArrowhead(context, state.rawA, state.rawB, state.color);
      if (state.arrowEnd) drawArrowhead(context, state.rawB, state.rawA, state.color);
    });
  },
};

export function createTrendlinePrimitive(paneKey: string, drawingId: string): DrawingPrimitive<TrendlineState> {
  return new DrawingPrimitive(paneKey, drawingId, trendlineSpec);
}
