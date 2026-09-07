import { useEffect, useState } from "react";
import { useActiveWorkspace } from "../workspace/workspaceStore";
import { useUiStore } from "../workspace/uiStore";
import { dataLayer } from "../data/DataLayer";
import { useMarketQuote, useSymbolMarketStatus } from "../data/useLiveMarketData";
import "./StatusBar.css";

// Real backend-side provider-stream status for one symbol (LIVE/CONNECTING/
// DISCONNECTED/RECONNECTING/MARKET_CLOSED) - deliberately distinct from the
// existing provider-configured indicator below (that's "is a provider
// configured at all," this is "is this SYMBOL's live stream actually
// receiving updates right now"). `undefined` (no status message yet, e.g.
// nothing has subscribed to this symbol's stream) intentionally renders as
// a neutral "no live feed" state, never as LIVE - per the user's explicit
// "do not show LIVE simply because the connection exists" requirement.
const STREAM_STATUS_LABEL: Record<string, string> = {
  live: "live",
  connecting: "connecting",
  reconnecting: "reconnecting",
  disconnected: "disconnected",
  market_closed: "market closed",
};

function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export function StatusBar() {
  const ws = useActiveWorkspace();
  const hint = useUiStore((s) => s.statusHint);
  const setHint = useUiStore((s) => s.setStatusHint);
  const [providerStatus, setProviderStatus] = useState<{ provider: string; configured: boolean } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const streamStatus = useSymbolMarketStatus(ws.symbol);
  const liveQuote = useMarketQuote(ws.symbol);

  // A plain "Xs ago" computed once at render time would freeze between
  // quotes (e.g. while MARKET_CLOSED, or mid-reconnect) - tick a "now"
  // value every few seconds so the displayed age keeps advancing even when
  // no new quote has arrived, per the user's explicit "show last update
  // time/age" requirement.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (!hint) return;
    const t = window.setTimeout(() => setHint(null), 3200);
    return () => window.clearTimeout(t);
  }, [hint, setHint]);

  // Roadmap Phase 2: purely informational - fetched once per mount, never
  // polled. A provider not being configured is an expected, common state
  // (see getProviderStatus's doc comment), not something to alarm about;
  // failing to reach the backend at all (e.g. static/offline mode) just
  // hides the indicator rather than showing an error in the status bar.
  useEffect(() => {
    let cancelled = false;
    dataLayer
      .getProviderStatus()
      .then((status) => !cancelled && setProviderStatus({ provider: status.provider, configured: status.configured }))
      .catch(() => !cancelled && setProviderStatus(null));
    return () => {
      cancelled = true;
    };
  }, []);

  function syncActiveSymbol() {
    if (syncing || !providerStatus?.configured) return;
    setSyncing(true);
    const end = Math.floor(Date.now() / 1000);
    const start = end - 60 * 60 * 24; // last 24h - a manual, bounded verification sync, not a bulk backfill
    dataLayer
      .getProviderCandles(ws.symbol, "1m", start, end)
      .then((result) => setHint(`${result.provider}: synced ${result.bars.length} candles for ${ws.symbol}`))
      .catch((err: Error) => setHint(`Provider sync failed: ${err.message}`))
      .finally(() => setSyncing(false));
  }

  return (
    <div className="statusbar mono">
      <span>{ws.symbol}</span>
      <span className="dim">·</span>
      <span>{ws.timeframe.toUpperCase()}</span>
      <span className="dim">·</span>
      <span>workspace: {ws.name}</span>
      {providerStatus && (
        <>
          <span className="dim">·</span>
          <button
            type="button"
            className="statusbar-provider"
            disabled={!providerStatus.configured || syncing}
            onClick={syncActiveSymbol}
            title={
              providerStatus.configured
                ? `Sync last 24h of ${ws.symbol} from ${providerStatus.provider}`
                : `${providerStatus.provider} provider not configured (see terminal/backend/.env.example)`
            }
          >
            {providerStatus.configured ? "●" : "○"} {providerStatus.provider}
          </button>
        </>
      )}
      {streamStatus && (
        <>
          <span className="dim">·</span>
          <span
            className={`statusbar-stream statusbar-stream--${streamStatus}`}
            title={
              liveQuote
                ? `${ws.symbol} live feed: ${STREAM_STATUS_LABEL[streamStatus]} - last update ${formatAge(now - liveQuote.timestampMs)}`
                : `${ws.symbol} live feed: ${STREAM_STATUS_LABEL[streamStatus]}`
            }
          >
            {streamStatus === "live" ? "●" : streamStatus === "market_closed" ? "◐" : "○"} {STREAM_STATUS_LABEL[streamStatus]}
            {liveQuote && streamStatus === "live" ? ` · ${formatAge(now - liveQuote.timestampMs)}` : ""}
          </span>
        </>
      )}
      <div className="statusbar-spacer" />
      {hint && <span className="statusbar-hint">{hint}</span>}
    </div>
  );
}
