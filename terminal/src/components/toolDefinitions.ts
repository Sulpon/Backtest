export interface ToolDef {
  id: string;
  label: string;
  /** Live tools place a real DrawingObject (architecture doc, Section 04).
   * Everything else is visible, correctly grouped, and armable, but shows a
   * "not yet wired" hint instead of drawing - it joins the registry in
   * drawing/kinds.ts on its own schedule without any rail/grouping changes. */
  live: boolean;
}

export interface ToolGroup {
  id: string;
  label: string;
  tools: ToolDef[];
}

const t = (id: string, label: string, live = false): ToolDef => ({ id, label, live });

/** Single-letter arming shortcuts for live tools - no modifier, guarded (in
 * useToolShortcuts.ts) against firing while any text input has focus. */
export const TOOL_SHORTCUTS: Record<string, string> = {
  trendline: "T",
  hline: "H",
  vline: "V",
  ray: "R",
  rectangle: "B", // "R" is taken by Ray - TradingView itself uses Alt+R for rectangle
  fibretracement: "F",
  long: "L",
  short: "S",
};

export const TOOL_DESCRIPTIONS: Record<string, string> = {
  trendline: "Draw a line between two points",
  hline: "Place a horizontal price level",
  vline: "Place a vertical time marker",
  ray: "Draw a line that extends from an origin in one direction",
  rectangle: "Draw a rectangular price/time zone",
  fibretracement: "Measure retracement levels between a swing high and low",
  long: "Plan a long entry with stop-loss and R:R target",
  short: "Plan a short entry with stop-loss and R:R target",
};

// Deliberately no SMC group here - SMC tools are analysis, not drawings
// (architecture doc, Section 05), and live in the Analysis hub instead.
export const TOOL_GROUPS: ToolGroup[] = [
  {
    id: "navigation",
    label: "Navigation",
    tools: [t("cursor", "Cursor", true), t("crosshair", "Crosshair", true), t("hand", "Hand", true)],
  },
  {
    id: "lines",
    label: "Lines",
    tools: [
      t("trendline", "Trend Line", true),
      t("infoline", "Info Line"),
      t("extendedline", "Extended Line"),
      t("hline", "Horizontal Line", true),
      t("vline", "Vertical Line", true),
      t("ray", "Ray", true),
      t("arrow", "Arrow"),
      t("polyline", "Polyline"),
      t("path", "Path"),
    ],
  },
  {
    id: "channels",
    label: "Channels",
    tools: [
      t("parallelchannel", "Parallel Channel"),
      t("regressionchannel", "Regression Channel"),
      t("flatchannel", "Flat Top/Bottom"),
    ],
  },
  {
    id: "fibonacci",
    label: "Fibonacci",
    tools: [
      t("fibretracement", "Fib Retracement", true),
      t("fibextension", "Fib Extension"),
      t("trendfib", "Trend-Based Fib"),
      t("fibchannel", "Fib Channel"),
      t("fibtimezone", "Fib Time Zone"),
    ],
  },
  {
    id: "shapes",
    label: "Shapes",
    tools: [
      t("rectangle", "Rectangle", true),
      t("circle", "Circle"),
      t("ellipse", "Ellipse"),
      t("triangle", "Triangle"),
      t("polygon", "Polygon"),
    ],
  },
  {
    id: "annotations",
    label: "Annotations",
    tools: [t("text", "Text"), t("note", "Note"), t("callout", "Callout"), t("pricelabel", "Price Label")],
  },
  {
    id: "risk",
    label: "Risk Tools",
    tools: [t("long", "Long Position", true), t("short", "Short Position", true), t("riskreward", "Risk/Reward")],
  },
  {
    id: "measurement",
    label: "Measurement",
    tools: [t("measure", "Measure")],
  },
  {
    id: "brushes",
    label: "Brushes",
    tools: [t("brush", "Brush"), t("highlighter", "Highlighter"), t("eraser", "Eraser")],
  },
];
