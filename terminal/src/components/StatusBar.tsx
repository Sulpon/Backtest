import { useEffect, useState } from "react";
import { useActiveWorkspace } from "../workspace/workspaceStore";
import { useUiStore } from "../workspace/uiStore";
import { dataLayer } from "../data/DataLayer";
import "./StatusBar.css";

export function StatusBar() {
  const ws = useActiveWorkspace();
  const hint = useUiStore((s) => s.statusHint);
  const setHint = useUiStore((s) => s.setStatusHint);
  const [providerStatus, setProviderStatus] = useState<{ provider: string; configured: boolean } | null>(null);
  const [syncing, setSyncing] = useState(false);

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
      <div className="statusbar-spacer" />
      {hint && <span className="statusbar-hint">{hint}</span>}
    </div>
  );
}
