import type { IChartApi, ISeriesApi, Time } from "lightweight-charts";
import type { DrawingObject } from "../types";
import { DrawingPrimitive, type DrawingPrimitiveSpec } from "./primitiveBase";

/** Mirrors kinds.ts's `positionKind()` factory (shared by the `long` and
 * `short` tools) exactly, including its private positionZones() math,
 * duplicated here the same way every other migrated tool duplicates its
 * old renderer's private helpers. */
function positionZones(obj: DrawingObject, type: "long" | "short") {
  const [p1, p2] = obj.points;
  const entry = p1.price;
  const stop = p2.price;
  const rr = obj.meta?.rr ?? 2.45;
  const risk = Math.abs(entry - stop);
  const target = type === "long" ? entry + rr * risk : entry - rr * risk;
  return { entry, stop, target, rr };
}

export interface PositionState {
  x0: number;
  x1: number;
  yEntry: number;
  yStop: number;
  yTarget: number;
  color: string;
  label: string;
}

function makeSpec(type: "long" | "short"): DrawingPrimitiveSpec<PositionState> {
  return {
    computeState(obj: DrawingObject, chart: IChartApi, series: ISeriesApi<"Candlestick">): PositionState | null {
      const [p1, p2] = obj.points;
      const { entry, stop, target, rr } = positionZones(obj, type);
      const timeScale = chart.timeScale();
      const x0 = timeScale.timeToCoordinate(Math.min(p1.time, p2.time) as Time);
      const x1 = timeScale.timeToCoordinate(Math.max(p1.time, p2.time) as Time);
      const yEntry = series.priceToCoordinate(entry);
      const yStop = series.priceToCoordinate(stop);
      const yTarget = series.priceToCoordinate(target);
      if (x0 == null || x1 == null || yEntry == null || yStop == null || yTarget == null) return null;
      return {
        x0,
        x1,
        yEntry,
        yStop,
        yTarget,
        color: obj.style.color,
        label: `${type === "long" ? "LONG" : "SHORT"} ${rr.toFixed(2)}R`,
      };
    },

    draw(target, state) {
      target.useMediaCoordinateSpace(({ context }) => {
        const { x0, x1, yEntry, yStop, yTarget, color, label } = state;

        context.fillStyle = "rgba(239,83,80,0.25)";
        context.fillRect(x0, Math.min(yEntry, yStop), x1 - x0, Math.abs(yEntry - yStop));
        context.strokeStyle = "rgba(239,83,80,0.85)";
        context.lineWidth = 1;
        context.strokeRect(x0, Math.min(yEntry, yStop), x1 - x0, Math.abs(yEntry - yStop));

        context.fillStyle = "rgba(38,166,154,0.25)";
        context.fillRect(x0, Math.min(yEntry, yTarget), x1 - x0, Math.abs(yEntry - yTarget));
        context.strokeStyle = "rgba(38,166,154,0.85)";
        context.strokeRect(x0, Math.min(yEntry, yTarget), x1 - x0, Math.abs(yEntry - yTarget));

        context.strokeStyle = color;
        context.lineWidth = 1;
        context.setLineDash([3, 3]);
        context.beginPath();
        context.moveTo(x0, yEntry);
        context.lineTo(x1, yEntry);
        context.stroke();
        context.setLineDash([]);

        context.fillStyle = color;
        context.font = "10px 'IBM Plex Mono', monospace";
        context.fillText(label, x0 + 4, Math.min(yEntry, yTarget) - 4);
      });
    },
  };
}

export const longSpec = makeSpec("long");
export const shortSpec = makeSpec("short");

export function createPositionPrimitive(paneKey: string, drawingId: string, type: "long" | "short"): DrawingPrimitive<PositionState> {
  return new DrawingPrimitive(paneKey, drawingId, type === "long" ? longSpec : shortSpec);
}
