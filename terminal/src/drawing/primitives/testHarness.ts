import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { IChartApi, ISeriesApi, Time } from "lightweight-charts";

/**
 * Shared old-vs-new regression harness for every Phase 2 primitive test
 * file (trendline/ray/hline/vline/fib/position/marketStructure). Not a
 * *.test.ts file itself, so vitest never tries to run it as a suite.
 *
 * The whole point: drive the OLD renderer (DRAWING_KINDS[type].render, the
 * real production function from kinds.ts, completely unmodified) and the
 * NEW primitive through the exact same time->x / price->y formulas, record
 * every canvas call each one makes in order, and assert the two call lists
 * are identical. Same approach rectanglePrimitive.test.ts used for
 * Rectangle, generalized so it doesn't need to be copy-pasted per tool.
 */

export const T0 = 1_700_000_000; // unix seconds
export const PX_PER_SEC = 0.02;
export const P0 = 1.1;
export const PX_PER_UNIT = 100_000; // EURUSD-scale prices need a large px/unit factor
export const HEIGHT = 400;
export const WIDTH = 800;

export function timeToX(t: number): number {
  return (t - T0) * PX_PER_SEC;
}
export function priceToY(p: number): number {
  return HEIGHT - (p - P0) * PX_PER_UNIT;
}

/** DrawScale-shaped mock for the OLD renderer (kinds.ts's own interface). */
export function oldScale() {
  return {
    x: (t: number) => timeToX(t),
    y: (p: number) => priceToY(p),
    toPx: (t: number, p: number) => ({ x: timeToX(t), y: priceToY(p) }),
    fromPx: () => null,
    width: WIDTH,
    height: HEIGHT,
  };
}

export function fakeChart(): IChartApi {
  return {
    timeScale: () => ({ timeToCoordinate: (t: Time) => timeToX(t as number) }),
  } as unknown as IChartApi;
}

export function fakeSeries(): ISeriesApi<"Candlestick"> {
  return { priceToCoordinate: (p: number) => priceToY(p) } as unknown as ISeriesApi<"Candlestick">;
}

export type RecordedCall = { op: "set"; prop: string; value: unknown } | { op: "call"; method: string; args: unknown[] };

const METHOD_NAMES = [
  "beginPath",
  "moveTo",
  "lineTo",
  "stroke",
  "closePath",
  "fill",
  "fillRect",
  "strokeRect",
  "fillText",
  "setLineDash",
  "save",
  "restore",
  "arc",
  "arcTo",
  "ellipse",
];
const PROP_NAMES = ["fillStyle", "strokeStyle", "lineWidth", "font", "textAlign", "textBaseline", "globalAlpha", "lineJoin", "lineCap"];

/** Records every draw call/property-set a CanvasRenderingContext2D would
 * receive, in order - no real canvas is available under vitest's node
 * environment (matching every other test in this codebase). */
export function recordingCtx(): { ctx: CanvasRenderingContext2D; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const target: Record<string, unknown> = {};
  for (const m of METHOD_NAMES) {
    target[m] = (...args: unknown[]) => {
      calls.push({ op: "call", method: m, args });
    };
  }
  for (const p of PROP_NAMES) {
    Object.defineProperty(target, p, {
      set(v: unknown) {
        calls.push({ op: "set", prop: p, value: v });
      },
      get() {
        return undefined;
      },
      configurable: true,
    });
  }
  return { ctx: target as unknown as CanvasRenderingContext2D, calls };
}

/** Mimics FancyCanvas's CanvasRenderingTarget2D.useMediaCoordinateSpace -
 * media (CSS-pixel) coordinates, the same space the old renderer already
 * draws in (its ctx is pre-scaled by devicePixelRatio - see DrawingLayer's
 * own `ctx.setTransform(dpr,...)`), so the two renderers' numbers are
 * directly comparable without a pixel-ratio conversion step in tests. */
export function fakeTarget(ctx: CanvasRenderingContext2D): CanvasRenderingTarget2D {
  return {
    useMediaCoordinateSpace: (f: (scope: { context: CanvasRenderingContext2D; mediaSize: { width: number; height: number } }) => void) =>
      f({ context: ctx, mediaSize: { width: WIDTH, height: HEIGHT } }),
  } as unknown as CanvasRenderingTarget2D;
}

export const PANE = "__test_pane__";
