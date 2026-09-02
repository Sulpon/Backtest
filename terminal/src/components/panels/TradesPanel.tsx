import { Fragment, useEffect, useMemo, useState } from "react";
import { dataLayer } from "../../data/DataLayer";
import type { SymbolTimeframeData, Timeframe, Trade } from "../../data/types";
import { useActiveWorkspace } from "../../workspace/workspaceStore";
import { useReplayStore } from "../../replay/replayStore";
import { useJournalStore, useJournalEntry, tradeKey } from "../../journal/journalStore";
import { usePineIndicators, type PineRunResult } from "../../pine/usePineIndicators";
import { groupPineTradesByIndicator, pineJournalSourceKey } from "../../pine/pineTradesAdapter";
import { usePineTradeOverridesStore } from "../../pine/pineTradeOverridesStore";
import { usePineIndicatorStore } from "../../pine/pineIndicatorStore";
import { sendTradeReview, type TradeReviewPayload } from "../../telegram/telegramApi";
import {
  buildTradeReviewPayload,
  buildPineTradeReviewPayload,
  computeSnapshotWindow,
  computePineSnapshotWindow,
} from "../../telegram/tradeReviewPayload";
import { useChartRegistry, findChartForSymbol, type ChartSnapshotWindow } from "../chartRegistry";
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

type SendState = "idle" | "sending" | "sent" | "failed";

interface TelegramButtonProps {
  symbol: string;
  timeframe: Timeframe;
  payload: TradeReviewPayload;
  snapshotWindow: ChartSnapshotWindow;
}

// Works for both backend and Pine-indicator trades - the caller (see
// TradesPanel below) builds `payload`/`snapshotWindow` differently
// depending on source (buildTradeReviewPayload/computeSnapshotWindow vs
// buildPineTradeReviewPayload/computePineSnapshotWindow - a Pine trade's
// entryBar/exitBar index that indicator's own windowedBars, never the full
// dataset), but this component itself doesn't need to know which.
//
// Milestone 4 - automatically tries to capture a chart snapshot (same
// mechanism as the standalone "Preview Snapshot" button below) before
// sending, so the review arrives as a photo with YES/NO/PARTIALLY inline
// buttons attached. Silently sends WITHOUT a snapshot (falls back to
// Milestone 2's plain text) if no chart pane showing this exact
// symbol/timeframe is currently open - a missing snapshot is never a
// reason to fail the whole send.
function SendToTelegramButton({ symbol, timeframe, payload, snapshotWindow }: TelegramButtonProps) {
  const panes = useChartRegistry((s) => s.panes);
  const [state, setState] = useState<SendState>("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setState("sending");
    setError(null);
    try {
      const outgoing = { ...payload };
      const chart = findChartForSymbol(panes, symbol, timeframe);
      if (chart) {
        try {
          outgoing.snapshotDataUrl = await chart.takeSnapshot(snapshotWindow);
        } catch {
          // no snapshot this time - still send the review itself below
        }
      }
      const result = await sendTradeReview(outgoing);
      if (result.ok) {
        setState("sent");
      } else {
        setState("failed");
        setError(result.error);
      }
    } catch (e) {
      setState("failed");
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="jr-telegram">
      <button type="button" className="hk-key" onClick={handleClick} disabled={state === "sending"}>
        {state === "sending" ? "Sending…" : "Send to Telegram"}
      </button>
      {state === "sent" && <span className="pos">✅ Sent</span>}
      {state === "failed" && <span className="neg">❌ {error}</span>}
    </div>
  );
}

type SnapshotState = "idle" | "capturing" | "ready" | "failed";

// Milestone 3 - proves the actual chart-snapshot pipeline (chartRegistry.ts
// + chartSnapshot.ts) end to end before Milestone 4 wires it into the
// Telegram send itself: find a mounted chart pane showing this trade's
// symbol/timeframe, frame it around the trade, screenshot + composite,
// show the result inline. Requires a chart pane actually showing this
// exact symbol/timeframe to be open somewhere in the workspace (any
// dockview pane, not necessarily "chart-1") - this reuses that pane's own
// live rendering rather than building a second one, per the original
// spec's "PLATFORM CHART -> TRADE SNAPSHOT -> TELEGRAM" requirement, so
// there's no snapshot to take if no such pane is mounted.
function SnapshotPreviewButton({ symbol, timeframe, snapshotWindow }: Omit<TelegramButtonProps, "payload">) {
  const panes = useChartRegistry((s) => s.panes);
  const [state, setState] = useState<SnapshotState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  async function handleClick() {
    const chart = findChartForSymbol(panes, symbol, timeframe);
    if (!chart) {
      setState("failed");
      setError(`No open chart pane showing ${symbol} · ${timeframe.toUpperCase()} - open one to preview a snapshot`);
      return;
    }
    setState("capturing");
    setError(null);
    try {
      const url = await chart.takeSnapshot(snapshotWindow);
      setImageUrl(url);
      setState("ready");
    } catch (e) {
      setState("failed");
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="jr-snapshot">
      <div className="jr-telegram">
        <button type="button" className="hk-key" onClick={handleClick} disabled={state === "capturing"}>
          {state === "capturing" ? "Capturing…" : "Preview Snapshot"}
        </button>
        {state === "failed" && <span className="neg">❌ {error}</span>}
      </div>
      {state === "ready" && imageUrl && <img className="jr-snapshot-img" src={imageUrl} alt={`${symbol} trade snapshot`} />}
    </div>
  );
}

// Telegram review is scoped to recent trades only - unix seconds for
// 2024-01-01T00:00:00 UTC. Journal notes/tags/rating stay available for
// every trade regardless of date; only the Send to Telegram/Preview
// Snapshot buttons are gated by this.
const TELEGRAM_REVIEW_CUTOFF = Date.UTC(2024, 0, 1) / 1000;

// The backend/EURUSD-1h journal's own selector key - namespaced apart from
// pineJournalSourceKey's `pine:${id}` shape so the two can never collide.
const BACKEND_SOURCE = "backend";

interface DisplayRow {
  /** React list key - the composite id from pineTradesAdapter for a Pine
   * trade (already globally unique across indicators), or the plain
   * tradeKey for a backend trade. */
  reactKey: string;
  /** journalStore/pineTradeOverridesStore lookup key for THIS row, already
   * scoped to whichever journal (backend, or a specific indicator) is
   * currently selected - see tradeKey's doc comment on why a Pine row's
   * key must include the indicator id. */
  journalKey: string;
  trade: Trade;
  /** null for a backend row - only a Pine row has a PineRunResult to
   * convert entryBar/exitBar to a real time or inspect drawing output. */
  source: PineRunResult | null;
}

export function TradesPanel() {
  const ws = useActiveWorkspace();
  const seek = useReplayStore((s) => s.seek);
  const [dataset, setDataset] = useState<SymbolTimeframeData | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<string>(BACKEND_SOURCE);
  const entries = useJournalStore((s) => s.entries);

  useEffect(() => {
    let cancelled = false;
    // trades only exist on the 1H series - the strategy never trades daily
    dataLayer.getSymbolData(ws.symbol, "1h").then((d) => {
      if (!cancelled) setDataset(d);
    });
    return () => {
      cancelled = true;
    };
  }, [ws.symbol]);

  const backendTrades = dataset?.trades ?? [];
  const bars = dataset?.bars ?? [];

  // Each visible Pine indicator that records trades (backtest.recordTrade)
  // gets its OWN journal below - never flattened together, and never
  // merged with the backend/EURUSD-1h journal, which is a distinct trust
  // model (see this repo's docs/ARCHITECTURE.md). Kept as {trade, source}
  // pairs (not a plain Trade[]) because the Telegram buttons below need
  // each trade's own PineRunResult - its entryBar/exitBar index THAT
  // indicator's windowedBars, not any shared/full-dataset array (see
  // tradeReviewPayload.ts's Pine-specific builders).
  const pineResults = usePineIndicators(bars, dataset?.symbol, dataset?.timeframe);
  const removedPineTrades = usePineTradeOverridesStore((s) => s.removed);
  const pineGroups = useMemo(() => groupPineTradesByIndicator(pineResults, removedPineTrades), [pineResults, removedPineTrades]);
  const visiblePineCount = usePineIndicatorStore((s) => s.items.filter((i) => i.visible).length);
  // Distinguishes "still computing" from "genuinely produced zero trades" -
  // both look identical as an empty pineResults array otherwise, and a full
  // run can take a minute or more (longer if it's queued behind another
  // pending run on the shared worker - see usePineIndicators.ts).
  const pineComputing = visiblePineCount > 0 && pineResults.length === 0;

  // A tab per journal: the backend/EURUSD-1h one (always present) plus one
  // per currently-visible Pine indicator that has actually produced a
  // result (even with zero trades so far - the tab exists so the user can
  // watch it fill in). Falls back to the backend tab the moment a
  // previously-selected indicator's tab disappears (hidden/removed), so
  // "selectedSource" never points at a journal that no longer exists.
  const sourceTabs = useMemo(
    () => [
      { key: BACKEND_SOURCE, label: `Backend (${ws.symbol} 1h)` },
      ...pineGroups.map((g) => ({ key: pineJournalSourceKey(g.indicator.id), label: g.indicator.name })),
    ],
    [ws.symbol, pineGroups]
  );
  useEffect(() => {
    if (!sourceTabs.some((t) => t.key === selectedSource)) setSelectedSource(BACKEND_SOURCE);
  }, [sourceTabs, selectedSource]);

  function selectSource(key: string) {
    setSelectedSource(key);
    setExpanded(null);
  }

  const fromPine = selectedSource !== BACKEND_SOURCE;
  const selectedPineGroup = fromPine ? pineGroups.find((g) => pineJournalSourceKey(g.indicator.id) === selectedSource) ?? null : null;

  const rows: DisplayRow[] = useMemo(() => {
    if (!fromPine) {
      return backendTrades.map((t) => {
        const key = tradeKey(ws.symbol, t.entryBar);
        return { reactKey: key, journalKey: key, trade: t, source: null };
      });
    }
    if (!selectedPineGroup) return [];
    return selectedPineGroup.trades.map((p) => ({
      reactKey: p.id,
      journalKey: tradeKey(ws.symbol, p.trade.entryBar, selectedPineGroup.indicator.id),
      trade: p.trade,
      source: p.source,
    }));
  }, [fromPine, backendTrades, selectedPineGroup, ws.symbol]);

  const canJump = ws.timeframe === "1h";

  return (
    <div className="panel-scroll">
      {sourceTabs.length > 1 && (
        <div className="jr-source-tabs">
          {sourceTabs.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`jr-source-tab${selectedSource === t.key ? " active" : ""}`}
              onClick={() => selectSource(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      {pineComputing && (
        <div className="panel-dim" style={{ padding: "6px 8px", fontSize: 11 }}>
          Computing the Pine indicator over the full dataset - this can take a minute or more, and longer still if
          another indicator change is already queued.
        </div>
      )}
      {fromPine && (
        <div className="panel-dim" style={{ padding: "6px 8px", fontSize: 11 }}>
          Showing trades recorded by this Pine indicator - editing its settings updates this list. Right-click a
          position's zone on the chart to remove a trade. "Detected conditions" on a Telegram review are a
          best-effort match against this script's own BOS/CHoCH/FVG labels, not a guarantee.
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
          {rows.map((row) => {
            const { trade: t, source, journalKey: key } = row;
            const hasEntry = !!entries[key] && (entries[key].note !== "" || entries[key].tags.length > 0 || entries[key].rating > 0);
            const isOpen = expanded === key;
            // entryBar indexes a different bars array depending on source
            // (see tradeReviewPayload.ts's own doc comments) - cheap
            // either way, just an array lookup, so this runs for every
            // row (not just the expanded one) to decide whether the
            // Telegram buttons show at all.
            const entryTime = source ? source.windowedBars[t.entryBar]?.time : dataset?.bars[t.entryBar]?.time;
            const eligibleForTelegram = entryTime != null && entryTime >= TELEGRAM_REVIEW_CUTOFF;
            // Only actually build these (label scans for Pine, etc.) for
            // the one row that's expanded - every other row never needs
            // them.
            let telegramPayload: TradeReviewPayload | null = null;
            let telegramWindow: ChartSnapshotWindow | null = null;
            if (isOpen && dataset && eligibleForTelegram) {
              if (source) {
                telegramPayload = buildPineTradeReviewPayload(source, dataset.symbol, dataset.timeframe, t);
                telegramWindow = computePineSnapshotWindow(source, t);
              } else {
                telegramPayload = buildTradeReviewPayload(dataset, t);
                telegramWindow = computeSnapshotWindow(dataset, t);
              }
            }
            return (
              <Fragment key={row.reactKey}>
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
                      {dataset && telegramPayload && telegramWindow && (
                        <>
                          <SnapshotPreviewButton symbol={dataset.symbol} timeframe={dataset.timeframe} snapshotWindow={telegramWindow} />
                          <SendToTelegramButton
                            symbol={dataset.symbol}
                            timeframe={dataset.timeframe}
                            payload={telegramPayload}
                            snapshotWindow={telegramWindow}
                          />
                        </>
                      )}
                      {!eligibleForTelegram && (
                        <div className="jr-telegram">
                          <span className="panel-dim">Telegram review is only available for trades from 2024 onward.</span>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {rows.length === 0 && (
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
