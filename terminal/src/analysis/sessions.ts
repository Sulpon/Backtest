export type SessionId = "asian" | "london" | "newYork";

export interface SessionDef {
  id: SessionId;
  label: string;
  startHour: number; // UTC hour, 0-23
  endHour: number; // UTC hour, 0-23 - none of these wrap past midnight
  color: string; // low-alpha rgba fill for the chart band
}

export const SESSIONS: SessionDef[] = [
  { id: "asian", label: "Asian (Tokyo)", startHour: 0, endHour: 9, color: "rgba(129,140,248,0.11)" },
  { id: "london", label: "London", startHour: 7, endHour: 16, color: "rgba(56,189,248,0.11)" },
  { id: "newYork", label: "New York", startHour: 12, endHour: 21, color: "rgba(244,114,182,0.11)" },
];

const DAY_SECONDS = 86400;
const MAX_SPAN_SECONDS = 30 * DAY_SECONDS;

export interface SessionBand {
  session: SessionDef;
  start: number; // unix seconds
  end: number;
}

/**
 * Session bands (one per session per calendar day) that overlap [from, to].
 * Skips entirely once the range would mean thousands of bands (a
 * multi-year zoomed-out view) - sessions only read as intraday shading
 * anyway, the same reasoning FVG/OrderBlock windowing already applies to
 * skip out-of-view items rather than ever rendering an unbounded number.
 */
export function sessionBandsInRange(from: number, to: number): SessionBand[] {
  if (to - from > MAX_SPAN_SECONDS) return [];
  const bands: SessionBand[] = [];
  const firstDay = Math.floor(from / DAY_SECONDS) * DAY_SECONDS;
  for (let day = firstDay; day <= to; day += DAY_SECONDS) {
    for (const session of SESSIONS) {
      const start = day + session.startHour * 3600;
      const end = day + session.endHour * 3600;
      if (end < from || start > to) continue;
      bands.push({ session, start, end });
    }
  }
  return bands;
}

/** UTC hours at which some session opens - the replay "jump to session"
 * transport seeks to the next/previous bar whose hour matches one of these. */
export const SESSION_OPEN_HOURS = Array.from(new Set(SESSIONS.map((s) => s.startHour))).sort((a, b) => a - b);
