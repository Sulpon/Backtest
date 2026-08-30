import type { IChartApi, ISeriesApi, Time } from "lightweight-charts";
import type { DrawingObject } from "../types";
import { DrawingPrimitive, type DrawingPrimitiveSpec } from "./primitiveBase";

/** Mirrors kinds.ts's `vline` DrawingKind.render() exactly. */
export interface VLineState {
  x: number;
  color: string;
  lineWidth: number;
}

export const vlineSpec: DrawingPrimitiveSpec<VLineState> = {
  computeState(obj: DrawingObject, chart: IChartApi, _series: ISeriesApi<"Candlestick">): VLineState | null {
    const x = chart.timeScale().timeToCoordinate(obj.points[0].time as Time);
    if (x == null) return null;
    return { x, color: obj.style.color, lineWidth: obj.style.lineWidth };
  },

  draw(target, state) {
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      context.strokeStyle = state.color;
      context.lineWidth = state.lineWidth;
      context.setLineDash([6, 4]);
      context.beginPath();
      context.moveTo(state.x, 0);
      context.lineTo(state.x, mediaSize.height);
      context.stroke();
      context.setLineDash([]);
    });
  },
};

export function createVLinePrimitive(paneKey: string, drawingId: string): DrawingPrimitive<VLineState> {
  return new DrawingPrimitive(paneKey, drawingId, vlineSpec);
}
