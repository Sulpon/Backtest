import type { Arg, Expr } from "./ast";
import type { BuiltinCtx, Namespace, NamespaceFn, ResolvedArgs, StdlibTable } from "./interpreter";
import { NA, isNa, isPineArray } from "./interpreter";

// ---- color ----
export interface PineColor {
  __pine: "color";
  r: number;
  g: number;
  b: number;
  a: number; // 0-1
}
function rgb(r: number, g: number, b: number, a = 1): PineColor {
  return { __pine: "color", r, g, b, a };
}
export function pineColorToCss(c: unknown, fallback = "#e7ebf3"): string {
  if (c && typeof c === "object" && (c as PineColor).__pine === "color") {
    const { r, g, b, a } = c as PineColor;
    return `rgba(${r},${g},${b},${a})`;
  }
  return fallback;
}
const NAMED_COLORS: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  silver: [192, 192, 192],
  gray: [128, 128, 128],
  white: [255, 255, 255],
  maroon: [128, 0, 0],
  red: [255, 0, 0],
  purple: [128, 0, 128],
  fuchsia: [255, 0, 255],
  green: [76, 175, 80],
  lime: [0, 255, 0],
  olive: [128, 128, 0],
  yellow: [255, 235, 59],
  navy: [0, 0, 128],
  blue: [33, 150, 243],
  teal: [0, 128, 128],
  aqua: [0, 255, 255],
  orange: [255, 152, 0],
};

export function hexToColor(hex: string): PineColor {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return rgb(r, g, b, a);
}

function toHex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
}

/** RGB-only hex for use with a native <input type="color"> swatch, which
 * has no alpha channel - the color's own transparency (still stored) just
 * isn't editable from that control, matching how these scripts only ever
 * expose color pickers for the RGB part and set transparency in code. */
export function colorToHex(c: unknown): string {
  if (c && typeof c === "object" && (c as PineColor).__pine === "color") {
    const { r, g, b } = c as PineColor;
    return `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`;
  }
  return "#e7ebf3";
}

// ---- box / line / label runtime objects ----
export interface PineLine {
  __pine: "line";
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  xloc: "bar_index" | "bar_time";
  extend: "none" | "left" | "right" | "both";
  color: PineColor;
  style: string;
  width: number;
  deleted?: boolean;
}
export interface PineBox {
  __pine: "box";
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  xloc: "bar_index" | "bar_time";
  borderColor: PineColor;
  borderWidth: number;
  borderStyle: string;
  bgColor: PineColor;
  extend: "none" | "left" | "right" | "both";
  text: string;
  textColor: PineColor;
  deleted?: boolean;
  /** Set by backtest.recordTrade (Interpreter.recordTrade) to link a
   * profit/loss zone box back to the trade it belongs to - see
   * PineIndicatorLayer's right-click "Remove Trade" handler. */
  tradeId?: string;
}
export interface PineLabel {
  __pine: "label";
  id: string;
  x: number;
  y: number;
  xloc: "bar_index" | "bar_time";
  text: string;
  style: string;
  color: PineColor;
  textColor: PineColor;
  size: string;
  deleted?: boolean;
}

function num(v: unknown, dflt = 0): number {
  return isNa(v) || typeof v !== "number" ? dflt : v;
}
function str(v: unknown, dflt = ""): string {
  return isNa(v) ? dflt : String(v);
}
function col(v: unknown, dflt: PineColor): PineColor {
  return v && typeof v === "object" && (v as PineColor).__pine === "color" ? (v as PineColor) : dflt;
}
function xlocOf(v: unknown): "bar_index" | "bar_time" {
  return v === "bar_time" ? "bar_time" : "bar_index";
}
function extendOf(v: unknown): "none" | "left" | "right" | "both" {
  return v === "left" || v === "right" || v === "both" ? v : "none";
}

const WHITE = rgb(255, 255, 255, 1);
const BLUE = rgb(33, 150, 243, 1);

function fn(params: string[], call: NamespaceFn["call"]): NamespaceFn {
  return { params, call };
}

export function buildStdlib(): StdlibTable {
  const namespaces: Record<string, Namespace> = {};

  namespaces.math = {
    constants: {},
    functions: {
      abs: fn(["number"], (a) => (isNa(a.number) ? NA : Math.abs(num(a.number)))),
      ceil: fn(["number"], (a) => (isNa(a.number) ? NA : Math.ceil(num(a.number)))),
      floor: fn(["number"], (a) => (isNa(a.number) ? NA : Math.floor(num(a.number)))),
      round: fn(["number", "precision"], (a) => {
        if (isNa(a.number)) return NA;
        const p = num(a.precision, 0);
        const m = Math.pow(10, p);
        return Math.round(num(a.number) * m) / m;
      }),
      max: fn(["n0", "n1", "n2", "n3"], (a) =>
        Math.max(...Object.values(a).filter((v) => typeof v === "number") as number[])
      ),
      min: fn(["n0", "n1", "n2", "n3"], (a) =>
        Math.min(...Object.values(a).filter((v) => typeof v === "number") as number[])
      ),
      pow: fn(["base", "exponent"], (a) => Math.pow(num(a.base), num(a.exponent))),
      sqrt: fn(["number"], (a) => Math.sqrt(num(a.number))),
      log: fn(["number"], (a) => Math.log(num(a.number))),
      sign: fn(["number"], (a) => Math.sign(num(a.number))),
    },
  };

  namespaces.ta = {
    constants: {},
    functions: {
      highest: { params: [], call: () => NA, callRaw: (args, ctx) => taExtremeRaw(args, ctx, "high", true, false) },
      lowest: { params: [], call: () => NA, callRaw: (args, ctx) => taExtremeRaw(args, ctx, "low", false, false) },
      highestbars: { params: [], call: () => NA, callRaw: (args, ctx) => taExtremeRaw(args, ctx, "high", true, true) },
      lowestbars: { params: [], call: () => NA, callRaw: (args, ctx) => taExtremeRaw(args, ctx, "low", false, true) },
      atr: fn(["length"], (a, ctx) => taAtr(num(a.length, 14), ctx)),
    },
  };

  namespaces.array = {
    constants: {},
    functions: {
      new_int: fn(["size", "initial_value"], (a) => newArr(a)),
      new_float: fn(["size", "initial_value"], (a) => newArr(a)),
      new_bool: fn(["size", "initial_value"], (a) => newArr(a, false)),
      new_string: fn(["size", "initial_value"], (a) => newArr(a, "")),
      new_line: fn(["size", "initial_value"], (a) => newArr(a)),
      new_box: fn(["size", "initial_value"], (a) => newArr(a)),
      new_label: fn(["size", "initial_value"], (a) => newArr(a)),
      push: fn(["id", "value"], (a) => {
        if (isPineArray(a.id)) a.id.items.push(a.value);
        return NA;
      }),
      get: fn(["id", "index"], (a) => (isPineArray(a.id) ? a.id.items[num(a.index)] ?? NA : NA)),
      set: fn(["id", "index", "value"], (a) => {
        if (isPineArray(a.id)) a.id.items[num(a.index)] = a.value;
        return NA;
      }),
      remove: fn(["id", "index"], (a) => {
        if (isPineArray(a.id)) {
          const [removed] = a.id.items.splice(num(a.index), 1);
          return removed ?? NA;
        }
        return NA;
      }),
      shift: fn(["id"], (a) => (isPineArray(a.id) ? a.id.items.shift() ?? NA : NA)),
      pop: fn(["id"], (a) => (isPineArray(a.id) ? a.id.items.pop() ?? NA : NA)),
      clear: fn(["id"], (a) => {
        if (isPineArray(a.id)) a.id.items.length = 0;
        return NA;
      }),
      size: fn(["id"], (a) => (isPineArray(a.id) ? a.id.items.length : 0)),
      includes: fn(["id", "value"], (a) => (isPineArray(a.id) ? a.id.items.includes(a.value) : false)),
      indexof: fn(["id", "value"], (a) => (isPineArray(a.id) ? a.id.items.indexOf(a.value) : -1)),
    },
  };

  namespaces.str = {
    constants: {},
    functions: {
      length: fn(["string"], (a) => str(a.string).length),
      substring: fn(["string", "begin_pos", "end_pos"], (a) => {
        const s = str(a.string);
        const begin = num(a.begin_pos, 0);
        const end = a.end_pos === undefined || isNa(a.end_pos) ? s.length : num(a.end_pos);
        return s.slice(begin, end);
      }),
      tostring: fn(["value", "format"], (a) => {
        if (isNa(a.value)) return "NaN";
        if (typeof a.value === "number") return String(a.value);
        return String(a.value);
      }),
      contains: fn(["source", "str"], (a) => str(a.source).includes(str(a.str))),
      pos: fn(["source", "str"], (a) => {
        const idx = str(a.source).indexOf(str(a.str));
        return idx < 0 ? NA : idx;
      }),
      upper: fn(["source"], (a) => str(a.source).toUpperCase()),
      lower: fn(["source"], (a) => str(a.source).toLowerCase()),
      replace: fn(["source", "target", "replacement"], (a) => str(a.source).replace(str(a.target), str(a.replacement))),
      format: fn(["formatString"], (a) => str(a.formatString)),
    },
  };

  namespaces.color = {
    constants: Object.fromEntries(Object.entries(NAMED_COLORS).map(([k, [r, g, b]]) => [k, rgb(r, g, b, 1)])),
    functions: {
      new: fn(["color", "transparency"], (a) => {
        const base = col(a.color, WHITE);
        const t = num(a.transparency, 0);
        return rgb(base.r, base.g, base.b, Math.max(0, Math.min(1, 1 - t / 100)));
      }),
      rgb: fn(["red", "green", "blue", "transparency"], (a) =>
        rgb(num(a.red), num(a.green), num(a.blue), 1 - num(a.transparency, 0) / 100)
      ),
    },
  };

  namespaces.line = {
    constants: {
      style_solid: "solid",
      style_dashed: "dashed",
      style_dotted: "dotted",
      style_arrow_left: "solid",
      style_arrow_right: "solid",
    },
    functions: {
      new: fn(["x1", "y1", "x2", "y2", "xloc", "extend", "color", "style", "width"], (a, ctx) => {
        const obj: PineLine = {
          __pine: "line",
          id: ctx.interp.freshObjId(),
          x1: num(a.x1),
          y1: num(a.y1),
          x2: num(a.x2),
          y2: num(a.y2),
          xloc: xlocOf(a.xloc),
          extend: extendOf(a.extend),
          color: col(a.color, WHITE),
          style: str(a.style, "solid"),
          width: num(a.width, 1),
        };
        ctx.interp.registerLine(obj as unknown as Record<string, unknown> & { id: string });
        return obj;
      }),
      delete: fn(["id"], (a) => {
        if (isLine(a.id)) a.id.deleted = true;
        return NA;
      }),
      set_x1: fn(["id", "x"], (a) => setField(a.id, "x1", num(a.x))),
      set_y1: fn(["id", "y"], (a) => setField(a.id, "y1", num(a.y))),
      set_x2: fn(["id", "x"], (a) => setField(a.id, "x2", num(a.x))),
      set_y2: fn(["id", "y"], (a) => setField(a.id, "y2", num(a.y))),
      set_xy1: fn(["id", "x", "y"], (a) => {
        setField(a.id, "x1", num(a.x));
        setField(a.id, "y1", num(a.y));
        return NA;
      }),
      set_xy2: fn(["id", "x", "y"], (a) => {
        setField(a.id, "x2", num(a.x));
        setField(a.id, "y2", num(a.y));
        return NA;
      }),
      set_color: fn(["id", "color"], (a) => setField(a.id, "color", col(a.color, WHITE))),
      set_width: fn(["id", "width"], (a) => setField(a.id, "width", num(a.width, 1))),
      set_style: fn(["id", "style"], (a) => setField(a.id, "style", str(a.style, "solid"))),
      set_extend: fn(["id", "extend"], (a) => setField(a.id, "extend", extendOf(a.extend))),
      get_x1: fn(["id"], (a) => (isLine(a.id) ? a.id.x1 : NA)),
      get_y1: fn(["id"], (a) => (isLine(a.id) ? a.id.y1 : NA)),
      get_x2: fn(["id"], (a) => (isLine(a.id) ? a.id.x2 : NA)),
      get_y2: fn(["id"], (a) => (isLine(a.id) ? a.id.y2 : NA)),
    },
  };

  namespaces.box = {
    constants: {},
    functions: {
      new: fn(
        [
          "left", "top", "right", "bottom", "border_color", "border_width", "border_style",
          "extend", "xloc", "bgcolor", "text", "text_color",
        ],
        (a, ctx) => {
          const obj: PineBox = {
            __pine: "box",
            id: ctx.interp.freshObjId(),
            left: num(a.left),
            top: num(a.top),
            right: num(a.right),
            bottom: num(a.bottom),
            xloc: xlocOf(a.xloc),
            borderColor: col(a.border_color, WHITE),
            borderWidth: num(a.border_width, 1),
            borderStyle: str(a.border_style, "solid"),
            bgColor: col(a.bgcolor, rgb(33, 150, 243, 0.1)),
            extend: extendOf(a.extend),
            text: str(a.text, ""),
            textColor: col(a.text_color, WHITE),
          };
          ctx.interp.registerBox(obj as unknown as Record<string, unknown> & { id: string });
          return obj;
        }
      ),
      delete: fn(["id"], (a) => {
        if (isBox(a.id)) a.id.deleted = true;
        return NA;
      }),
      set_left: fn(["id", "left"], (a) => setField(a.id, "left", num(a.left))),
      set_top: fn(["id", "top"], (a) => setField(a.id, "top", num(a.top))),
      set_right: fn(["id", "right"], (a) => setField(a.id, "right", num(a.right))),
      set_bottom: fn(["id", "bottom"], (a) => setField(a.id, "bottom", num(a.bottom))),
      set_bgcolor: fn(["id", "color"], (a) => setField(a.id, "bgColor", col(a.color, WHITE))),
      set_border_color: fn(["id", "color"], (a) => setField(a.id, "borderColor", col(a.color, WHITE))),
      set_text: fn(["id", "text"], (a) => setField(a.id, "text", str(a.text))),
      get_left: fn(["id"], (a) => (isBox(a.id) ? a.id.left : NA)),
      get_top: fn(["id"], (a) => (isBox(a.id) ? a.id.top : NA)),
      get_right: fn(["id"], (a) => (isBox(a.id) ? a.id.right : NA)),
      get_bottom: fn(["id"], (a) => (isBox(a.id) ? a.id.bottom : NA)),
    },
  };

  namespaces.label = {
    constants: {
      style_none: "none",
      style_label_up: "label_up",
      style_label_down: "label_down",
      style_label_left: "label_left",
      style_label_right: "label_right",
      style_circle: "circle",
      style_cross: "cross",
    },
    functions: {
      new: fn(
        ["x", "y", "text", "xloc", "yloc", "color", "style", "textcolor", "size"],
        (a, ctx) => {
          const obj: PineLabel = {
            __pine: "label",
            id: ctx.interp.freshObjId(),
            x: num(a.x),
            y: num(a.y),
            xloc: xlocOf(a.xloc),
            text: str(a.text, ""),
            style: str(a.style, "label_down"),
            color: col(a.color, BLUE),
            textColor: col(a.textcolor, WHITE),
            size: str(a.size, "normal"),
          };
          ctx.interp.registerLabel(obj as unknown as Record<string, unknown> & { id: string });
          return obj;
        }
      ),
      delete: fn(["id"], (a) => {
        if (isLabel(a.id)) a.id.deleted = true;
        return NA;
      }),
      set_x: fn(["id", "x"], (a) => setField(a.id, "x", num(a.x))),
      set_y: fn(["id", "y"], (a) => setField(a.id, "y", num(a.y))),
      set_text: fn(["id", "text"], (a) => setField(a.id, "text", str(a.text))),
      set_color: fn(["id", "color"], (a) => setField(a.id, "color", col(a.color, BLUE))),
      set_textcolor: fn(["id", "color"], (a) => setField(a.id, "textColor", col(a.color, WHITE))),
    },
  };

  // The one external import both scripts use (`import .../Drawings_public/1
  // as d`) is reduced to its single actually-used member: a na-safe
  // line.delete wrapper. See ast.ts's `import` handling - the import
  // statement itself is parsed and discarded; this namespace stands in for
  // what it would have provided.
  namespaces.d = {
    constants: {},
    functions: {
      // Every real call site passes TWO arguments (a line and its paired
      // label, e.g. `d.delete_line(fibo1Line, fibo1Label)`) - it deletes
      // both together. An earlier version of this stub only accepted the
      // first, so the label half was silently kept alive forever (up to
      // the max_labels_count cap), which is exactly what produced stacked,
      // never-cleared fib labels every time structure redrew.
      delete_line: fn(["id", "label"], (a) => {
        if (isLine(a.id)) a.id.deleted = true;
        if (isLabel(a.label)) a.label.deleted = true;
        return NA;
      }),
    },
  };
  namespaces.xloc = { constants: { bar_index: "bar_index", bar_time: "bar_time" }, functions: {} };
  namespaces.yloc = { constants: { price: "price", abovebar: "abovebar", belowbar: "belowbar" }, functions: {} };
  namespaces.extend = { constants: { none: "none", left: "left", right: "right", both: "both" }, functions: {} };
  namespaces.alert = { constants: { freq_once_per_bar: "once_per_bar", freq_once_per_bar_close: "once_per_bar_close", freq_all: "all" }, functions: {} };
  namespaces.barstate = { constants: {}, functions: {} };
  namespaces.shape = {
    constants: Object.fromEntries(
      [
        "circle", "labeldown", "labelup", "xcross", "cross", "triangleup", "triangledown",
        "arrowup", "arrowdown", "square", "diamond", "flag",
      ].map((k) => [k, k])
    ),
    functions: {},
  };
  namespaces.location = {
    constants: { abovebar: "abovebar", belowbar: "belowbar", top: "top", bottom: "bottom", absolute: "absolute" },
    functions: {},
  };
  namespaces.position = {
    constants: {
      top_left: "top_left",
      top_center: "top_center",
      top_right: "top_right",
      middle_left: "middle_left",
      middle_center: "middle_center",
      middle_right: "middle_right",
      bottom_left: "bottom_left",
      bottom_center: "bottom_center",
      bottom_right: "bottom_right",
    },
    functions: {},
  };
  namespaces.size = {
    constants: { tiny: "tiny", small: "small", normal: "normal", large: "large", huge: "huge", auto: "auto" },
    functions: {},
  };
  namespaces.table = {
    constants: {},
    functions: {
      // Not rendered (no on-chart table surface yet) - accepted and no-op
      // so scripts that build a debug table don't fail to run.
      new: fn(["position", "columns", "rows"], () => ({ __pine: "table" })),
      cell: fn(["table_id", "column", "row", "text"], () => NA),
      clear: fn(["table_id", "start_column", "start_row"], () => NA),
    },
  };
  // Not a real Pine namespace (there is no "backtest.*" in the actual
  // language) - a small custom addition so a script's own trade
  // bookkeeping (entry/exit/result/R, however it computes those) can hand
  // a finished, closed trade to the host app's Trades panel / pane-header
  // stats / journal, which otherwise have no way to see inside a script's
  // internal state. One call per CLOSED trade, at the point a script
  // already knows both its entry and exit - see smc.pine's EXIT loop for
  // the call site.
  namespaces.backtest = {
    constants: {},
    functions: {
      recordTrade: fn(
        ["dir", "entryBar", "entryPrice", "sl", "tp", "exitBar", "result", "r", "setup", "profitBox", "lossBox"],
        (a, ctx) => {
          ctx.interp.recordTrade({
            dir: a.dir === "short" ? "short" : "long",
            entryBar: num(a.entryBar),
            entryPrice: num(a.entryPrice),
            sl: num(a.sl),
            tp: num(a.tp),
            exitBar: num(a.exitBar),
            result: a.result === "Win" ? "Win" : "Lose",
            r: num(a.r),
            setup: str(a.setup, ""),
            boxes: [isBox(a.profitBox) ? a.profitBox : null, isBox(a.lossBox) ? a.lossBox : null],
          });
          return NA;
        }
      ),
    },
  };

  const globals: Record<string, NamespaceFn> = {
    indicator: fn(
      ["title", "shorttitle", "overlay", "max_bars_back", "max_lines_count", "max_labels_count", "max_boxes_count"],
      (a, ctx) => {
        if (typeof a.max_lines_count === "number") ctx.interp.maxLines = a.max_lines_count;
        if (typeof a.max_labels_count === "number") ctx.interp.maxLabels = a.max_labels_count;
        if (typeof a.max_boxes_count === "number") ctx.interp.maxBoxes = a.max_boxes_count;
        return NA;
      }
    ),
    plot: fn(["series", "title", "color", "linewidth"], (a, ctx) => {
      const name = str(a.title, "plot");
      const arr = ctx.interp.plotSeries.get(name) ?? [];
      if (!isNa(a.series)) arr.push({ time: ctx.bars[ctx.bar]?.time ?? 0, value: num(a.series) });
      ctx.interp.plotSeries.set(name, arr);
      if (a.color) ctx.interp.plotColors.set(name, pineColorToCss(a.color));
      return NA;
    }),
    plotshape: fn(["series", "title", "style", "location", "color", "text"], () => NA),
    plotchar: fn(["series", "title", "char", "location", "color", "text"], () => NA),
    bgcolor: fn(["color", "offset", "editable", "show_last", "title"], () => NA),
    fill: fn(["hline1", "hline2", "color", "title"], () => NA),
    hline: fn(["price", "title", "color", "linestyle", "linewidth"], () => NA),
    alert: fn(["message", "freq"], () => NA),
    alertcondition: fn(["condition", "title", "message"], () => NA),
    nz: fn(["source", "replacement"], (a) => (isNa(a.source) ? (a.replacement === undefined ? 0 : a.replacement) : a.source)),
    na: fn(["value"], (a) => isNa(a.value)),
    fixnan: fn(["source"], (a) => a.source),
    int: fn(["x"], (a) => (isNa(a.x) ? NA : Math.trunc(num(a.x)))),
    float: fn(["x"], (a) => (isNa(a.x) ? NA : num(a.x))),
    bool: fn(["x"], (a) => (isNa(a.x) ? NA : !!a.x)),
    string: fn(["x"], (a) => (isNa(a.x) ? NA : String(a.x))),
    color: fn(["x"], (a) => a.x),
    input: fn(["defval", "title"], (a) => a.defval), // fallback; real dispatch is in Interpreter.callInput
  };

  return {
    namespaces,
    globals,
    methodNamespaceForTag: { line: "line", box: "box", label: "label" },
    makeColorLiteral: (hex: string) => hexToColor(hex),
  };
}

function newArr(a: ResolvedArgs, dflt: unknown = NA) {
  const size = num(a.size, 0);
  const initial = a.initial_value === undefined ? dflt : a.initial_value;
  return { __pine: "array" as const, items: new Array(size).fill(initial) };
}

function isLine(v: unknown): v is PineLine {
  return !!v && typeof v === "object" && (v as PineLine).__pine === "line";
}
function isBox(v: unknown): v is PineBox {
  return !!v && typeof v === "object" && (v as PineBox).__pine === "box";
}
function isLabel(v: unknown): v is PineLabel {
  return !!v && typeof v === "object" && (v as PineLabel).__pine === "label";
}
function setField(id: unknown, field: string, value: unknown) {
  if (id && typeof id === "object") (id as Record<string, unknown>)[field] = value;
  return NA;
}

/** Shared engine for ta.highest/lowest/highestbars/lowestbars. Pine's real
 * signature is `(source, length)`, with a `(length)` shorthand that
 * defaults source to `high`/`low` - both forms are used across the two
 * target scripts. `source` is walked via `ctx.seriesAt` (history-aware),
 * not pre-evaluated, since that's the whole reason these need callRaw. */
function taExtremeRaw(
  args: Arg[],
  ctx: { bar: number; bars: { high: number; low: number }[]; seriesAt: (e: Expr, offset: number) => unknown },
  ohlcKey: "high" | "low",
  isHigh: boolean,
  wantBarOffset: boolean
): unknown {
  let sourceExpr: Expr | null = null;
  let lengthExpr: Expr;
  if (args.length >= 2) {
    sourceExpr = args[0].value;
    lengthExpr = args[1].value;
  } else if (args.length === 1) {
    lengthExpr = args[0].value;
  } else {
    return NA;
  }
  const length = Math.max(1, Math.trunc(num(ctx.seriesAt(lengthExpr, 0))));
  const win: number[] = [];
  for (let i = 0; i < length; i++) {
    const idx = ctx.bar - i;
    if (idx < 0) break;
    const v = sourceExpr ? ctx.seriesAt(sourceExpr, i) : ctx.bars[idx][ohlcKey];
    win.push(num(v));
  }
  if (win.length === 0) return NA;
  let bestI = 0;
  for (let i = 1; i < win.length; i++) {
    if (isHigh ? win[i] > win[bestI] : win[i] < win[bestI]) bestI = i;
  }
  if (wantBarOffset) return -bestI; // Pine returns a negative offset from the current bar
  return win[bestI];
}

function taAtr(length: number, ctx: BuiltinCtx): unknown {
  const n = Math.max(1, Math.trunc(length));
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const idx = ctx.bar - i;
    if (idx < 1) break;
    const cur = ctx.bars[idx];
    const prevClose = ctx.bars[idx - 1].close;
    const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prevClose), Math.abs(cur.low - prevClose));
    sum += tr;
    count++;
  }
  return count === 0 ? NA : sum / count;
}
