import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Trade journaling (architecture doc's "Edgewonk" piece of the vision) -
 * notes/tags/rating a trader attaches to a specific historical trade.
 * Backtest trades themselves are immutable engine output (re-derived from
 * the CSV on every build_db.py run), so journal entries live in their own
 * client-side store keyed by a stable trade identity rather than being
 * bolted onto the Trade type - the engine never needs to know journaling
 * exists, and re-running the backtest never loses a trader's notes.
 */
export interface JournalEntry {
  note: string;
  tags: string[];
  rating: number; // 0 = unrated, 1-5 stars
}

const EMPTY_ENTRY: JournalEntry = { note: "", tags: [], rating: 0 };

interface JournalStore {
  entries: Record<string, JournalEntry>;
  setNote: (key: string, note: string) => void;
  addTag: (key: string, tag: string) => void;
  removeTag: (key: string, tag: string) => void;
  setRating: (key: string, rating: number) => void;
}

/** Symbol + entry bar is a stable, unique identity for a BACKEND trade
 * within the dataset a given build_db.py run produced - the backtest only
 * ever holds one open position at a time, so no two backend trades share
 * an entry bar. This is NOT true across Pine indicators: a Pine trade's
 * entryBar indexes that indicator's own windowedBars (see PineRunResult's
 * doc comment), so two different indicators can easily record a trade
 * with the same entryBar. Passing `indicatorId` scopes the key to that
 * indicator (matching the `${symbol}:pine:${indicatorId}:${bar}` shape
 * tradeReviewPayload.ts's buildPineTradeReviewPayload already uses for its
 * own Telegram tradeId), producing a key format that never collides with
 * the plain backend-trade key below - callers that omit it (every backend-
 * trade call site, unchanged) get exactly today's key, so existing
 * backend-trade journal entries in localStorage are unaffected. Any
 * already-saved Pine-trade entry keyed under the old `symbol:entryBar`
 * form (before indicatorId scoping existed) will not be found under its
 * new key - a one-time loss of pre-existing Pine-trade notes only, not
 * backend-trade notes. */
export function tradeKey(symbol: string, entryBar: number, indicatorId?: string): string {
  return indicatorId ? `${symbol}:pine:${indicatorId}:${entryBar}` : `${symbol}:${entryBar}`;
}

/** Journal key for a Strategy-scan trade (strategy/historicalScanner.ts) -
 * a sibling to tradeKey above, not an overload of it: a scan trade's
 * ScanTradeRecord.entryTime is an absolute unix timestamp (~1.7 billion),
 * never a small bar-index int like tradeKey's `entryBar` param, so reusing
 * tradeKey's own signature for it would silently give that parameter a
 * third, differently-typed meaning tradeKey's own doc comment doesn't
 * describe. The literal "scan" segment plus timeframe keeps this format
 * visually unambiguous from both of tradeKey's existing shapes and safe
 * even if a symbol is scanned at more than one timeframe. Takes exitTime
 * too, matching ScanTradeRecord.id's own shape (see that type's doc
 * comment): a single bar can open more than one distinct trade, so
 * entryTime alone isn't a unique key - without exitTime here, two such
 * trades would incorrectly share one journal note/rating even though
 * they're now correctly stored and displayed as separate rows. */
export function scanTradeKey(symbol: string, timeframe: string, entryTime: number, exitTime: number, indicatorId: string): string {
  return `${symbol}:${timeframe}:pine:${indicatorId}:scan:${entryTime}:${exitTime}`;
}

function patch(entries: Record<string, JournalEntry>, key: string, changes: Partial<JournalEntry>): Record<string, JournalEntry> {
  const current = entries[key] ?? EMPTY_ENTRY;
  return { ...entries, [key]: { ...current, ...changes } };
}

export const useJournalStore = create<JournalStore>()(
  persist(
    (set) => ({
      entries: {},
      setNote: (key, note) => set((s) => ({ entries: patch(s.entries, key, { note }) })),
      addTag: (key, tag) =>
        set((s) => {
          const current = s.entries[key] ?? EMPTY_ENTRY;
          if (!tag.trim() || current.tags.includes(tag)) return s;
          return { entries: patch(s.entries, key, { tags: [...current.tags, tag] }) };
        }),
      removeTag: (key, tag) =>
        set((s) => {
          const current = s.entries[key] ?? EMPTY_ENTRY;
          return { entries: patch(s.entries, key, { tags: current.tags.filter((x) => x !== tag) }) };
        }),
      setRating: (key, rating) => set((s) => ({ entries: patch(s.entries, key, { rating }) })),
    }),
    { name: "terminal.journal" }
  )
);

export function useJournalEntry(key: string): JournalEntry {
  return useJournalStore((s) => s.entries[key] ?? EMPTY_ENTRY);
}
