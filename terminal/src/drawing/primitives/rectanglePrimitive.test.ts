import { describe, expect, it, beforeEach } from "vitest";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { IChartApi, ISeriesApi, Time } from "lightweight-charts";
import { DRAWING_KINDS } from "../kinds";
import type { DrawingObject } from "../types";
import { useDrawingStore } from "../drawingStore";
import { RectanglePrimitive, computeRectCoords, withAlpha } from "./rectanglePrimitive";

/**
 * Side-by-side regression check for the rectangle ISeriesPrimitive vs. the
 * production DrawingLayer canvas renderer (DRAWING_KINDS.rectangle in
 * kinds.ts, unmodified by this change). Both are driven through the exact
 * same time->x / price->y formulas so any divergence in the numbers below
 * is a real behavioral difference, not a mock-setup artifact.
 */

const T0 = 1_700_000_000; // unix seconds
const PX_PER_SEC = 0.02;
const P0 = 1.1;
const PX_PER_UNIT = 100_000; // EURUSD-scale prices need a large px/unit factor
const HEIGHT = 400;
const WIDTH = 800;

function timeToX(t: number): number {
  return (t - T0) * PX_PER_SEC;
}
function priceToY(p: number): number {
  return HEIGHT - (p - P0) * PX_PER_UNIT;
}

/** DrawScale-shaped mock for the OLD renderer (kinds.ts's own interface). */
function oldScale() {
  return {
    x: (t: number) => timeToX(t),
    y: (p: number) => priceToY(p),
    toPx: (t: number, p: number) => ({ x: timeToX(t), y: priceToY(p) }),
    fromPx: () => null,
    width: WIDTH,
    height: HEIGHT,
  };
}

/** Records every draw call a CanvasRenderingContext2D would receive, without
 * needing a real canvas (none is available under vitest's node environment,
 * matching every other test in this codebase). */
function recordingCtx() {
  const calls: { fillRect?: number[]; strokeRect?: number[]; fillStyle?: string; strokeStyle?: string; lineWidth?: number }[] = [];
  const ctx = {
    set fillStyle(v: string) {
      calls.push({ fillStyle: v });
    },
    set strokeStyle(v: string) {
      calls.push({ strokeStyle: v });
    },
    set lineWidth(v: number) {
      calls.push({ lineWidth: v });
    },
    fillRect(x: number, y: number, w: number, h: number) {
      calls.push({ fillRect: [x, y, w, h] });
    },
    strokeRect(x: number, y: number, w: number, h: number) {
      calls.push({ strokeRect: [x, y, w, h] });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

function fakeChart(): IChartApi {
  return {
    timeScale: () => ({ timeToCoordinate: (t: Time) => timeToX(t as number) }),
  } as unknown as IChartApi;
}

function fakeSeries(): ISeriesApi<"Candlestick"> {
  return { priceToCoordinate: (p: number) => priceToY(p) } as unknown as ISeriesApi<"Candlestick">;
}

/** Mimics FancyCanvas's CanvasRenderingTarget2D.useMediaCoordinateSpace -
 * media (CSS-pixel) coordinates, same space the old renderer already draws
 * in (its ctx is pre-scaled by devicePixelRatio - see DrawingLayer's own
 * `ctx.setTransform(dpr,...)`), so the two renderers' numbers are directly
 * comparable without a pixel-ratio conversion step in this test. */
function fakeTarget(ctx: CanvasRenderingContext2D): CanvasRenderingTarget2D {
  return {
    useMediaCoordinateSpace: (f: (scope: { context: CanvasRenderingContext2D; mediaSize: { width: number; height: number } }) => void) =>
      f({ context: ctx, mediaSize: { width: WIDTH, height: HEIGHT } }),
  } as unknown as CanvasRenderingTarget2D;
}

function makeRect(overrides: Partial<DrawingObject> = {}): DrawingObject {
  const now = Date.now();
  return {
    id: "r1",
    type: "rectangle",
    points: [
      { time: T0, price: 1.105 },
      { time: T0 + 3600, price: 1.098 },
    ],
    style: { color: "#4f8cff", lineWidth: 2 },
    props: {},
    locked: false,
    hidden: false,
    zIndex: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const PANE = "__test_pane__";

beforeEach(() => {
  // Isolate each test's drawings from the persisted store and from each other.
  useDrawingStore.setState({ byPane: {}, selectedIds: [], history: {} });
});

describe("rectangle primitive vs. old canvas renderer - visual parity", () => {
  const cases: { name: string; overrides: Partial<DrawingObject> }[] = [
    { name: "plain rectangle, forward points", overrides: {} },
    {
      name: "reversed points (p2 earlier/higher than p1)",
      overrides: {
        points: [
          { time: T0 + 3600, price: 1.098 },
          { time: T0, price: 1.105 },
        ],
      },
    },
    { name: "extendLeft", overrides: { props: { extendLeft: true } } },
    { name: "extendRight", overrides: { props: { extendRight: true } } },
    { name: "extendLeft + extendRight", overrides: { props: { extendLeft: true, extendRight: true } } },
    { name: "custom fillOpacity", overrides: { props: { fillOpacity: 0.4 } } },
    { name: "custom color + lineWidth", overrides: { style: { color: "#ef5350", lineWidth: 3 } } },
  ];

  for (const { name, overrides } of cases) {
    it(`matches for: ${name}`, () => {
      const obj = makeRect(overrides);

      // OLD: production DrawingLayer path, verbatim.
      const { ctx: oldCtx, calls: oldCalls } = recordingCtx();
      DRAWING_KINDS.rectangle.render(oldCtx, oldScale(), obj);

      // NEW: the primitive, driven through its real attached()/updateAllViews()/
      // paneViews()/renderer()/draw() lifecycle - not a shortcut through
      // computeRectCoords directly.
      useDrawingStore.setState((s) => ({ byPane: { ...s.byPane, [PANE]: [obj] } }));
      const primitive = new RectanglePrimitive(PANE, obj.id);
      primitive.attached({ chart: fakeChart(), series: fakeSeries(), requestUpdate: () => {} } as never);
      primitive.updateAllViews();
      const renderer = primitive.paneViews()[0].renderer();
      const { ctx: newCtx, calls: newCalls } = recordingCtx();
      renderer?.draw(fakeTarget(newCtx));

      expect(newCalls).toEqual(oldCalls);
    });
  }

  it("hidden rectangle: old draws nothing (filtered upstream), new renderer draws nothing", () => {
    const obj = makeRect({ hidden: true });
    useDrawingStore.setState((s) => ({ byPane: { ...s.byPane, [PANE]: [obj] } }));

    const primitive = new RectanglePrimitive(PANE, obj.id);
    primitive.attached({ chart: fakeChart(), series: fakeSeries(), requestUpdate: () => {} } as never);
    primitive.updateAllViews();
    const { ctx, calls } = recordingCtx();
    primitive.paneViews()[0].renderer()?.draw(fakeTarget(ctx));

    expect(calls).toEqual([]);
  });
});

describe("computeRectCoords (pure geometry helper)", () => {
  it("normalizes reversed corners the same way old rectBounds/render does", () => {
    const box = computeRectCoords({ x: 100, y: 50 }, { x: 10, y: 200 }, WIDTH, false, false);
    expect(box).toEqual({ x0: 10, x1: 100, y0: 50, y1: 200 });
  });

  it("extendLeft pins x0 to 0, extendRight pins x1 to mediaWidth", () => {
    expect(computeRectCoords({ x: 100, y: 0 }, { x: 200, y: 10 }, WIDTH, true, false)?.x0).toBe(0);
    expect(computeRectCoords({ x: 100, y: 0 }, { x: 200, y: 10 }, WIDTH, false, true)?.x1).toBe(WIDTH);
  });

  it("returns null when a coordinate is unresolvable (off-scale time/price)", () => {
    expect(computeRectCoords({ x: null, y: 0 }, { x: 1, y: 1 }, WIDTH, false, false)).toBeNull();
  });
});

describe("withAlpha matches kinds.ts's private helper's output format", () => {
  it("produces the expected rgba() string", () => {
    expect(withAlpha("#4f8cff", 0.15)).toBe("rgba(79,140,255,0.15)");
  });
});

describe("primitive lifecycle: redraw-on-change, not redraw-always", () => {
  it("attaching triggers exactly one initial requestUpdate", () => {
    const obj = makeRect();
    useDrawingStore.setState((s) => ({ byPane: { ...s.byPane, [PANE]: [obj] } }));
    let calls = 0;
    const primitive = new RectanglePrimitive(PANE, obj.id);
    primitive.attached({ chart: fakeChart(), series: fakeSeries(), requestUpdate: () => calls++ } as never);
    expect(calls).toBe(1);
  });

  it("mutating the SAME object triggers a requestUpdate", () => {
    const obj = makeRect();
    useDrawingStore.setState((s) => ({ byPane: { ...s.byPane, [PANE]: [obj] } }));
    let calls = 0;
    const primitive = new RectanglePrimitive(PANE, obj.id);
    primitive.attached({ chart: fakeChart(), series: fakeSeries(), requestUpdate: () => calls++ } as never);
    calls = 0; // ignore the initial attach-time update

    // Same mutation shape DrawingLayer's drag handler uses (update(), immutable replace).
    useDrawingStore.getState().update(PANE, (ds) => ds.map((d) => (d.id === obj.id ? { ...d, points: [...d.points] } : d)));
    expect(calls).toBe(1);
  });

  it("mutating a DIFFERENT object, or a different pane, triggers NO requestUpdate", () => {
    const obj = makeRect();
    const other = makeRect({ id: "r2" });
    useDrawingStore.setState((s) => ({ byPane: { ...s.byPane, [PANE]: [obj, other], ["other:pane"]: [makeRect({ id: "r3" })] } }));
    let calls = 0;
    const primitive = new RectanglePrimitive(PANE, obj.id);
    primitive.attached({ chart: fakeChart(), series: fakeSeries(), requestUpdate: () => calls++ } as never);
    calls = 0;

    useDrawingStore.getState().update(PANE, (ds) => ds.map((d) => (d.id === "r2" ? { ...d, style: { ...d.style, lineWidth: 3 } } : d)));
    useDrawingStore.getState().update("other:pane", (ds) => ds.map((d) => ({ ...d, hidden: true })));
    expect(calls).toBe(0);
  });

  it("undo/redo (which replace the whole array) trigger a requestUpdate", () => {
    const obj = makeRect();
    useDrawingStore.setState((s) => ({ byPane: { ...s.byPane, [PANE]: [obj] } }));
    let calls = 0;
    const primitive = new RectanglePrimitive(PANE, obj.id);
    primitive.attached({ chart: fakeChart(), series: fakeSeries(), requestUpdate: () => calls++ } as never);
    calls = 0;

    useDrawingStore.getState().mutate(PANE, (ds) => ds.map((d) => ({ ...d, style: { ...d.style, color: "#ef5350" } })));
    expect(calls).toBe(1);
    useDrawingStore.getState().undo(PANE);
    expect(calls).toBe(2);
    useDrawingStore.getState().redo(PANE);
    expect(calls).toBe(3);
  });

  it("after detached(), no further requestUpdate calls occur for that object", () => {
    const obj = makeRect();
    useDrawingStore.setState((s) => ({ byPane: { ...s.byPane, [PANE]: [obj] } }));
    let calls = 0;
    const primitive = new RectanglePrimitive(PANE, obj.id);
    primitive.attached({ chart: fakeChart(), series: fakeSeries(), requestUpdate: () => calls++ } as never);
    primitive.detached();
    calls = 0;

    useDrawingStore.getState().update(PANE, (ds) => ds.map((d) => ({ ...d, points: [...d.points] })));
    expect(calls).toBe(0);
  });

  it("attaching/detaching never itself writes to drawingStore (persistence untouched)", () => {
    const obj = makeRect();
    useDrawingStore.setState((s) => ({ byPane: { ...s.byPane, [PANE]: [obj] } }));
    const before = useDrawingStore.getState().byPane;

    const primitive = new RectanglePrimitive(PANE, obj.id);
    primitive.attached({ chart: fakeChart(), series: fakeSeries(), requestUpdate: () => {} } as never);
    primitive.updateAllViews();
    primitive.detached();

    expect(useDrawingStore.getState().byPane).toBe(before); // same reference - no mutation occurred
  });
});

describe("structural performance property: redraw cost scales with what changed, not with drawing count", () => {
  it("with 100 rectangles attached, mutating ONE triggers exactly 1 of the 100 primitives' requestUpdate", () => {
    const rects = Array.from({ length: 100 }, (_, i) => makeRect({ id: `r${i}` }));
    useDrawingStore.setState((s) => ({ byPane: { ...s.byPane, [PANE]: rects } }));

    let totalCalls = 0;
    const primitives = rects.map((r) => {
      const p = new RectanglePrimitive(PANE, r.id);
      p.attached({ chart: fakeChart(), series: fakeSeries(), requestUpdate: () => totalCalls++ } as never);
      return p;
    });
    totalCalls = 0; // ignore the 100 initial attach-time updates

    useDrawingStore.getState().update(PANE, (ds) => ds.map((d) => (d.id === "r42" ? { ...d, points: [...d.points] } : d)));

    // Exactly one primitive (the mutated object's own) redrew - not all 100.
    // The OLD renderer has no equivalent selectivity: its rAF loop
    // (DrawingLayer.tsx's `draw()`) unconditionally re-renders every
    // drawing in the pane on every frame regardless of which one changed.
    expect(totalCalls).toBe(1);
    void primitives;
  });
});
