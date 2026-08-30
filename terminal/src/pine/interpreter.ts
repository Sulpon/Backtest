import type { Expr, Stmt, Arg } from "./ast";
import type { PineBox } from "./stdlib";

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** A single variable's per-bar value history. Index = bar index. A read at
 * bar b with offset n first tries history[b-n] directly (fast path for the
 * common "just declared this bar" case); if that slot was never written
 * (a conditional declaration skipped it), it falls back to the nearest
 * earlier written value - Pine's series semantics: `x[1]` always yields
 * the last known value of x, not "undefined" just because the assigning
 * line didn't happen to run on that exact bar. */
export class Binding {
  history: unknown[] = [];
  set(bar: number, value: unknown) {
    this.history[bar] = value;
  }
  get(bar: number): unknown {
    if (bar < 0) return NA;
    for (let b = bar; b >= 0; b--) {
      const v = this.history[b];
      if (v !== undefined) return v;
    }
    return NA;
  }
}

export const NA = Symbol("na");
export function isNa(v: unknown): boolean {
  return v === NA || v === undefined || v === null || (typeof v === "number" && Number.isNaN(v));
}

export class Scope {
  vars = new Map<string, Binding>();
  parent: Scope | null;
  constructor(parent: Scope | null = null) {
    this.parent = parent;
  }
  /** Declares (or re-fetches) a binding for `=`-style declarations - always
   * resolves to THIS scope, shadowing any same-named binding in a parent. */
  declare(name: string): Binding {
    let b = this.vars.get(name);
    if (!b) {
      b = new Binding();
      this.vars.set(name, b);
    }
    return b;
  }
  /** Finds an EXISTING binding by walking up to the parent - for `:=`
   * reassignment and plain reads, which must resolve to a variable
   * declared somewhere in an enclosing scope, not silently create one. */
  resolve(name: string): Binding | null {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let s: Scope | null = this;
    while (s) {
      const b = s.vars.get(name);
      if (b) return b;
      s = s.parent;
    }
    return null;
  }
}

export interface UserFunction {
  name: string;
  params: string[];
  body: Stmt[];
  scope: Scope; // persistent across all calls/bars - see interpreter.ts module doc
}

interface BreakSignal {
  __signal: "break";
}
interface ContinueSignal {
  __signal: "continue";
}
const BREAK: BreakSignal = { __signal: "break" };
const CONTINUE: ContinueSignal = { __signal: "continue" };
export function isSignal(v: unknown): v is BreakSignal | ContinueSignal {
  return !!v && typeof v === "object" && "__signal" in (v as object);
}

export class PineRuntimeError extends Error {}

/** Resolved call arguments: named args matched by name, positional args
 * filled into the given parameter name list in order. Extra positional
 * args beyond the list, or arg names not in the list, are kept in
 * `extra`/`extraNamed` for builtins with loose/overflow signatures. */
export interface ResolvedArgs {
  [param: string]: unknown;
}

export type BuiltinFn = (args: ResolvedArgs, ctx: BuiltinCtx) => unknown;

export interface BuiltinCtx {
  bar: number;
  bars: Bar[];
  interp: Interpreter;
}

export interface NamespaceFn {
  params: string[];
  call: BuiltinFn;
  /** Functions that need lookback over a SERIES argument (ta.highest and
   * friends: Pine passes `high`/`low` and the function walks their history
   * itself) can't work from a single pre-evaluated scalar. When set, the
   * interpreter calls `callRaw` instead of `call`, passing the unevaluated
   * argument expressions plus a `seriesAt` helper so the function can pull
   * values at any bar offset on its own. */
  callRaw?: (args: Arg[], ctx: BuiltinCtx & { scope: Scope; seriesAt: (expr: Expr, offset: number) => unknown }) => unknown;
}

export interface Namespace {
  functions: Record<string, NamespaceFn>;
  constants: Record<string, unknown>;
}

/** What a Call AST node's callee statically resolves to - see
 * Interpreter.callCache's doc comment for why this is safe to cache per
 * node. */
type CallResolution =
  | { kind: "user"; name: string }
  | { kind: "input"; property: string }
  | { kind: "global"; fn: NamespaceFn }
  | { kind: "callRaw"; fn: NamespaceFn }
  | { kind: "namespace"; fn: NamespaceFn };

export interface StdlibTable {
  namespaces: Record<string, Namespace>;
  globals: Record<string, NamespaceFn>;
  /** object.method(...) sugar dispatch keyed by the object's runtime tag
   * (see kinds in stdlib.ts: "line" | "box" | "label"). */
  methodNamespaceForTag: Record<string, string>;
  makeColorLiteral: (hex: string) => unknown;
}

/** A closed trade a script reported via backtest.recordTrade() (see
 * stdlib.ts's `backtest` namespace) - deliberately shaped to match this
 * app's own `Trade` type (data/types.ts) field-for-field, so a script's
 * results can drop straight into the existing Trades panel / pane-header
 * stats / journal without a translation layer. `id` is deterministic
 * (derived from entry/exit bar, not random) so a client-side "remove this
 * trade" choice stays stable across re-runs of the same script. */
export interface PineTradeRecord {
  id: string;
  dir: "long" | "short";
  entryBar: number;
  entryPrice: number;
  sl: number;
  tp: number;
  exitBar: number;
  result: "Win" | "Lose";
  r: number;
  setup: string;
}

export interface PineOutputs {
  lines: Record<string, unknown>[];
  boxes: Record<string, unknown>[];
  labels: Record<string, unknown>[];
  plots: { name: string; points: { time: number; value: number }[]; color: string }[];
  trades: PineTradeRecord[];
  errors: string[];
}

export interface InputDef {
  key: string; // the variable name it's assigned to
  kind: "bool" | "int" | "float" | "string" | "color" | "generic";
  title: string;
  defaultValue: unknown;
  options?: string[];
  minval?: number;
  maxval?: number;
  group?: string;
}

export class Interpreter {
  program: Stmt[];
  bars: Bar[];
  global = new Scope(null);
  functions = new Map<string, UserFunction>();
  stdlib: StdlibTable;
  inputOverrides: Record<string, unknown>;
  inputDefs: InputDef[] = [];
  bar = 0;
  /** @internal - widened for compiler.ts */ inputCallCounter = 0;
  /** @internal */ inputCache: unknown[] = [];
  /** @internal */ currentAssignTarget: string | null = null;
  /** @internal */ allBindings: Binding[] = [];
  /** Caches which Binding a given Ident/history-ref/Reassign AST node
   * resolves to, keyed by the node object itself. Safe because Pine
   * scoping in this interpreter is purely static: blocks (if/for bodies)
   * share their enclosing scope rather than creating a new one, and a user
   * function's scope is created once (in hoistFunctions) and reused for
   * every call to it, including recursive ones - so for a GIVEN AST node,
   * scope.resolve(name) returns the exact same Binding on every bar/call,
   * forever. Without this, every identifier read re-walked the scope
   * chain (a Map.get per ancestor scope) from scratch, every single bar -
   * see the "Scope.resolve" line item in the Pine interpreter profiling
   * report this was built from. Only successful resolutions are cached;
   * an unresolved name throws immediately (aborting the run), so there's
   * no second evaluation of that node to benefit from a cached miss. */
  private identCache = new WeakMap<object, Binding>();
  /** Caches which function a given Call AST node's callee resolves to
   * (user function / input() / a stdlib global / a stdlib namespace
   * function, raw or not) - same staticness argument as identCache:
   * `this.functions` and `this.stdlib` never change after hoistFunctions
   * runs, so a Call node's callee always resolves the same way. The one
   * call shape that's genuinely dynamic - `obj.method(args)` method-call
   * sugar, where the target namespace depends on the RUNTIME value's own
   * __pine tag - is deliberately never cached; see evalCall's own comment
   * at that branch. */
  private callCache = new WeakMap<object, CallResolution>();
  /** Caches the ResolvedArgs OUTPUT object per Call AST node's `args` array
   * (used as the key since it's a stable, unique-per-call-site array
   * created once at parse time), so a hot call site (e.g. smc.pine's
   * FVGDraw, which calls box.get_top/box.get_bottom/array.get/label.set_x
   * tens of millions of times across a full run) doesn't allocate a fresh
   * object on every single call - see the profiling report in
   * terminal/README.md#performance ("Pine interpreter - Phase 2") this was
   * built from: resolveArgs was ~15% of total self-time, largely from this
   * per-call allocation. This is safe to reuse across bars/iterations
   * because, for a GIVEN args array: (1) paramNames is always the exact
   * same array reference every time (callCache's own doc comment already
   * establishes a Call node's callee - and therefore its target function's
   * .params - never changes across the run), and (2) args.length and each
   * Arg's `.name` are fixed at parse time, so the exact SET of object keys
   * written by the loop below is identical on every invocation of this
   * call site, forever - any paramName never covered by that fixed set
   * simply stays at its one-time `undefined` initialization for the life
   * of the run, exactly as if a fresh object had been re-initialized to
   * undefined every time. No stdlib function in stdlib.ts stores the whole
   * ResolvedArgs object anywhere (verified: every consumer only reads
   * individual field VALUES, immediately, synchronously - grepped for any
   * `return args`/object-spread of the parameter itself, found none), and
   * none of the call sites this applies to (only resolveArgs's "global"/
   * "namespace" dispatch kinds - method-call-sugar's
   * resolveArgsWithLeadingValue is deliberately left untouched, same
   * reasoning as callCache never caching that dynamic-dispatch branch) can
   * re-enter themselves mid-evaluation (no user-recursive Pine functions in
   * either target script, and a stdlib call's own argument expressions
   * can't textually reference that same call site again without infinite
   * recursion), so there's no risk of two in-flight uses of the same cached
   * object colliding. */
  private argsCache = new WeakMap<Arg[], ResolvedArgs>();
  /** Single reusable BuiltinCtx object, mutated in place rather than
   * reallocated on every stdlib/global call (see ctx()) - `bars` and
   * `interp` never change for the lifetime of an Interpreter instance, and
   * `bar` only changes once per outer bar-loop iteration, not once per
   * call, so a fresh {bar,bars,interp} literal on every single call (tens
   * of millions of times for a hot call site - see argsCache's comment
   * above) was a pure allocation cost with no observable purpose. Safe for
   * the same reason argsCache is safe: verified (grep) that no stdlib
   * function stores the ctx object itself past its own synchronous call -
   * every consumer reads `ctx.bar`/`ctx.bars`/`ctx.interp` immediately and
   * only ever needs the CURRENT bar's values, never a snapshot of some
   * earlier bar's. */
  private sharedCtx: BuiltinCtx;
  lineRegistry = new Map<string, Record<string, unknown>>();
  boxRegistry = new Map<string, Record<string, unknown>>();
  labelRegistry = new Map<string, Record<string, unknown>>();
  /** Pine auto-evicts the OLDEST drawing object of a kind (FIFO) once a
   * script exceeds the max_lines_count/max_boxes_count/max_labels_count it
   * declared in indicator(...) - scripts routinely rely on this instead of
   * manually deleting (e.g. redrawing a "live" label every bar). Defaults
   * match Pine's own default of 50 when a script doesn't specify one. */
  maxLines = 50;
  maxBoxes = 50;
  maxLabels = 50;

  private registerCapped(registry: Map<string, Record<string, unknown>>, id: string, obj: Record<string, unknown>, max: number) {
    registry.set(id, obj);
    if (registry.size > max) {
      const oldest = registry.keys().next().value;
      if (oldest !== undefined) registry.delete(oldest);
    }
  }
  registerLine(obj: Record<string, unknown> & { id: string }) {
    this.registerCapped(this.lineRegistry, obj.id, obj, this.maxLines);
  }
  registerBox(obj: Record<string, unknown> & { id: string }) {
    this.registerCapped(this.boxRegistry, obj.id, obj, this.maxBoxes);
  }
  registerLabel(obj: Record<string, unknown> & { id: string }) {
    this.registerCapped(this.labelRegistry, obj.id, obj, this.maxLabels);
  }
  /** Called by line.delete()/box.delete()/label.delete() (see stdlib.ts) in
   * addition to setting `.deleted = true` on the object itself. A deleted
   * object can never become undeleted and will never appear in output
   * again (collectOutputs already filters `!x.deleted`), so there's no
   * behavior difference between leaving it soft-deleted-but-registered
   * until the max_lines_count/max_boxes_count/max_labels_count FIFO cap
   * eventually evicts it, versus removing it right away - except that a
   * script declaring a very large *_count (smc.pine sets max_lines_count/
   * max_labels_count to 1,000,000 and max_boxes_count to 500,000, so the
   * FIFO cap essentially never triggers) would otherwise accumulate
   * hundreds of thousands of dead-but-still-registered entries over a long
   * run, growing the live heap and the one-time collectOutputs() filter
   * pass for no observable benefit. Measured on smc.pine over 100k bars:
   * ~8% lower peak heap, byte-identical output. */
  deleteLine(id: string) {
    this.lineRegistry.delete(id);
  }
  deleteBox(id: string) {
    this.boxRegistry.delete(id);
  }
  deleteLabel(id: string) {
    this.labelRegistry.delete(id);
  }
  plotSeries = new Map<string, { time: number; value: number }[]>();
  plotColors = new Map<string, string>();
  /** Keyed by id so a script recording the "same" trade again (e.g. a
   * re-run after an unrelated input change) overwrites rather than
   * duplicates it - see PineTradeRecord's id-stability doc comment. */
  tradeRegistry = new Map<string, PineTradeRecord>();
  errors: string[] = [];
  /** @internal */ nextObjId = 1;
  /** @internal */ aborted = false;

  recordTrade(trade: Omit<PineTradeRecord, "id"> & { boxes?: (PineBox | null)[] }) {
    const id = `t${trade.entryBar}_${trade.exitBar}`;
    const { boxes, ...fields } = trade;
    this.tradeRegistry.set(id, { ...fields, id });
    // Tag the trade's own drawing objects (profit/loss zone boxes) with
    // this id so the render layer can offer "remove this trade" when the
    // user right-clicks one of them, without needing a separate lookup
    // table - see PineIndicatorLayer's context menu.
    for (const box of boxes ?? []) {
      if (box) box.tradeId = id;
    }
  }

  constructor(program: Stmt[], bars: Bar[], stdlib: StdlibTable, inputOverrides: Record<string, unknown> = {}) {
    this.program = program;
    this.bars = bars;
    this.stdlib = stdlib;
    this.inputOverrides = inputOverrides;
    this.sharedCtx = { bar: 0, bars: this.bars, interp: this };
  }

  freshObjId(): string {
    return "o" + this.nextObjId++;
  }

  /** @internal */ declareBinding(scope: Scope, name: string): Binding {
    const existing = scope.vars.get(name);
    if (existing) return existing;
    const b = scope.declare(name);
    this.allBindings.push(b);
    return b;
  }

  /** Registers every top-level function declaration before the bar loop
   * starts - a Pine function definition isn't "executed" per bar, only
   * calls to it are. */
  /** @internal */ hoistFunctions(stmts: Stmt[]) {
    for (const s of stmts) {
      if (s.kind === "FunctionDecl") {
        const fnScope = new Scope(this.global);
        this.functions.set(s.name, { name: s.name, params: s.params, body: s.body, scope: fnScope });
      }
    }
  }

  run(maxBars?: number): PineOutputs {
    this.hoistFunctions(this.program);
    const total = maxBars ? Math.min(maxBars, this.bars.length) : this.bars.length;
    for (let b = 0; b < total; b++) {
      if (this.aborted) break;
      this.bar = b;
      this.inputCallCounter = 0;
      this.carryForward(b);
      try {
        this.execBlock(this.program, this.global);
      } catch (e) {
        // Node-only debug escape hatch for the standalone test harness
        // (scratchpad/pine/test_run.ts etc.) - referenced via globalThis
        // rather than the bare `process` global so this browser-targeted
        // project doesn't need @types/node just for this one check.
        const nodeProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
        if (nodeProcess?.env?.PINE_DEBUG) throw e;
        if (e instanceof PineRuntimeError) {
          this.errors.push(`Bar ${b}: ${e.message}`);
          this.aborted = true;
        } else {
          throw e;
        }
      }
    }
    return this.collectOutputs();
  }

  /** Eagerly copies every existing binding's previous-bar value forward
   * into this bar (a no-op for anything this bar's execution goes on to
   * overwrite). Without this, Binding.get()'s lazy backward scan is the
   * ONLY way to resolve a rarely-reassigned `var` binding, which degrades
   * to an O(bars) scan on every single read of it - O(bindings * bars^2)
   * across a whole run. This makes every read O(1) instead. */
  /** @internal */ carryForward(bar: number) {
    if (bar === 0) return;
    for (const binding of this.allBindings) {
      const h = binding.history;
      if (h[bar] === undefined && h[bar - 1] !== undefined) h[bar] = h[bar - 1];
    }
  }

  /** @internal */ collectOutputs(): PineOutputs {
    return {
      lines: [...this.lineRegistry.values()].filter((l) => !l.deleted),
      boxes: [...this.boxRegistry.values()].filter((b) => !b.deleted),
      labels: [...this.labelRegistry.values()].filter((l) => !l.deleted),
      plots: [...this.plotSeries.entries()].map(([name, points]) => ({
        name,
        points,
        color: this.plotColors.get(name) ?? "#4f8cff",
      })),
      trades: [...this.tradeRegistry.values()],
      errors: this.errors,
    };
  }

  // ---- statement execution ----
  /** @internal */ execBlock(stmts: Stmt[], scope: Scope): unknown {
    let last: unknown = NA;
    for (const s of stmts) {
      last = this.execStmt(s, scope);
      if (isSignal(last)) return last;
    }
    return last;
  }

  /** @internal */ execStmt(stmt: Stmt, scope: Scope): unknown {
    switch (stmt.kind) {
      case "FunctionDecl":
        return NA; // hoisted already
      case "VarDecl": {
        const binding = this.declareBinding(scope, stmt.name);
        if (stmt.declKind === "var" || stmt.declKind === "varip") {
          // Only initialize once, ever - later bars keep the carried-
          // forward value (or whatever `:=` reassignment set it to).
          const already = binding.history.some((v) => v !== undefined);
          if (already) return binding.get(this.bar);
        }
        this.currentAssignTarget = stmt.name;
        const value = this.evalExpr(stmt.expr, scope);
        this.currentAssignTarget = null;
        binding.set(this.bar, value);
        return value;
      }
      case "Reassign": {
        let binding = this.identCache.get(stmt);
        if (!binding) {
          const resolved = scope.resolve(stmt.name);
          if (!resolved) throw new PineRuntimeError(`assignment to undeclared variable '${stmt.name}'`);
          binding = resolved;
          this.identCache.set(stmt, binding);
        }
        const value = this.evalExpr(stmt.expr, scope);
        binding.set(this.bar, value);
        return value;
      }
      case "ExprStmt":
        return this.evalExpr(stmt.expr, scope);
      case "ForNumeric": {
        const from = Number(this.evalExpr(stmt.from, scope));
        const to = Number(this.evalExpr(stmt.to, scope));
        const step = stmt.step ? Number(this.evalExpr(stmt.step, scope)) : from <= to ? 1 : -1;
        const binding = this.declareBinding(scope, stmt.varName);
        let result: unknown = NA;
        if (step > 0) {
          for (let i = from; i <= to; i += step) {
            binding.set(this.bar, i);
            result = this.execBlock(stmt.body, scope);
            if (isSignal(result)) {
              if (result.__signal === "break") {
                result = NA;
                break;
              }
              result = NA;
            }
          }
        } else {
          for (let i = from; i >= to; i += step) {
            binding.set(this.bar, i);
            result = this.execBlock(stmt.body, scope);
            if (isSignal(result)) {
              if (result.__signal === "break") {
                result = NA;
                break;
              }
              result = NA;
            }
          }
        }
        return result;
      }
      case "ForIn": {
        const arr = this.evalExpr(stmt.iterable, scope) as { items: unknown[] } | null;
        if (!arr || !Array.isArray(arr.items)) return NA;
        const idxBinding = this.declareBinding(scope, stmt.indexName);
        const valBinding = this.declareBinding(scope, stmt.valueName);
        let result: unknown = NA;
        const n = arr.items.length;
        for (let i = 0; i < n; i++) {
          if (i >= arr.items.length) break; // body may have removed items
          idxBinding.set(this.bar, i);
          valBinding.set(this.bar, arr.items[i]);
          result = this.execBlock(stmt.body, scope);
          if (isSignal(result)) {
            if (result.__signal === "break") {
              result = NA;
              break;
            }
            result = NA;
          }
        }
        return result;
      }
      case "Break":
        return BREAK;
      case "Continue":
        return CONTINUE;
      default:
        return NA;
    }
  }

  // ---- expression evaluation ----
  evalExpr(expr: Expr, scope: Scope): unknown {
    switch (expr.kind) {
      case "Number":
        return expr.value;
      case "String":
        return expr.value;
      case "Color":
        return this.stdlib.makeColorLiteral(expr.value);
      case "Bool":
        return expr.value;
      case "Na":
        return NA;
      case "ArrayLit":
        return { __pine: "array", items: expr.items.map((e) => this.evalExpr(e, scope)) };
      case "Ident":
        return this.evalIdent(expr, scope);
      case "Member": {
        // barstate.* is dynamic (depends on the current bar), unlike every
        // other namespace access here which is a static constant.
        if (expr.object.kind === "Ident" && expr.object.name === "barstate") {
          switch (expr.property) {
            case "islast":
            case "isconfirmed":
              return this.bar === this.bars.length - 1;
            case "isfirst":
              return this.bar === 0;
            case "ishistory":
              return this.bar < this.bars.length - 1;
            case "isrealtime":
              return false;
            case "isnew":
              return true;
          }
        }
        // Bare namespace constant access, e.g. `line.style_dashed`,
        // `color.green`, `extend.none`, `xloc.bar_time`.
        if (expr.object.kind === "Ident") {
          const ns = this.stdlib.namespaces[expr.object.name];
          if (ns && expr.property in ns.constants) return ns.constants[expr.property];
        }
        // Struct-like field access isn't supported (no `type` declarations
        // in the target scripts) - only namespace constants reach here.
        throw new PineRuntimeError(`unsupported member access '.${expr.property}'`);
      }
      case "Index": {
        const offset = Number(this.evalExpr(expr.index, scope));
        return this.evalHistoryRef(expr.object, offset, scope);
      }
      case "Unary": {
        const v = this.evalExpr(expr.expr, scope);
        return applyUnaryOp(expr.op, v);
      }
      case "Binary":
        return this.evalBinary(expr.op, expr.left, expr.right, scope);
      case "Ternary": {
        const c = this.evalExpr(expr.cond, scope);
        return toBool(c) ? this.evalExpr(expr.then, scope) : this.evalExpr(expr.else, scope);
      }
      case "IfExpr": {
        for (const branch of expr.branches) {
          const c = this.evalExpr(branch.cond, scope);
          if (toBool(c)) return this.execBlock(branch.body, scope);
        }
        if (expr.elseBody) return this.execBlock(expr.elseBody, scope);
        return NA;
      }
      case "Call":
        return this.evalCall(expr, scope);
      case "FunctionLit":
        return NA; // not used by the target scripts (no closures-as-values)
      default:
        return NA;
    }
  }

  /** @internal */ evalIdent(expr: Extract<Expr, { kind: "Ident" }>, scope: Scope): unknown {
    const name = expr.name;
    switch (name) {
      case "open":
        return this.bars[this.bar]?.open ?? NA;
      case "high":
        return this.bars[this.bar]?.high ?? NA;
      case "low":
        return this.bars[this.bar]?.low ?? NA;
      case "close":
        return this.bars[this.bar]?.close ?? NA;
      case "volume":
        return this.bars[this.bar]?.volume ?? NA;
      case "time":
        return (this.bars[this.bar]?.time ?? 0) * 1000; // Pine `time` is ms
      case "bar_index":
        return this.bar;
      case "last_bar_index":
        return this.bars.length - 1;
      case "na":
        return NA;
    }
    const cached = this.identCache.get(expr);
    if (cached) return cached.get(this.bar);
    const binding = scope.resolve(name);
    if (binding) {
      this.identCache.set(expr, binding);
      return binding.get(this.bar);
    }
    // A bare namespace-as-value reference (e.g. passing `xloc.bar_time`'s
    // parent alone) never happens in these scripts; treat unknown
    // identifiers as script-level constants from stdlib globals if present.
    const g = this.stdlib.globals[name];
    if (g) return g.call({}, this.ctx());
    throw new PineRuntimeError(`unknown identifier '${name}'`);
  }

  /** @internal */ evalHistoryRef(objExpr: Expr, offset: number, scope: Scope): unknown {
    if (objExpr.kind === "Ident") {
      const name = objExpr.name;
      const target = this.bar - offset;
      switch (name) {
        case "open":
          return this.bars[target]?.open ?? NA;
        case "high":
          return this.bars[target]?.high ?? NA;
        case "low":
          return this.bars[target]?.low ?? NA;
        case "close":
          return this.bars[target]?.close ?? NA;
        case "volume":
          return this.bars[target]?.volume ?? NA;
        case "time":
          return target >= 0 ? (this.bars[target]?.time ?? NA) * 1000 : NA;
        case "bar_index":
          return target;
      }
      const cached = this.identCache.get(objExpr);
      if (cached) return cached.get(target);
      const binding = scope.resolve(name);
      if (binding) {
        this.identCache.set(objExpr, binding);
        return binding.get(target);
      }
      throw new PineRuntimeError(`unknown identifier '${name}' in history reference`);
    }
    // History-reference on an arbitrary expression (rare in these scripts,
    // but Pine allows e.g. `(a+b)[1]`) isn't supported - series identity
    // only exists for named bindings and OHLCV.
    throw new PineRuntimeError("history-reference [] is only supported on a plain variable or OHLCV series");
  }

  /** @internal */ evalBinary(op: string, leftE: Expr, rightE: Expr, scope: Scope): unknown {
    if (op === "and") {
      const l = this.evalExpr(leftE, scope);
      if (!toBool(l)) return false;
      return toBool(this.evalExpr(rightE, scope));
    }
    if (op === "or") {
      const l = this.evalExpr(leftE, scope);
      if (toBool(l)) return true;
      return toBool(this.evalExpr(rightE, scope));
    }
    const l = this.evalExpr(leftE, scope);
    const r = this.evalExpr(rightE, scope);
    return applyBinaryOp(op, l, r);
  }

  /** @internal */ evalCall(expr: Extract<Expr, { kind: "Call" }>, scope: Scope): unknown {
    const { callee, args } = expr;

    const cached = this.callCache.get(expr);
    if (cached) return this.dispatchCall(cached, args, scope);

    if (callee.kind === "Ident") {
      if (this.functions.has(callee.name)) {
        this.callCache.set(expr, { kind: "user", name: callee.name });
        return this.callUserFunction(callee.name, args, scope);
      }
      if (INPUT_FN_NAMES.has(callee.name)) {
        this.callCache.set(expr, { kind: "input", property: "generic" });
        return this.callInput("generic", args, scope);
      }
      const g = this.stdlib.globals[callee.name];
      if (g) {
        this.callCache.set(expr, { kind: "global", fn: g });
        const resolved = this.resolveArgs(g.params, args, scope);
        return g.call(resolved, this.ctx());
      }
      throw new PineRuntimeError(`unknown function '${callee.name}'`);
    }

    if (callee.kind === "Member") {
      const { object, property } = callee;
      if (object.kind === "Ident" && object.name === "input") {
        this.callCache.set(expr, { kind: "input", property });
        return this.callInput(property, args, scope);
      }
      if (object.kind === "Ident" && this.stdlib.namespaces[object.name]) {
        const ns = this.stdlib.namespaces[object.name];
        const fn = ns.functions[property];
        if (!fn) throw new PineRuntimeError(`unknown function '${object.name}.${property}'`);
        if (fn.callRaw) {
          this.callCache.set(expr, { kind: "callRaw", fn });
          const seriesAt = (e: Expr, offset: number) => (offset === 0 ? this.evalExpr(e, scope) : this.evalHistoryRef(e, offset, scope));
          return fn.callRaw(args, { ...this.ctx(), scope, seriesAt });
        }
        this.callCache.set(expr, { kind: "namespace", fn });
        const resolved = this.resolveArgs(fn.params, args, scope);
        return fn.call(resolved, this.ctx());
      }
      // Method-call sugar: obj.method(args) where obj is a runtime value
      // tagged "line"/"box"/"label", equivalent to namespace.method(obj, args).
      // Deliberately NEVER cached (unlike every branch above): which
      // namespace this dispatches to depends on the RUNTIME value's own
      // __pine tag, which this same AST node could in principle see change
      // across bars - nothing here is statically fixed the way a plain
      // function/namespace-member callee is.
      const objVal = this.evalExpr(object, scope) as { __pine?: string } | null;
      const tag = objVal && typeof objVal === "object" ? objVal.__pine : undefined;
      const nsName = tag ? this.stdlib.methodNamespaceForTag[tag] : undefined;
      if (!nsName) throw new PineRuntimeError(`cannot call '.${property}' on this value`);
      const ns = this.stdlib.namespaces[nsName];
      const fn = ns.functions[property];
      if (!fn) throw new PineRuntimeError(`unknown function '${nsName}.${property}'`);
      const resolved = this.resolveArgsWithLeadingValue(fn.params, objVal, args, scope);
      return fn.call(resolved, this.ctx());
    }

    throw new PineRuntimeError("uncallable expression: " + JSON.stringify(callee).slice(0, 200));
  }

  /** Executes an already-resolved call - the exact same logic each branch
   * of evalCall runs on a cache miss, just without re-deriving `res`. */
  /** @internal */ dispatchCall(res: CallResolution, args: Arg[], scope: Scope): unknown {
    switch (res.kind) {
      case "user":
        return this.callUserFunction(res.name, args, scope);
      case "input":
        return this.callInput(res.property, args, scope);
      case "global": {
        const resolved = this.resolveArgs(res.fn.params, args, scope);
        return res.fn.call(resolved, this.ctx());
      }
      case "callRaw": {
        const seriesAt = (e: Expr, offset: number) => (offset === 0 ? this.evalExpr(e, scope) : this.evalHistoryRef(e, offset, scope));
        return res.fn.callRaw!(args, { ...this.ctx(), scope, seriesAt });
      }
      case "namespace": {
        const resolved = this.resolveArgs(res.fn.params, args, scope);
        return res.fn.call(resolved, this.ctx());
      }
    }
  }

  /** @internal */ callInput(kindHint: string, args: Arg[], scope: Scope): unknown {
    const idx = this.inputCallCounter++;
    if (this.bar > 0) {
      return this.inputCache[idx];
    }
    // First bar: actually resolve default/title/etc and cache for every
    // later bar - input() always yields the same value across the whole run.
    const resolved = this.resolveArgs(
      ["defval", "title", "minval", "maxval", "options", "step", "group", "inline", "tooltip"],
      args,
      scope
    );
    const key = this.currentAssignTarget ?? `input_${idx}`;
    const override = Object.prototype.hasOwnProperty.call(this.inputOverrides, key) ? this.inputOverrides[key] : undefined;
    const value = override !== undefined ? override : resolved.defval;
    this.inputCache[idx] = value;
    let kind: InputDef["kind"] = "generic";
    if (kindHint === "bool" || typeof resolved.defval === "boolean") kind = "bool";
    else if (kindHint === "int") kind = "int";
    else if (kindHint === "float") kind = "float";
    else if (kindHint === "string" || typeof resolved.defval === "string") kind = "string";
    else if (kindHint === "color" || (resolved.defval && typeof resolved.defval === "object" && (resolved.defval as { __pine?: string }).__pine === "color"))
      kind = "color";
    this.inputDefs.push({
      key,
      kind,
      title: typeof resolved.title === "string" ? resolved.title : key,
      defaultValue: resolved.defval,
      options: isPineArray(resolved.options) ? (resolved.options.items as string[]) : undefined,
      minval: typeof resolved.minval === "number" ? resolved.minval : undefined,
      maxval: typeof resolved.maxval === "number" ? resolved.maxval : undefined,
      group: typeof resolved.group === "string" ? resolved.group : undefined,
    });
    return value;
  }

  /** @internal */ callUserFunction(name: string, args: Arg[], callerScope: Scope): unknown {
    const fn = this.functions.get(name)!;
    // Evaluate arguments in the CALLER's scope, then bind into the
    // function's own persistent scope (shared across all calls/bars - see
    // module doc in the header comment above Scope).
    const values: { name: string | null; value: unknown }[] = args.map((a) => ({
      name: a.name,
      value: this.evalExpr(a.value, callerScope),
    }));
    let positional = 0;
    for (const v of values) {
      const paramName = v.name ?? fn.params[positional++];
      if (!paramName) continue;
      const binding = this.declareBinding(fn.scope, paramName);
      binding.set(this.bar, v.value);
    }
    const result = this.execBlock(fn.body, fn.scope);
    return isSignal(result) ? NA : result;
  }

  /** @internal */ resolveArgs(paramNames: string[], args: Arg[], scope: Scope): ResolvedArgs {
    // Reuse the same output object across every call to this exact call
    // site (keyed by its `args` array - see argsCache's doc comment for
    // why this is safe) instead of allocating a fresh one every time.
    let out = this.argsCache.get(args);
    if (!out) {
      out = {};
      // Pre-declare every param name, in its own fixed order, before
      // evaluating any argument - gives V8 a single stable hidden class per
      // stdlib function signature instead of building up whatever shape the
      // actually-supplied args happen to produce. This same resolveArgs body
      // runs for every stdlib call site in the script (ta.*, math.*, array.*,
      // ...), each with a different, fixed paramNames array called
      // repeatedly across every bar - without this, property writes into
      // `out` were megamorphic from V8's point of view. A param not actually
      // supplied below simply keeps the `undefined` set here, identical to
      // what reading an absent key already returned - this changes
      // allocation/property-access performance only, never an observable
      // value (nothing in this codebase checks key presence on a
      // ResolvedArgs object, only the value itself).
      for (const p of paramNames) out[p] = undefined;
      this.argsCache.set(args, out);
    }
    let positional = 0;
    for (const a of args) {
      const value = this.evalExpr(a.value, scope);
      if (a.name) out[a.name] = value;
      else out[paramNames[positional++] ?? `_pos${positional}`] = value;
    }
    return out;
  }

  /** @internal */ resolveArgsWithLeadingValue(paramNames: string[], leading: unknown, args: Arg[], scope: Scope): ResolvedArgs {
    const out: ResolvedArgs = {};
    // Same hidden-class-stability reasoning as resolveArgs above.
    for (const p of paramNames) out[p] = undefined;
    if (paramNames[0]) out[paramNames[0]] = leading;
    let positional = 1;
    for (const a of args) {
      const value = this.evalExpr(a.value, scope);
      if (a.name) out[a.name] = value;
      else out[paramNames[positional++] ?? `_pos${positional}`] = value;
    }
    return out;
  }

  ctx(): BuiltinCtx {
    this.sharedCtx.bar = this.bar;
    return this.sharedCtx;
  }
}

export const INPUT_FN_NAMES = new Set(["input"]);

/** @internal - exported for compiler.ts, which needs the exact same
 * truthiness/coercion/equality rules the interpreter uses. */
export function toBool(v: unknown): boolean {
  if (isNa(v)) return false;
  return !!v;
}
export function toNum(v: unknown): number {
  if (isNa(v)) return NaN;
  return typeof v === "number" ? v : Number(v);
}
export function isPineArray(v: unknown): v is { __pine: "array"; items: unknown[] } {
  return !!v && typeof v === "object" && (v as { __pine?: string }).__pine === "array";
}
export function pineEquals(a: unknown, b: unknown): boolean {
  if (isNa(a) && isNa(b)) return true;
  if (isNa(a) || isNa(b)) return false;
  if (typeof a === "object" && typeof b === "object") return a === b;
  return a === b;
}

/** The non-short-circuit half of Binary evaluation: everything from `==`
 * onward, given BOTH operand values already evaluated. Split out of
 * Interpreter.evalBinary so compiler.ts's compileBinary can share the
 * EXACT same operator semantics instead of re-implementing them - "and"/
 * "or" stay in evalBinary itself (and get their own compiled form) since
 * they're short-circuiting and can't be expressed as "compute from two
 * already-evaluated values". */
export function applyBinaryOp(op: string, l: unknown, r: unknown): unknown {
  if (op === "==") return pineEquals(l, r);
  if (op === "!=") return !pineEquals(l, r);
  if (op === "+") {
    if (typeof l === "string" || typeof r === "string") return (isNa(l) ? "" : String(l)) + (isNa(r) ? "" : String(r));
    if (isNa(l) || isNa(r)) return NA;
    return toNum(l) + toNum(r);
  }
  if (isNa(l) || isNa(r)) return NA;
  const ln = toNum(l);
  const rn = toNum(r);
  switch (op) {
    case "-":
      return ln - rn;
    case "*":
      return ln * rn;
    case "/":
      return ln / rn;
    case "%":
      return ln % rn;
    case "<":
      return ln < rn;
    case "<=":
      return ln <= rn;
    case ">":
      return ln > rn;
    case ">=":
      return ln >= rn;
    default:
      throw new PineRuntimeError(`unknown operator '${op}'`);
  }
}

/** Same reasoning as applyBinaryOp, for Unary. */
export function applyUnaryOp(op: string, v: unknown): unknown {
  if (op === "not") return isNa(v) ? NA : !toBool(v);
  if (op === "-") return isNa(v) ? NA : -toNum(v);
  return v;
}
