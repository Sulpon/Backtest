import { tokenize } from "./lexer";
import { parse, ParseError } from "./parser";
import type { Stmt } from "./ast";
import { Interpreter, PineRuntimeError, type Bar, type InputDef, type PineOutputs } from "./interpreter";
import { buildStdlib } from "./stdlib";

/** Runs the Pine interpreter off the main thread so a full-history run (up
 * to 100k+ bars for this app's largest datasets) doesn't freeze chart
 * panning/zooming while it computes - see usePineIndicators.ts, which
 * posts one message per (indicator, bars) run and matches replies back up
 * by requestId. Pure computation, no DOM - safe to run in a worker as-is. */
const stdlib = buildStdlib();

export interface WorkerRequest {
  requestId: number;
  code: string;
  bars: Bar[];
  inputOverrides: Record<string, unknown>;
}

export interface WorkerResponse {
  requestId: number;
  outputs: PineOutputs;
  inputDefs: InputDef[];
  fatalError: string | null;
}

/** In-worker cache from raw source string -> parsed AST. Keyed on the full
 * script text (not a hash) - worker state is in-memory only, so a hashed
 * key buys nothing and reintroduces collision risk for zero benefit; Pine
 * scripts are at most a few KB, so V8's string hashing for Map keys is not
 * a bottleneck. Bounded to AST_CACHE_MAX entries with simple FIFO eviction
 * (oldest-inserted key first) since Map preserves insertion order. This
 * saves the re-tokenize/re-parse cost on repeated runs of the same script
 * text (e.g. switching symbol/timeframe with the same indicator still
 * attached), independent of which execution path (interp.run() below, or
 * the AST-compiled runCompiled() in compiler.ts) consumes the resulting
 * AST - re-running interp.run() itself needs no cache, it's the parse step
 * this avoids repeating.
 *
 * Note: this worker deliberately still uses interp.run() (the Phase-1
 * tree-walking interpreter), not compiler.ts's runCompiled(). A measured
 * benchmark against the real smc.pine script over the real ~100k-bar
 * EURUSD 1h dataset showed no meaningful speedup from runCompiled() at
 * this scale (median ~22.0s vs ~21.8s for interp.run(), within noise) -
 * not enough measured benefit to justify a new production execution path.
 * Revisit if a future profiling pass shows a different workload where it
 * actually wins. */
const AST_CACHE_MAX = 20;
const astCache = new Map<string, Stmt[]>();
function getOrParseAst(code: string): Stmt[] {
  const cached = astCache.get(code);
  if (cached) return cached;
  const ast = parse(tokenize(code));
  if (astCache.size >= AST_CACHE_MAX) {
    const oldest = astCache.keys().next().value;
    if (oldest !== undefined) astCache.delete(oldest);
  }
  astCache.set(code, ast);
  return ast;
}

/** Pure request -> response logic, extracted from onmessage so it's
 * directly unit-testable without a real Worker/jsdom shim. */
export function handleWorkerRequest(req: WorkerRequest): WorkerResponse {
  const { requestId, code, bars, inputOverrides } = req;
  try {
    const ast = getOrParseAst(code);
    const interp = new Interpreter(ast, bars, stdlib, inputOverrides);
    const outputs = interp.run();
    return { requestId, outputs, inputDefs: interp.inputDefs, fatalError: null };
  } catch (err) {
    const message =
      err instanceof ParseError || err instanceof PineRuntimeError ? err.message : err instanceof Error ? err.message : String(err);
    return {
      requestId,
      outputs: { lines: [], boxes: [], labels: [], plots: [], trades: [], errors: [message] },
      inputDefs: [],
      fatalError: message,
    };
  }
}

// Guarded so this module can be imported directly in a plain Node test
// environment (to unit-test handleWorkerRequest without a real Worker/
// jsdom shim) without throwing on a missing `self` global. In an actual
// worker context `self` always exists, so this is a no-op there.
if (typeof self !== "undefined") {
  self.onmessage = (e: MessageEvent<WorkerRequest>) => {
    (self as unknown as Worker).postMessage(handleWorkerRequest(e.data));
  };
}
