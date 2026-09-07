import { useEffect, useMemo, useState } from "react";
import { dataLayer } from "../../data/DataLayer";
import type { BacktestStats } from "../../data/types";
import { useActiveWorkspace } from "../../workspace/workspaceStore";
import { useStrategyScanStore } from "../../strategy/strategyScanStore";
import { scanTradesToStatsInput } from "../../strategy/scanStats";
import { computeLiveStats } from "../../replay/applyCursor";
import "./panels.css";

const BACKEND_SOURCE = "backend";
const STRATEGY_SOURCE = "strategy-scan";

export function StatsPanel() {
  const ws = useActiveWorkspace();
  const [backendStats, setBackendStats] = useState<BacktestStats | null>(null);
  const [source, setSource] = useState<string>(BACKEND_SOURCE);

  useEffect(() => {
    let cancelled = false;
    // stats are computed over the 1H series only, same as trades
    dataLayer.getSymbolData(ws.symbol, "1h").then((d) => {
      if (!cancelled) setBackendStats(d.stats);
    });
    return () => {
      cancelled = true;
    };
  }, [ws.symbol]);

  // Strategy tab's combined multi-symbol scan trades - same store
  // TradesPanel's "Strategy Scan" source tab reads from, fed through the
  // SAME computeLiveStats() call TradesPanel's own summary tiles use, so
  // Journal and Performance provably derive from one calculation over one
  // set of trade records, not two independent engines.
  const scanTradesMap = useStrategyScanStore((s) => s.trades);
  const scanTrades = useMemo(() => Object.values(scanTradesMap), [scanTradesMap]);
  const scanStats = useMemo(() => computeLiveStats(scanTradesToStatsInput(scanTrades), 1), [scanTrades]);

  useEffect(() => {
    if (source === STRATEGY_SOURCE && scanTrades.length === 0) setSource(BACKEND_SOURCE);
  }, [source, scanTrades.length]);

  const stats = source === STRATEGY_SOURCE ? scanStats : backendStats;

  if (!stats) return <div className="panel-empty">Loading…</div>;

  return (
    <div className="panel-scroll">
      {scanTrades.length > 0 && (
        <div className="jr-source-tabs">
          <button
            type="button"
            className={`jr-source-tab${source === BACKEND_SOURCE ? " active" : ""}`}
            onClick={() => setSource(BACKEND_SOURCE)}
          >
            Backend ({ws.symbol} 1h)
          </button>
          <button
            type="button"
            className={`jr-source-tab${source === STRATEGY_SOURCE ? " active" : ""}`}
            onClick={() => setSource(STRATEGY_SOURCE)}
          >
            Strategy Scan
          </button>
        </div>
      )}
      <div className="panel-summary mono">
        <div>
          <span className="panel-dim">Total</span>
          <span>{stats.total}</span>
        </div>
        <div>
          <span className="panel-dim">Win Rate</span>
          <span>{stats.winRate.toFixed(1)}%</span>
        </div>
        <div>
          <span className="panel-dim">Expectancy</span>
          <span className={stats.expectancy >= 0 ? "pos" : "neg"}>
            {stats.expectancy >= 0 ? "+" : ""}
            {stats.expectancy.toFixed(2)}R
          </span>
        </div>
        <div>
          <span className="panel-dim">Breakeven WR</span>
          <span>{stats.breakevenWr.toFixed(1)}%</span>
        </div>
      </div>
      <table className="panel-table">
        <thead>
          <tr>
            <th>Setup</th>
            <th>N</th>
            <th>WR</th>
            <th>Exp</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(stats.bySetup).map(([setup, s]) => (
            <tr key={setup}>
              <td className="panel-dim">{setup}</td>
              <td className="mono">{s.n}</td>
              <td className="mono">{s.wr.toFixed(1)}%</td>
              <td className={`mono ${s.exp >= 0 ? "pos" : "neg"}`}>
                {s.exp >= 0 ? "+" : ""}
                {s.exp.toFixed(2)}R
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
