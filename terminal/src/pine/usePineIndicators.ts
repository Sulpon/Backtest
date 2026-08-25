import { useEffect, useRef, useState } from "react";
import type { CandleBar } from "../data/types";
import { usePineIndicatorStore, type PineIndicator } from "./pineIndicatorStore";
import { tokenize } from "./lexer";
import { parse, ParseError } from "./parser";
import { Interpreter, PineRuntimeError, type Bar, type InputDef, type PineOutputs } from "./interpreter";
import { buildStdlib } from "./stdlib";
import type { WorkerRequest, WorkerResponse } from "./pine.worker";
import { LatestWins } from "../lib/latestWins";
import { datasetVersion, hashCode } from "./pineFingerprint";
import { getCachedPineResult, persistentCacheKey, setCachedPineResult } from "./pineIndexedDbCache";

export { datasetVersion } from "./pineFingerprint";

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
  /** Which symbol/timeframe/dataset this result was actually computed
   * against - null for the synchronous preview call sites (settings
   * dialog, Pine tab editor preview), which aren't tied to a live chart
   * pane and have nothing to race against. A consumer rendering this
   * result onto a specific pane should verify these match that pane's
   * current symbol/timeframe before using it (see ChartPane/TradesPanel) -
   * belt-and-suspenders on top of usePineIndicators' own staleness
   * guard, per the "don't rely only on React state timing" requirement. */
  symbol: string | null;
  timeframe: string | null;
  datasetVersion: string;
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
    return {
      indicator,
      outputs,
      inputDefs: interp.inputDefs,
      fatalError: null,
      windowedBars: windowed,
      symbol: null,
      timeframe: null,
      datasetVersion: datasetVersion(windowed),
    };
  } catch (e) {
    const message = e instanceof ParseError || e instanceof PineRuntimeError ? e.message : e instanceof Error ? e.message : String(e);
    return {
      indicator,
      outputs: { lines: [], boxes: [], labels: [], plots: [], trades: [], errors: [message] },
      inputDefs: [],
      fatalError: message,
      windowedBars: windowed,
      symbol: null,
      timeframe: null,
      datasetVersion: datasetVersion(windowed),
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

/** Exported for tests. The in-memory (session-only) result cache key - see
 * pineIndexedDbCache.ts for the persistent-across-reloads counterpart,
 * which uses the same components (indicator id, code, overrides, startDate,
 * dataset version) plus explicit symbol/timeframe. */
export function cacheKey(ind: PineIndicator, bars: CandleBar[]): string {
  return `${ind.id}:${hashCode(ind.code)}:${JSON.stringify(ind.inputOverrides)}:${ind.startDate ?? ""}:${datasetVersion(bars)}`;
}

function getOrComputeResult(
  ind: PineIndicator,
  bars: CandleBar[],
  symbol: string | null,
  timeframe: string | null
): Promise<PineRunResult> {
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
  const version = datasetVersion(windowed);

  const promise = (async (): Promise<PineRunResult> => {
    // A page reload wipes resultCache (in-memory only) but not IndexedDB -
    // check there before paying for a real worker run. Only meaningful
    // when the caller actually identified its symbol/timeframe (the
    // synchronous preview call sites pass null/null and never reach here
    // anyway - see runPineScript).
    if (symbol && timeframe) {
      const diskKey = persistentCacheKey(ind, symbol, timeframe, windowed);
      const fromDisk = await getCachedPineResult(diskKey);
      if (fromDisk) {
        return {
          indicator: ind,
          outputs: fromDisk.outputs,
          inputDefs: fromDisk.inputDefs,
          fatalError: fromDisk.fatalError,
          windowedBars: windowed,
          symbol,
          timeframe,
          datasetVersion: version,
        };
      }
    }

    const interpBars = toInterpBars(windowed);
    const res = await runOnWorker(ind.code, interpBars, ind.inputOverrides);
    const result: PineRunResult = {
      indicator: ind,
      outputs: res.outputs,
      inputDefs: res.inputDefs,
      fatalError: res.fatalError,
      windowedBars: windowed,
      symbol,
      timeframe,
      datasetVersion: version,
    };
    // Fire-and-forget: never let a slow/failed disk write hold up handing
    // the already-computed result back to the caller. A run that ended in
    // fatalError is deliberately not persisted - there's no expensive
    // computation to skip next time (it fails fast), and persisting a
    // transient worker-side failure (rather than a real script bug) could
    // otherwise hide a since-fixed environment issue behind a stale cached
    // error.
    if (symbol && timeframe && !res.fatalError) {
      void setCachedPineResult(persistentCacheKey(ind, symbol, timeframe, windowed), {
        outputs: res.outputs,
        inputDefs: res.inputDefs,
        fatalError: res.fatalError,
        symbol,
        timeframe,
        datasetVersion: version,
      });
    }
    return result;
  })();

  resultCache.set(key, promise);
  return promise;
}

/** Runs every visible Pine indicator over the given bars in a background
 * worker, keyed so a pan/zoom (which doesn't change `bars`' identity)
 * never re-runs it - only a genuine data/code/settings change does.
 *
 * Two distinct kinds of change are handled differently on purpose:
 *  - the DATASET changes (symbol/timeframe switch, i.e. `bars`' own
 *    content is now a different dataset): `results` is cleared to []
 *    SYNCHRONOUSLY before the new computation starts, so the caller's own
 *    "still computing" state (results.length === 0) becomes true
 *    immediately - the previous symbol/timeframe's lines/stats can never
 *    render under the new candles, even for the ~20s+ a full recompute
 *    can take. Previously `results` was left untouched until the new
 *    computation resolved, which is what let GBPUSD candles render under
 *    EURUSD's stale FVG boxes/trade stats for the entire compute window.
 *  - only SETTINGS change (indicator added/removed/toggled, code edited,
 *    an input overridden) on the SAME dataset: `results` is left alone
 *    until the new value is ready, since a cache hit here resolves in
 *    ~100-300ms and clearing first would just add a visible flash for no
 *    benefit.
 *
 * Staleness of the async result itself is guarded independently of either
 * of the above via LatestWins - see that module's doc comment. This is
 * what makes "request A (EURUSD) resolves after request B (GBPUSD) was
 * already applied" impossible regardless of React's own effect/state
 * timing: A's setResults call is skipped because its token is no longer
 * current by the time A resolves, full stop. */
export function usePineIndicators(
  bars: CandleBar[] | undefined,
  symbol?: string | null,
  timeframe?: string | null
): PineRunResult[] {
  const items = usePineIndicatorStore((s) => s.items);
  const visible = items.filter((i) => i.visible);
  const key = visible.map((i) => `${i.id}:${hashCode(i.code)}:${JSON.stringify(i.inputOverrides)}:${i.startDate ?? ""}`).join("|");
  const [results, setResults] = useState<PineRunResult[]>([]);
  const latestWinsRef = useRef<LatestWins | null>(null);
  if (!latestWinsRef.current) latestWinsRef.current = new LatestWins();
  const prevDatasetVersionRef = useRef<string | null>(null);

  useEffect(() => {
    const version = bars && bars.length > 0 ? datasetVersion(bars) : null;
    const isNewDataset = version !== prevDatasetVersionRef.current;
    prevDatasetVersionRef.current = version;

    if (!bars || bars.length === 0 || visible.length === 0) {
      setResults([]);
      return;
    }
    if (isNewDataset) setResults([]);

    const token = latestWinsRef.current!.start();
    const sym = symbol ?? null;
    const tf = timeframe ?? null;
    Promise.all(visible.map((ind) => getOrComputeResult(ind, bars, sym, tf))).then((all) => {
      if (token.isCurrent()) setResults(all);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, key, symbol, timeframe]);

  return results;
}
