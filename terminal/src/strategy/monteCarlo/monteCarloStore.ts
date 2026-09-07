import { create } from "zustand";
import { runChallengeMonteCarloOnWorker, runMonteCarloOnWorker } from "./monteCarloClient";
import type { CustomOutcome, MonteCarloMode, MonteCarloRawResult, OutcomeModel, SimulationRunConfig } from "./types";
import type { ChallengeRawResult, ChallengeRunConfig, ChallengeType, DrawdownType } from "./challengeTypes";

/**
 * Monte Carlo's own UI/run state - deliberately NOT persisted (unlike
 * strategyScanStore.ts): a MonteCarloRawResult/ChallengeRawResult holds
 * several typed arrays plus per-simulation samples that can reach tens of
 * MB at the spec's stated worst case, which is not something to
 * round-trip through localStorage on every run. Filters/params are small
 * and could in principle persist, but the spec's own "opening Monte Carlo
 * does NOT automatically run simulations" + "changing filters invalidates
 * results" rules mean a fresh session starting from defaults is the
 * correct/simplest behavior, not a gap.
 *
 * Never reads or writes strategy/strategyScanStore.ts, journalStore.ts, or
 * any ScanTradeRecord directly - the My Strategy mode's UI component (and,
 * for Challenge mode's "My Strategy" strategy source, the Challenge UI
 * component) reads trades itself (via useStrategyScanStore +
 * dateAnalytics.ts's filterTrades/historicalStats.ts's historicalRStats)
 * and hands this store only the resulting run config to execute - this
 * store never becomes a second trade store.
 */

export interface MyStrategyFilters {
  symbolMode: "all" | "custom";
  customSymbols: string[];
  /** "all" or one exact setup value. */
  setup: string;
  /** "" (unset) or "YYYY-MM-DD". */
  fromDate: string;
  toDate: string;
}

export interface MyStrategySettings {
  numSimulations: number;
  /** "historical" = the filtered trade set's own count (the spec's
   * default for My Strategy) - resolved to a concrete number by the UI
   * component when it builds a SimulationRunConfig. */
  tradesPerSimulation: number | "historical";
  riskPct: number;
  /** null = no dollar starting balance entered - compounded currency
   * equity/Risk Comparison still work (they use a normalized 100-unit
   * base internally, see riskEquity.ts), just nothing shown in dollars. */
  startingBalance: number | null;
  seed: number;
}

export interface LabParams {
  winRatePct: number;
  avgWinR: number;
  avgLossR: number;
  riskPct: number;
  startingBalance: number;
  tradesPerSimulation: number;
  numSimulations: number;
  seed: number;
  outcomeModel: OutcomeModel;
  customWins: CustomOutcome[];
  customLosses: CustomOutcome[];
}

export type RunStatus = "idle" | "running" | "done" | "error";

export interface ModeRunState {
  status: RunStatus;
  progress: { completed: number; total: number } | null;
  result: MonteCarloRawResult | null;
  error: string | null;
  /** e.g. "Bootstrapped from 1,284 historical trades" / "Hypothetical Win
   * Rate / RR model" - set when a run starts, shown alongside its result so
   * a user can never confuse which model produced what's on screen. */
  sourceLabel: string;
}

const IDLE_RUN_STATE: ModeRunState = { status: "idle", progress: null, result: null, error: null, sourceLabel: "" };

/** Which existing strategy model feeds the Challenge Simulator - never a
 * third model, always the same My Strategy bootstrap / Strategy Lab
 * simple-or-custom source the generic Monte Carlo modes already use. */
export type ChallengeStrategySource = "myStrategy" | "strategyLab";

export interface ChallengeFormConfig {
  challengeType: ChallengeType;
  accountSize: number;
  phase1TargetPct: number;
  phase1MaxDDPct: number;
  phase2TargetPct: number;
  phase2MaxDDPct: number;
  dailyDrawdownEnabled: boolean;
  dailyDrawdownPct: number;
  drawdownType: DrawdownType;
  profitSplitPct: number;
  challengeFee: number;
}

export interface ChallengeSimSettings {
  strategySource: ChallengeStrategySource;
  riskPct: number;
  numSimulations: number;
  tradesPerSimulation: number | "historical";
  /** Only meaningful when challengeConfig.dailyDrawdownEnabled - for
   * "My Strategy" the UI computes this from the historical trades' own
   * average trades/day (dateAnalytics.ts's tradeFrequencyAnalytics)
   * instead of using this stored value; this field is the Strategy Lab
   * (and manual-override) input. */
  tradesPerDay: number;
  seed: number;
}

export interface ChallengeModeRunState {
  status: RunStatus;
  progress: { completed: number; total: number } | null;
  result: ChallengeRawResult | null;
  error: string | null;
  sourceLabel: string;
}

const IDLE_CHALLENGE_RUN_STATE: ChallengeModeRunState = { status: "idle", progress: null, result: null, error: null, sourceLabel: "" };

interface MonteCarloStoreState {
  mode: MonteCarloMode;
  setMode: (mode: MonteCarloMode) => void;

  myStrategyFilters: MyStrategyFilters;
  setMyStrategyFilters: (patch: Partial<MyStrategyFilters>) => void;

  myStrategySettings: MyStrategySettings;
  setMyStrategySettings: (patch: Partial<MyStrategySettings>) => void;

  labParams: LabParams;
  setLabParams: (patch: Partial<LabParams>) => void;

  myStrategyRun: ModeRunState;
  labRun: ModeRunState;

  challengeConfig: ChallengeFormConfig;
  setChallengeConfig: (patch: Partial<ChallengeFormConfig>) => void;
  challengeSimSettings: ChallengeSimSettings;
  setChallengeSimSettings: (patch: Partial<ChallengeSimSettings>) => void;
  challengeRun: ChallengeModeRunState;

  /** The ONLY way a result is ever produced - never automatic (not on
   * mount, not on filter/param change - those instead clear the relevant
   * mode's result back to idle via the setters above, per the spec's
   * "changing filters must invalidate previous results / user must press
   * Run"). */
  runMyStrategy: (config: SimulationRunConfig, sourceLabel: string) => Promise<void>;
  runLab: (config: SimulationRunConfig, sourceLabel: string) => Promise<void>;
  runChallenge: (config: ChallengeRunConfig, sourceLabel: string) => Promise<void>;
}

function runOnSlot(
  slot: "myStrategyRun" | "labRun",
  set: (updater: (s: MonteCarloStoreState) => Partial<MonteCarloStoreState>) => void,
  config: SimulationRunConfig,
  sourceLabel: string
): Promise<void> {
  set((s) => ({ [slot]: { ...s[slot], status: "running", progress: { completed: 0, total: config.numSimulations }, result: null, error: null, sourceLabel } }));
  return runMonteCarloOnWorker(config, (completed, total) => {
    set((s) => ({ [slot]: { ...s[slot], progress: { completed, total } } }));
  })
    .then((result) => {
      set((s) => ({ [slot]: { ...s[slot], status: "done", result, progress: null } }));
    })
    .catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      set((s) => ({ [slot]: { ...s[slot], status: "error", error: message, progress: null } }));
    });
}

function runChallengeOnSlot(
  set: (updater: (s: MonteCarloStoreState) => Partial<MonteCarloStoreState>) => void,
  config: ChallengeRunConfig,
  sourceLabel: string
): Promise<void> {
  set((s) => ({
    challengeRun: { ...s.challengeRun, status: "running", progress: { completed: 0, total: config.numSimulations }, result: null, error: null, sourceLabel },
  }));
  return runChallengeMonteCarloOnWorker(config, (completed, total) => {
    set((s) => ({ challengeRun: { ...s.challengeRun, progress: { completed, total } } }));
  })
    .then((result) => {
      set((s) => ({ challengeRun: { ...s.challengeRun, status: "done", result, progress: null } }));
    })
    .catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      set((s) => ({ challengeRun: { ...s.challengeRun, status: "error", error: message, progress: null } }));
    });
}

export const useMonteCarloStore = create<MonteCarloStoreState>()((set) => ({
  mode: "myStrategy",
  setMode: (mode) => set({ mode }),

  myStrategyFilters: { symbolMode: "all", customSymbols: [], setup: "all", fromDate: "", toDate: "" },
  setMyStrategyFilters: (patch) =>
    set((s) => ({
      myStrategyFilters: { ...s.myStrategyFilters, ...patch },
      myStrategyRun: { ...IDLE_RUN_STATE },
    })),

  myStrategySettings: { numSimulations: 10000, tradesPerSimulation: "historical", riskPct: 1, startingBalance: null, seed: 12345 },
  setMyStrategySettings: (patch) =>
    set((s) => ({
      myStrategySettings: { ...s.myStrategySettings, ...patch },
      myStrategyRun: { ...IDLE_RUN_STATE },
    })),

  labParams: {
    winRatePct: 40,
    avgWinR: 2.45,
    avgLossR: 1,
    riskPct: 1,
    startingBalance: 100000,
    tradesPerSimulation: 100,
    numSimulations: 10000,
    seed: 12345,
    outcomeModel: "simple",
    customWins: [],
    customLosses: [],
  },
  setLabParams: (patch) =>
    set((s) => ({
      labParams: { ...s.labParams, ...patch },
      labRun: { ...IDLE_RUN_STATE },
    })),

  myStrategyRun: { ...IDLE_RUN_STATE },
  labRun: { ...IDLE_RUN_STATE },

  challengeConfig: {
    challengeType: "single",
    accountSize: 100000,
    phase1TargetPct: 8,
    phase1MaxDDPct: 10,
    phase2TargetPct: 5,
    phase2MaxDDPct: 10,
    dailyDrawdownEnabled: true,
    dailyDrawdownPct: 5,
    drawdownType: "initial",
    profitSplitPct: 80,
    challengeFee: 500,
  },
  setChallengeConfig: (patch) =>
    set((s) => ({
      challengeConfig: { ...s.challengeConfig, ...patch },
      challengeRun: { ...IDLE_CHALLENGE_RUN_STATE },
    })),

  challengeSimSettings: {
    strategySource: "myStrategy",
    riskPct: 1,
    numSimulations: 10000,
    tradesPerSimulation: "historical",
    tradesPerDay: 1,
    seed: 12345,
  },
  setChallengeSimSettings: (patch) =>
    set((s) => ({
      challengeSimSettings: { ...s.challengeSimSettings, ...patch },
      challengeRun: { ...IDLE_CHALLENGE_RUN_STATE },
    })),

  challengeRun: { ...IDLE_CHALLENGE_RUN_STATE },

  runMyStrategy: (config, sourceLabel) => runOnSlot("myStrategyRun", set, config, sourceLabel),
  runLab: (config, sourceLabel) => runOnSlot("labRun", set, config, sourceLabel),
  runChallenge: (config, sourceLabel) => runChallengeOnSlot(set, config, sourceLabel),
}));
