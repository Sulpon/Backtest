import { useEffect, useState } from "react";
import { dataLayer } from "../../data/DataLayer";
import { useActiveWorkspace, useWorkspaceStore } from "../../workspace/workspaceStore";
import "./panels.css";

interface Row {
  symbol: string;
  last: number | null;
  changePct: number | null;
}

export function WatchlistPanel() {
  const ws = useActiveWorkspace();
  const setSymbol = useWorkspaceStore((s) => s.setSymbol);
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    let cancelled = false;
    dataLayer
      .getQuotes("1h")
      .then((quotes) => {
        if (cancelled) return;
        setRows(
          quotes.map((q) => ({
            symbol: q.symbol,
            last: q.last,
            changePct: q.last != null && q.prev ? ((q.last - q.prev) / q.prev) * 100 : null,
          }))
        );
      })
      .catch(() => !cancelled && setRows([]));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="panel-scroll">
      <table className="panel-table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Last</th>
            <th>Chg</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.symbol}
              className={r.symbol === ws.symbol ? "active" : ""}
              onClick={() => setSymbol(r.symbol)}
            >
              <td>{r.symbol}</td>
              <td className="mono">{r.last != null ? r.last.toFixed(5) : "—"}</td>
              <td className={`mono ${r.changePct != null && r.changePct >= 0 ? "pos" : "neg"}`}>
                {r.changePct != null ? `${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(2)}%` : "—"}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={3} className="panel-empty">
                Loading…
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
