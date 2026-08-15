import { useEffect, useState } from "react";
import type { CandleBar } from "../data/types";
import { usePineIndicatorStore, type PineIndicator } from "./pineIndicatorStore";
import { tokenize } from "./lexer";
import { parse, ParseError } from "./parser";
import { Interpreter, PineRuntimeError, type Bar, type InputDef, type PineOutputs } from "./interpreter";
import { buildStdlib } from "./stdlib";
import type { WorkerRequest, WorkerResponse } from "./pine.worker";

export interface PineRunResult {
  indicator: PineIndicator;
  outputs: PineOutputs;
  inputDefs: InputDef[];
  fatalError: string | null;
  /** The EXACT bars array the interpreter ran against - see the startDate
   * filtering in usePineIndicators below. A script's `bar_index` is an
   * index into this array, not the full dataset, once startDate slices off
   * the front - PineIndicatorLayer must convert bar_index -> time using
   * this same array per-result, never a shared/full-dataset one. */
  windowedBars: CandleBar[];
}

// Used only by the cheap, synchronous call sites below (the settings
// dialog's single-bar input-metadata run, and the Pine tab's ~1000-bar
// validation preview) - both already slice their own bars before calling
// runPineScript, so this cap never actually binds for them. The live
// chart's OWN run goes through the worker (see usePineIndicators) with a
// much larger ceiling, since running off the main thread means a slow run
// doesn't freeze panning/zooming while it computes.
const PREVIEW_MAX_BARS = 5000;

function toInterpBars(bars: CandleBar[]): Bar[] {
  return bars.map((b) => ({ ...b, volume: (b as unknown as { volume?: number }).volume ?? 0 }));
}

const stdlib = buildStdlib();

export function runPineScript(indicator: PineIndicator, bars: CandleBar[]): PineRunResult {
  const windowed = bars.length > PREVIEW_MAX_BARS ? bars.slice(bars.length - PREVIEW_MAX_BARS) : bars;
  const interpBars = toInterpBars(windowed);
  try {
    const ast = parse(tokenize(indicator.code));
    const interp = new Interpreter(ast, interpBars, stdlib, indicator.inputOverrides);
    const outputs = interp.run();
    return { indicator, outputs, inputDefs: interp.inputDefs, fatalError: null, windowedBars: windowed };
  } catch (e) {
    const message = e instanceof ParseError || e instanceof PineRuntimeError ? e.message : e instanceof Error ? e.message : String(e);
    return {
      indicator,
      outputs: { lines: [], boxes: [], labels: [], plots: [], trades: [], errors: [message] },
      inputDefs: [],
      fatalError: message,
      windowedBars: windowed,
    };
  }
}

// ---- background worker plumbing for the live chart's own runs ----

// Real ceiling only, not a UX-driven cap - this app's largest datasets
// (~100k bars) already fit under it. Full history is what "whole period"
// means, and running off the main thread is what makes that safe: a run
// over 100k bars takes tens of seconds, but the chart stays responsive
// (pan/zoom/every other panel) the entire time it computes in the
// background - it just draws in once the worker replies.
const WORKER_SAFETY_CAP_BARS = 200_000;

let sharedWorker: Worker | null = null;
let nextRequestId = 1;
const pendingRequests = new Map<number, (res: WorkerResponse) => void>();

function getWorker(): Worker {
  if (!sharedWorker) {
    sharedWorker = new Worker(new URL("./pine.worker.ts", import.meta.url), { type: "module" });
    sharedWorker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const resolve = pendingRequests.get(e.data.requestId);
      if (resolve) {
        pendingRequests.delete(e.data.requestId);
        resolve(e.data);
      }
    };
  }
  return sharedWorker;
}

function runOnWorker(code: string, bars: Bar[], inputOverrides: Record<string, unknown>): Promise<WorkerResponse> {
  const requestId = nextRequestId++;
  return new Promise((resolve) => {
    pendingRequests.set(requestId, resolve);
    const req: WorkerRequest = { requestId, code, bars, inputOverrides };
    getWorker().postMessage(req);
  });
}

// ChartPane and TradesPanel (at least) each call usePineIndicators
// independently for the same indicator/bars - without sharing in-flight
// work, each one posts its OWN ~100k-bar request to the single shared
// worker, which processes messages one at a time. Adding, deleting, and
// re-adding an indicator in quick succession could pile up several of
// these (each ~110s) back to back, so a "reload, delete, re-paste" cycle
// could take several MINUTES to settle with nothing on screen in the
// meantime - not a hang, just an invisible queue. Caching the in-flight
// Promise by its exact inputs means every caller asking for the same
// (indicator, bars) combo shares the one real computation.
const resultCache = new Map<string, Promise<PineRunResult>>();
const RESULT_CACHE_MAX = 16;

function cacheKey(ind: PineIndicator, bars: CandleBar[]): string {
  const first = bars[0]?.time ?? 0;
  const last = bars[bars.length - 1]?.time ?? 0;
  return `${ind.id}:${hashCode(ind.code)}:${JSON.stringify(ind.inputOverrides)}:${ind.startDate ?? ""}:${bars.length}:${first}:${last}`;
}

function getOrComputeResult(ind: PineIndicator, bars: CandleBar[]): Promise<PineRunResult> {
  const key = cacheKey(ind, bars);
  const cached = resultCache.get(key);
  if (cached) return cached;

  if (resultCache.size >= RESULT_CACHE_MAX) {
    const oldest = resultCache.keys().next().value;
    if (oldest !== undefined) resultCache.delete(oldest);
  }

  // startDate ("apply from" - see PineIndicator's doc comment) slices
  // BEFORE the worker safety cap, so a script's own state (structure
  // tracking, open trades) genuinely starts fresh at that bar rather
  // than merely hiding earlier output - this is also what makes "journal
  // only records trades from that time" true for free: the interpreter
  // has no bars before it to record a trade from.
  const fromDate = ind.startDate ? bars.filter((b) => b.time >= ind.startDate!) : bars;
  const windowed = fromDate.length > WORKER_SAFETY_CAP_BARS ? fromDate.slice(fromDate.length - WORKER_SAFETY_CAP_BARS) : fromDate;
  const interpBars = toInterpBars(windowed);
  const promise = runOnWorker(ind.code, interpBars, ind.inputOverrides).then(
    (res): PineRunResult => ({ indicator: ind, outputs: res.outputs, inputDefs: res.inputDefs, fatalError: res.fatalError, windowedBars: windowed })
  );
  resultCache.set(key, promise);
  return promise;
}

/** Runs every visible Pine indicator over the given bars in a background
 * worker, keyed so a pan/zoom (which doesn't change `bars`' identity)
 * never re-runs it - only a genuine data/code/settings change does.
 * Returns [] until the first run resolves (and again briefly after a
 * dependency change) rather than blocking the render on it. */
export function usePineIndicators(bars: CandleBar[] | undefined): PineRunResult[] {
  const items = usePineIndicatorStore((s) => s.items);
  const visible = items.filter((i) => i.visible);
  const key = visible.map((i) => `${i.id}:${hashCode(i.code)}:${JSON.stringify(i.inputOverrides)}:${i.startDate ?? ""}`).join("|");
  const [results, setResults] = useState<PineRunResult[]>([]);

  useEffect(() => {
    if (!bars || bars.length === 0 || visible.length === 0) {
      setResults([]);
      return;
    }
    let cancelled = false;

    Promise.all(visible.map((ind) => getOrComputeResult(ind, bars))).then((all) => {
      if (!cancelled) setResults(all);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, key]);

  return results;
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
