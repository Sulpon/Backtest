import type { IChartApi, ISeriesApi, Time } from "lightweight-charts";
import type { DrawingObject } from "../types";
import { DrawingPrimitive, type DrawingPrimitiveSpec } from "./primitiveBase";
import { withAlpha } from "./drawUtils";

/** Mirrors kinds.ts's `daterange` DrawingKind.render() exactly. */
export interface DateRangeState {
  x0: number;
  x1: number;
  color: string;
  lineWidth: number;
  fillOpacity: number;
  label: string;
}

export const dateRangeSpec: DrawingPrimitiveSpec<DateRangeState> = {
  computeState(obj: DrawingObject, chart: IChartApi, _series: ISeriesApi<"Candlestick">): DateRangeState | null {
    const [p1, p2] = obj.points;
    const timeScale = chart.timeScale();
    const x0raw = timeScale.timeToCoordinate(p1.time as Time);
    const x1raw = timeScale.timeToCoordinate(p2.time as Time);
    if (x0raw == null || x1raw == null) return null;
    const seconds = Math.abs(p2.time - p1.time);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const label = days > 0 ? `${days}d ${hours}h` : `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
    return {
      x0: Math.min(x0raw, x1raw),
      x1: Math.max(x0raw, x1raw),
      color: obj.style.color,
      lineWidth: obj.style.lineWidth,
      fillOpacity: typeof obj.props.fillOpacity === "number" ? (obj.props.fillOpacity as number) : 0.08,
      label,
    };
  },

  draw(target, state) {
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      const { x0, x1, color, lineWidth, fillOpacity, label } = state;
      context.fillStyle = withAlpha(color, fillOpacity);
      context.fillRect(x0, 0, x1 - x0, mediaSize.height);
      context.strokeStyle = color;
      context.lineWidth = lineWidth;
      context.setLineDash([6, 4]);
      context.beginPath();
      context.moveTo(x0, 0);
      context.lineTo(x0, mediaSize.height);
      context.stroke();
      context.beginPath();
      context.moveTo(x1, 0);
      context.lineTo(x1, mediaSize.height);
      context.stroke();
      context.setLineDash([]);
      context.fillStyle = color;
      context.font = "10px 'IBM Plex Mono', monospace";
      context.textAlign = "center";
      context.fillText(label, (x0 + x1) / 2, 14);
      context.textAlign = "left";
    });
  },
};

export function createDateRangePrimitive(paneKey: string, drawingId: string): DrawingPrimitive<DateRangeState> {
  return new DrawingPrimitive(paneKey, drawingId, dateRangeSpec);
}
