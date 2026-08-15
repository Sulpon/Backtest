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
    dataLayer.listSymbols().then(async (symbols) => {
      const loaded = await Promise.all(
        symbols.map(async (symbol): Promise<Row> => {
          try {
            const d = await dataLayer.getSymbolData(symbol, "1h");
            const bars = d.bars;
            const last = bars.length ? bars[bars.length - 1].close : null;
            const prev = bars.length > 1 ? bars[bars.length - 2].close : null;
            const changePct = last != null && prev ? ((last - prev) / prev) * 100 : null;
            return { symbol, last, changePct };
          } catch {
            return { symbol, last: null, changePct: null };
          }
        })
      );
      if (!cancelled) setRows(loaded);
    });
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
