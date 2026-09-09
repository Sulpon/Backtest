import { useEffect, useState } from "react";
import { dataLayer } from "../../data/DataLayer";
import { useActiveWorkspace, useWorkspaceStore } from "../../workspace/workspaceStore";
import { groupSymbolsByCategory, type WatchlistCategory } from "./watchlistGrouping";
import "./WatchlistPanel.css";

interface Row {
  symbol: string;
  last: number | null;
  changePct: number | null;
}

export function WatchlistPanel() {
  const ws = useActiveWorkspace();
  const setSymbol = useWorkspaceStore((s) => s.setSymbol);
  const [rows, setRows] = useState<Row[]>([]);
  // Local, unpersisted collapse state per category - out of scope to persist
  // this (no per-user watchlist settings model exists), so every section
  // just starts expanded on mount like TradingView's own default.
  const [collapsed, setCollapsed] = useState<Record<WatchlistCategory, boolean>>({ Forex: false, Metals: false });

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

  const sections = groupSymbolsByCategory(rows);

  return (
    <div className="wl-scroll">
      {sections.map(([category, categoryRows]) => {
        const isCollapsed = collapsed[category];
        return (
          <div key={category}>
            <button
              type="button"
              className="wl-section-header"
              onClick={() => setCollapsed((c) => ({ ...c, [category]: !c[category] }))}
            >
              <span className={`wl-section-caret${isCollapsed ? " collapsed" : ""}`}>▾</span>
              {category.toUpperCase()}
            </button>
            {!isCollapsed &&
              categoryRows.map((r) => (
                <button
                  key={r.symbol}
                  type="button"
                  className={`wl-row${r.symbol === ws.symbol ? " active" : ""}`}
                  onClick={() => setSymbol(r.symbol)}
                >
                  <span className="wl-row-symbol">{r.symbol}</span>
                  <span className="wl-row-prices">
                    <span className="wl-row-last">{r.last != null ? r.last.toFixed(5) : "—"}</span>
                    <span className={`wl-row-change ${r.changePct != null && r.changePct >= 0 ? "pos" : "neg"}`}>
                      {r.changePct != null ? `${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(2)}%` : "—"}
                    </span>
                  </span>
                </button>
              ))}
          </div>
        );
      })}
      {rows.length === 0 && <div className="wl-empty">Loading…</div>}
    </div>
  );
}
