import { describe, expect, it, beforeEach } from "vitest";
import { DRAWING_KINDS } from "../kinds";
import type { DrawingObject } from "../types";
import { useDrawingStore } from "../drawingStore";
import { DrawingPrimitive } from "./primitiveBase";
import { longSpec, shortSpec } from "./positionPrimitive";
import { T0, oldScale, fakeChart, fakeSeries, recordingCtx, fakeTarget, PANE } from "./testHarness";

function makePosition(type: "long" | "short", overrides: Partial<DrawingObject> = {}): DrawingObject {
  const now = Date.now();
  return {
    id: "d1",
    type,
    points: [
      { time: T0, price: 1.1 }, // entry
      { time: T0 + 3600, price: 1.095 }, // stop
    ],
    style: { color: "#e7ebf3", lineWidth: 2 },
    props: {},
    meta: { rr: 2.45 },
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
  const spec = obj.type === "long" ? longSpec : shortSpec;
  const { ctx: oldCtx, calls: oldCalls } = recordingCtx();
  DRAWING_KINDS[obj.type].render(oldCtx, oldScale(), obj);

  useDrawingStore.setState((s) => ({ byPane: { ...s.byPane, [PANE]: [obj] } }));
  const primitive = new DrawingPrimitive(PANE, obj.id, spec);
  primitive.attached({ chart: fakeChart(), series: fakeSeries(), requestUpdate: () => {} } as never);
  primitive.updateAllViews();
  const renderer = primitive.paneViews()[0].renderer();
  const { ctx: newCtx, calls: newCalls } = recordingCtx();
  renderer?.draw(fakeTarget(newCtx));

  expect(newCalls).toEqual(oldCalls);
}

describe("long position primitive vs. old renderer", () => {
  it("matches for: default R:R", () => assertParity(makePosition("long")));
  it("matches for: custom R:R", () => assertParity(makePosition("long", { meta: { rr: 4 } })));
  it("matches for: no meta.rr (falls back to 2.45 default)", () => assertParity(makePosition("long", { meta: undefined })));
  it("matches for: reversed time order (stop point placed before entry point)", () =>
    assertParity(
      makePosition("long", {
        points: [
          { time: T0 + 3600, price: 1.095 },
          { time: T0, price: 1.1 },
        ],
      })
    ));
});

describe("short position primitive vs. old renderer", () => {
  it("matches for: default R:R", () => assertParity(makePosition("short", { points: [{ time: T0, price: 1.095 }, { time: T0 + 3600, price: 1.1 }] })));
  it("matches for: custom R:R", () => assertParity(makePosition("short", { meta: { rr: 1.5 } })));
});

describe("hidden position drawings render nothing", () => {
  for (const type of ["long", "short"] as const) {
    it(type, () => {
      const obj = makePosition(type, { hidden: true });
      useDrawingStore.setState((s) => ({ byPane: { ...s.byPane, [PANE]: [obj] } }));
      const primitive = new DrawingPrimitive(PANE, obj.id, type === "long" ? longSpec : shortSpec);
      primitive.attached({ chart: fakeChart(), series: fakeSeries(), requestUpdate: () => {} } as never);
      primitive.updateAllViews();
      const { ctx, calls } = recordingCtx();
      primitive.paneViews()[0].renderer()?.draw(fakeTarget(ctx));
      expect(calls).toEqual([]);
    });
  }
});
