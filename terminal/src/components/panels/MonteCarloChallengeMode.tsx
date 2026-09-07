import { useMemo, useState } from "react";
import { useStrategyScanStore } from "../../strategy/strategyScanStore";
import { filterTrades, tradeFrequencyAnalytics } from "../../strategy/analysis/dateAnalytics";
import { historicalRStats } from "../../strategy/monteCarlo/historicalStats";
import { expectedValueR } from "../../strategy/monteCarlo/labMath";
import { validateChallengeConfig, type ChallengeConfigInput } from "../../strategy/monteCarlo/challengeValidation";
import { useMonteCarloStore, type ChallengeFormConfig } from "../../strategy/monteCarlo/monteCarloStore";
import { randomSeed } from "../../strategy/monteCarlo/rng";
import type { ChallengeConfig, ChallengeRunConfig } from "../../strategy/monteCarlo/challengeTypes";
import type { OutcomeSource } from "../../strategy/monteCarlo/types";
import { ChallengeResultsView } from "./ChallengeResultsView";
import "./panels.css";
import "./StrategyPanel.css";
import "./MonteCarlo.css";

const SIMULATION_COUNTS = [1000, 5000, 10000, 25000, 50000];
const TRADES_PER_SIM_PRESETS = [50, 100, 250, 500, 1000];
const ACCOUNT_SIZES = [10000, 25000, 50000, 100000, 200000];

type PresetKey = "custom" | "single" | "twoPhase";

const PRESETS: Record<Exclude<PresetKey, "custom">, Partial<ChallengeFormConfig>> = {
  single: {
    challengeType: "single",
    phase1TargetPct: 8,
    phase1MaxDDPct: 10,
    dailyDrawdownEnabled: true,
    dailyDrawdownPct: 5,
  },
  twoPhase: {
    challengeType: "two-phase",
    phase1TargetPct: 8,
    phase2TargetPct: 5,
    phase1MaxDDPct: 10,
    phase2MaxDDPct: 10,
    dailyDrawdownEnabled: true,
    dailyDrawdownPct: 5,
  },
};

function toEngineChallengeConfig(form: ChallengeFormConfig): ChallengeConfig {
  return {
    challengeType: form.challengeType,
    phase1: { profitTargetPct: form.phase1TargetPct, maxDrawdownPct: form.phase1MaxDDPct },
    phase2: form.challengeType === "two-phase" ? { profitTargetPct: form.phase2TargetPct, maxDrawdownPct: form.phase2MaxDDPct } : null,
    drawdownType: form.drawdownType,
    dailyDrawdownPct: form.dailyDrawdownEnabled ? form.dailyDrawdownPct : null,
    profitSplitPct: form.profitSplitPct,
    challengeFee: form.challengeFee,
  };
}

function signedR(n: number, digits = 2): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}R`;
}

/**
 * CHALLENGE mode - "Given this strategy and this prop-firm challenge
 * configuration, what is the probability that I pass the challenge?"
 * (per spec). Reuses, never duplicates:
 *  - the historical Strategy Scan trades (via useStrategyScanStore +
 *    dateAnalytics.ts's filterTrades, applying the SAME
 *    myStrategyFilters the generic My Strategy tab already configures -
 *    "the same filtered trade set" the spec asks for) for its "My
 *    Strategy" source, and historicalStats.ts's historicalRStats for its
 *    Win Rate/EV/rHistory bootstrap population - identical to the
 *    generic Monte Carlo My Strategy mode.
 *  - the generic Strategy Lab model (monteCarloStore.ts's `labParams`)
 *    for its "Strategy Lab" source - the same Win Rate/Avg Win/Avg
 *    Loss/Custom Distribution fields, never a second hypothetical model.
 *  - challengeEngine.ts/challengeStatistics.ts/challengeRiskComparison.ts
 *    for every actual calculation; this component only assembles a
 *    ChallengeRunConfig and renders ChallengeResultsView.
 */
export function MonteCarloChallengeMode() {
  const [preset, setPreset] = useState<PresetKey>("single");

  const challengeConfig = useMonteCarloStore((s) => s.challengeConfig);
  const setChallengeConfig = useMonteCarloStore((s) => s.setChallengeConfig);
  const simSettings = useMonteCarloStore((s) => s.challengeSimSettings);
  const setSimSettings = useMonteCarloStore((s) => s.setChallengeSimSettings);
  const run = useMonteCarloStore((s) => s.challengeRun);
  const runChallenge = useMonteCarloStore((s) => s.runChallenge);
  const labParams = useMonteCarloStore((s) => s.labParams);
  const myStrategyFilters = useMonteCarloStore((s) => s.myStrategyFilters);

  const tradesMap = useStrategyScanStore((s) => s.trades);
  const allTrades = useMemo(() => Object.values(tradesMap), [tradesMap]);

  const fromSec = myStrategyFilters.fromDate ? Math.floor(Date.parse(`${myStrategyFilters.fromDate}T00:00:00Z`) / 1000) : null;
  const toSec = myStrategyFilters.toDate ? Math.floor(Date.parse(`${myStrategyFilters.toDate}T00:00:00Z`) / 1000) + 86400 - 1 : null;
  const filtered = useMemo(
    () => filterTrades(allTrades, myStrategyFilters.symbolMode === "all" ? "all" : myStrategyFilters.customSymbols, myStrategyFilters.setup, fromSec, toSec),
    [allTrades, myStrategyFilters.symbolMode, myStrategyFilters.customSymbols, myStrategyFilters.setup, fromSec, toSec]
  );
  const hist = useMemo(() => historicalRStats(filtered), [filtered]);
  const historicalTradesPerDay = useMemo(() => Math.max(1, Math.round(tradeFrequencyAnalytics(filtered).avgTradesPerDay || 1)), [filtered]);

  const labEv = useMemo(() => expectedValueR(labParams.winRatePct, labParams.avgWinR, labParams.avgLossR), [labParams]);

  const isMyStrategy = simSettings.strategySource === "myStrategy";
  const resolvedTradesPerPhase = isMyStrategy
    ? simSettings.tradesPerSimulation === "historical"
      ? hist.count
      : simSettings.tradesPerSimulation
    : simSettings.tradesPerSimulation === "historical"
      ? 100
      : simSettings.tradesPerSimulation;
  const resolvedTradesPerDay = isMyStrategy ? historicalTradesPerDay : simSettings.tradesPerDay;

  function applyPreset(next: PresetKey) {
    setPreset(next);
    if (next !== "custom") setChallengeConfig(PRESETS[next]);
  }

  const validationInput: ChallengeConfigInput = {
    accountSize: challengeConfig.accountSize,
    challengeType: challengeConfig.challengeType,
    phase1TargetPct: challengeConfig.phase1TargetPct,
    phase1MaxDDPct: challengeConfig.phase1MaxDDPct,
    phase2TargetPct: challengeConfig.challengeType === "two-phase" ? challengeConfig.phase2TargetPct : null,
    phase2MaxDDPct: challengeConfig.challengeType === "two-phase" ? challengeConfig.phase2MaxDDPct : null,
    dailyDrawdownEnabled: challengeConfig.dailyDrawdownEnabled,
    dailyDrawdownPct: challengeConfig.dailyDrawdownEnabled ? challengeConfig.dailyDrawdownPct : null,
    riskPct: simSettings.riskPct,
    profitSplitPct: challengeConfig.profitSplitPct,
    challengeFee: challengeConfig.challengeFee,
    numSimulations: simSettings.numSimulations,
    tradesPerSimulation: resolvedTradesPerPhase,
  };
  const validation = validateChallengeConfig(validationInput);
  const hasStrategy = isMyStrategy ? hist.count > 0 : true;
  const canRun = validation.valid && hasStrategy && resolvedTradesPerPhase > 0;

  function handleRun() {
    if (!canRun) return;
    const source: OutcomeSource = isMyStrategy
      ? { kind: "bootstrap", rHistory: hist.rHistory }
      : labParams.outcomeModel === "custom"
        ? { kind: "custom", params: { winRatePct: labParams.winRatePct, wins: labParams.customWins, losses: labParams.customLosses } }
        : { kind: "simple", params: { winRatePct: labParams.winRatePct, avgWinR: labParams.avgWinR, avgLossR: labParams.avgLossR } };

    const config: ChallengeRunConfig = {
      numSimulations: simSettings.numSimulations,
      tradesPerPhaseCap: resolvedTradesPerPhase,
      seed: simSettings.seed,
      source,
      riskPct: simSettings.riskPct,
      accountSize: challengeConfig.accountSize,
      challenge: toEngineChallengeConfig(challengeConfig),
      tradesPerDay: challengeConfig.dailyDrawdownEnabled ? resolvedTradesPerDay : null,
    };
    const sourceLabel = isMyStrategy
      ? `Bootstrapped from ${hist.count.toLocaleString()} historical trade${hist.count === 1 ? "" : "s"}`
      : "Hypothetical Win Rate / RR model";
    void runChallenge(config, sourceLabel);
  }

  return (
    <div className="mc-mode">
      <div className="da-filter-bar">
        <div className="strategy-row">
          <label className="strategy-label">Preset</label>
          <select className="strategy-input" value={preset} onChange={(e) => applyPreset(e.target.value as PresetKey)}>
            <option value="custom">Custom</option>
            <option value="single">Single Phase Example</option>
            <option value="twoPhase">Two Phase Example</option>
          </select>
        </div>
      </div>

      <div className="mc-settings">
        <span className="da-widget-title">Challenge Settings</span>
        <div className="strategy-row">
          <label className="strategy-label">Challenge Type</label>
          <select
            className="strategy-input"
            value={challengeConfig.challengeType}
            onChange={(e) => {
              setPreset("custom");
              setChallengeConfig({ challengeType: e.target.value as "single" | "two-phase" });
            }}
          >
            <option value="single">Single Phase</option>
            <option value="two-phase">Two Phase</option>
          </select>
        </div>
        <div className="strategy-row">
          <label className="strategy-label">Account Size</label>
          <select className="strategy-input" value={challengeConfig.accountSize} onChange={(e) => setChallengeConfig({ accountSize: Number(e.target.value) })}>
            {ACCOUNT_SIZES.map((size) => (
              <option key={size} value={size}>
                ${size.toLocaleString()}
              </option>
            ))}
          </select>
        </div>
        <div className="strategy-row">
          <label className="strategy-label">{challengeConfig.challengeType === "two-phase" ? "Phase 1 Profit Target" : "Profit Target"}</label>
          <input
            type="number"
            step="0.5"
            className="strategy-input"
            value={challengeConfig.phase1TargetPct}
            onChange={(e) => setChallengeConfig({ phase1TargetPct: Number(e.target.value) })}
          />
          <span className="panel-dim">%</span>
        </div>
        <div className="strategy-row">
          <label className="strategy-label">{challengeConfig.challengeType === "two-phase" ? "Phase 1 Max Drawdown" : "Maximum Drawdown"}</label>
          <input
            type="number"
            step="0.5"
            className="strategy-input"
            value={challengeConfig.phase1MaxDDPct}
            onChange={(e) => setChallengeConfig({ phase1MaxDDPct: Number(e.target.value) })}
          />
          <span className="panel-dim">%</span>
        </div>
        {challengeConfig.challengeType === "two-phase" && (
          <>
            <div className="strategy-row">
              <label className="strategy-label">Phase 2 Profit Target</label>
              <input
                type="number"
                step="0.5"
                className="strategy-input"
                value={challengeConfig.phase2TargetPct}
                onChange={(e) => setChallengeConfig({ phase2TargetPct: Number(e.target.value) })}
              />
              <span className="panel-dim">%</span>
            </div>
            <div className="strategy-row">
              <label className="strategy-label">Phase 2 Max Drawdown</label>
              <input
                type="number"
                step="0.5"
                className="strategy-input"
                value={challengeConfig.phase2MaxDDPct}
                onChange={(e) => setChallengeConfig({ phase2MaxDDPct: Number(e.target.value) })}
              />
              <span className="panel-dim">%</span>
            </div>
          </>
        )}
        <div className="strategy-row">
          <label className="strategy-label">Daily Drawdown</label>
          <input
            type="checkbox"
            checked={challengeConfig.dailyDrawdownEnabled}
            onChange={(e) => setChallengeConfig({ dailyDrawdownEnabled: e.target.checked })}
          />
          {challengeConfig.dailyDrawdownEnabled && (
            <>
              <input
                type="number"
                step="0.5"
                className="strategy-input"
                value={challengeConfig.dailyDrawdownPct}
                onChange={(e) => setChallengeConfig({ dailyDrawdownPct: Number(e.target.value) })}
              />
              <span className="panel-dim">%</span>
            </>
          )}
        </div>
        <div className="strategy-row">
          <label className="strategy-label">Drawdown Type</label>
          <select
            className="strategy-input"
            value={challengeConfig.drawdownType}
            onChange={(e) => setChallengeConfig({ drawdownType: e.target.value as "initial" | "trailing" })}
          >
            <option value="initial">Initial</option>
            <option value="trailing">Trailing</option>
          </select>
        </div>
        <div className="strategy-row">
          <label className="strategy-label">Profit Split</label>
          <input
            type="number"
            step="1"
            className="strategy-input"
            value={challengeConfig.profitSplitPct}
            onChange={(e) => setChallengeConfig({ profitSplitPct: Number(e.target.value) })}
          />
          <span className="panel-dim">%</span>
        </div>
        <div className="strategy-row">
          <label className="strategy-label">Challenge Fee</label>
          <input
            type="number"
            step="10"
            min="0"
            className="strategy-input"
            value={challengeConfig.challengeFee}
            onChange={(e) => setChallengeConfig({ challengeFee: Number(e.target.value) })}
          />
        </div>
      </div>

      <div className="mc-settings">
        <span className="da-widget-title">Strategy</span>
        <div className="strategy-row">
          <label className="strategy-label">Source</label>
          <select
            className="strategy-input"
            value={simSettings.strategySource}
            onChange={(e) => setSimSettings({ strategySource: e.target.value as "myStrategy" | "strategyLab" })}
          >
            <option value="myStrategy">My Strategy</option>
            <option value="strategyLab">Strategy Lab</option>
          </select>
        </div>
        {isMyStrategy ? (
          <div className="panel-dim">
            "Bootstrap from historical Strategy Scan trades" - Historical Trades: {hist.count.toLocaleString()}, Win Rate: {hist.winRate.toFixed(1)}%, EV:{" "}
            {signedR(hist.expectancy)}
            {hist.count === 0 && <div className="mc-error">No historical trades match the Strategy tab's current filters.</div>}
          </div>
        ) : (
          <div className="panel-dim">
            "Hypothetical outcome model" - Win Rate: {labParams.winRatePct}%, Avg Win: {signedR(labParams.avgWinR)}, Avg Loss: {signedR(-labParams.avgLossR)}, EV:{" "}
            {signedR(labEv)}
          </div>
        )}
      </div>

      <div className="mc-settings">
        <span className="da-widget-title">Simulation</span>
        <div className="strategy-row">
          <label className="strategy-label">Risk / Trade</label>
          <input type="number" step="0.1" min="0" className="strategy-input" value={simSettings.riskPct} onChange={(e) => setSimSettings({ riskPct: Number(e.target.value) })} />
          <span className="panel-dim">%</span>
        </div>
        <div className="strategy-row">
          <label className="strategy-label">Simulations</label>
          <select className="strategy-input" value={simSettings.numSimulations} onChange={(e) => setSimSettings({ numSimulations: Number(e.target.value) })}>
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
            value={String(simSettings.tradesPerSimulation)}
            onChange={(e) => setSimSettings({ tradesPerSimulation: e.target.value === "historical" ? "historical" : Number(e.target.value) })}
          >
            {isMyStrategy && <option value="historical">Historical sample size</option>}
            {TRADES_PER_SIM_PRESETS.map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()}
              </option>
            ))}
          </select>
        </div>
        {!isMyStrategy && challengeConfig.dailyDrawdownEnabled && (
          <div className="strategy-row">
            <label className="strategy-label">Trades / Day</label>
            <input
              type="number"
              min="1"
              step="1"
              className="strategy-input"
              value={simSettings.tradesPerDay}
              onChange={(e) => setSimSettings({ tradesPerDay: Number(e.target.value) })}
            />
            <span className="panel-dim">assumed trades per simulated trading day</span>
          </div>
        )}
        {isMyStrategy && challengeConfig.dailyDrawdownEnabled && (
          <div className="panel-dim">Trades / Day (from history): {historicalTradesPerDay}</div>
        )}
        <div className="strategy-row">
          <label className="strategy-label">Seed</label>
          <input type="number" className="strategy-input" value={simSettings.seed} onChange={(e) => setSimSettings({ seed: Number(e.target.value) })} />
          <button type="button" className="strategy-link-btn" onClick={() => setSimSettings({ seed: randomSeed() })}>
            Randomize
          </button>
        </div>
      </div>

      {!validation.valid && (
        <div className="panel-empty mc-error">
          {validation.errors.map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      )}

      <div className="strategy-actions">
        <button type="button" className="strategy-scan-btn" onClick={handleRun} disabled={!canRun || run.status === "running"}>
          Run Challenge Simulation
        </button>
      </div>

      <ChallengeResultsView
        run={run}
        tradesPerPhaseCap={resolvedTradesPerPhase}
        tradesPerDay={challengeConfig.dailyDrawdownEnabled ? resolvedTradesPerDay : null}
        fee={challengeConfig.challengeFee}
        profitSplitPct={challengeConfig.profitSplitPct}
        seed={simSettings.seed}
        idleHint="Configure the challenge settings and strategy source above, then press Run Challenge Simulation."
      />
    </div>
  );
}
