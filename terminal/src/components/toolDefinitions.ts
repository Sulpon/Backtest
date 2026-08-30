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
  bosbull: "Mark a bullish Break of Structure you identified",
  bosbear: "Mark a bearish Break of Structure you identified",
  chochbull: "Mark a bullish Change of Character you identified",
  chochbear: "Mark a bearish Change of Character you identified",
  text: "Click to place a text label, then type",
  arrow: "Draw a line with an arrowhead at the end",
  circle: "Draw a circle from its center outward",
  ellipse: "Draw an ellipse inside a bounding box",
  triangle: "Draw a triangle from three points",
  parallelchannel: "Draw a channel from a baseline plus a width point",
  fibextension: "Project extension levels from a 3-point swing",
  fibchannel: "Draw a channel with Fibonacci-ratio levels between its lines",
  pricerange: "Measure the price change between two points",
  daterange: "Measure the elapsed time between two points",
  brush: "Freehand drawing",
  highlighter: "Freehand drawing with a translucent stroke",
};

// The automatic SMC overlay toggles in the Analysis hub (architecture doc,
// Section 05) are a DIFFERENT thing from this group: those render whatever
// the backend/Pine engine computed. These 4 tools are manual drawings you
// place yourself - every one is logged verbatim into the market-structure
// dataset (see src/marketStructure/) as your own decision, not compared
// against or replaced by the automatic overlays in any way.
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
      t("arrow", "Arrow", true),
      t("polyline", "Polyline"),
      t("path", "Path"),
    ],
  },
  {
    id: "channels",
    label: "Channels",
    tools: [
      t("parallelchannel", "Parallel Channel", true),
      t("regressionchannel", "Regression Channel"),
      t("flatchannel", "Flat Top/Bottom"),
    ],
  },
  {
    id: "fibonacci",
    label: "Fibonacci",
    tools: [
      t("fibretracement", "Fib Retracement", true),
      t("fibextension", "Fib Extension", true),
      t("trendfib", "Trend-Based Fib"),
      t("fibchannel", "Fib Channel", true),
      t("fibtimezone", "Fib Time Zone"),
    ],
  },
  {
    id: "shapes",
    label: "Shapes",
    tools: [
      t("rectangle", "Rectangle", true),
      t("circle", "Circle", true),
      t("ellipse", "Ellipse", true),
      t("triangle", "Triangle", true),
      t("polygon", "Polygon"),
    ],
  },
  {
    id: "annotations",
    label: "Annotations",
    tools: [t("text", "Text", true), t("note", "Note"), t("callout", "Callout"), t("pricelabel", "Price Label")],
  },
  {
    id: "risk",
    label: "Risk Tools",
    tools: [t("long", "Long Position", true), t("short", "Short Position", true), t("riskreward", "Risk/Reward")],
  },
  {
    id: "marketstructure",
    label: "Market Structure",
    tools: [
      t("bosbull", "Bullish BOS", true),
      t("bosbear", "Bearish BOS", true),
      t("chochbull", "Bullish CHoCH", true),
      t("chochbear", "Bearish CHoCH", true),
    ],
  },
  {
    id: "measurement",
    label: "Measurement",
    tools: [t("pricerange", "Price Range", true), t("daterange", "Date Range", true)],
  },
  {
    id: "brushes",
    label: "Brushes",
    tools: [t("brush", "Brush", true), t("highlighter", "Highlighter", true), t("eraser", "Eraser")],
  },
];
