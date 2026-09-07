import { useMonteCarloStore } from "../../strategy/monteCarlo/monteCarloStore";
import { MonteCarloMyStrategyMode } from "./MonteCarloMyStrategyMode";
import { MonteCarloStrategyLabMode } from "./MonteCarloStrategyLabMode";
import { MonteCarloChallengeMode } from "./MonteCarloChallengeMode";
import "./panels.css";
import "./MonteCarlo.css";

/**
 * Root of the Monte Carlo tab - the My Strategy / Strategy Lab / Challenge
 * mode switch (monteCarloStore.ts's `mode`); each mode owns its own
 * filters/params/run state in that same store, so switching tabs never
 * loses or merges another mode's configuration or last result. No mode
 * ever runs automatically on mount/mode-switch - see each mode's own
 * results view idle state and "Run" button.
 */
export function MonteCarloPanel() {
  const mode = useMonteCarloStore((s) => s.mode);
  const setMode = useMonteCarloStore((s) => s.setMode);

  return (
    <div className="panel-scroll mc-panel">
      <div className="jr-source-tabs">
        <button type="button" className={`jr-source-tab${mode === "myStrategy" ? " active" : ""}`} onClick={() => setMode("myStrategy")}>
          My Strategy
        </button>
        <button type="button" className={`jr-source-tab${mode === "strategyLab" ? " active" : ""}`} onClick={() => setMode("strategyLab")}>
          Strategy Lab
        </button>
        <button type="button" className={`jr-source-tab${mode === "challenge" ? " active" : ""}`} onClick={() => setMode("challenge")}>
          Challenge
        </button>
      </div>
      {mode === "myStrategy" && <MonteCarloMyStrategyMode />}
      {mode === "strategyLab" && <MonteCarloStrategyLabMode />}
      {mode === "challenge" && <MonteCarloChallengeMode />}
    </div>
  );
}
