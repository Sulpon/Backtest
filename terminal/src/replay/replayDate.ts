/** All bar timestamps are UTC-based (see analysis/sessions.ts's use of
 * getUTCHours for session detection) - formatting replay dates in UTC too
 * keeps "Replay: 2026-07-31 14:00" lined up with the session/hour math
 * everywhere else, instead of drifting with the viewer's local timezone. */
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatReplayDateTime(sec: number): string {
  const d = new Date(sec * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function formatReplayDateOnly(sec: number): string {
  const d = new Date(sec * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function formatReplayTimeOnly(sec: number): string {
  const d = new Date(sec * 1000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Inverse of the two formatters above - combines a "YYYY-MM-DD" and
 * "HH:mm" pair (as produced by <input type="date"/time">) back into unix
 * seconds, interpreted as UTC to match formatReplayDateTime. */
export function parseReplayDateTime(dateStr: string, timeStr: string): number | null {
  if (!dateStr) return null;
  const ms = Date.parse(`${dateStr}T${timeStr || "00:00"}:00Z`);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}
