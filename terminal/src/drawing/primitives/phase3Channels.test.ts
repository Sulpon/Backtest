import { describe, expect, it, beforeEach } from "vitest";
import { DRAWING_KINDS } from "../kinds";
import type { DrawingObject } from "../types";
import { useDrawingStore } from "../drawingStore";
import { DrawingPrimitive, type DrawingPrimitiveSpec } from "./primitiveBase";
import { parallelChannelSpec, fibChannelSpec } from "./channelPrimitives";
import { fibExtensionSpec } from "./fibExtensionPrimitive";
import { T0, oldScale, fakeChart, fakeSeries, recordingCtx, fakeTarget, PANE } from "./testHarness";

function makeBase(type: DrawingObject["type"], points: DrawingObject["points"], overrides: Partial<DrawingObject> = {}): DrawingObject {
  const now = Date.now();
  return {
    id: "d1",
    type,
    points,
    style: { color: "#d4a24e", lineWidth: 1 },
    props: {},
    locked: false,
    hidden: false,
    zIndex: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const baseline: DrawingObject["points"] = [
  { time: T0, price: 1.1 },
  { time: T0 + 3600, price: 1.105 },
  { time: T0 + 600, price: 1.09 }, // offset point
];

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

describe("parallel channel primitive vs. old renderer", () => {
  it("matches for: baseline + offset point", () => assertParity(makeBase("parallelchannel", baseline), parallelChannelSpec));
  it("matches for: custom fill opacity", () => assertParity(makeBase("parallelchannel", baseline, { props: { fillOpacity: 0.2 } }), parallelChannelSpec));
});

describe("fib channel primitive vs. old renderer", () => {
  it("matches for: baseline + offset point", () => assertParity(makeBase("fibchannel", baseline), fibChannelSpec));
});

describe("fib extension primitive vs. old renderer", () => {
  const swing: DrawingObject["points"] = [
    { time: T0, price: 1.09 }, // A
    { time: T0 + 3600, price: 1.11 }, // B
    { time: T0 + 4800, price: 1.1 }, // C (retracement point)
  ];
  it("matches for: bullish swing", () => assertParity(makeBase("fibextension", swing), fibExtensionSpec));
  it("matches for: bearish swing (reversed A/B)", () =>
    assertParity(
      makeBase("fibextension", [
        { time: T0, price: 1.11 },
        { time: T0 + 3600, price: 1.09 },
        { time: T0 + 4800, price: 1.1 },
      ]),
      fibExtensionSpec
    ));
});

describe("hidden channel/fib-extension drawings render nothing", () => {
  const cases: { type: DrawingObject["type"]; spec: DrawingPrimitiveSpec<unknown> }[] = [
    { type: "parallelchannel", spec: parallelChannelSpec as DrawingPrimitiveSpec<unknown> },
    { type: "fibchannel", spec: fibChannelSpec as DrawingPrimitiveSpec<unknown> },
    { type: "fibextension", spec: fibExtensionSpec as DrawingPrimitiveSpec<unknown> },
  ];
  for (const { type, spec } of cases) {
    it(type, () => {
      const obj = makeBase(type, baseline, { hidden: true });
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
