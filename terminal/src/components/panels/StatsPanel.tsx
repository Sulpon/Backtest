import { useEffect, useState } from "react";
import { dataLayer } from "../../data/DataLayer";
import type { BacktestStats } from "../../data/types";
import { useActiveWorkspace } from "../../workspace/workspaceStore";
import "./panels.css";

export function StatsPanel() {
  const ws = useActiveWorkspace();
  const [stats, setStats] = useState<BacktestStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    // stats are computed over the 1H series only, same as trades
    dataLayer.getSymbolData(ws.symbol, "1h").then((d) => {
      if (!cancelled) setStats(d.stats);
    });
    return () => {
      cancelled = true;
    };
  }, [ws.symbol]);

  if (!stats) return <div className="panel-empty">Loading…</div>;

  return (
    <div className="panel-scroll">
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
