import { useMemo } from "react";
import { useStrategyScanStore } from "../../strategy/strategyScanStore";
import { filterTrades } from "../../strategy/analysis/dateAnalytics";
import { historicalRStats } from "../../strategy/monteCarlo/historicalStats";
import { aggregateResults } from "../../strategy/monteCarlo/statistics";
import { myStrategyInterpretation } from "../../strategy/monteCarlo/interpretation";
import { useMonteCarloStore } from "../../strategy/monteCarlo/monteCarloStore";
import type { SimulationRunConfig } from "../../strategy/monteCarlo/types";
import { randomSeed } from "../../strategy/monteCarlo/rng";
import { MonteCarloResultsView } from "./MonteCarloResultsView";
import "./panels.css";
import "./StrategyPanel.css";
import "./DetailedAnalysis.css";
import "./MonteCarlo.css";

function dateInputToSec(value: string): number {
  return Math.floor(Date.parse(`${value}T00:00:00Z`) / 1000);
}

function signedR(n: number, digits = 2): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}R`;
}

const SIMULATION_COUNTS = [1000, 5000, 10000, 25000, 50000];
const TRADES_PER_SIM_OPTIONS: { value: string; label: string }[] = [
  { value: "historical", label: "Historical sample size" },
  { value: "50", label: "50" },
  { value: "100", label: "100" },
  { value: "250", label: "250" },
  { value: "500", label: "500" },
  { value: "1000", label: "1,000" },
];

/**
 * MY STRATEGY mode - answers "what could happen if my actual historical
 * strategy continues behaving like it has historically?" via bootstrap
 * resampling of the real Strategy Scan trade records (never a second trade
 * store - reads useStrategyScanStore directly, filters via
 * dateAnalytics.ts's own filterTrades, the exact same function/semantics
 * Detailed Analysis uses, so this mode's filter bar behaves identically to
 * that tab's, including the exitTime-only date-range rule).
 *
 * Filters/settings live in monteCarloStore.ts (setMyStrategyFilters/
 * setMyStrategySettings), which also clears any previous result the
 * instant either changes - "Run Monte Carlo" is the only thing that ever
 * produces a new one (see that store's own doc comment).
 */
export function MonteCarloMyStrategyMode() {
  const tradesMap = useStrategyScanStore((s) => s.trades);
  const allTrades = useMemo(() => Object.values(tradesMap), [tradesMap]);
  const symbolOptions = useMemo(() => [...new Set(allTrades.map((t) => t.symbol))].sort(), [allTrades]);
  const setupOptions = useMemo(() => [...new Set(allTrades.map((t) => t.setup))].sort(), [allTrades]);

  const filters = useMonteCarloStore((s) => s.myStrategyFilters);
  const setFilters = useMonteCarloStore((s) => s.setMyStrategyFilters);
  const settings = useMonteCarloStore((s) => s.myStrategySettings);
  const setSettings = useMonteCarloStore((s) => s.setMyStrategySettings);
  const run = useMonteCarloStore((s) => s.myStrategyRun);
  const runMyStrategy = useMonteCarloStore((s) => s.runMyStrategy);

  const fromSec = filters.fromDate ? dateInputToSec(filters.fromDate) : null;
  const toSec = filters.toDate ? dateInputToSec(filters.toDate) + 86400 - 1 : null;

  const filtered = useMemo(
    () => filterTrades(allTrades, filters.symbolMode === "all" ? "all" : filters.customSymbols, filters.setup, fromSec, toSec),
    [allTrades, filters.symbolMode, filters.customSymbols, filters.setup, fromSec, toSec]
  );

  const hist = useMemo(() => historicalRStats(filtered), [filtered]);

  function toggleCustomSymbol(sym: string) {
    setFilters({ customSymbols: filters.customSymbols.includes(sym) ? filters.customSymbols.filter((s) => s !== sym) : [...filters.customSymbols, sym] });
  }

  const resolvedTradesPerSim = settings.tradesPerSimulation === "historical" ? hist.count : settings.tradesPerSimulation;
  const canRun = hist.count > 0 && resolvedTradesPerSim > 0 && settings.numSimulations > 0;

  function handleRun() {
    if (!canRun) return;
    const config: SimulationRunConfig = {
      numSimulations: settings.numSimulations,
      tradesPerSimulation: resolvedTradesPerSim,
      seed: settings.seed,
      source: { kind: "bootstrap", rHistory: hist.rHistory },
    };
    void runMyStrategy(config, `Bootstrapped from ${hist.count.toLocaleString()} historical trade${hist.count === 1 ? "" : "s"}`);
  }

  const interpretationLines = useMemo(() => {
    if (!run.result) return [];
    return myStrategyInterpretation(hist.count, run.result.numSimulations, aggregateResults(run.result));
  }, [run.result, hist.count]);

  return (
    <div className="mc-mode">
      <div className="da-filter-bar">
        <div className="strategy-row">
          <label className="strategy-label">Symbols</label>
          <select className="strategy-input" value={filters.symbolMode} onChange={(e) => setFilters({ symbolMode: e.target.value as "all" | "custom" })}>
            <option value="all">All Symbols</option>
            <option value="custom">Custom</option>
          </select>
        </div>
        {filters.symbolMode === "custom" && (
          <div className="strategy-symbol-picker">
            <div className="strategy-symbol-actions">
              <button type="button" className="strategy-link-btn" onClick={() => setFilters({ customSymbols: symbolOptions })}>
                Select All
              </button>
              <button type="button" className="strategy-link-btn" onClick={() => setFilters({ customSymbols: [] })}>
                Clear All
              </button>
            </div>
            <div className="strategy-symbol-list">
              {symbolOptions.map((sym) => (
                <label key={sym} className="strategy-symbol-item">
                  <input type="checkbox" checked={filters.customSymbols.includes(sym)} onChange={() => toggleCustomSymbol(sym)} />
                  {sym}
                </label>
              ))}
              {symbolOptions.length === 0 && <span className="panel-dim">No trades yet</span>}
            </div>
          </div>
        )}
        <div className="strategy-row">
          <label className="strategy-label">Setup</label>
          <select className="strategy-input" value={filters.setup} onChange={(e) => setFilters({ setup: e.target.value })}>
            <option value="all">All Setups</option>
            {setupOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="strategy-row">
          <label className="strategy-label">Date Range</label>
          <input type="date" className="strategy-input da-date-input" value={filters.fromDate} onChange={(e) => setFilters({ fromDate: e.target.value })} />
          <span className="panel-dim">→</span>
          <input type="date" className="strategy-input da-date-input" value={filters.toDate} onChange={(e) => setFilters({ toDate: e.target.value })} />
        </div>
      </div>

      {hist.count === 0 ? (
        <div className="panel-empty">No historical trades match the selected filters.</div>
      ) : (
        <div className="panel-summary mono">
          <div>
            <span className="panel-dim">Trades</span>
            <span>{hist.count}</span>
          </div>
          <div>
            <span className="panel-dim">Win Rate</span>
            <span>{hist.winRate.toFixed(1)}%</span>
          </div>
          <div>
            <span className="panel-dim">Avg Win</span>
            <span className="pos">{signedR(hist.avgWinR)}</span>
          </div>
          <div>
            <span className="panel-dim">Avg Loss</span>
            <span className="neg">{signedR(-hist.avgLossR)}</span>
          </div>
          <div>
            <span className="panel-dim">EV</span>
            <span className={hist.expectancy >= 0 ? "pos" : "neg"}>{signedR(hist.expectancy)}</span>
          </div>
        </div>
      )}

      <div className="mc-settings">
        <div className="strategy-row">
          <label className="strategy-label">Simulations</label>
          <select className="strategy-input" value={settings.numSimulations} onChange={(e) => setSettings({ numSimulations: Number(e.target.value) })}>
            {SIMULATION_COUNTS.map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()}
              </option>
            ))}
          </select>
        </div>
        <div className="strategy-row">
          <label className="strategy-label">Trades / Simulation</label>
          <select
            className="strategy-input"
            value={String(settings.tradesPerSimulation)}
            onChange={(e) => setSettings({ tradesPerSimulation: e.target.value === "historical" ? "historical" : Number(e.target.value) })}
          >
            {TRADES_PER_SIM_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="strategy-row">
          <label className="strategy-label">Risk / Trade</label>
          <input
            type="number"
            step="0.1"
            min="0"
            className="strategy-input"
            value={settings.riskPct}
            onChange={(e) => setSettings({ riskPct: Number(e.target.value) })}
          />
          <span className="panel-dim">%</span>
        </div>
        <div className="strategy-row">
          <label className="strategy-label">Starting Balance</label>
          <input
            type="number"
            min="0"
            className="strategy-input"
            placeholder="Optional"
            value={settings.startingBalance ?? ""}
            onChange={(e) => setSettings({ startingBalance: e.target.value === "" ? null : Number(e.target.value) })}
          />
        </div>
        <div className="strategy-row">
          <label className="strategy-label">Seed</label>
          <input type="number" className="strategy-input" value={settings.seed} onChange={(e) => setSettings({ seed: Number(e.target.value) })} />
          <button type="button" className="strategy-link-btn" onClick={() => setSettings({ seed: randomSeed() })}>
            Randomize
          </button>
        </div>
        <div className="strategy-actions">
          <button type="button" className="strategy-scan-btn" onClick={handleRun} disabled={!canRun || run.status === "running"}>
            Run Monte Carlo
          </button>
        </div>
      </div>

      <MonteCarloResultsView
        run={run}
        interpretationLines={interpretationLines}
        idleHint="Configure My Strategy's filters and settings above, then press Run Monte Carlo."
      />
    </div>
  );
}
