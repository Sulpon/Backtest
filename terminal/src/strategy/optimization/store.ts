import { create } from "zustand";
import type { CandleBar, Timeframe } from "../../data/types";
import type { PineIndicator } from "../../pine/pineIndicatorStore";
import type { ScanTradeRecord } from "../types";
import { discoverParameterDefs, generateTradesForGrid } from "./strategyEvaluation";
import { buildParameterGrid, selectParameterDefs } from "./parameterSpace";
import { splitTrainTest } from "./trainTestSplit";
import { runOptimizationOnWorker } from "./client";
import { runCandidateMonteCarlo } from "./monteCarloIntegration";
import type { CandidateMonteCarloResult } from "./monteCarloIntegration";
import type { DateRange, OptimizationObjective, OptimizationRunSummary, ParameterDef, TrainTestSplitConfig } from "./types";

/**
 * Strategy Optimization's own Zustand store - mirrors monteCarlo/
 * monteCarloStore.ts's own idle/running/done/error run-state pattern, and
 * its "changing config invalidates the previous result" convention.
 *
 * CACHING (spec item 32): this store never builds a second trade-result
 * cache. Every per-combination Pine run already goes through
 * getOrComputeResult (via strategyEvaluation.ts), which already has its
 * own two-layer cache (in-memory + persistent IndexedDB) keyed on
 * indicator id/code/inputOverrides/startDate/dataset version - re-running
 * an identical grid config already skips recomputation for whatever's
 * still cached, for free, with zero duplicate cache logic here.
 *
 * Never reads/writes strategyScanStore.ts or journalStore.ts - this store
 * generates its OWN parameter-swept trade sets via strategyEvaluation.ts,
 * entirely separate from the single "official" Strategy Scan result.
 */

export type OptimizationRunStatus = "idle" | "generating" | "scoring" | "done" | "error" | "blocked" | "cancelled";

export interface OptimizationRunState {
  status: OptimizationRunStatus;
  progress: { completed: number; total: number } | null;
  result: OptimizationRunSummary | null;
  error: string | null;
  blockedMessage: string | null;
}

const IDLE_RUN_STATE: OptimizationRunState = { status: "idle", progress: null, result: null, error: null, blockedMessage: null };

export interface CandidateMonteCarloState {
  status: "idle" | "loading" | "done" | "error";
  train: CandidateMonteCarloResult | null;
  test: CandidateMonteCarloResult | null;
  error: string | null;
}

const IDLE_CANDIDATE_MC_STATE: CandidateMonteCarloState = { status: "idle", train: null, test: null, error: null };

interface OptimizationStoreState {
  parameterDefs: ParameterDef[];
  setParameterDefs: (defs: ParameterDef[]) => void;
  updateParameterDef: (key: string, patch: Partial<ParameterDef>) => void;
  discoverParameters: (indicator: PineIndicator, bars: CandleBar[]) => void;

  /** Which discovered parameters actually participate in the grid - a
   * discovered indicator can expose many numeric inputs (display/cosmetic
   * settings alongside real strategy parameters, e.g. Ara.pine's "BOS
   * Width" or "Number of FVG to show" alongside "Fibonacci Entry Level"),
   * so nothing is swept by default - the user opts individual parameters
   * in. Reset to empty only on a fresh discoverParameters call (a
   * different indicator has an entirely different key set); editing an
   * already-selected parameter's Min/Max/Step never clears its selection. */
  selectedParameterKeys: Record<string, boolean>;
  toggleParameterSelected: (key: string) => void;

  symbolMode: "all" | "custom";
  customSymbols: string[];
  setSymbolMode: (mode: "all" | "custom") => void;
  setCustomSymbols: (symbols: string[]) => void;

  timeframe: Timeframe;
  setTimeframe: (tf: Timeframe) => void;

  startDate: number;
  setStartDate: (sec: number) => void;

  trainTestSplit: TrainTestSplitConfig;
  setTrainTestSplit: (config: TrainTestSplitConfig) => void;

  minSampleSize: number;
  setMinSampleSize: (n: number) => void;

  walkForwardFolds: number | null;
  setWalkForwardFolds: (folds: number | null) => void;

  objective: OptimizationObjective;
  setObjective: (objective: OptimizationObjective) => void;

  seed: number;
  setSeed: (seed: number) => void;

  run: OptimizationRunState;
  /** The exact trade sets and date range the current `run.result` was
   * computed from - kept on the main thread (never sent back from the
   * worker, which only returns aggregated metrics) so the Monte Carlo
   * validation step below can bootstrap from a candidate's REAL trade
   * R-history rather than a synthesized approximation. Cleared whenever
   * config changes invalidate the run. */
  lastTradesByCombo: Map<string, ScanTradeRecord[]> | null;
  lastRange: DateRange | null;

  runOptimization: (indicator: PineIndicator, symbols: string[]) => Promise<void>;
  cancelOptimization: () => void;

  selectedCandidateKey: string | null;
  selectCandidate: (key: string | null) => void;

  candidateMonteCarlo: Map<string, CandidateMonteCarloState>;
  /** Runs Monte Carlo validation for the currently selected candidate,
   * separately on its Train and Test trade R-histories (per spec: "a
   * separate OOS Monte Carlo run shown alongside Training Monte Carlo") -
   * both via the EXISTING bootstrap Monte Carlo engine, never a new one. */
  runSelectedCandidateMonteCarlo: () => Promise<void>;
}

let cancelRequested = false;

function invalidateRun(): Partial<OptimizationStoreState> {
  return { run: { ...IDLE_RUN_STATE }, selectedCandidateKey: null, candidateMonteCarlo: new Map(), lastTradesByCombo: null, lastRange: null };
}

export const useOptimizationStore = create<OptimizationStoreState>()((set, get) => ({
  parameterDefs: [],
  setParameterDefs: (defs) => set({ parameterDefs: defs, ...invalidateRun() }),
  updateParameterDef: (key, patch) =>
    set((s) => ({
      parameterDefs: s.parameterDefs.map((d) => (d.key === key ? { ...d, ...patch } : d)),
      ...invalidateRun(),
    })),
  discoverParameters: (indicator, bars) => {
    const defs = discoverParameterDefs(indicator, bars);
    set({ parameterDefs: defs, selectedParameterKeys: {}, ...invalidateRun() });
  },

  selectedParameterKeys: {},
  toggleParameterSelected: (key) =>
    set((s) => ({
      selectedParameterKeys: { ...s.selectedParameterKeys, [key]: !s.selectedParameterKeys[key] },
      ...invalidateRun(),
    })),

  symbolMode: "all",
  customSymbols: [],
  setSymbolMode: (mode) => set({ symbolMode: mode, ...invalidateRun() }),
  setCustomSymbols: (symbols) => set({ customSymbols: symbols, ...invalidateRun() }),

  timeframe: "1h",
  setTimeframe: (tf) => set({ timeframe: tf, ...invalidateRun() }),

  startDate: 0,
  setStartDate: (sec) => set({ startDate: sec, ...invalidateRun() }),

  trainTestSplit: { trainPct: 70 },
  setTrainTestSplit: (config) => set({ trainTestSplit: config, ...invalidateRun() }),

  minSampleSize: 30,
  setMinSampleSize: (n) => set({ minSampleSize: n, ...invalidateRun() }),

  walkForwardFolds: null,
  setWalkForwardFolds: (folds) => set({ walkForwardFolds: folds, ...invalidateRun() }),

  objective: "robustness",
  setObjective: (objective) => set({ objective, ...invalidateRun() }),

  seed: 12345,
  setSeed: (seed) => set({ seed, ...invalidateRun() }),

  run: { ...IDLE_RUN_STATE },
  lastTradesByCombo: null,
  lastRange: null,

  runOptimization: async (indicator, symbols) => {
    cancelRequested = false;
    const { parameterDefs, selectedParameterKeys, timeframe, startDate, trainTestSplit, minSampleSize, walkForwardFolds, objective } = get();

    const selectedDefs = selectParameterDefs(parameterDefs, selectedParameterKeys);
    if (parameterDefs.length > 0 && selectedDefs.length === 0) {
      set({ run: { ...IDLE_RUN_STATE, status: "blocked", blockedMessage: "Select at least one parameter to optimize." } });
      return;
    }

    const grid = buildParameterGrid(selectedDefs);
    if (grid.blocked) {
      set({ run: { ...IDLE_RUN_STATE, status: "blocked", blockedMessage: grid.blockedMessage } });
      return;
    }

    set({
      run: { status: "generating", progress: { completed: 0, total: grid.combinations.length }, result: null, error: null, blockedMessage: null },
      lastTradesByCombo: null,
      lastRange: null,
    });

    try {
      const tradesByCombo = await generateTradesForGrid(
        indicator,
        grid.combinations,
        symbols,
        timeframe,
        startDate,
        (completed, total) => set((s) => ({ run: { ...s.run, progress: { completed, total } } })),
        () => cancelRequested
      );

      if (tradesByCombo === null) {
        set({ run: { ...IDLE_RUN_STATE, status: "cancelled" } });
        return;
      }

      set((s) => ({ run: { ...s.run, status: "scoring" } }));

      let toSec = startDate;
      for (const trades of tradesByCombo.values()) {
        for (const t of trades) if (t.exitTime > toSec) toSec = t.exitTime;
      }
      const range: DateRange = { fromSec: startDate, toSec };

      const result = await runOptimizationOnWorker({
        combos: grid.combinations,
        defs: selectedDefs,
        tradesByCombo,
        range,
        trainTestSplit,
        minSampleSize,
        walkForwardFolds,
        objective,
      });

      set({ run: { status: "done", progress: null, result, error: null, blockedMessage: null }, lastTradesByCombo: tradesByCombo, lastRange: range });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set({ run: { ...IDLE_RUN_STATE, status: "error", error: message }, lastTradesByCombo: null, lastRange: null });
    }
  },

  cancelOptimization: () => {
    cancelRequested = true;
  },

  selectedCandidateKey: null,
  selectCandidate: (key) => set({ selectedCandidateKey: key }),

  candidateMonteCarlo: new Map(),
  runSelectedCandidateMonteCarlo: async () => {
    const { selectedCandidateKey, lastTradesByCombo, lastRange, trainTestSplit, seed, candidateMonteCarlo } = get();
    if (!selectedCandidateKey || !lastTradesByCombo || !lastRange) return;
    if (candidateMonteCarlo.get(selectedCandidateKey)?.status === "done") return; // already computed

    const trades = lastTradesByCombo.get(selectedCandidateKey) ?? [];
    const split = splitTrainTest(trades, lastRange, trainTestSplit);

    const next = new Map(candidateMonteCarlo);
    next.set(selectedCandidateKey, { ...IDLE_CANDIDATE_MC_STATE, status: "loading" });
    set({ candidateMonteCarlo: next });

    try {
      const [train, test] = await Promise.all([runCandidateMonteCarlo(split.train, seed), runCandidateMonteCarlo(split.test, seed + 1)]);
      const after = new Map(get().candidateMonteCarlo);
      after.set(selectedCandidateKey, { status: "done", train, test, error: null });
      set({ candidateMonteCarlo: after });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const after = new Map(get().candidateMonteCarlo);
      after.set(selectedCandidateKey, { ...IDLE_CANDIDATE_MC_STATE, status: "error", error: message });
      set({ candidateMonteCarlo: after });
    }
  },
}));
