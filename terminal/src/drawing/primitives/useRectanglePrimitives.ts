import { useEffect } from "react";
import type { IChartApi, ISeriesApi } from "lightweight-charts";
import { useDrawingStore } from "../drawingStore";
import { RectanglePrimitive } from "./rectanglePrimitive";
import { isRectanglePrimitiveEnabled } from "./featureFlag";

/**
 * Attaches/detaches one RectanglePrimitive per rectangle-type DrawingObject
 * in `paneKey`, kept in sync with drawingStore (new rectangle -> attach,
 * deleted rectangle -> detach; a hidden/edited rectangle stays attached and
 * repaints itself via its own subscription - see rectanglePrimitive.ts).
 * No-ops entirely when the feature flag is off, so with the flag off this
 * hook has zero effect on the chart, the series, or drawingStore - the
 * existing DrawingLayer canvas renderer is the only thing drawing
 * rectangles, exactly as before this file existed.
 */
export function useRectanglePrimitives(
  chart: IChartApi | null,
  series: ISeriesApi<"Candlestick"> | null,
  paneKey: string
): void {
  useEffect(() => {
    if (!chart || !series || !isRectanglePrimitiveEnabled()) return;

    const attached = new Map<string, RectanglePrimitive>();

    function sync() {
      const drawings = useDrawingStore.getState().getDrawings(paneKey);
      const liveIds = new Set(drawings.filter((d) => d.type === "rectangle").map((d) => d.id));

      for (const [id, primitive] of attached) {
        if (!liveIds.has(id)) {
          series!.detachPrimitive(primitive);
          attached.delete(id);
        }
      }
      for (const id of liveIds) {
        if (!attached.has(id)) {
          const primitive = new RectanglePrimitive(paneKey, id);
          series!.attachPrimitive(primitive);
          attached.set(id, primitive);
        }
      }
    }

    sync();
    const unsubscribe = useDrawingStore.subscribe(sync);

    return () => {
      unsubscribe();
      for (const primitive of attached.values()) series.detachPrimitive(primitive);
      attached.clear();
    };
  }, [chart, series, paneKey]);
}
