import { tokenize } from "./lexer";
import { parse, ParseError } from "./parser";
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

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { requestId, code, bars, inputOverrides } = e.data;
  try {
    const ast = parse(tokenize(code));
    const interp = new Interpreter(ast, bars, stdlib, inputOverrides);
    const outputs = interp.run();
    const response: WorkerResponse = { requestId, outputs, inputDefs: interp.inputDefs, fatalError: null };
    (self as unknown as Worker).postMessage(response);
  } catch (err) {
    const message =
      err instanceof ParseError || err instanceof PineRuntimeError ? err.message : err instanceof Error ? err.message : String(err);
    const response: WorkerResponse = {
      requestId,
      outputs: { lines: [], boxes: [], labels: [], plots: [], trades: [], errors: [message] },
      inputDefs: [],
      fatalError: message,
    };
    (self as unknown as Worker).postMessage(response);
  }
};
