import { Fragment, useEffect, useMemo, useState } from "react";
import { dataLayer } from "../../data/DataLayer";
import type { CandleBar, Trade } from "../../data/types";
import { useActiveWorkspace } from "../../workspace/workspaceStore";
import { useReplayStore } from "../../replay/replayStore";
import { useJournalStore, useJournalEntry, tradeKey } from "../../journal/journalStore";
import { usePineIndicators } from "../../pine/usePineIndicators";
import { collectPineTrades } from "../../pine/pineTradesAdapter";
import { usePineTradeOverridesStore } from "../../pine/pineTradeOverridesStore";
import { usePineIndicatorStore } from "../../pine/pineIndicatorStore";
import "./panels.css";

const STARS = [1, 2, 3, 4, 5];

function StarRating({ tradeKey: key }: { tradeKey: string }) {
  const rating = useJournalEntry(key).rating;
  const setRating = useJournalStore((s) => s.setRating);
  return (
    <div className="jr-stars">
      {STARS.map((n) => (
        <button
          key={n}
          type="button"
          className={`jr-star${n <= rating ? " filled" : ""}`}
          title={`${n} star${n > 1 ? "s" : ""}`}
          onClick={() => setRating(key, rating === n ? 0 : n)}
        >
          ★
        </button>
      ))}
    </div>
  );
}

function TagEditor({ tradeKey: key }: { tradeKey: string }) {
  const tags = useJournalEntry(key).tags;
  const addTag = useJournalStore((s) => s.addTag);
  const removeTag = useJournalStore((s) => s.removeTag);
  const [input, setInput] = useState("");

  function commit() {
    const t = input.trim();
    if (t) addTag(key, t);
    setInput("");
  }

  return (
    <div className="jr-tags">
      {tags.map((t) => (
        <span key={t} className="jr-tag">
          {t}
          <button type="button" onClick={() => removeTag(key, t)} title="Remove tag">
            &times;
          </button>
        </span>
      ))}
      <input
        className="jr-tag-input"
        placeholder="+ tag"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        onBlur={commit}
      />
    </div>
  );
}

function JournalEditor({ tradeKey: key }: { tradeKey: string }) {
  const note = useJournalEntry(key).note;
  const setNote = useJournalStore((s) => s.setNote);
  return (
    <div className="jr-editor">
      <StarRating tradeKey={key} />
      <TagEditor tradeKey={key} />
      <textarea
        className="jr-note"
        placeholder="What was your read on this trade? What would you do differently?"
        value={note}
        onChange={(e) => setNote(key, e.target.value)}
      />
    </div>
  );
}

export function TradesPanel() {
  const ws = useActiveWorkspace();
  const seek = useReplayStore((s) => s.seek);
  const [backendTrades, setBackendTrades] = useState<Trade[]>([]);
  const [bars, setBars] = useState<CandleBar[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const entries = useJournalStore((s) => s.entries);

  useEffect(() => {
    let cancelled = false;
    // trades only exist on the 1H series - the strategy never trades daily
    dataLayer.getSymbolData(ws.symbol, "1h").then((d) => {
      if (!cancelled) {
        setBackendTrades(d.trades);
        setBars(d.bars);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [ws.symbol]);

  // A Pine indicator that records trades (backtest.recordTrade) takes over
  // this list entirely while it has any - same reasoning as ChartPane's
  // pane-header stat: that's what makes "change a setting, see the trade
  // count update" actually true, rather than showing two disconnected
  // trade lists side by side.
  const pineResults = usePineIndicators(bars);
  const removedPineTrades = usePineTradeOverridesStore((s) => s.removed);
  const pineTrades = useMemo(() => collectPineTrades(pineResults, removedPineTrades), [pineResults, removedPineTrades]);
  const trades = pineTrades.length > 0 ? pineTrades : backendTrades;
  const fromPine = pineTrades.length > 0;
  const visiblePineCount = usePineIndicatorStore((s) => s.items.filter((i) => i.visible).length);
  // Distinguishes "still computing" from "genuinely produced zero trades" -
  // both look identical as an empty pineResults array otherwise, and a full
  // run can take a minute or more (longer if it's queued behind another
  // pending run on the shared worker - see usePineIndicators.ts).
  const pineComputing = visiblePineCount > 0 && pineResults.length === 0;

  const canJump = ws.timeframe === "1h";

  return (
    <div className="panel-scroll">
      {pineComputing && (
        <div className="panel-dim" style={{ padding: "6px 8px", fontSize: 11 }}>
          Computing the Pine indicator over the full dataset - this can take a minute or more, and longer still if
          another indicator change is already queued.
        </div>
      )}
      {fromPine && (
        <div className="panel-dim" style={{ padding: "6px 8px", fontSize: 11 }}>
          Showing trades recorded by a Pine indicator - editing its settings updates this list. Right-click a
          position's zone on the chart to remove a trade.
        </div>
      )}
      <table className="panel-table">
        <thead>
          <tr>
            <th />
            <th>Dir</th>
            <th>Entry</th>
            <th>Result</th>
            <th>R</th>
            <th>Setup</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => {
            const key = tradeKey(ws.symbol, t.entryBar);
            const hasEntry = !!entries[key] && (entries[key].note !== "" || entries[key].tags.length > 0 || entries[key].rating > 0);
            const isOpen = expanded === key;
            return (
              <Fragment key={key}>
                <tr className={canJump ? "clickable" : ""} title={canJump ? "Jump replay to this trade" : "Switch to 1H to jump here"}>
                  <td className="jr-expand-cell">
                    <button
                      type="button"
                      className={`jr-expand-btn${hasEntry ? " has-entry" : ""}`}
                      title={isOpen ? "Collapse journal" : "Journal this trade"}
                      onClick={() => setExpanded(isOpen ? null : key)}
                    >
                      {isOpen ? "▾" : "▸"}
                    </button>
                  </td>
                  <td className={t.dir === "long" ? "pos" : "neg"} onClick={() => canJump && seek(t.entryBar)}>
                    {t.dir === "long" ? "Long" : "Short"}
                  </td>
                  <td className="mono" onClick={() => canJump && seek(t.entryBar)}>
                    {t.entryPrice.toFixed(5)}
                  </td>
                  <td className={t.result === "Win" ? "pos" : "neg"} onClick={() => canJump && seek(t.entryBar)}>
                    {t.result}
                  </td>
                  <td className={`mono ${t.r >= 0 ? "pos" : "neg"}`} onClick={() => canJump && seek(t.entryBar)}>
                    {t.r >= 0 ? "+" : ""}
                    {t.r.toFixed(2)}
                  </td>
                  <td className="panel-dim" onClick={() => canJump && seek(t.entryBar)}>
                    {t.setup}
                  </td>
                </tr>
                {isOpen && (
                  <tr className="jr-row">
                    <td colSpan={6}>
                      <JournalEditor tradeKey={key} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {trades.length === 0 && (
            <tr>
              <td colSpan={6} className="panel-empty">
                No trades
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
