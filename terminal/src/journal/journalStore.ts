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

/** Symbol + entry bar is a stable, unique identity for a trade within the
 * dataset a given build_db.py run produced - the backtest only ever holds
 * one open position at a time, so no two trades share an entry bar. */
export function tradeKey(symbol: string, entryBar: number): string {
  return `${symbol}:${entryBar}`;
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
