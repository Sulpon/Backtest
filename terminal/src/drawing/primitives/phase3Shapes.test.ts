import { describe, expect, it, beforeEach } from "vitest";
import { DRAWING_KINDS } from "../kinds";
import type { DrawingObject } from "../types";
import { useDrawingStore } from "../drawingStore";
import { DrawingPrimitive, type DrawingPrimitiveSpec } from "./primitiveBase";
import { textSpec } from "./textPrimitive";
import { arrowSpec } from "./arrowPrimitive";
import { circleSpec } from "./circlePrimitive";
import { ellipseSpec } from "./ellipsePrimitive";
import { triangleSpec } from "./trianglePrimitive";
import { T0, oldScale, fakeChart, fakeSeries, recordingCtx, fakeTarget, PANE } from "./testHarness";

/** Phase 3 visual-parity checks: text/arrow/circle/ellipse/triangle against
 * DRAWING_KINDS[type].render() (the real renderer these primitives were
 * written to mirror - unlike Phase 1/2, there's no PRIOR production
 * behavior to protect here since these tools didn't exist before this
 * change, but the same old-vs-new call-recording comparison still proves
 * the flag-on and flag-off paths are visually identical to each other). */

function makeBase(type: DrawingObject["type"], points: DrawingObject["points"], overrides: Partial<DrawingObject> = {}): DrawingObject {
  const now = Date.now();
  return {
    id: "d1",
    type,
    points,
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

describe("text primitive vs. old renderer", () => {
  it("matches for: default font size", () => assertParity(makeBase("text", [{ time: T0, price: 1.1 }], { props: { text: "Swing High" } }), textSpec));
  it("matches for: custom font size", () =>
    assertParity(makeBase("text", [{ time: T0, price: 1.1 }], { props: { text: "OTE", fontSize: 18 } }), textSpec));
  it("empty text draws nothing (both old and new)", () => {
    const obj = makeBase("text", [{ time: T0, price: 1.1 }], { props: { text: "" } });
    const { ctx: oldCtx, calls: oldCalls } = recordingCtx();
    DRAWING_KINDS.text.render(oldCtx, oldScale(), obj);
    expect(oldCalls).toEqual([]);

    useDrawingStore.setState((s) => ({ byPane: { ...s.byPane, [PANE]: [obj] } }));
    const primitive = new DrawingPrimitive(PANE, obj.id, textSpec);
    primitive.attached({ chart: fakeChart(), series: fakeSeries(), requestUpdate: () => {} } as never);
    primitive.updateAllViews();
    const { ctx, calls } = recordingCtx();
    primitive.paneViews()[0].renderer()?.draw(fakeTarget(ctx));
    expect(calls).toEqual([]);
  });
});

describe("arrow primitive vs. old renderer", () => {
  it("matches for: forward points", () => assertParity(makeBase("arrow", [{ time: T0, price: 1.105 }, { time: T0 + 3600, price: 1.098 }]), arrowSpec));
  it("matches for: reversed points", () =>
    assertParity(makeBase("arrow", [{ time: T0 + 3600, price: 1.098 }, { time: T0, price: 1.105 }]), arrowSpec));
});

describe("circle primitive vs. old renderer", () => {
  it("matches for: center + edge", () => assertParity(makeBase("circle", [{ time: T0, price: 1.1 }, { time: T0 + 1800, price: 1.09 }]), circleSpec));
  it("matches for: custom fill opacity", () =>
    assertParity(makeBase("circle", [{ time: T0, price: 1.1 }, { time: T0 + 1800, price: 1.09 }], { props: { fillOpacity: 0.3 } }), circleSpec));
});

describe("ellipse primitive vs. old renderer", () => {
  it("matches for: normal bounding box", () =>
    assertParity(makeBase("ellipse", [{ time: T0, price: 1.11 }, { time: T0 + 3600, price: 1.09 }]), ellipseSpec));
  it("matches for: reversed corners", () =>
    assertParity(makeBase("ellipse", [{ time: T0 + 3600, price: 1.09 }, { time: T0, price: 1.11 }]), ellipseSpec));
});

describe("triangle primitive vs. old renderer", () => {
  const pts: DrawingObject["points"] = [
    { time: T0, price: 1.1 },
    { time: T0 + 1800, price: 1.11 },
    { time: T0 + 3600, price: 1.095 },
  ];
  it("matches for: 3 vertices", () => assertParity(makeBase("triangle", pts), triangleSpec));
  it("matches for: custom fill opacity", () => assertParity(makeBase("triangle", pts, { props: { fillOpacity: 0.25 } }), triangleSpec));
});

describe("hidden Phase 3 shapes render nothing", () => {
  const cases: { type: DrawingObject["type"]; spec: DrawingPrimitiveSpec<unknown>; points: DrawingObject["points"]; props?: Record<string, unknown> }[] = [
    { type: "text", spec: textSpec as DrawingPrimitiveSpec<unknown>, points: [{ time: T0, price: 1.1 }], props: { text: "hi" } },
    { type: "arrow", spec: arrowSpec as DrawingPrimitiveSpec<unknown>, points: [{ time: T0, price: 1.1 }, { time: T0 + 60, price: 1.11 }] },
    { type: "circle", spec: circleSpec as DrawingPrimitiveSpec<unknown>, points: [{ time: T0, price: 1.1 }, { time: T0 + 60, price: 1.11 }] },
    { type: "ellipse", spec: ellipseSpec as DrawingPrimitiveSpec<unknown>, points: [{ time: T0, price: 1.1 }, { time: T0 + 60, price: 1.11 }] },
    {
      type: "triangle",
      spec: triangleSpec as DrawingPrimitiveSpec<unknown>,
      points: [{ time: T0, price: 1.1 }, { time: T0 + 60, price: 1.11 }, { time: T0 + 120, price: 1.09 }],
    },
  ];
  for (const { type, spec, points, props } of cases) {
    it(type, () => {
      const obj = makeBase(type, points, { hidden: true, props: props ?? {} });
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
