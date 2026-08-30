import { describe, expect, it, beforeEach } from "vitest";
import { DRAWING_KINDS } from "../kinds";
import type { DrawingObject } from "../types";
import { useDrawingStore } from "../drawingStore";
import { DrawingPrimitive, type DrawingPrimitiveSpec } from "./primitiveBase";
import { priceRangeSpec } from "./priceRangePrimitive";
import { dateRangeSpec } from "./dateRangePrimitive";
import { T0, oldScale, fakeChart, fakeSeries, recordingCtx, fakeTarget, PANE } from "./testHarness";

function makeBase(type: DrawingObject["type"], points: DrawingObject["points"], overrides: Partial<DrawingObject> = {}): DrawingObject {
  const now = Date.now();
  return {
    id: "d1",
    type,
    points,
    style: { color: "#e7ebf3", lineWidth: 2 },
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

function assertParity<T>(obj: DrawingObject, spec: DrawingPrimitiveSpec<T>) {
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

describe("price range primitive vs. old renderer", () => {
  it("matches for: price up", () =>
    assertParity(makeBase("pricerange", [{ time: T0, price: 1.1 }, { time: T0 + 3600, price: 1.108 }]), priceRangeSpec));
  it("matches for: price down", () =>
    assertParity(makeBase("pricerange", [{ time: T0, price: 1.1 }, { time: T0 + 3600, price: 1.092 }]), priceRangeSpec));
});

describe("date range primitive vs. old renderer", () => {
  it("matches for: multi-day span", () =>
    assertParity(makeBase("daterange", [{ time: T0, price: 1.1 }, { time: T0 + 86400 * 3 + 3600 * 5, price: 1.1 }]), dateRangeSpec));
  it("matches for: sub-day span", () =>
    assertParity(makeBase("daterange", [{ time: T0, price: 1.1 }, { time: T0 + 3600 * 2 + 600, price: 1.1 }]), dateRangeSpec));
  it("matches for: reversed time order", () =>
    assertParity(makeBase("daterange", [{ time: T0 + 7200, price: 1.1 }, { time: T0, price: 1.1 }]), dateRangeSpec));
});

describe("hidden measurement drawings render nothing", () => {
  const cases: { type: DrawingObject["type"]; spec: DrawingPrimitiveSpec<unknown> }[] = [
    { type: "pricerange", spec: priceRangeSpec as DrawingPrimitiveSpec<unknown> },
    { type: "daterange", spec: dateRangeSpec as DrawingPrimitiveSpec<unknown> },
  ];
  for (const { type, spec } of cases) {
    it(type, () => {
      const obj = makeBase(type, [{ time: T0, price: 1.1 }, { time: T0 + 3600, price: 1.1 }], { hidden: true });
      useDrawingStore.setState((s) => ({ byPane: { ...s.byPane, [PANE]: [obj] } }));
      const primitive = new DrawingPrimitive(PANE, obj.id, spec);
      primitive.attached({ chart: fakeChart(), series: fakeSeries(), requestUpdate: () => {} } as never);
      primitive.updateAllViews();
      const { ctx, calls } = recordingCtx();
      primitive.paneViews()[0].renderer()?.draw(fakeTarget(ctx));
      expect(calls).toEqual([]);
    });
  }
});
