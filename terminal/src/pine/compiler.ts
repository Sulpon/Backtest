import type { Expr, Stmt, Arg } from "./ast";
import {
  Interpreter,
  Binding,
  Scope,
  NA,
  isNa,
  isSignal,
  toBool,
  applyBinaryOp,
  applyUnaryOp,
  INPUT_FN_NAMES,
  PineRuntimeError,
  type ResolvedArgs,
  type NamespaceFn,
  type PineOutputs,
} from "./interpreter";

/**
 * Compiles a Pine AST into a tree of zero-argument JS closures, once, up
 * front - instead of re-walking (and re-dispatching on `.kind`) the AST
 * fresh on every single bar. Every compiled closure below is a small,
 * hand-written specialization of exactly what the corresponding branch of
 * Interpreter.evalExpr/execStmt already does; nothing here reimplements
 * Pine semantics independently. Where the interpreter itself factors
 * "compute the result given already-evaluated operands" into a shared
 * function (applyBinaryOp/applyUnaryOp), the compiler calls that SAME
 * function - so the compiled and interpreted paths cannot semantically
 * diverge for anything routed through it.
 *
 * A node kind this file doesn't specialize (Member, FunctionLit, method-
 * call sugar, ForNumeric, ForIn, Break, Continue) falls back to a closure
 * that calls straight into the existing interpreted evalExpr/execStmt for
 * that exact node - full AST coverage from day one, with only the
 * explicitly-compiled kinds actually getting faster.
 */

export type Compiled = () => unknown;

// ---- per-interpreter-instance cache for compiled user-function bodies -
// keyed by interpreter instance (WeakMap), never global, so two unrelated
// runCompiled() calls (different scripts/datasets) can never see each
// other's compiled functions. ----
const functionBodyCacheByInterp = new WeakMap<Interpreter, Map<string, Compiled>>();
function getFunctionBodyCache(interp: Interpreter): Map<string, Compiled> {
  let m = functionBodyCacheByInterp.get(interp);
  if (!m) {
    m = new Map();
    functionBodyCacheByInterp.set(interp, m);
  }
  return m;
}

function compileFallbackExpr(expr: Expr, interp: Interpreter, scope: Scope): Compiled {
  return () => interp.evalExpr(expr, scope);
}
function compileFallbackStmt(stmt: Stmt, interp: Interpreter, scope: Scope): Compiled {
  return () => interp.execStmt(stmt, scope);
}

// ---- literals ----

function compileLiteral(expr: Expr, interp: Interpreter): Compiled | null {
  switch (expr.kind) {
    case "Number": {
      const v = expr.value;
      return () => v;
    }
    case "String": {
      const v = expr.value;
      return () => v;
    }
    case "Bool": {
      const v = expr.value;
      return () => v;
    }
    case "Na":
      return () => NA;
    case "Color": {
      // NOT precomputed: the interpreter itself calls makeColorLiteral
      // fresh on every evaluation (a new object each time) - matching
      // that exactly rather than caching avoids any risk tied to color
      // objects being compared/held by reference anywhere.
      const hex = expr.value;
      return () => interp.stdlib.makeColorLiteral(hex);
    }
    default:
      return null;
  }
}

// ---- identifiers ----

export function compileIdentifier(expr: Extract<Expr, { kind: "Ident" }>, interp: Interpreter, scope: Scope): Compiled {
  const name = expr.name;
  switch (name) {
    case "open":
      return () => interp.bars[interp.bar]?.open ?? NA;
    case "high":
      return () => interp.bars[interp.bar]?.high ?? NA;
    case "low":
      return () => interp.bars[interp.bar]?.low ?? NA;
    case "close":
      return () => interp.bars[interp.bar]?.close ?? NA;
    case "volume":
      return () => interp.bars[interp.bar]?.volume ?? NA;
    case "time":
      return () => (interp.bars[interp.bar]?.time ?? 0) * 1000;
    case "bar_index":
      return () => interp.bar;
    case "last_bar_index":
      return () => interp.bars.length - 1;
    case "na":
      return () => NA;
  }
  // Lazily resolved once, then held directly in this closure's own
  // variable - one step further than Phase 1's identCache (a WeakMap
  // lookup every bar): once resolved, a read here is a plain closure-
  // variable access, no lookup of any kind.
  let binding: Binding | null = null;
  return () => {
    if (binding) return binding.get(interp.bar);
    const b = scope.resolve(name);
    if (b) {
      binding = b;
      return b.get(interp.bar);
    }
    const g = interp.stdlib.globals[name];
    if (g) return g.call({}, interp.ctx());
    throw new PineRuntimeError(`unknown identifier '${name}'`);
  };
}

// ---- history references: expr[offset] ----

export function compileHistoryReference(objExpr: Expr, compiledOffset: Compiled, interp: Interpreter, scope: Scope): Compiled {
  if (objExpr.kind !== "Ident") {
    // Matches evalHistoryRef's own unsupported-case error exactly.
    return () => {
      throw new PineRuntimeError("history-reference [] is only supported on a plain variable or OHLCV series");
    };
  }
  const name = objExpr.name;
  // NOTE: Number(...), not toNum(...) - the interpreter's own Index case
  // uses plain Number() on the offset, which THROWS for an NA (Symbol)
  // offset rather than coercing to NaN. Preserving that exact quirk (a
  // history-ref with an NA offset crashes the run today) rather than
  // silently changing it.
  switch (name) {
    case "open":
      return () => {
        const t = interp.bar - Number(compiledOffset());
        return interp.bars[t]?.open ?? NA;
      };
    case "high":
      return () => {
        const t = interp.bar - Number(compiledOffset());
        return interp.bars[t]?.high ?? NA;
      };
    case "low":
      return () => {
        const t = interp.bar - Number(compiledOffset());
        return interp.bars[t]?.low ?? NA;
      };
    case "close":
      return () => {
        const t = interp.bar - Number(compiledOffset());
        return interp.bars[t]?.close ?? NA;
      };
    case "volume":
      return () => {
        const t = interp.bar - Number(compiledOffset());
        return interp.bars[t]?.volume ?? NA;
      };
    case "time":
      return () => {
        const t = interp.bar - Number(compiledOffset());
        return t >= 0 ? (interp.bars[t]?.time ?? NA) * 1000 : NA;
      };
    case "bar_index":
      return () => interp.bar - Number(compiledOffset());
  }
  let binding: Binding | null = null;
  return () => {
    const t = interp.bar - Number(compiledOffset());
    if (binding) return binding.get(t);
    const b = scope.resolve(name);
    if (b) {
      binding = b;
      return b.get(t);
    }
    throw new PineRuntimeError(`unknown identifier '${name}' in history reference`);
  };
}

// ---- binary / unary ----

export function compileBinary(expr: Extract<Expr, { kind: "Binary" }>, interp: Interpreter, scope: Scope): Compiled {
  const op = expr.op;
  const compiledLeft = compileExpression(expr.left, interp, scope);
  const compiledRight = compileExpression(expr.right, interp, scope);
  if (op === "and") {
    return () => {
      if (!toBool(compiledLeft())) return false;
      return toBool(compiledRight());
    };
  }
  if (op === "or") {
    return () => {
      if (toBool(compiledLeft())) return true;
      return toBool(compiledRight());
    };
  }
  return () => applyBinaryOp(op, compiledLeft(), compiledRight());
}

function compileUnary(expr: Extract<Expr, { kind: "Unary" }>, interp: Interpreter, scope: Scope): Compiled {
  const op = expr.op;
  const compiled = compileExpression(expr.expr, interp, scope);
  return () => applyUnaryOp(op, compiled());
}

// ---- conditionals ----

function compileTernary(expr: Extract<Expr, { kind: "Ternary" }>, interp: Interpreter, scope: Scope): Compiled {
  const compiledCond = compileExpression(expr.cond, interp, scope);
  const compiledThen = compileExpression(expr.then, interp, scope);
  const compiledElse = compileExpression(expr.else, interp, scope);
  return () => (toBool(compiledCond()) ? compiledThen() : compiledElse());
}

function compileIfExpr(expr: Extract<Expr, { kind: "IfExpr" }>, interp: Interpreter, scope: Scope): Compiled {
  const branches = expr.branches.map((b) => ({
    cond: compileExpression(b.cond, interp, scope),
    body: compileBlock(b.body, interp, scope),
  }));
  const elseBody = expr.elseBody ? compileBlock(expr.elseBody, interp, scope) : null;
  return () => {
    for (const b of branches) {
      if (toBool(b.cond())) return b.body();
    }
    if (elseBody) return elseBody();
    return NA;
  };
}

// ---- calls ----

export function compileCall(expr: Extract<Expr, { kind: "Call" }>, interp: Interpreter, scope: Scope): Compiled {
  const { callee, args } = expr;

  if (callee.kind === "Ident") {
    if (interp.functions.has(callee.name)) {
      return compileUserFunctionCall(callee.name, args, interp, scope);
    }
    if (INPUT_FN_NAMES.has(callee.name)) {
      return compileInputCall("generic", args, interp, scope);
    }
    const g = interp.stdlib.globals[callee.name];
    if (g) return compileStdlibCall(g, args, interp, scope);
    return () => {
      throw new PineRuntimeError(`unknown function '${callee.name}'`);
    };
  }

  if (callee.kind === "Member") {
    const { object, property } = callee;
    if (object.kind === "Ident" && object.name === "input") {
      return compileInputCall(property, args, interp, scope);
    }
    if (object.kind === "Ident" && interp.stdlib.namespaces[object.name]) {
      const ns = interp.stdlib.namespaces[object.name];
      const fn = ns.functions[property];
      if (!fn) {
        const nsName = object.name;
        return () => {
          throw new PineRuntimeError(`unknown function '${nsName}.${property}'`);
        };
      }
      if (fn.callRaw) return compileCallRaw(fn, args, interp, scope);
      return compileStdlibCall(fn, args, interp, scope);
    }
    // Method-call sugar (obj.method(args)): deliberately never compiled,
    // same reasoning as Phase 1's callCache - which namespace this
    // dispatches to depends on the RUNTIME value's own tag, not anything
    // fixed at this AST position.
    return compileFallbackExpr(expr, interp, scope);
  }

  return () => {
    throw new PineRuntimeError("uncallable expression: " + JSON.stringify(callee).slice(0, 200));
  };
}

function compileInputCall(kindHint: string, args: Arg[], interp: Interpreter, scope: Scope): Compiled {
  // callInput already has its own bar>0 fast path and is called at most a
  // handful of times per script - reused as-is rather than specialized.
  return () => interp.callInput(kindHint, args, scope);
}

function compileCallRaw(fn: NamespaceFn, args: Arg[], interp: Interpreter, scope: Scope): Compiled {
  // callRaw builtins (ta.highest/lowest/...) want the raw, unevaluated Arg[]
  // plus a seriesAt helper - they do their own dynamic-offset history
  // walking at runtime, so there's nothing to usefully precompile here.
  // Reused as-is, matching evalCall's own callRaw branch exactly.
  return () => {
    const seriesAt = (e: Expr, offset: number) => (offset === 0 ? interp.evalExpr(e, scope) : interp.evalHistoryRef(e, offset, scope));
    return fn.callRaw!(args, { ...interp.ctx(), scope, seriesAt });
  };
}

/** Precomputes the {key, compiledValue} slot list ONCE - the exact same
 * name/positional resolution resolveArgs does every bar (named args by
 * name, positional args filled into paramNames in order, `??` short-
 * circuiting so a named arg never consumes a positional slot), just done
 * once instead of per-bar. Still builds a genuinely fresh ResolvedArgs
 * object per call (same hidden-class pre-declaration as Phase 1's
 * resolveArgs) - builtins get the same "new object every time" contract
 * they always have. */
function compileResolveArgs(paramNames: string[], args: Arg[], interp: Interpreter, scope: Scope): () => ResolvedArgs {
  let positional = 0;
  const slots = args.map((a) => {
    const key = a.name ?? (paramNames[positional++] ?? `_pos${positional}`);
    return { key, compiled: compileExpression(a.value, interp, scope) };
  });
  return () => {
    const out: ResolvedArgs = {};
    for (const p of paramNames) out[p] = undefined;
    for (const s of slots) out[s.key] = s.compiled();
    return out;
  };
}

function compileStdlibCall(fn: NamespaceFn, args: Arg[], interp: Interpreter, scope: Scope): Compiled {
  const buildArgs = compileResolveArgs(fn.params, args, interp, scope);
  return () => fn.call(buildArgs(), interp.ctx());
}

function compileUserFunctionCall(name: string, args: Arg[], interp: Interpreter, scope: Scope): Compiled {
  const compiledArgs = args.map((a) => ({ name: a.name, compiled: compileExpression(a.value, interp, scope) }));
  return () => {
    const fn = interp.functions.get(name)!;
    // Two-phase, matching callUserFunction exactly: evaluate EVERY arg (in
    // the CALLER's scope) before binding ANY of them into the callee's
    // persistent scope. Matters for a function calling itself: an arg
    // expression referencing the function's own parameter must see the
    // value from before THIS call started, not a sibling arg's just-bound
    // one - interleaving evaluate+bind per-arg (instead of this two-phase
    // approach) would silently break that one case.
    const values = compiledArgs.map((a) => ({ name: a.name, value: a.compiled() }));
    let positional = 0;
    for (const v of values) {
      const paramName = v.name ?? fn.params[positional++];
      if (!paramName) continue;
      const binding = interp.declareBinding(fn.scope, paramName);
      binding.set(interp.bar, v.value);
    }
    const cache = getFunctionBodyCache(interp);
    let compiledBody = cache.get(name);
    if (!compiledBody) {
      compiledBody = compileBlock(fn.body, interp, fn.scope);
      cache.set(name, compiledBody);
    }
    const result = compiledBody();
    return isSignal(result) ? NA : result;
  };
}

// ---- assignment / reassignment ----

export function compileAssignment(stmt: Extract<Stmt, { kind: "VarDecl" }>, interp: Interpreter, scope: Scope): Compiled {
  const compiledExpr = compileExpression(stmt.expr, interp, scope);
  const isPersistent = stmt.declKind === "var" || stmt.declKind === "varip";
  const name = stmt.name;
  let binding: Binding | null = null;
  // `initialized` caches the result of binding.history.some(v => v !==
  // undefined) once it becomes true - a value that, once true, can never
  // become false again (set() never un-sets a slot), so scanning the
  // WHOLE history array on every single bar (as the interpreted path
  // still does, unchanged) to answer "has this var ever been initialized"
  // is pure repeated work this compiled path can skip after the first hit.
  let initialized = false;
  return () => {
    if (!binding) binding = interp.declareBinding(scope, name);
    if (isPersistent) {
      if (!initialized) initialized = binding.history.some((v) => v !== undefined);
      if (initialized) return binding.get(interp.bar);
    }
    interp.currentAssignTarget = name;
    const value = compiledExpr();
    interp.currentAssignTarget = null;
    binding.set(interp.bar, value);
    initialized = true;
    return value;
  };
}

export function compileReassignment(stmt: Extract<Stmt, { kind: "Reassign" }>, interp: Interpreter, scope: Scope): Compiled {
  const compiledExpr = compileExpression(stmt.expr, interp, scope);
  const name = stmt.name;
  let binding: Binding | null = null;
  return () => {
    if (!binding) {
      const resolved = scope.resolve(name);
      if (!resolved) throw new PineRuntimeError(`assignment to undeclared variable '${name}'`);
      binding = resolved;
    }
    const value = compiledExpr();
    binding.set(interp.bar, value);
    return value;
  };
}

// ---- top-level dispatchers ----

export function compileExpression(expr: Expr, interp: Interpreter, scope: Scope): Compiled {
  const literal = compileLiteral(expr, interp);
  if (literal) return literal;
  switch (expr.kind) {
    case "ArrayLit": {
      const items = expr.items.map((e) => compileExpression(e, interp, scope));
      return () => ({ __pine: "array", items: items.map((c) => c()) });
    }
    case "Ident":
      return compileIdentifier(expr, interp, scope);
    case "Member":
      return compileFallbackExpr(expr, interp, scope);
    case "Index": {
      const compiledOffset = compileExpression(expr.index, interp, scope);
      return compileHistoryReference(expr.object, compiledOffset, interp, scope);
    }
    case "Unary":
      return compileUnary(expr, interp, scope);
    case "Binary":
      return compileBinary(expr, interp, scope);
    case "Ternary":
      return compileTernary(expr, interp, scope);
    case "IfExpr":
      return compileIfExpr(expr, interp, scope);
    case "Call":
      return compileCall(expr, interp, scope);
    case "FunctionLit":
      return () => NA; // matches evalExpr's own no-op for this kind
    default:
      return () => NA;
  }
}

export function compileStatement(stmt: Stmt, interp: Interpreter, scope: Scope): Compiled {
  switch (stmt.kind) {
    case "FunctionDecl":
      return () => NA; // hoisted already, matches execStmt
    case "VarDecl":
      return compileAssignment(stmt, interp, scope);
    case "Reassign":
      return compileReassignment(stmt, interp, scope);
    case "ExprStmt":
      return compileExpression(stmt.expr, interp, scope);
    case "ForNumeric":
    case "ForIn":
    case "Break":
    case "Continue":
      return compileFallbackStmt(stmt, interp, scope);
    default:
      return compileFallbackStmt(stmt, interp, scope);
  }
}

export function compileBlock(stmts: Stmt[], interp: Interpreter, scope: Scope): Compiled {
  const compiled = stmts.map((s) => compileStatement(s, interp, scope));
  return () => {
    let last: unknown = NA;
    for (const c of compiled) {
      last = c();
      if (isSignal(last)) return last;
    }
    return last;
  };
}

/** The compiled counterpart of Interpreter.run() - same bar loop, same
 * carryForward/error-handling/collectOutputs, just executing one pre-
 * compiled closure per bar instead of re-walking the AST. Does not modify
 * or call Interpreter.run() itself; Phase 1's interpreted path is
 * untouched and still reachable exactly as before. */
export function runCompiled(interp: Interpreter, maxBars?: number): PineOutputs {
  interp.hoistFunctions(interp.program);
  const total = maxBars ? Math.min(maxBars, interp.bars.length) : interp.bars.length;
  const compiledProgram = compileBlock(interp.program, interp, interp.global);
  for (let b = 0; b < total; b++) {
    if (interp.aborted) break;
    interp.bar = b;
    interp.inputCallCounter = 0;
    interp.carryForward(b);
    try {
      compiledProgram();
    } catch (e) {
      const nodeProcess = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
      if (nodeProcess?.env?.PINE_DEBUG) throw e;
      if (e instanceof PineRuntimeError) {
        interp.errors.push(`Bar ${b}: ${e.message}`);
        interp.aborted = true;
      } else {
        throw e;
      }
    }
  }
  return interp.collectOutputs();
}

// re-exported for tests
export { isNa };
