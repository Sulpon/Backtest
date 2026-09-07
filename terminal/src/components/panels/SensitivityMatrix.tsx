import { useMemo, useState } from "react";
import { useMonteCarloStore } from "../../strategy/monteCarlo/monteCarloStore";
import { expectedValueR } from "../../strategy/monteCarlo/labMath";
import { SENSITIVITY_RISK_PRESET_OPTIONS, SENSITIVITY_RR_PRESET_OPTIONS } from "../../strategy/monteCarlo/sensitivityTypes";
import type { SensitivityCellStats, SensitivityRunConfig } from "../../strategy/monteCarlo/sensitivityTypes";
import "./panels.css";
import "./StrategyPanel.css";
import "./DetailedAnalysis.css";
import "./MonteCarlo.css";

type CellDisplayMode = "expectedR" | "medianR";

function signedR(n: number, digits = 1): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}R`;
}

/**
 * RISK x REWARD/RISK SENSITIVITY - built entirely on
 * strategy/monteCarlo/sensitivityEngine.ts (via monteCarloStore.ts's
 * `runSensitivity`), which itself reuses the existing RNG/outcome
 * model/risk-equity layer - see that engine's own module doc comment.
 * This component only assembles a SensitivityRunConfig from the CURRENT
 * Strategy Lab settings (Win Rate, Trades/Simulation, Simulations,
 * Starting Balance, Seed - read directly from `labParams`, never
 * duplicated into separate controls here) plus this feature's own two
 * axis arrays, and renders the resulting heatmap + a click-through detail
 * panel. NOT the Challenge Simulator - no phase targets, drawdown, or
 * fee/pass-fail concepts appear anywhere in this file.
 */
export function SensitivityMatrix() {
  const labParams = useMonteCarloStore((s) => s.labParams);
  const axes = useMonteCarloStore((s) => s.sensitivityAxes);
  const setAxes = useMonteCarloStore((s) => s.setSensitivityAxes);
  const run = useMonteCarloStore((s) => s.sensitivityRun);
  const runSensitivity = useMonteCarloStore((s) => s.runSensitivity);

  const [displayMode, setDisplayMode] = useState<CellDisplayMode>("expectedR");
  const [selectedCell, setSelectedCell] = useState<SensitivityCellStats | null>(null);
  const [editingAxes, setEditingAxes] = useState(false);

  const theoreticalEv = useMemo(
    () => (selectedCell ? expectedValueR(labParams.winRatePct, selectedCell.rr, 1) : 0),
    [selectedCell, labParams.winRatePct]
  );

  function toggleAxisValue(axis: "riskLevelsPct" | "rewardRiskRatios", value: number) {
    const current = axes[axis];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value].sort((a, b) => a - b);
    if (next.length === 0) return; // never allow an empty axis
    setAxes({ [axis]: next } as Partial<typeof axes>);
    setSelectedCell(null);
  }

  function handleRun() {
    const config: SensitivityRunConfig = {
      winRatePct: labParams.winRatePct,
      tradesPerSimulation: labParams.tradesPerSimulation,
      numSimulations: labParams.numSimulations,
      seed: labParams.seed,
      startingBalance: labParams.startingBalance,
      axes,
    };
    setSelectedCell(null);
    void runSensitivity(config);
  }

  const result = run.result;

  return (
    <div className="da-card">
      <div className="da-card-header">
        <span className="da-widget-title">Risk × Reward/Risk Sensitivity</span>
        <div className="mc-legend">
          <button type="button" className={`da-range-btn${displayMode === "expectedR" ? " active" : ""}`} onClick={() => setDisplayMode("expectedR")}>
            Expected R
          </button>
          <button type="button" className={`da-range-btn${displayMode === "medianR" ? " active" : ""}`} onClick={() => setDisplayMode("medianR")}>
            Median Final R
          </button>
        </div>
      </div>

      <p className="panel-dim mc-heatmap-caption">
        Uses the current Strategy Lab settings: Win Rate {labParams.winRatePct}%, Average Loss 1R (by convention - Reward:Risk is measured
        against it), Trades / Simulation {labParams.tradesPerSimulation.toLocaleString()}, Simulations {labParams.numSimulations.toLocaleString()},
        Seed {labParams.seed}.
      </p>

      <div className="strategy-row">
        <button type="button" className="strategy-link-btn" onClick={() => setEditingAxes((v) => !v)}>
          {editingAxes ? "Done editing axes" : "Edit Risk / Reward:Risk axes"}
        </button>
      </div>
      {editingAxes && (
        <div className="mc-custom-dist">
          <div className="mc-custom-dist-col">
            <div className="panel-dim">Risk per Trade levels</div>
            <div className="strategy-symbol-list">
              {SENSITIVITY_RISK_PRESET_OPTIONS.map((v) => (
                <label key={v} className="strategy-symbol-item">
                  <input type="checkbox" checked={axes.riskLevelsPct.includes(v)} onChange={() => toggleAxisValue("riskLevelsPct", v)} />
                  {v}%
                </label>
              ))}
            </div>
          </div>
          <div className="mc-custom-dist-col">
            <div className="panel-dim">Reward:Risk levels</div>
            <div className="strategy-symbol-list">
              {SENSITIVITY_RR_PRESET_OPTIONS.map((v) => (
                <label key={v} className="strategy-symbol-item">
                  <input type="checkbox" checked={axes.rewardRiskRatios.includes(v)} onChange={() => toggleAxisValue("rewardRiskRatios", v)} />
                  {v}R
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="strategy-actions">
        <button type="button" className="strategy-scan-btn" onClick={handleRun} disabled={run.status === "running"}>
          Run Sensitivity Matrix
        </button>
      </div>

      {run.status === "running" && (
        <div className="mc-progress">
          <div className="panel-dim">
            Calculating sensitivity matrix...{" "}
            {run.progress ? `${run.progress.completed} / ${run.progress.total} cells` : ""}
          </div>
          <div className="mc-progress-bar">
            <div
              className="mc-progress-fill"
              style={{ width: `${run.progress ? Math.round((run.progress.completed / run.progress.total) * 100) : 0}%` }}
            />
          </div>
        </div>
      )}

      {run.status === "error" && <div className="panel-empty mc-error">Calculation failed: {run.error}</div>}

      {!result && run.status !== "running" && run.status !== "error" && (
        <div className="panel-empty mc-idle">Press Run Sensitivity Matrix to calculate the heatmap for the current Strategy Lab settings.</div>
      )}

      {result && (
        <>
          <div className="mc-heatmap-scroll">
            <table className="mc-heatmap-table">
              <thead>
                <tr>
                  <th className="mc-heatmap-corner">Risk ↓ / RR →</th>
                  {result.rewardRiskRatios.map((rr) => (
                    <th key={rr}>{rr}R</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.riskLevelsPct.map((riskPct, rowIdx) => (
                  <tr key={riskPct}>
                    <th scope="row">{riskPct}%</th>
                    {result.cells[rowIdx].map((cell, colIdx) => {
                      const secondary = displayMode === "expectedR" ? cell.meanFinalR : cell.medianFinalR;
                      const isSelected = selectedCell === cell;
                      return (
                        <td
                          key={colIdx}
                          className={`mc-heatmap-cell mc-heatmap-cell-clickable${isSelected ? " mc-heatmap-cell-selected" : ""}`}
                          style={{ background: `color-mix(in srgb, var(--ok) ${cell.probabilityOfProfitPct}%, var(--danger))` }}
                          onClick={() => setSelectedCell(cell)}
                          title={`Risk ${riskPct}%, RR ${cell.rr} - click for details`}
                        >
                          <div className="mc-heatmap-cell-primary">{cell.probabilityOfProfitPct.toFixed(1)}%</div>
                          <div className={`mc-heatmap-cell-secondary ${secondary >= 0 ? "pos" : "neg"}`}>{signedR(secondary)}</div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selectedCell && (
            <div className="da-card mc-cell-detail">
              <span className="da-widget-title">
                Risk {selectedCell.riskPct}% × RR {selectedCell.rr}
              </span>
              <div className="panel-summary mono">
                <div>
                  <span className="panel-dim">Risk</span>
                  <span>{selectedCell.riskPct}%</span>
                </div>
                <div>
                  <span className="panel-dim">Reward/Risk</span>
                  <span>{selectedCell.rr}</span>
                </div>
                <div>
                  <span className="panel-dim">Win Rate</span>
                  <span>{labParams.winRatePct}%</span>
                </div>
                <div>
                  <span className="panel-dim">Trades</span>
                  <span>{result.tradesPerSimulation.toLocaleString()}</span>
                </div>
                <div>
                  <span className="panel-dim">Simulations</span>
                  <span>{result.numSimulations.toLocaleString()}</span>
                </div>
                <div>
                  <span className="panel-dim">Probability of Profit</span>
                  <span className="pos">{selectedCell.probabilityOfProfitPct.toFixed(1)}%</span>
                </div>
                <div>
                  <span className="panel-dim">Expected Final R (simulated mean)</span>
                  <span className={selectedCell.meanFinalR >= 0 ? "pos" : "neg"}>{signedR(selectedCell.meanFinalR, 2)}</span>
                </div>
                <div>
                  <span className="panel-dim">Expected Value (theoretical, per trade)</span>
                  <span className={theoreticalEv >= 0 ? "pos" : "neg"}>{signedR(theoreticalEv, 2)}</span>
                </div>
                <div>
                  <span className="panel-dim">Median Final R</span>
                  <span className={selectedCell.medianFinalR >= 0 ? "pos" : "neg"}>{signedR(selectedCell.medianFinalR, 2)}</span>
                </div>
                <div>
                  <span className="panel-dim">Median Max Drawdown</span>
                  <span className="neg">{signedR(selectedCell.medianMaxDrawdownR, 2)}</span>
                </div>
                {result.startingBalance != null && (
                  <div>
                    <span className="panel-dim">Expected Final Equity</span>
                    <span>
                      ${(result.startingBalance * selectedCell.meanFinalEquityMultiplier).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
