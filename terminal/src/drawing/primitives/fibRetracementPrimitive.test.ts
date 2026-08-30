import { describe, expect, it, beforeEach } from "vitest";
import { DRAWING_KINDS } from "../kinds";
import type { DrawingObject } from "../types";
import { useDrawingStore } from "../drawingStore";
import { DrawingPrimitive } from "./primitiveBase";
import { fibRetracementSpec } from "./fibRetracementPrimitive";
import { T0, oldScale, fakeChart, fakeSeries, recordingCtx, fakeTarget, PANE } from "./testHarness";

function makeFib(overrides: Partial<DrawingObject> = {}): DrawingObject {
  const now = Date.now();
  return {
    id: "d1",
    type: "fibretracement",
    points: [
      { time: T0, price: 1.11 },
      { time: T0 + 3600, price: 1.095 },
    ],
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

beforeEach(() => {
  useDrawingStore.setState({ byPane: {}, selectedIds: [], history: {} });
});

function assertParity(obj: DrawingObject) {
  const { ctx: oldCtx, calls: oldCalls } = recordingCtx();
  DRAWING_KINDS.fibretracement.render(oldCtx, oldScale(), obj);

  useDrawingStore.setState((s) => ({ byPane: { ...s.byPane, [PANE]: [obj] } }));
  const primitive = new DrawingPrimitive(PANE, obj.id, fibRetracementSpec);
  primitive.attached({ chart: fakeChart(), series: fakeSeries(), requestUpdate: () => {} } as never);
  primitive.updateAllViews();
  const renderer = primitive.paneViews()[0].renderer();
  const { ctx: newCtx, calls: newCalls } = recordingCtx();
  renderer?.draw(fakeTarget(newCtx));

  expect(newCalls).toEqual(oldCalls);
}

describe("fib retracement primitive vs. old renderer", () => {
  it("matches for: high-to-low swing (forward)", () => assertParity(makeFib()));

  it("matches for: low-to-high swing (reversed)", () =>
    assertParity(
      makeFib({
        points: [
          { time: T0, price: 1.095 },
          { time: T0 + 3600, price: 1.11 },
        ],
      })
    ));

  it("matches for: swing spanning many bars", () =>
    assertParity(
      makeFib({
        points: [
          { time: T0, price: 1.2 },
          { time: T0 + 3600 * 200, price: 1.05 },
        ],
      })
    ));

  it("hidden fib retracement draws nothing", () => {
    const obj = makeFib({ hidden: true });
    useDrawingStore.setState((s) => ({ byPane: { ...s.byPane, [PANE]: [obj] } }));
    const primitive = new DrawingPrimitive(PANE, obj.id, fibRetracementSpec);
    primitive.attached({ chart: fakeChart(), series: fakeSeries(), requestUpdate: () => {} } as never);
    primitive.updateAllViews();
    const { ctx, calls } = recordingCtx();
    primitive.paneViews()[0].renderer()?.draw(fakeTarget(ctx));
    expect(calls).toEqual([]);
  });
});
