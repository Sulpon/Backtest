import { useEffect, useState } from "react";
import { useActiveWorkspace } from "../workspace/workspaceStore";
import { useUiStore } from "../workspace/uiStore";
import { useFocusedChartPane } from "../workspace/useFocusedChartPane";
import { dataLayer } from "../data/DataLayer";
import { WatchlistPanel } from "./panels/WatchlistPanel";
import { DrawingObjectTree } from "../drawing/DrawingObjectTree";
import { paneKey } from "../drawing/drawingStore";
import "./RightSidebar.css";

type SidebarTab = "watchlist" | "symbol" | "objects";

/** Small, self-contained widget - reuses the exact `dataLayer.getQuotes()`
 * call WatchlistPanel already makes (promise-cached in DataLayer, so this
 * is never a second network round-trip once anything else has fetched
 * quotes for this timeframe), just picks out the one row for `symbol`. */
function SymbolInfoPanel({ symbol }: { symbol: string }) {
  const [quote, setQuote] = useState<{ last: number | null; prev: number | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    dataLayer
      .getQuotes("1h")
      .then((quotes) => {
        if (cancelled) return;
        const q = quotes.find((row) => row.symbol === symbol);
        setQuote(q ? { last: q.last, prev: q.prev } : null);
      })
      .catch(() => !cancelled && setQuote(null));
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  const change = quote?.last != null && quote.prev ? quote.last - quote.prev : null;
  const changePct = change != null && quote?.prev ? (change / quote.prev) * 100 : null;

  return (
    <div className="panel-scroll">
      <div className="si-symbol mono">{symbol}</div>
      {quote ? (
        <div className="panel-summary mono">
          <div>
            <span className="panel-dim">Last</span>
            <span>{quote.last != null ? quote.last.toFixed(5) : "—"}</span>
          </div>
          <div>
            <span className="panel-dim">Change</span>
            <span className={change != null && change >= 0 ? "pos" : "neg"}>
              {change != null ? `${change >= 0 ? "+" : ""}${change.toFixed(5)}` : "—"}
              {changePct != null ? ` (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)` : ""}
            </span>
          </div>
        </div>
      ) : (
        <div className="panel-empty">Loading…</div>
      )}
    </div>
  );
}

/**
 * TradingView-style persistent right sidebar - same "icon rail + slide-out
 * panel" shape LeftToolRail.tsx already established (reuses its
 * `.rail-btn`/`.rail-glyph` CSS classes directly, see RightSidebar.css).
 * Deliberately sits OUTSIDE Dockview: Watchlist/Trades/Stats already have a
 * home as optional dockview panels (see TopToolbar's toggleWatchlist and
 * the per-workspace-preset seeding in DockviewRoot.tsx) - this is a
 * second, always-available home for the panels that most deserve one, not
 * a replacement, so it touches zero dockview/workspace-persistence code.
 */
export function RightSidebar() {
  const ws = useActiveWorkspace();
  const dockviewApi = useUiStore((s) => s.dockviewApi);
  const focused = useFocusedChartPane(dockviewApi);
  // Same fallback TopToolbar's own symbol/timeframe controls already use -
  // the focused chart pane's own params, or the workspace default.
  const symbol = focused.symbol ?? ws.symbol;
  const timeframe = focused.timeframe ?? ws.timeframe;
  const [openTab, setOpenTab] = useState<SidebarTab | null>(null);

  function toggle(tab: SidebarTab) {
    setOpenTab((cur) => (cur === tab ? null : tab));
  }

  return (
    <div className="right-sidebar">
      <div className="right-sidebar-rail">
        <button
          type="button"
          className={`rail-btn${openTab === "watchlist" ? " active" : ""}`}
          title="Watchlist"
          onClick={() => toggle("watchlist")}
        >
          <span className="rail-glyph">☰</span>
        </button>
        <button
          type="button"
          className={`rail-btn${openTab === "symbol" ? " active" : ""}`}
          title="Symbol Info"
          onClick={() => toggle("symbol")}
        >
          <span className="rail-glyph">ⓘ</span>
        </button>
        <button
          type="button"
          className={`rail-btn${openTab === "objects" ? " active" : ""}`}
          title="Object Tree - drawings on the focused chart"
          onClick={() => toggle("objects")}
        >
          <span className="rail-glyph">▤</span>
        </button>
      </div>
      {openTab && (
        <div className="right-sidebar-panel">
          <div className="right-sidebar-panel-title">
            {openTab === "watchlist" && "Watchlist"}
            {openTab === "symbol" && "Symbol Info"}
            {openTab === "objects" && "Object Tree"}
          </div>
          <div className="right-sidebar-panel-body">
            {openTab === "watchlist" && <WatchlistPanel />}
            {openTab === "symbol" && <SymbolInfoPanel symbol={symbol} />}
            {openTab === "objects" && <DrawingObjectTree paneKey={paneKey(symbol, timeframe)} />}
          </div>
        </div>
      )}
    </div>
  );
}
