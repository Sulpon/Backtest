import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  DrawingEventLogEntry,
  FibonacciEvent,
  MarketStructureEvent,
  MarketStructureRevision,
  UserClassification,
} from "./types";

/** One id per browser tab session - distinguishes "this session's" edits
 * from another tab's in the log, since this app has no pre-existing
 * session concept to reuse (it's an interactive terminal, not a batch
 * runner with discrete session records). Regenerated on every page load,
 * same lifetime as the in-memory undo history in drawingStore. */
export const marketStructureSessionId = "sess-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

interface MarketStructureStore {
  marketStructures: MarketStructureEvent[];
  fibonacciEvents: FibonacciEvent[];
  drawingEvents: DrawingEventLogEntry[];
  nextSequence: number;

  addMarketStructure: (event: MarketStructureEvent) => void;
  editMarketStructure: (
    id: string,
    revision: MarketStructureRevision,
    fields: Pick<
      MarketStructureEvent,
      | "start"
      | "end"
      | "rangeCandles"
      | "rangePercent"
      | "rangePercentPerCandle"
      | "rangeHigh"
      | "rangeLow"
      | "absolutePriceDistance"
      | "directionalMovePercent"
      | "startTimestamp"
      | "endTimestamp"
      | "durationMinutes"
      | "durationCandles"
      | "rawDrawing"
    >
  ) => void;
  deleteMarketStructure: (id: string) => void;
  setUserNote: (id: string, note: string | null) => void;
  setUserClassification: (id: string, classification: UserClassification) => void;

  addFibonacciEvent: (event: FibonacciEvent) => void;
  editFibonacciEvent: (
    id: string,
    fields: Pick<FibonacciEvent, "startCandleIndex" | "endCandleIndex" | "startTimestamp" | "endTimestamp" | "startPrice" | "endPrice" | "levels" | "rawDrawing">
  ) => void;
  deleteFibonacciEvent: (id: string) => void;

  appendDrawingEvent: (entry: DrawingEventLogEntry) => void;

  nextId: (prefix: "ms" | "fib" | "evt") => { id: string; sequence: number };
}

export const useMarketStructureStore = create<MarketStructureStore>()(
  persist(
    (set, get) => ({
      marketStructures: [],
      fibonacciEvents: [],
      drawingEvents: [],
      nextSequence: 1,

      nextId: (prefix) => {
        const sequence = get().nextSequence;
        set({ nextSequence: sequence + 1 });
        return { id: `${prefix}-${sequence}`, sequence };
      },

      addMarketStructure: (event) => set((s) => ({ marketStructures: [...s.marketStructures, event] })),

      editMarketStructure: (id, revision, fields) =>
        set((s) => ({
          marketStructures: s.marketStructures.map((m) =>
            m.id === id
              ? {
                  ...m,
                  ...fields,
                  revision: revision.revision,
                  editHistory: [...m.editHistory, revision],
                  updatedAt: revision.editedAt,
                }
              : m
          ),
        })),

      deleteMarketStructure: (id) =>
        set((s) => ({
          marketStructures: s.marketStructures.map((m) =>
            m.id === id && m.status === "active" ? { ...m, status: "deleted", deletedAt: Date.now(), updatedAt: Date.now() } : m
          ),
        })),

      setUserNote: (id, note) =>
        set((s) => ({
          marketStructures: s.marketStructures.map((m) => (m.id === id ? { ...m, userNote: note, updatedAt: Date.now() } : m)),
        })),

      setUserClassification: (id, classification) =>
        set((s) => ({
          marketStructures: s.marketStructures.map((m) =>
            m.id === id ? { ...m, userClassification: classification, updatedAt: Date.now() } : m
          ),
        })),

      addFibonacciEvent: (event) => set((s) => ({ fibonacciEvents: [...s.fibonacciEvents, event] })),

      editFibonacciEvent: (id, fields) =>
        set((s) => ({
          fibonacciEvents: s.fibonacciEvents.map((f) => (f.id === id ? { ...f, ...fields, updatedAt: Date.now() } : f)),
        })),

      deleteFibonacciEvent: (id) =>
        set((s) => ({
          fibonacciEvents: s.fibonacciEvents.map((f) =>
            f.id === id && f.status === "active" ? { ...f, status: "deleted", deletedAt: Date.now(), updatedAt: Date.now() } : f
          ),
        })),

      appendDrawingEvent: (entry) => set((s) => ({ drawingEvents: [...s.drawingEvents, entry] })),
    }),
    {
      name: "terminal.marketStructure.v1",
      version: 1,
    }
  )
);
