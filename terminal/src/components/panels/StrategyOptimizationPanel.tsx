import { Fragment, useMemo, useState } from "react";
import { useSymbols } from "../../data/useSymbols";
import { TIMEFRAMES, TIMEFRAME_LABELS } from "../../data/timeframes";
import type { Timeframe } from "../../data/types";
import { dataLayer } from "../../data/DataLayer";
import { usePineIndicatorStore } from "../../pine/pineIndicatorStore";
import { useOptimizationStore } from "../../strategy/optimization/store";
import type { CandidateMonteCarloState } from "../../strategy/optimization/store";
import { MAX_COMBINATIONS, safeCountCombinations, selectParameterDefs, validateParameterDef } from "../../strategy/optimization/parameterSpace";
import type { CandidateResult, OptimizationObjective, WalkForwardSummary } from "../../strategy/optimization/types";
import "./panels.css";
import "./StrategyPanel.css";
import "./MonteCarlo.css";
import "./StrategyOptimization.css";

function todayMinusDaysISO(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function dateInputToSec(value: string): number {
  return Math.floor(Date.parse(`${value}T00:00:00Z`) / 1000);
}
function signedR(n: number, digits = 2): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}R`;
}
function pct(n: number, digits = 1): string {
  return `${n.toFixed(digits)}%`;
}

const OBJECTIVE_OPTIONS: { value: OptimizationObjective; label: string }[] = [
  { value: "robustness", label: "Robustness Score" },
  { value: "oosEv", label: "OOS Expected Value" },
  { value: "oosTotalR", label: "OOS Total R" },
  { value: "riskAdjusted", label: "Risk-Adjusted (Return/Drawdown)" },
];

/**
 * Strategy Optimization - an ANALYSIS LAYER on top of the existing
 * Strategy Scan + Monte Carlo systems (see strategy/optimization/'s own
 * module doc comments). This component is purely a config UI + results
 * view; ALL computation happens in strategy/optimization/store.ts's
 * runOptimization action (Pine invocation via strategyEvaluation.ts,
 * scoring via the optimizer worker) - never anything here.
 *
 * Purpose (per spec): find parameter REGIONS that produce a robust edge
 * across unseen data/symbols/time, not the single highest historical-
 * profit combination - hence the default ranking objective is Robustness
 * Score, never raw Total R, and a "No stable parameter region detected"
 * fallback is shown honestly rather than a fabricated one.
 */
export function StrategyOptimizationPanel() {
  const symbols = useSymbols();
  const indicators = usePineIndicatorStore((s) => s.items);

  const parameterDefs = useOptimizationStore((s) => s.parameterDefs);
  const updateParameterDef = useOptimizationStore((s) => s.updateParameterDef);
  const discoverParameters = useOptimizationStore((s) => s.discoverParameters);
  const selectedParameterKeys = useOptimizationStore((s) => s.selectedParameterKeys);
  const toggleParameterSelected = useOptimizationStore((s) => s.toggleParameterSelected);
  const trainTestSplit = useOptimizationStore((s) => s.trainTestSplit);
  const setTrainTestSplit = useOptimizationStore((s) => s.setTrainTestSplit);
  const minSampleSize = useOptimizationStore((s) => s.minSampleSize);
  const setMinSampleSize = useOptimizationStore((s) => s.setMinSampleSize);
  const walkForwardFolds = useOptimizationStore((s) => s.walkForwardFolds);
  const setWalkForwardFolds = useOptimizationStore((s) => s.setWalkForwardFolds);
  const objective = useOptimizationStore((s) => s.objective);
  const setObjective = useOptimizationStore((s) => s.setObjective);
  const seed = useOptimizationStore((s) => s.seed);
  const setSeed = useOptimizationStore((s) => s.setSeed);
  const setStoreStartDate = useOptimizationStore((s) => s.setStartDate);
  const setStoreTimeframe = useOptimizationStore((s) => s.setTimeframe);
  const run = useOptimizationStore((s) => s.run);
  const runOptimization = useOptimizationStore((s) => s.runOptimization);
  const cancelOptimization = useOptimizationStore((s) => s.cancelOptimization);
  const selectedCandidateKey = useOptimizationStore((s) => s.selectedCandidateKey);
  const selectCandidate = useOptimizationStore((s) => s.selectCandidate);
  const candidateMonteCarlo = useOptimizationStore((s) => s.candidateMonteCarlo);
  const runSelectedCandidateMonteCarlo = useOptimizationStore((s) => s.runSelectedCandidateMonteCarlo);

  const [indicatorId, setIndicatorId] = useState("");
  const [symbolMode, setSymbolMode] = useState<"all" | "custom">("all");
  const [customSymbols, setCustomSymbols] = useState<string[]>([]);
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const [startDate, setStartDate] = useState(todayMinusDaysISO(365));
  const [discovering, setDiscovering] = useState(false);
  const [walkForwardEnabled, setWalkForwardEnabled] = useState(false);

  const selectedIndicator = indicators.find((i) => i.id === indicatorId) ?? indicators[0] ?? null;
  const targetSymbols = symbolMode === "all" ? symbols : customSymbols;
  const running = run.status === "generating" || run.status === "scoring";

  function toggleCustomSymbol(sym: string) {
    setCustomSymbols((cur) => (cur.includes(sym) ? cur.filter((s) => s !== sym) : [...cur, sym]));
  }

  async function handleDiscoverParameters() {
    if (!selectedIndicator || targetSymbols.length === 0) return;
    setDiscovering(true);
    try {
      const data = await dataLayer.getSymbolData(targetSymbols[0], timeframe);
      discoverParameters(selectedIndicator, data.bars);
    } finally {
      setDiscovering(false);
    }
  }

  async function handleRun() {
    if (!selectedIndicator || targetSymbols.length === 0) return;
    setStoreStartDate(dateInputToSec(startDate));
    setStoreTimeframe(timeframe);
    await runOptimization(selectedIndicator, targetSymbols);
  }

  const selectedDefs = useMemo(() => selectParameterDefs(parameterDefs, selectedParameterKeys), [parameterDefs, selectedParameterKeys]);
  const selectedCount = selectedDefs.length;
  const needsSelection = parameterDefs.length > 0 && selectedCount === 0;
  const liveCombinations = useMemo(() => safeCountCombinations(selectedDefs), [selectedDefs]);
  const validationByKey = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const def of selectedDefs) {
      const issues = validateParameterDef(def);
      if (issues.length > 0) map.set(def.key, issues);
    }
    return map;
  }, [selectedDefs]);
  const hasRangeErrors = [...validationByKey.values()].some((issues) => issues.some((i) => !i.includes("outside the Min/Max")));

  const canRun = !running && !!selectedIndicator && targetSymbols.length > 0 && !needsSelection && !hasRangeErrors;

  const result = run.result;
  const selectedCandidate = useMemo(
    () => result?.candidates.find((c) => c.combination.key === selectedCandidateKey) ?? null,
    [result, selectedCandidateKey]
  );
  const mcState = selectedCandidateKey ? candidateMonteCarlo.get(selectedCandidateKey) : undefined;

  return (
    <div className="panel-scroll opt-panel">
      <div className="strategy-form">
        <div className="strategy-row">
          <label className="strategy-label">Indicator</label>
          {indicators.length === 0 ? (
            <span className="panel-dim">No indicators added yet - add one in the Pine tab</span>
          ) : (
            <select className="strategy-input" value={selectedIndicator?.id ?? ""} onChange={(e) => setIndicatorId(e.target.value)} disabled={running}>
              {indicators.map((ind) => (
                <option key={ind.id} value={ind.id}>
                  {ind.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="strategy-row">
          <label className="strategy-label">Start Date</label>
          <input type="date" className="strategy-input" value={startDate} onChange={(e) => setStartDate(e.target.value)} disabled={running} />
        </div>

        <div className="strategy-row">
          <label className="strategy-label">Symbols</label>
          <select className="strategy-input" value={symbolMode} onChange={(e) => setSymbolMode(e.target.value as "all" | "custom")} disabled={running}>
            <option value="all">All Symbols</option>
            <option value="custom">Custom</option>
          </select>
        </div>
        {symbolMode === "custom" && (
          <div className="strategy-symbol-picker">
            <div className="strategy-symbol-actions">
              <button type="button" className="strategy-link-btn" onClick={() => setCustomSymbols(symbols)} disabled={running}>
                Select All
              </button>
              <button type="button" className="strategy-link-btn" onClick={() => setCustomSymbols([])} disabled={running}>
                Clear All
              </button>
            </div>
            <div className="strategy-symbol-list">
              {symbols.map((sym) => (
                <label key={sym} className="strategy-symbol-item">
                  <input type="checkbox" checked={customSymbols.includes(sym)} onChange={() => toggleCustomSymbol(sym)} disabled={running} />
                  {sym}
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="strategy-row">
          <label className="strategy-label">Timeframe</label>
          <select className="strategy-input" value={timeframe} onChange={(e) => setTimeframe(e.target.value as Timeframe)} disabled={running}>
            {TIMEFRAMES.map((tf) => (
              <option key={tf} value={tf}>
                {TIMEFRAME_LABELS[tf]}
              </option>
            ))}
          </select>
        </div>

        <div className="strategy-actions">
          <button type="button" className="strategy-link-btn" onClick={handleDiscoverParameters} disabled={running || discovering || !selectedIndicator}>
            {discovering ? "Discovering..." : "Discover Parameters"}
          </button>
        </div>
      </div>

      {parameterDefs.length > 0 && (
        <div>
          <div className="da-widget-title">Optimizable Parameters</div>
          <p className="panel-dim mc-heatmap-caption">
            Every numeric input the script declares is discovered automatically - check the ones you want to search. Unchecked parameters stay fixed at
            their current value and are not part of the grid.
          </p>
          <table className="opt-param-table">
            <thead>
              <tr>
                <th></th>
                <th>Name</th>
                <th>Current</th>
                <th>Min</th>
                <th>Max</th>
                <th>Step</th>
              </tr>
            </thead>
            <tbody>
              {parameterDefs.map((def) => {
                const isSelected = !!selectedParameterKeys[def.key];
                const issues = validationByKey.get(def.key) ?? [];
                return (
                  <Fragment key={def.key}>
                    <tr className={isSelected ? "opt-param-row-selected" : undefined}>
                      <td>
                        <input type="checkbox" checked={isSelected} onChange={() => toggleParameterSelected(def.key)} disabled={running} />
                      </td>
                      <td>{def.label}</td>
                      <td>{def.current}</td>
                      <td>
                        <input
                          type="number"
                          className="strategy-input opt-param-input"
                          value={def.min}
                          onChange={(e) => updateParameterDef(def.key, { min: Number(e.target.value) })}
                          disabled={running || !isSelected}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          className="strategy-input opt-param-input"
                          value={def.max}
                          onChange={(e) => updateParameterDef(def.key, { max: Number(e.target.value) })}
                          disabled={running || !isSelected}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          className="strategy-input opt-param-input"
                          value={def.step}
                          onChange={(e) => updateParameterDef(def.key, { step: Number(e.target.value) })}
                          disabled={running || !isSelected}
                        />
                      </td>
                    </tr>
                    {isSelected && issues.length > 0 && (
                      <tr>
                        <td></td>
                        <td colSpan={5} className="opt-param-issue">
                          {issues.join(" ")}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>

          {needsSelection && <div className="opt-blocked">Select at least one parameter to optimize.</div>}
          {!needsSelection && selectedCount > 0 && (
            <div className="panel-summary mono">
              <div>
                <span className="panel-dim">Selected Parameters</span>
                <span>{selectedCount}</span>
              </div>
              <div>
                <span className="panel-dim">Combinations</span>
                <span>{liveCombinations == null ? "—" : liveCombinations.toLocaleString("en-US")}</span>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="strategy-form">
        <div className="strategy-row">
          <label className="strategy-label">Train / Test Split</label>
          <select
            className="strategy-input"
            value={trainTestSplit.trainPct}
            onChange={(e) => setTrainTestSplit({ trainPct: Number(e.target.value) as 50 | 60 | 70 | 80 })}
            disabled={running}
          >
            {[50, 60, 70, 80].map((p) => (
              <option key={p} value={p}>
                {p}% Train / {100 - p}% Test
              </option>
            ))}
          </select>
        </div>
        <div className="strategy-row">
          <label className="strategy-label">Min. Sample Size</label>
          <input type="number" className="strategy-input" value={minSampleSize} onChange={(e) => setMinSampleSize(Number(e.target.value))} disabled={running} />
        </div>
        <div className="strategy-row">
          <label className="strategy-label">Walk-Forward</label>
          <input
            type="checkbox"
            checked={walkForwardEnabled}
            onChange={(e) => {
              setWalkForwardEnabled(e.target.checked);
              setWalkForwardFolds(e.target.checked ? 3 : null);
            }}
            disabled={running}
          />
          {walkForwardEnabled && (
            <input
              type="number"
              className="strategy-input opt-param-input"
              min={1}
              value={walkForwardFolds ?? 3}
              onChange={(e) => setWalkForwardFolds(Number(e.target.value))}
              disabled={running}
            />
          )}
        </div>
        <div className="strategy-row">
          <label className="strategy-label">Objective</label>
          <select className="strategy-input" value={objective} onChange={(e) => setObjective(e.target.value as OptimizationObjective)} disabled={running}>
            {OBJECTIVE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="strategy-row">
          <label className="strategy-label">Seed</label>
          <input type="number" className="strategy-input" value={seed} onChange={(e) => setSeed(Number(e.target.value))} disabled={running} />
        </div>

        <div className="strategy-actions">
          {running ? (
            <button type="button" className="strategy-scan-btn strategy-cancel-btn" onClick={cancelOptimization}>
              Cancel
            </button>
          ) : (
            <button type="button" className="strategy-scan-btn" onClick={handleRun} disabled={!canRun}>
              Run Optimization
            </button>
          )}
        </div>
      </div>

      {run.status === "blocked" && (
        <div className="opt-blocked">
          {run.blockedMessage} (limit: {MAX_COMBINATIONS.toLocaleString("en-US")} combinations)
        </div>
      )}

      {run.status === "error" && <div className="panel-empty mc-error">Optimization failed: {run.error}</div>}
      {run.status === "cancelled" && <div className="panel-empty">Optimization cancelled.</div>}

      {running && run.progress && (
        <div className="mc-progress">
          <div className="panel-dim">
            {run.status === "generating" ? "Generating trades..." : "Scoring candidates..."} {run.progress.completed} / {run.progress.total}
          </div>
          <div className="mc-progress-bar">
            <div className="mc-progress-fill" style={{ width: `${Math.round((run.progress.completed / run.progress.total) * 100)}%` }} />
          </div>
        </div>
      )}

      {!result && !running && run.status !== "blocked" && run.status !== "error" && (
        <div className="panel-empty">
          Configure parameters and press Run Optimization. The optimizer searches for a ROBUST parameter region across Train/Test data, not the single
          highest historical-profit combination.
        </div>
      )}

      {result && (
        <>
          <div className="panel-summary mono">
            <div>
              <span className="panel-dim">Combinations Tested</span>
              <span>{result.combinationsTested.toLocaleString("en-US")}</span>
            </div>
            <div>
              <span className="panel-dim">Valid Candidates</span>
              <span>{result.validCandidates.toLocaleString("en-US")}</span>
            </div>
            <div>
              <span className="panel-dim">Insufficient Sample (excluded from ranking)</span>
              <span>{result.insufficientSampleCount.toLocaleString("en-US")}</span>
            </div>
          </div>

          <div>
            <div className="da-widget-title">Robust Parameter Region</div>
            {result.robustRegion ? (
              <div className="opt-region-box">
                {Object.entries(result.robustRegion.ranges).map(([key, range]) => {
                  const def = parameterDefs.find((d) => d.key === key);
                  return (
                    <div key={key} className="opt-region-row">
                      <span className="panel-dim">{def?.label ?? key}:</span>
                      <span>
                        {range.min} – {range.max}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="panel-empty">No stable parameter region detected.</div>
            )}
          </div>

          <div>
            <div className="da-widget-title">Top Robust Candidates</div>
            <div className="mc-heatmap-scroll">
              <table className="panel-table">
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Parameters</th>
                    <th>Robustness</th>
                    <th>Train EV</th>
                    <th>Test EV</th>
                    <th>Degradation</th>
                    <th>Train Trades</th>
                    <th>Warnings</th>
                  </tr>
                </thead>
                <tbody>
                  {result.ranked.slice(0, 25).map((cand, i) => (
                    <tr
                      key={cand.combination.key}
                      className={`clickable${selectedCandidateKey === cand.combination.key ? " active" : ""}`}
                      onClick={() => selectCandidate(cand.combination.key)}
                    >
                      <td>{i + 1}</td>
                      <td>{Object.entries(cand.combination.values).map(([k, v]) => `${k}=${v}`).join(", ") || "(baseline)"}</td>
                      <td>{cand.robustness.total.toFixed(1)}</td>
                      <td className={cand.trainMetrics.expectedValue >= 0 ? "pos" : "neg"}>{signedR(cand.trainMetrics.expectedValue)}</td>
                      <td className={cand.testMetrics.expectedValue >= 0 ? "pos" : "neg"}>{signedR(cand.testMetrics.expectedValue)}</td>
                      <td>{cand.evDegradationPct == null ? "—" : pct(cand.evDegradationPct)}</td>
                      <td>{cand.trainMetrics.trades}</td>
                      <td>{cand.warnings.length}</td>
                    </tr>
                  ))}
                  {result.ranked.length === 0 && (
                    <tr>
                      <td colSpan={8} className="panel-empty">
                        No candidates met the minimum sample size.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {selectedCandidate && (
            <CandidateDetail
              candidate={selectedCandidate}
              baseline={result.baseline}
              mcState={mcState}
              onRunMonteCarlo={() => void runSelectedCandidateMonteCarlo()}
            />
          )}

          {result.walkForward && <WalkForwardSummaryView summary={result.walkForward} />}
        </>
      )}
    </div>
  );
}

function severityLabel(severity: string): string {
  return severity.toUpperCase();
}

function CandidateDetail({
  candidate,
  baseline,
  mcState,
  onRunMonteCarlo,
}: {
  candidate: CandidateResult;
  baseline: CandidateResult;
  mcState: CandidateMonteCarloState | undefined;
  onRunMonteCarlo: () => void;
}) {
  const isBaseline = candidate.combination.key === baseline.combination.key;
  return (
    <div className="da-card mc-cell-detail">
      <span className="da-widget-title">Candidate Detail{isBaseline ? " (Current / Baseline)" : ""}</span>

      <div className="opt-detail-section-label">Parameters</div>
      <div className="panel-summary mono">
        {Object.entries(candidate.combination.values).map(([k, v]) => (
          <div key={k}>
            <span className="panel-dim">{k}</span>
            <span>{v}</span>
          </div>
        ))}
        {Object.keys(candidate.combination.values).length === 0 && <div className="panel-dim">Baseline (no swept parameters)</div>}
      </div>

      <div className="opt-detail-section-label">Training</div>
      <div className="panel-summary mono">
        <div>
          <span className="panel-dim">Trades</span>
          <span>
            {candidate.trainMetrics.trades}
            {candidate.trainMetrics.insufficientSample ? " (insufficient)" : ""}
          </span>
        </div>
        <div>
          <span className="panel-dim">Win Rate</span>
          <span>{pct(candidate.trainMetrics.winRate)}</span>
        </div>
        <div>
          <span className="panel-dim">Expected Value</span>
          <span className={candidate.trainMetrics.expectedValue >= 0 ? "pos" : "neg"}>{signedR(candidate.trainMetrics.expectedValue)}</span>
        </div>
        <div>
          <span className="panel-dim">Total R</span>
          <span className={candidate.trainMetrics.totalR >= 0 ? "pos" : "neg"}>{signedR(candidate.trainMetrics.totalR, 1)}</span>
        </div>
        <div>
          <span className="panel-dim">Max Drawdown</span>
          <span className="neg">{signedR(candidate.trainMetrics.maxDrawdownR, 1)}</span>
        </div>
        <div>
          <span className="panel-dim">Profit Factor</span>
          <span>{candidate.trainMetrics.profitFactor == null ? "—" : candidate.trainMetrics.profitFactor.toFixed(2)}</span>
        </div>
      </div>

      <div className="opt-detail-section-label">Test (Out-of-Sample)</div>
      <div className="panel-summary mono">
        <div>
          <span className="panel-dim">Trades</span>
          <span>
            {candidate.testMetrics.trades}
            {candidate.testMetrics.insufficientSample ? " (insufficient)" : ""}
          </span>
        </div>
        <div>
          <span className="panel-dim">Win Rate</span>
          <span>{pct(candidate.testMetrics.winRate)}</span>
        </div>
        <div>
          <span className="panel-dim">Expected Value</span>
          <span className={candidate.testMetrics.expectedValue >= 0 ? "pos" : "neg"}>{signedR(candidate.testMetrics.expectedValue)}</span>
        </div>
        <div>
          <span className="panel-dim">Total R</span>
          <span className={candidate.testMetrics.totalR >= 0 ? "pos" : "neg"}>{signedR(candidate.testMetrics.totalR, 1)}</span>
        </div>
        <div>
          <span className="panel-dim">EV Degradation vs Train</span>
          <span>{candidate.evDegradationPct == null ? "—" : pct(candidate.evDegradationPct)}</span>
        </div>
      </div>

      <div className="opt-detail-section-label">Robustness Score Breakdown ({candidate.robustness.total.toFixed(1)} / 100)</div>
      <div className="panel-summary mono">
        <div>
          <span className="panel-dim">EV</span>
          <span>{(candidate.robustness.evScore * 100).toFixed(0)}</span>
        </div>
        <div>
          <span className="panel-dim">Total R</span>
          <span>{(candidate.robustness.totalRScore * 100).toFixed(0)}</span>
        </div>
        <div>
          <span className="panel-dim">Drawdown</span>
          <span>{(candidate.robustness.drawdownScore * 100).toFixed(0)}</span>
        </div>
        <div>
          <span className="panel-dim">Sample Size</span>
          <span>{(candidate.robustness.sampleSizeScore * 100).toFixed(0)}</span>
        </div>
        <div>
          <span className="panel-dim">Symbol Consistency</span>
          <span>{(candidate.robustness.symbolConsistencyScore * 100).toFixed(0)}</span>
        </div>
        <div>
          <span className="panel-dim">Time Consistency</span>
          <span>{(candidate.robustness.timeConsistencyScore * 100).toFixed(0)}</span>
        </div>
        <div>
          <span className="panel-dim">Parameter Stability</span>
          <span>{(candidate.robustness.parameterStabilityScore * 100).toFixed(0)}</span>
        </div>
      </div>

      {candidate.symbolRobustness.bySymbol.length > 0 && (
        <>
          <div className="opt-detail-section-label">Symbol Breakdown ({pct(candidate.symbolRobustness.profitableSymbolsPct, 0)} profitable)</div>
          <table className="panel-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Trades</th>
                <th>Total R</th>
                <th>Win Rate</th>
              </tr>
            </thead>
            <tbody>
              {candidate.symbolRobustness.bySymbol.map((s) => (
                <tr key={s.symbol}>
                  <td>{s.symbol}</td>
                  <td>{s.trades}</td>
                  <td className={s.totalR >= 0 ? "pos" : "neg"}>{signedR(s.totalR, 1)}</td>
                  <td>{pct(s.winRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {candidate.timeRobustness.byYear.length > 0 && (
        <>
          <div className="opt-detail-section-label">Yearly Breakdown</div>
          <table className="panel-table">
            <thead>
              <tr>
                <th>Year</th>
                <th>Trades</th>
                <th>Total R</th>
                <th>Win Rate</th>
              </tr>
            </thead>
            <tbody>
              {candidate.timeRobustness.byYear.map((y) => (
                <tr key={y.key}>
                  <td>{y.key}</td>
                  <td>{y.trades}</td>
                  <td className={y.totalR >= 0 ? "pos" : "neg"}>{signedR(y.totalR, 1)}</td>
                  <td>{pct(y.winRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {candidate.warnings.length > 0 && (
        <>
          <div className="opt-detail-section-label">Warnings</div>
          {candidate.warnings.map((w, i) => (
            <div key={i} className={`opt-warning opt-warning-${w.severity}`}>
              <span className="opt-severity-chip">{severityLabel(w.severity)}</span>
              <span>{w.message}</span>
            </div>
          ))}
        </>
      )}

      <div className="opt-detail-section-label">Monte Carlo Validation (existing engine, bootstrapped from this candidate's own trades)</div>
      {!mcState || mcState.status === "idle" ? (
        <button type="button" className="strategy-link-btn" onClick={onRunMonteCarlo}>
          Run Monte Carlo Validation
        </button>
      ) : mcState.status === "loading" ? (
        <div className="panel-dim">Running Monte Carlo...</div>
      ) : mcState.status === "error" ? (
        <div className="panel-empty mc-error">{mcState.error}</div>
      ) : (
        <div className="panel-summary mono">
          <div>
            <span className="panel-dim">Training MC - Probability of Profit</span>
            <span>{mcState.train?.sufficientSample && mcState.train.stats ? pct(mcState.train.stats.finalR.probabilityPositive) : "Insufficient sample"}</span>
          </div>
          <div>
            <span className="panel-dim">Training MC - Median Final R</span>
            <span>{mcState.train?.sufficientSample && mcState.train.stats ? signedR(mcState.train.stats.finalR.median, 1) : "—"}</span>
          </div>
          <div>
            <span className="panel-dim">OOS MC - Probability of Profit</span>
            <span>{mcState.test?.sufficientSample && mcState.test.stats ? pct(mcState.test.stats.finalR.probabilityPositive) : "Insufficient sample"}</span>
          </div>
          <div>
            <span className="panel-dim">OOS MC - Median Final R</span>
            <span>{mcState.test?.sufficientSample && mcState.test.stats ? signedR(mcState.test.stats.finalR.median, 1) : "—"}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function WalkForwardSummaryView({ summary }: { summary: WalkForwardSummary }) {
  return (
    <div>
      <div className="da-widget-title">Walk-Forward Validation</div>
      <div className="panel-summary mono">
        <div>
          <span className="panel-dim">OOS Total R</span>
          <span className={summary.oosTotalR >= 0 ? "pos" : "neg"}>{signedR(summary.oosTotalR, 1)}</span>
        </div>
        <div>
          <span className="panel-dim">OOS Expected Value</span>
          <span className={summary.oosExpectedValue >= 0 ? "pos" : "neg"}>{signedR(summary.oosExpectedValue)}</span>
        </div>
        <div>
          <span className="panel-dim">OOS Consistency</span>
          <span>
            {pct(summary.oosConsistencyPct, 0)} ({summary.profitableFolds}/{summary.totalFolds} folds profitable)
          </span>
        </div>
      </div>
      <table className="panel-table">
        <thead>
          <tr>
            <th>Fold</th>
            <th>Train Trades</th>
            <th>Selected Params</th>
            <th>Test EV</th>
            <th>Test Total R</th>
          </tr>
        </thead>
        <tbody>
          {summary.folds.map((f) => (
            <tr key={f.foldIndex}>
              <td>{f.foldIndex + 1}</td>
              <td>{f.trainMetrics.trades}</td>
              <td>{Object.entries(f.selectedParams).map(([k, v]) => `${k}=${v}`).join(", ") || "(baseline)"}</td>
              <td className={f.testMetrics.expectedValue >= 0 ? "pos" : "neg"}>{signedR(f.testMetrics.expectedValue)}</td>
              <td className={f.testMetrics.totalR >= 0 ? "pos" : "neg"}>{signedR(f.testMetrics.totalR, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
