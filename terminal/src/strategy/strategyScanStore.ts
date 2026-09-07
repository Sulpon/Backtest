import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ScanConfig, ScanProgressEntry, ScanStatus, ScanTradeRecord } from "./types";

/**
 * Central, persisted source of truth for the Strategy tab's historical scan
 * results - the UI (StrategyPanel/TradesPanel/StatsPanel) only ever reads
 * from here, never accumulates its own copy. Mirrors pineIndicatorStore.ts's
 * exact create(persist(...)) shape/conventions.
 *
 * `trades` is keyed by ScanTradeRecord.id (see that type's doc comment) -
 * writing the same id twice (an identical re-run of the same scan config)
 * overwrites in place rather than duplicating, which IS this app's dedup
 * mechanism, the same pattern interpreter.ts's own tradeRegistry uses for
 * live Pine trades.
 *
 * Nothing in this store is ever written outside the "Scan Historical
 * Trades" button's own click handler -> historicalScanner.ts call chain -
 * there is no automatic/background trigger anywhere.
 */
interface StrategyScanStore {
  config: ScanConfig | null;
  trades: Record<string, ScanTradeRecord>;
  status: ScanStatus;
  progress: ScanProgressEntry[];
  lastRunAt: number | null;

  setConfig: (config: ScanConfig) => void;
  /** Begins a new run: records the config used, seeds `progress` as
   * all-"pending" for the given symbols, and sets status to "scanning".
   * Deliberately does NOT clear `trades` - a fresh scan merges into
   * whatever history already exists rather than discarding it (a narrower
   * re-scan, e.g. one symbol after an "All Symbols" run, shouldn't erase
   * every other symbol's already-found trades). */
  startScan: (config: ScanConfig, symbols: string[]) => void;
  updateProgress: (symbol: string, patch: Partial<Omit<ScanProgressEntry, "symbol">>) => void;
  /** Writes new/updated trades into `trades`, keyed by id - see this
   * store's own doc comment on why this is the dedup mechanism. */
  mergeTrades: (records: ScanTradeRecord[]) => void;
  finishScan: (status: Exclude<ScanStatus, "scanning">) => void;
  /** Flips status so historicalScanner's loop stops starting new symbols
   * before its next iteration - cannot abort a symbol's run already in
   * flight (the interpreter has no cooperative-cancellation hook), only
   * stops queuing further ones. */
  cancel: () => void;
}

export const useStrategyScanStore = create<StrategyScanStore>()(
  persist(
    (set) => ({
      config: null,
      trades: {},
      status: "idle",
      progress: [],
      lastRunAt: null,

      setConfig: (config) => set({ config }),

      startScan: (config, symbols) =>
        set({
          config,
          status: "scanning",
          progress: symbols.map((symbol) => ({ symbol, status: "pending" as const })),
        }),

      updateProgress: (symbol, patch) =>
        set((s) => ({
          progress: s.progress.map((p) => (p.symbol === symbol ? { ...p, ...patch } : p)),
        })),

      mergeTrades: (records) =>
        set((s) => {
          if (records.length === 0) return s;
          const trades = { ...s.trades };
          for (const r of records) trades[r.id] = r;
          return { trades };
        }),

      finishScan: (status) => set({ status, lastRunAt: Date.now() }),

      cancel: () => set((s) => (s.status === "scanning" ? { status: "cancelled" as const } : s)),
    }),
    { name: "terminal.strategyScan" }
  )
);
