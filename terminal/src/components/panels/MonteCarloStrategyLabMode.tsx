import { useMemo } from "react";
import { useMonteCarloStore } from "../../strategy/monteCarlo/monteCarloStore";
import { breakevenWinRatePct, expectedValueR } from "../../strategy/monteCarlo/labMath";
import { validateCustomOutcomes, validateLabParams } from "../../strategy/monteCarlo/validation";
import { randomSeed } from "../../strategy/monteCarlo/rng";
import type { CustomOutcome, OutcomeSource, SimulationRunConfig } from "../../strategy/monteCarlo/types";
import { strategyLabInterpretation } from "../../strategy/monteCarlo/interpretation";
import { MonteCarloResultsView } from "./MonteCarloResultsView";
import "./panels.css";
import "./StrategyPanel.css";
import "./MonteCarlo.css";

const SIMULATION_COUNTS = [1000, 5000, 10000, 25000, 50000];
const TRADES_PER_SIM_PRESETS = [50, 100, 250, 500, 1000];

function signedR(n: number, digits = 2): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}R`;
}

function nextOutcomeRow(): CustomOutcome {
  return { r: 1, probabilityPct: 0 };
}

/**
 * STRATEGY LAB mode - a purely hypothetical Win-Rate/RR sandbox, no
 * historical trades required. Simple model is mandatory/default (per
 * spec); Custom Distribution is the optional advanced outcome model,
 * implemented here without touching the Simple path's own code (see
 * engine.ts's OutcomeSource union - "simple" and "custom" are fully
 * independent branches).
 */
export function MonteCarloStrategyLabMode() {
  const params = useMonteCarloStore((s) => s.labParams);
  const setParams = useMonteCarloStore((s) => s.setLabParams);
  const run = useMonteCarloStore((s) => s.labRun);
  const runLab = useMonteCarloStore((s) => s.runLab);

  const ev = useMemo(() => expectedValueR(params.winRatePct, params.avgWinR, params.avgLossR), [params.winRatePct, params.avgWinR, params.avgLossR]);
  const breakevenWr = useMemo(() => breakevenWinRatePct(params.avgWinR, params.avgLossR), [params.avgWinR, params.avgLossR]);

  const simpleValidation = useMemo(
    () =>
      validateLabParams({
        winRatePct: params.winRatePct,
        avgWinR: params.avgWinR,
        avgLossR: params.avgLossR,
        riskPct: params.riskPct,
        tradesPerSimulation: params.tradesPerSimulation,
        numSimulations: params.numSimulations,
      }),
    [params]
  );
  const customValidation = useMemo(
    () => (params.outcomeModel === "custom" ? validateCustomOutcomes(params.customWins, params.customLosses) : { valid: true, errors: [] }),
    [params.outcomeModel, params.customWins, params.customLosses]
  );
  const errors = [...simpleValidation.errors, ...customValidation.errors];
  const canRun = errors.length === 0;

  function handleRun() {
    if (!canRun) return;
    const source: OutcomeSource =
      params.outcomeModel === "custom"
        ? { kind: "custom", params: { winRatePct: params.winRatePct, wins: params.customWins, losses: params.customLosses } }
        : { kind: "simple", params: { winRatePct: params.winRatePct, avgWinR: params.avgWinR, avgLossR: params.avgLossR } };
    const config: SimulationRunConfig = {
      numSimulations: params.numSimulations,
      tradesPerSimulation: params.tradesPerSimulation,
      seed: params.seed,
      source,
    };
    void runLab(config, "Hypothetical Win Rate / RR model");
  }

  const interpretationLines = useMemo(
    () => strategyLabInterpretation(params.winRatePct, params.avgWinR, params.avgLossR, ev),
    [params.winRatePct, params.avgWinR, params.avgLossR, ev]
  );

  function updateOutcome(list: "customWins" | "customLosses", index: number, patch: Partial<CustomOutcome>) {
    const next = params[list].map((o, i) => (i === index ? { ...o, ...patch } : o));
    setParams({ [list]: next } as Partial<typeof params>);
  }
  function addOutcome(list: "customWins" | "customLosses") {
    setParams({ [list]: [...params[list], nextOutcomeRow()] } as Partial<typeof params>);
  }
  function removeOutcome(list: "customWins" | "customLosses", index: number) {
    setParams({ [list]: params[list].filter((_, i) => i !== index) } as Partial<typeof params>);
  }

  return (
    <div className="mc-mode">
      <div className="mc-settings">
        <div className="strategy-row">
          <label className="strategy-label">Win Rate</label>
          <input
            type="number"
            step="1"
            className="strategy-input"
            value={params.winRatePct}
            onChange={(e) => setParams({ winRatePct: Number(e.target.value) })}
          />
          <span className="panel-dim">%</span>
        </div>
        <div className="strategy-row">
          <label className="strategy-label">Average Win</label>
          <input type="number" step="0.05" className="strategy-input" value={params.avgWinR} onChange={(e) => setParams({ avgWinR: Number(e.target.value) })} />
          <span className="panel-dim">R</span>
        </div>
        <div className="strategy-row">
          <label className="strategy-label">Average Loss</label>
          <input
            type="number"
            step="0.05"
            className="strategy-input"
            value={params.avgLossR}
            onChange={(e) => setParams({ avgLossR: Number(e.target.value) })}
          />
          <span className="panel-dim">R</span>
        </div>
        <div className="strategy-row">
          <label className="strategy-label">Outcome Model</label>
          <select className="strategy-input" value={params.outcomeModel} onChange={(e) => setParams({ outcomeModel: e.target.value as "simple" | "custom" })}>
            <option value="simple">Simple</option>
            <option value="custom">Custom Distribution</option>
          </select>
        </div>

        {params.outcomeModel === "custom" && (
          <div className="mc-custom-dist">
            {(["customWins", "customLosses"] as const).map((list) => (
              <div key={list} className="mc-custom-dist-col">
                <div className="panel-dim">{list === "customWins" ? "Winning Outcomes" : "Losing Outcomes"}</div>
                {params[list].map((o, i) => (
                  <div key={i} className="mc-custom-dist-row">
                    <input
                      type="number"
                      step="0.1"
                      className="strategy-input mc-custom-dist-input"
                      value={o.r}
                      onChange={(e) => updateOutcome(list, i, { r: Number(e.target.value) })}
                    />
                    <span className="panel-dim">R →</span>
                    <input
                      type="number"
                      step="1"
                      className="strategy-input mc-custom-dist-input"
                      value={o.probabilityPct}
                      onChange={(e) => updateOutcome(list, i, { probabilityPct: Number(e.target.value) })}
                    />
                    <span className="panel-dim">%</span>
                    <button type="button" className="strategy-link-btn" onClick={() => removeOutcome(list, i)}>
                      Remove
                    </button>
                  </div>
                ))}
                <button type="button" className="strategy-link-btn" onClick={() => addOutcome(list)}>
                  + Add Outcome
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="strategy-row">
          <label className="strategy-label">Risk / Trade</label>
          <input type="number" step="0.1" min="0" className="strategy-input" value={params.riskPct} onChange={(e) => setParams({ riskPct: Number(e.target.value) })} />
          <span className="panel-dim">%</span>
        </div>
        <div className="strategy-row">
          <label className="strategy-label">Starting Balance</label>
          <input
            type="number"
            min="0"
            className="strategy-input"
            value={params.startingBalance}
            onChange={(e) => setParams({ startingBalance: Number(e.target.value) })}
          />
        </div>
        <div className="strategy-row">
          <label className="strategy-label">Trades / Simulation</label>
          <select className="strategy-input" value={params.tradesPerSimulation} onChange={(e) => setParams({ tradesPerSimulation: Number(e.target.value) })}>
            {TRADES_PER_SIM_PRESETS.map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()}
              </option>
            ))}
          </select>
        </div>
        <div className="strategy-row">
          <label className="strategy-label">Simulations</label>
          <select className="strategy-input" value={params.numSimulations} onChange={(e) => setParams({ numSimulations: Number(e.target.value) })}>
            {SIMULATION_COUNTS.map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()}
              </option>
            ))}
          </select>
        </div>
        <div className="strategy-row">
          <label className="strategy-label">Seed</label>
          <input type="number" className="strategy-input" value={params.seed} onChange={(e) => setParams({ seed: Number(e.target.value) })} />
          <button type="button" className="strategy-link-btn" onClick={() => setParams({ seed: randomSeed() })}>
            Randomize
          </button>
        </div>
      </div>

      <div className="panel-summary mono">
        <div>
          <span className="panel-dim">Expected Value</span>
          <span className={ev >= 0 ? "pos" : "neg"}>{signedR(ev)}</span>
        </div>
        <div>
          <span className="panel-dim">Breakeven Win Rate</span>
          <span>{breakevenWr.toFixed(2)}%</span>
        </div>
      </div>

      {errors.length > 0 && (
        <div className="panel-empty mc-error">
          {errors.map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      )}

      <div className="strategy-actions">
        <button type="button" className="strategy-scan-btn" onClick={handleRun} disabled={!canRun || run.status === "running"}>
          Run Simulation
        </button>
      </div>

      <MonteCarloResultsView run={run} interpretationLines={interpretationLines} idleHint="Set your hypothetical Win Rate / RR parameters above, then press Run Simulation." />
    </div>
  );
}
