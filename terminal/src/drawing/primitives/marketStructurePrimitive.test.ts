import { describe, expect, it, beforeEach } from "vitest";
import { DRAWING_KINDS } from "../kinds";
import type { DrawingObject, DrawingType } from "../types";
import { useDrawingStore } from "../drawingStore";
import { createMarketStructurePrimitive } from "./marketStructurePrimitive";
import { T0, oldScale, fakeChart, fakeSeries, recordingCtx, fakeTarget, PANE } from "./testHarness";

const TYPES: DrawingType[] = ["bosbull", "bosbear", "chochbull", "chochbear"];

function makeMarker(type: DrawingType, overrides: Partial<DrawingObject> = {}): DrawingObject {
  const now = Date.now();
  return {
    id: "d1",
    type,
    points: [
      { time: T0, price: 1.1 },
      { time: T0 + 3600, price: 1.108 },
    ],
    style: { color: type.startsWith("bos") ? "#42a5f5" : "#e0a64c", lineWidth: 2 },
    props: {},
    locked: false,
    hidden: false,
    zIndex: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  useDrawingStore.setState({ byPane: {}, selectedIds: [], history: {} });
});

function assertParity(obj: DrawingObject) {
  const { ctx: oldCtx, calls: oldCalls } = recordingCtx();
  DRAWING_KINDS[obj.type].render(oldCtx, oldScale(), obj);

  useDrawingStore.setState((s) => ({ byPane: { ...s.byPane, [PANE]: [obj] } }));
  const primitive = createMarketStructurePrimitive(PANE, obj.id, obj.type);
  primitive.attached({ chart: fakeChart(), series: fakeSeries(), requestUpdate: () => {} } as never);
  primitive.updateAllViews();
  const renderer = primitive.paneViews()[0].renderer();
  const { ctx: newCtx, calls: newCalls } = recordingCtx();
  renderer?.draw(fakeTarget(newCtx));

  expect(newCalls).toEqual(oldCalls);
}

describe("market-structure marker primitives vs. old renderer", () => {
  for (const type of TYPES) {
    it(`${type}: matches for forward points`, () => assertParity(makeMarker(type)));

    it(`${type}: matches for reversed points`, () =>
      assertParity(
        makeMarker(type, {
          points: [
            { time: T0 + 3600, price: 1.108 },
            { time: T0, price: 1.1 },
          ],
        })
      ));

    it(`${type}: matches with a user-recolored style`, () => assertParity(makeMarker(type, { style: { color: "#ff00ff", lineWidth: 3 } })));

    it(`${type}: hidden marker draws nothing`, () => {
      const obj = makeMarker(type, { hidden: true });
      useDrawingStore.setState((s) => ({ byPane: { ...s.byPane, [PANE]: [obj] } }));
      const primitive = createMarketStructurePrimitive(PANE, obj.id, type);
      primitive.attached({ chart: fakeChart(), series: fakeSeries(), requestUpdate: () => {} } as never);
      primitive.updateAllViews();
      const { ctx, calls } = recordingCtx();
      primitive.paneViews()[0].renderer()?.draw(fakeTarget(ctx));
      expect(calls).toEqual([]);
    });
  }

  it("createMarketStructurePrimitive throws for a non-market-structure type", () => {
    expect(() => createMarketStructurePrimitive(PANE, "d1", "trendline")).toThrow();
  });
});
