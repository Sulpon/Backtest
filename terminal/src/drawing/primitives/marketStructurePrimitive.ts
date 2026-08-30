import type { IChartApi, ISeriesApi } from "lightweight-charts";
import type { DrawingObject, DrawingType } from "../types";
import { DrawingPrimitive, type DrawingPrimitiveSpec } from "./primitiveBase";
import { toPixel, type PixelPoint } from "./drawUtils";

/** Mirrors kinds.ts's `marketStructureKind()` factory (shared by
 * bosbull/bosbear/chochbull/chochbear) exactly, including that
 * `ctx.textBaseline` is set to "alphabetic" before the label draw and
 * deliberately never reset afterward, same as the old renderer - and that
 * the display label ("BOS ↑", "CHoCH ↓", ...) is fixed per tool type, not
 * derived from the object's own style. */
export interface MarketStructureState {
  a: PixelPoint;
  b: PixelPoint;
  color: string;
  lineWidth: number;
  displayLabel: string;
}

const DISPLAY_LABELS: Record<string, string> = {
  bosbull: "BOS ↑",
  bosbear: "BOS ↓",
  chochbull: "CHoCH ↑",
  chochbear: "CHoCH ↓",
};

function makeSpec(displayLabel: string): DrawingPrimitiveSpec<MarketStructureState> {
  return {
    computeState(obj: DrawingObject, chart: IChartApi, series: ISeriesApi<"Candlestick">): MarketStructureState | null {
      const [p1, p2] = obj.points;
      const a = toPixel(chart, series, p1);
      const b = toPixel(chart, series, p2);
      if (!a || !b) return null;
      return { a, b, color: obj.style.color, lineWidth: obj.style.lineWidth, displayLabel };
    },

    draw(target, state) {
      target.useMediaCoordinateSpace(({ context }) => {
        const { a, b, color, lineWidth } = state;
        context.strokeStyle = color;
        context.lineWidth = lineWidth;
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.stroke();
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        context.fillStyle = color;
        context.font = "bold 11px -apple-system, 'Segoe UI', Arial, sans-serif";
        context.textAlign = "center";
        context.textBaseline = "alphabetic";
        context.fillText(state.displayLabel, midX, midY - 8);
        context.textAlign = "left";
      });
    },
  };
}

const SPECS: Record<string, DrawingPrimitiveSpec<MarketStructureState>> = {
  bosbull: makeSpec(DISPLAY_LABELS.bosbull),
  bosbear: makeSpec(DISPLAY_LABELS.bosbear),
  chochbull: makeSpec(DISPLAY_LABELS.chochbull),
  chochbear: makeSpec(DISPLAY_LABELS.chochbear),
};

export function createMarketStructurePrimitive(
  paneKey: string,
  drawingId: string,
  type: DrawingType
): DrawingPrimitive<MarketStructureState> {
  const spec = SPECS[type];
  if (!spec) throw new Error(`Not a market-structure drawing type: ${type}`);
  return new DrawingPrimitive(paneKey, drawingId, spec);
}
