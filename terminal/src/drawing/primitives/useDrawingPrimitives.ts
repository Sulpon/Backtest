import { useEffect } from "react";
import type { IChartApi, ISeriesApi, ISeriesPrimitive, Time } from "lightweight-charts";
import type { DrawingType } from "../types";
import { useDrawingStore } from "../drawingStore";
import { isDrawingPrimitivesEnabled } from "./featureFlag";
import { createTrendlinePrimitive } from "./trendlinePrimitive";
import { createRayPrimitive } from "./rayPrimitive";
import { createHLinePrimitive } from "./hlinePrimitive";
import { createVLinePrimitive } from "./vlinePrimitive";
import { createFibRetracementPrimitive } from "./fibRetracementPrimitive";
import { createPositionPrimitive } from "./positionPrimitive";
import { createMarketStructurePrimitive } from "./marketStructurePrimitive";
import { createTextPrimitive } from "./textPrimitive";
import { createArrowPrimitive } from "./arrowPrimitive";
import { createCirclePrimitive } from "./circlePrimitive";
import { createEllipsePrimitive } from "./ellipsePrimitive";
import { createTrianglePrimitive } from "./trianglePrimitive";
import { createParallelChannelPrimitive, createFibChannelPrimitive } from "./channelPrimitives";
import { createFibExtensionPrimitive } from "./fibExtensionPrimitive";
import { createPriceRangePrimitive } from "./priceRangePrimitive";
import { createDateRangePrimitive } from "./dateRangePrimitive";
import { createFreehandPrimitive } from "./freehandPrimitive";

type Factory = (paneKey: string, id: string) => ISeriesPrimitive<Time>;

/** Every live drawing tool covered by the Phase 2 + Phase 3 migrations,
 * except rectangle (which keeps its own Phase 1 hook -
 * useRectanglePrimitives.ts - and its own flag). A type with no entry here
 * (any not-yet-live tool from toolDefinitions.ts) is simply never touched
 * by this hook and keeps rendering through the old DrawingLayer canvas
 * path unconditionally. */
const FACTORIES: Partial<Record<DrawingType, Factory>> = {
  trendline: createTrendlinePrimitive,
  ray: createRayPrimitive,
  hline: createHLinePrimitive,
  vline: createVLinePrimitive,
  fibretracement: createFibRetracementPrimitive,
  long: (paneKey, id) => createPositionPrimitive(paneKey, id, "long"),
  short: (paneKey, id) => createPositionPrimitive(paneKey, id, "short"),
  bosbull: (paneKey, id) => createMarketStructurePrimitive(paneKey, id, "bosbull"),
  bosbear: (paneKey, id) => createMarketStructurePrimitive(paneKey, id, "bosbear"),
  chochbull: (paneKey, id) => createMarketStructurePrimitive(paneKey, id, "chochbull"),
  chochbear: (paneKey, id) => createMarketStructurePrimitive(paneKey, id, "chochbear"),
  // Phase 3 - brand-new tools, same flag (isDrawingPrimitivesEnabled), no
  // separate toggle: they ship OFF by default same as everything else here,
  // rendering via kinds.ts's canvas path (the "old" renderer, in this case
  // simply the only renderer that predates this hook) until the flag is on.
  text: createTextPrimitive,
  arrow: createArrowPrimitive,
  circle: createCirclePrimitive,
  ellipse: createEllipsePrimitive,
  triangle: createTrianglePrimitive,
  parallelchannel: createParallelChannelPrimitive,
  fibchannel: createFibChannelPrimitive,
  fibextension: createFibExtensionPrimitive,
  pricerange: createPriceRangePrimitive,
  daterange: createDateRangePrimitive,
  brush: (paneKey, id) => createFreehandPrimitive(paneKey, id, "brush"),
  highlighter: (paneKey, id) => createFreehandPrimitive(paneKey, id, "highlighter"),
};

/** The types this hook (and the DrawingLayer render-loop skip condition)
 * treats as primitive-backed once the flag is on. Exported so DrawingLayer
 * doesn't need its own separate copy of this list. */
export const PRIMITIVE_MIGRATED_TYPES: ReadonlySet<DrawingType> = new Set(Object.keys(FACTORIES) as DrawingType[]);

/**
 * Same attach/detach-on-store-change pattern as useRectanglePrimitives.ts,
 * generalized across every type in FACTORIES. No-ops entirely when the
 * flag is off.
 */
export function useDrawingPrimitives(
  chart: IChartApi | null,
  series: ISeriesApi<"Candlestick"> | null,
  paneKey: string
): void {
  useEffect(() => {
    if (!chart || !series || !isDrawingPrimitivesEnabled()) return;

    const attached = new Map<string, ISeriesPrimitive<Time>>();

    function sync() {
      const drawings = useDrawingStore.getState().getDrawings(paneKey);
      const live = drawings.filter((d) => FACTORIES[d.type]);
      const liveIds = new Set(live.map((d) => d.id));

      for (const [id, primitive] of attached) {
        if (!liveIds.has(id)) {
          series!.detachPrimitive(primitive);
          attached.delete(id);
        }
      }
      for (const d of live) {
        if (!attached.has(d.id)) {
          const factory = FACTORIES[d.type]!;
          const primitive = factory(paneKey, d.id);
          series!.attachPrimitive(primitive);
          attached.set(d.id, primitive);
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
