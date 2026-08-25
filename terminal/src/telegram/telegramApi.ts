/**
 * Talks to the backend's /api/telegram/* routes (see terminal/backend/app/
 * main.py + app/telegram/service.py). Deliberately NOT part of DataLayer -
 * that interface is explicitly scoped to candle/structure data (see its own
 * doc comment); this is unrelated config/status, small enough not to
 * warrant its own DataLayer-style pluggable-implementation abstraction.
 *
 * No bot token or secret ever reaches this file or the browser - the
 * backend only ever reports whether it's configured, never the value.
 */
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:8000";

export interface TelegramStatus {
  configured: boolean;
}

export interface TelegramTestResult {
  ok: boolean;
  error: string | null;
}

export async function getTelegramStatus(): Promise<TelegramStatus> {
  const res = await fetch(`${API_BASE}/api/telegram/status`);
  if (!res.ok) throw new Error(`Failed to fetch Telegram status (HTTP ${res.status})`);
  return res.json();
}

export async function testTelegram(): Promise<TelegramTestResult> {
  const res = await fetch(`${API_BASE}/api/telegram/test`, { method: "POST" });
  if (!res.ok) throw new Error(`Telegram test request failed (HTTP ${res.status})`);
  return res.json();
}

/** Mirrors backend/app/main.py's TradeReviewRequest field-for-field - the
 * backend does no lookup/derivation of its own, only formatting + sending,
 * so every field here must already be something the caller has on hand
 * (see tradeConditions.ts for how `conditions` gets computed). */
export interface TradeReviewPayload {
  tradeId: string;
  symbol: string;
  timeframe: string;
  direction: "LONG" | "SHORT";
  setup: string;
  entry: number;
  sl: number;
  tp: number;
  rr: number;
  resultR: number;
  closedAt: string;
  conditions: {
    liquiditySweep: boolean;
    bos: boolean;
    choch: boolean;
    fvg: boolean;
  };
  /** "data:image/png;base64,...." from ChartPane's takeSnapshot() (see
   * chartSnapshot.ts), or omitted when no matching chart pane was open to
   * capture from. Optional - the backend falls back to a plain text-only
   * send (no photo, no inline buttons) when it's missing. */
  snapshotDataUrl?: string;
}

export async function sendTradeReview(payload: TradeReviewPayload): Promise<TelegramTestResult> {
  const res = await fetch(`${API_BASE}/api/telegram/send-trade`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Telegram send-trade request failed (HTTP ${res.status})`);
  return res.json();
}
