/**
 * The generic drawing model (architecture doc, Section 04). A DrawingObject
 * is plain, JSON-serializable data - no class instances, no canvas/chart
 * references stored on it. All tool-specific behavior (render, hit-test,
 * which points are draggable) lives in a DrawingKind descriptor, looked up
 * by `type`. Adding a new tool is: add one DrawingKind to the registry in
 * kinds.ts, add one entry to toolDefinitions.ts. Nothing else changes.
 */
export interface DrawingPoint {
  time: number; // unix seconds
  price: number;
}

// bosbull/bosbear/chochbull/chochbear are manual market-structure markers -
// see src/marketStructure/. Direction is deliberately baked into the type
// (4 distinct tools) rather than a shared "bos"/"choch" type plus a
// direction prop or inferring it from the two points' relative price -
// picking a specific tool is the one way to record BOS-vs-CHOCH and
// bullish-vs-bearish that never involves the platform guessing anything
// about the user's own market-structure read (same reasoning "long"/
// "short" already use two types instead of one position type + a side prop).
export type DrawingType =
  | "trendline"
  | "hline"
  | "vline"
  | "ray"
  | "rectangle"
  | "fibretracement"
  | "long"
  | "short"
  | "bosbull"
  | "bosbear"
  | "chochbull"
  | "chochbear";

export interface DrawingStyle {
  color: string;
  lineWidth: 1 | 2 | 3;
}

export interface DrawingObject {
  id: string;
  type: DrawingType;
  points: DrawingPoint[];
  style: DrawingStyle;
  /** Tool-specific extra configuration that isn't a point or a universal
   * style field - extend flags, arrow ends, fill opacity, fib level
   * overrides, and so on. Loosely typed and read through small per-kind
   * helpers (see kinds.ts) instead of a big discriminated union, so a new
   * tool can add fields here without touching this file. */
  props: Record<string, unknown>;
  /** Tool-specific extras that aren't points or props - e.g. the R:R ratio for a position tool. */
  meta?: { rr?: number };
  locked: boolean;
  hidden: boolean;
  zIndex: number;
  createdAt: number;
  updatedAt: number;
}

export const DEFAULT_STYLE: DrawingStyle = { color: "#e7ebf3", lineWidth: 2 };
