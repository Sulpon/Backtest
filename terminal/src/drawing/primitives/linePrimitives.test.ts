import { describe, expect, it, beforeEach } from "vitest";
import { DRAWING_KINDS } from "../kinds";
import type { DrawingObject } from "../types";
import { useDrawingStore } from "../drawingStore";
import { DrawingPrimitive, type DrawingPrimitiveSpec } from "./primitiveBase";
import { trendlineSpec } from "./trendlinePrimitive";
import { raySpec } from "./rayPrimitive";
import { hlineSpec } from "./hlinePrimitive";
import { vlineSpec } from "./vlinePrimitive";
import { T0, oldScale, fakeChart, fakeSeries, recordingCtx, fakeTarget, PANE } from "./testHarness";

/** Visual-parity checks for trendline/ray/hline/vline against
 * DRAWING_KINDS[type].render() (the real, unmodified production renderer).
 * Lifecycle (attach/detach/redraw-on-change/persistence) is covered once,
 * generically, in primitiveBase.test.ts - not repeated per tool here. */

function makeBase(overrides: Partial<DrawingObject> = {}): DrawingObject {
  const now = Date.now();
  return {
    id: "d1",
    type: "trendline",
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

describe("trendline primitive vs. old renderer", () => {
  const cases: { name: string; overrides: Partial<DrawingObject> }[] = [
    { name: "plain, forward points", overrides: {} },
    {
      name: "reversed points",
      overrides: { points: [{ time: T0 + 3600, price: 1.098 }, { time: T0, price: 1.105 }] },
    },
    { name: "extendLeft", overrides: { props: { extendLeft: true } } },
    { name: "extendRight", overrides: { props: { extendRight: true } } },
    { name: "arrowStart + arrowEnd", overrides: { props: { arrowStart: true, arrowEnd: true } } },
    { name: "extend + arrows together", overrides: { props: { extendLeft: true, extendRight: true, arrowStart: true, arrowEnd: true } } },
  ];
  for (const { name, overrides } of cases) {
    it(`matches for: ${name}`, () => assertParity(makeBase({ type: "trendline", ...overrides }), trendlineSpec));
  }
});

describe("ray primitive vs. old renderer", () => {
  const cases: { name: string; overrides: Partial<DrawingObject> }[] = [
    { name: "plain, forward points", overrides: {} },
    {
      name: "reversed points",
      overrides: { points: [{ time: T0 + 3600, price: 1.098 }, { time: T0, price: 1.105 }] },
    },
    {
      name: "steep vertical-ish ray",
      overrides: { points: [{ time: T0, price: 1.105 }, { time: T0 + 60, price: 1.05 }] },
    },
  ];
  for (const { name, overrides } of cases) {
    it(`matches for: ${name}`, () => assertParity(makeBase({ type: "ray", ...overrides }), raySpec));
  }
});

describe("hline primitive vs. old renderer", () => {
  const cases: { name: string; overrides: Partial<DrawingObject> }[] = [
    { name: "plain price level", overrides: { points: [{ time: T0, price: 1.10523 }] } },
    { name: "custom color/width", overrides: { points: [{ time: T0, price: 1.09 }], style: { color: "#ef5350", lineWidth: 3 } } },
  ];
  for (const { name, overrides } of cases) {
    it(`matches for: ${name}`, () => assertParity(makeBase({ type: "hline", ...overrides }), hlineSpec));
  }
});

describe("vline primitive vs. old renderer", () => {
  const cases: { name: string; overrides: Partial<DrawingObject> }[] = [
    { name: "plain time marker", overrides: { points: [{ time: T0 + 1800, price: 1.1 }] } },
  ];
  for (const { name, overrides } of cases) {
    it(`matches for: ${name}`, () => assertParity(makeBase({ type: "vline", ...overrides }), vlineSpec));
  }
});

describe("hidden drawings render nothing (old: filtered upstream, new: renderer draws nothing)", () => {
  const singlePoint = [{ time: T0, price: 1.1 }];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cases: { type: DrawingObject["type"]; spec: DrawingPrimitiveSpec<any>; points?: DrawingObject["points"] }[] = [
    { type: "trendline", spec: trendlineSpec },
    { type: "ray", spec: raySpec },
    { type: "hline", spec: hlineSpec, points: singlePoint },
    { type: "vline", spec: vlineSpec, points: singlePoint },
  ];
  for (const { type, spec, points } of cases) {
    it(`${type}`, () => {
      const obj = makeBase({ type, hidden: true, ...(points ? { points } : {}) });
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
