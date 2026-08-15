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

export type DrawingType = "trendline" | "hline" | "vline" | "ray" | "rectangle" | "fibretracement" | "long" | "short";

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
