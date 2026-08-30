import { describe, expect, it, beforeEach } from "vitest";
import { DRAWING_KINDS } from "../kinds";
import type { DrawingObject } from "../types";
import { useDrawingStore } from "../drawingStore";
import { DrawingPrimitive } from "./primitiveBase";
import { brushSpec, highlighterSpec } from "./freehandPrimitive";
import { T0, oldScale, fakeChart, fakeSeries, recordingCtx, fakeTarget, PANE } from "./testHarness";

const strokePoints: DrawingObject["points"] = [
  { time: T0, price: 1.1 },
  { time: T0 + 60, price: 1.101 },
  { time: T0 + 120, price: 1.0995 },
  { time: T0 + 180, price: 1.102 },
  { time: T0 + 240, price: 1.0998 },
];

function makeBrush(type: "brush" | "highlighter", overrides: Partial<DrawingObject> = {}): DrawingObject {
  const now = Date.now();
  const kind = DRAWING_KINDS[type];
  return {
    id: "d1",
    type,
    points: strokePoints,
    style: kind.defaultStyle,
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

function assertParity(obj: DrawingObject, spec: typeof brushSpec) {
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

describe("brush primitive vs. old renderer", () => {
  it("matches for: a 5-point stroke", () => assertParity(makeBrush("brush"), brushSpec));
  it("matches for: a 2-point (minimal) stroke", () =>
    assertParity(makeBrush("brush", { points: strokePoints.slice(0, 2) }), brushSpec));
});

describe("highlighter primitive vs. old renderer", () => {
  it("matches for: a 5-point stroke (includes the translucency alpha)", () => assertParity(makeBrush("highlighter"), highlighterSpec));
});

describe("hidden freehand strokes render nothing", () => {
  for (const [type, spec] of [
    ["brush", brushSpec],
    ["highlighter", highlighterSpec],
  ] as const) {
    it(type, () => {
      const obj = makeBrush(type, { hidden: true });
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
