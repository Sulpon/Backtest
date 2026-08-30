import type { IChartApi, ISeriesApi } from "lightweight-charts";
import type { DrawingObject } from "../types";
import { DrawingPrimitive, type DrawingPrimitiveSpec } from "./primitiveBase";
import { toPixel, type PixelPoint } from "./drawUtils";

/** Mirrors kinds.ts's `text` DrawingKind.render() exactly. Editing the text
 * itself is a DOM overlay (see TextEditOverlay.tsx), not part of this
 * primitive - the primitive only ever draws whatever `props.text` already
 * holds, same separation StyleInspector already has from rendering. */
export interface TextState {
  p: PixelPoint;
  content: string;
  fontSize: number;
  color: string;
}

export const textSpec: DrawingPrimitiveSpec<TextState> = {
  computeState(obj: DrawingObject, chart: IChartApi, series: ISeriesApi<"Candlestick">): TextState | null {
    const p = toPixel(chart, series, obj.points[0]);
    if (!p) return null;
    const content = typeof obj.props.text === "string" ? obj.props.text : "";
    if (!content) return null;
    return {
      p,
      content,
      fontSize: typeof obj.props.fontSize === "number" ? (obj.props.fontSize as number) : 13,
      color: obj.style.color,
    };
  },

  draw(target, state) {
    target.useMediaCoordinateSpace(({ context }) => {
      context.fillStyle = state.color;
      context.font = `${state.fontSize}px -apple-system, 'Segoe UI', Arial, sans-serif`;
      context.textAlign = "left";
      context.textBaseline = "top";
      context.fillText(state.content, state.p.x, state.p.y);
      context.textBaseline = "alphabetic";
    });
  },
};

export function createTextPrimitive(paneKey: string, drawingId: string): DrawingPrimitive<TextState> {
  return new DrawingPrimitive(paneKey, drawingId, textSpec);
}
