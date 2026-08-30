import { describe, expect, it, beforeEach } from "vitest";
import { useDrawingStore } from "../drawingStore";
import type { DrawingObject } from "../types";
import { DrawingPrimitive, type DrawingPrimitiveSpec } from "./primitiveBase";
import { fakeChart, fakeSeries, PANE } from "./testHarness";

/**
 * Lifecycle contract for the SHARED DrawingPrimitive base class used by
 * every Phase 2 tool (trendline/ray/hline/vline/fib/long/short/bosbull/
 * bosbear/chochbull/chochbear). Tested once here, at the base-class level,
 * rather than duplicated per tool - the lifecycle code (attach/detach,
 * selective requestUpdate, store-read-only access) is identical for all of
 * them by construction, so this is the correct place to verify it. Each
 * tool's own test file only needs to cover its tool-specific rendering
 * math (see linePrimitives.test.ts etc.), not this.
 *
 * Uses a trivial dummy spec (computeState returns a draw counter, draw()
 * is a no-op) - deliberately NOT one of the real tool specs, so this file
 * stays a pure test of the base class's own contract.
 */

function makeObj(overrides: Partial<DrawingObject> = {}): DrawingObject {
  const now = Date.now();
  return {
    id: "d1",
    type: "trendline",
    points: [
      { time: 1, price: 1 },
      { time: 2, price: 2 },
    ],
    style: { color: "#fff", lineWidth: 1 },
    props: {},
    locked: false,
    hidden: false,
    zIndex: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const dummySpec: DrawingPrimitiveSpec<{ id: string }> = {
  computeState: (obj) => ({ id: obj.id }),
  draw: () => {},
};

beforeEach(() => {
  useDrawingStore.setState({ byPane: {}, selectedIds: [], history: {} });
});

describe("DrawingPrimitive base class lifecycle", () => {
  it("attaching triggers exactly one initial requestUpdate", () => {
    const obj = makeObj();
    useDrawingStore.setState((s) => ({ byPane: { ...s.byPane, [PANE]: [obj] } }));
    let calls = 0;
    const primitive = new DrawingPrimitive(PANE, obj.id, dummySpec);
    primitive.attached({ chart: fakeChart(), series: fakeSeries(), requestUpdate: () => calls++ } as never);
    expect(calls).toBe(1);
  });

  it("mutating the SAME object triggers a requestUpdate", () => {
    const obj = makeObj();
    useDrawingStore.setState((s) => ({ byPane: { ...s.byPane, [PANE]: [obj] } }));
    let calls = 0;
    const primitive = new DrawingPrimitive(PANE, obj.id, dummySpec);
    primitive.attached({ chart: fakeChart(), series: fakeSeries(), requestUpdate: () => calls++ } as never);
    calls = 0;

    useDrawingStore.getState().update(PANE, (ds) => ds.map((d) => (d.id === obj.id ? { ...d, points: [...d.points] } : d)));
    expect(calls).toBe(1);
  });

  it("mutating a DIFFERENT object, or a different pane, triggers NO requestUpdate", () => {
    const obj = makeObj();
    const other = makeObj({ id: "d2" });
    useDrawingStore.setState((s) => ({
      byPane: { ...s.byPane, [PANE]: [obj, other], ["other:pane"]: [makeObj({ id: "d3" })] },
    }));
    let calls = 0;
    const primitive = new DrawingPrimitive(PANE, obj.id, dummySpec);
    primitive.attached({ chart: fakeChart(), series: fakeSeries(), requestUpdate: () => calls++ } as never);
    calls = 0;

    useDrawingStore.getState().update(PANE, (ds) => ds.map((d) => (d.id === "d2" ? { ...d, style: { ...d.style, lineWidth: 3 } } : d)));
    useDrawingStore.getState().update("other:pane", (ds) => ds.map((d) => ({ ...d, hidden: true })));
    expect(calls).toBe(0);
  });

  it("undo/redo (which replace the whole array) trigger a requestUpdate", () => {
    const obj = makeObj();
    useDrawingStore.setState((s) => ({ byPane: { ...s.byPane, [PANE]: [obj] } }));
    let calls = 0;
    const primitive = new DrawingPrimitive(PANE, obj.id, dummySpec);
    primitive.attached({ chart: fakeChart(), series: fakeSeries(), requestUpdate: () => calls++ } as never);
    calls = 0;

    useDrawingStore.getState().mutate(PANE, (ds) => ds.map((d) => ({ ...d, style: { ...d.style, color: "#000" } })));
    expect(calls).toBe(1);
    useDrawingStore.getState().undo(PANE);
    expect(calls).toBe(2);
    useDrawingStore.getState().redo(PANE);
    expect(calls).toBe(3);
  });

  it("after detached(), no further requestUpdate calls occur", () => {
    const obj = makeObj();
    useDrawingStore.setState((s) => ({ byPane: { ...s.byPane, [PANE]: [obj] } }));
    let calls = 0;
    const primitive = new DrawingPrimitive(PANE, obj.id, dummySpec);
    primitive.attached({ chart: fakeChart(), series: fakeSeries(), requestUpdate: () => calls++ } as never);
    primitive.detached();
    calls = 0;

    useDrawingStore.getState().update(PANE, (ds) => ds.map((d) => ({ ...d, points: [...d.points] })));
    expect(calls).toBe(0);
  });

  it("hidden object: computeState never invoked, renderer draws nothing", () => {
    const obj = makeObj({ hidden: true });
    useDrawingStore.setState((s) => ({ byPane: { ...s.byPane, [PANE]: [obj] } }));
    let computeCalls = 0;
    let drawCalls = 0;
    const spec: DrawingPrimitiveSpec<{ id: string }> = {
      computeState: (o) => {
        computeCalls++;
        return { id: o.id };
      },
      draw: () => {
        drawCalls++;
      },
    };
    const primitive = new DrawingPrimitive(PANE, obj.id, spec);
    primitive.attached({ chart: fakeChart(), series: fakeSeries(), requestUpdate: () => {} } as never);
    primitive.updateAllViews();
    primitive.paneViews()[0].renderer()?.draw({} as never);

    expect(computeCalls).toBe(0);
    expect(drawCalls).toBe(0);
  });

  it("attaching/detaching never itself writes to drawingStore (persistence untouched)", () => {
    const obj = makeObj();
    useDrawingStore.setState((s) => ({ byPane: { ...s.byPane, [PANE]: [obj] } }));
    const before = useDrawingStore.getState().byPane;

    const primitive = new DrawingPrimitive(PANE, obj.id, dummySpec);
    primitive.attached({ chart: fakeChart(), series: fakeSeries(), requestUpdate: () => {} } as never);
    primitive.updateAllViews();
    primitive.detached();

    expect(useDrawingStore.getState().byPane).toBe(before); // same reference - no mutation occurred
  });

  it("structural: with 100 objects attached, mutating ONE triggers exactly 1 of the 100 requestUpdate calls", () => {
    const objs = Array.from({ length: 100 }, (_, i) => makeObj({ id: `d${i}` }));
    useDrawingStore.setState((s) => ({ byPane: { ...s.byPane, [PANE]: objs } }));

    let totalCalls = 0;
    const primitives = objs.map((o) => {
      const p = new DrawingPrimitive(PANE, o.id, dummySpec);
      p.attached({ chart: fakeChart(), series: fakeSeries(), requestUpdate: () => totalCalls++ } as never);
      return p;
    });
    totalCalls = 0;

    useDrawingStore.getState().update(PANE, (ds) => ds.map((d) => (d.id === "d42" ? { ...d, points: [...d.points] } : d)));
    expect(totalCalls).toBe(1);
    void primitives;
  });
});
