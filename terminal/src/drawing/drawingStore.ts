import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DrawingObject } from "./types";

const MAX_HISTORY = 50;

interface DrawingStore {
  byPane: Record<string, DrawingObject[]>;
  selectedIds: string[];
  history: Record<string, { past: DrawingObject[][]; future: DrawingObject[][] }>;

  getDrawings: (key: string) => DrawingObject[];
  select: (id: string | null) => void;
  toggleSelect: (id: string) => void;
  addToSelection: (id: string) => void;
  clearSelection: () => void;

  /** Snapshots current state for undo, then applies the mutation. Use for
   * discrete actions (add, delete, style change, and the START of a drag). */
  mutate: (key: string, fn: (drawings: DrawingObject[]) => DrawingObject[]) => void;
  /** Applies a mutation WITHOUT pushing history - for continuous drag updates,
   * so a whole drag gesture collapses into the single undo entry mutate() pushed
   * when the drag started. */
  update: (key: string, fn: (drawings: DrawingObject[]) => DrawingObject[]) => void;

  duplicate: (key: string, ids: string[]) => string[];
  setLocked: (key: string, ids: string[], locked: boolean) => void;
  setHidden: (key: string, ids: string[], hidden: boolean) => void;
  bringForward: (key: string, id: string) => void;
  sendBackward: (key: string, id: string) => void;
  remove: (key: string, ids: string[]) => void;

  undo: (key: string) => void;
  redo: (key: string) => void;
  canUndo: (key: string) => boolean;
  canRedo: (key: string) => boolean;
}

function touch<T extends DrawingObject>(obj: T): T {
  return { ...obj, updatedAt: Date.now() };
}

export const useDrawingStore = create<DrawingStore>()(
  persist(
    (set, get) => ({
      byPane: {},
      selectedIds: [],
      history: {},

      getDrawings: (key) => get().byPane[key] ?? [],

      select: (id) => set({ selectedIds: id ? [id] : [] }),
      toggleSelect: (id) =>
        set((s) => ({
          selectedIds: s.selectedIds.includes(id) ? s.selectedIds.filter((x) => x !== id) : [...s.selectedIds, id],
        })),
      addToSelection: (id) =>
        set((s) => ({ selectedIds: s.selectedIds.includes(id) ? s.selectedIds : [...s.selectedIds, id] })),
      clearSelection: () => set({ selectedIds: [] }),

      mutate: (key, fn) => {
        const current = get().byPane[key] ?? [];
        const h = get().history[key] ?? { past: [], future: [] };
        const past = [...h.past, current].slice(-MAX_HISTORY);
        set({
          byPane: { ...get().byPane, [key]: fn(current) },
          history: { ...get().history, [key]: { past, future: [] } },
        });
      },

      update: (key, fn) => {
        const current = get().byPane[key] ?? [];
        set({ byPane: { ...get().byPane, [key]: fn(current) } });
      },

      duplicate: (key, ids) => {
        const newIds: string[] = [];
        get().mutate(key, (drawings) => {
          const maxZ = drawings.reduce((m, d) => Math.max(m, d.zIndex), 0);
          const copies = drawings
            .filter((d) => ids.includes(d.id))
            .map((d, i) => {
              const id = "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
              newIds.push(id);
              // Offset in time only (a fixed number of bars is meaningless
              // across timeframes, and a price offset would be meaningless
              // across instruments) - shifted right so the copy is visibly
              // distinct from the original without guessing a bar width.
              const span = d.points.length > 1 ? Math.abs(d.points[1].time - d.points[0].time) : 0;
              const dt = (span || 3600) * 0.1;
              return touch({
                ...d,
                id,
                points: d.points.map((p) => ({ time: p.time + dt, price: p.price })),
                zIndex: maxZ + 1 + i,
                createdAt: Date.now(),
              });
            });
          return [...drawings, ...copies];
        });
        get().clearSelection();
        newIds.forEach((id) => get().addToSelection(id));
        return newIds;
      },

      setLocked: (key, ids, locked) => {
        get().mutate(key, (drawings) => drawings.map((d) => (ids.includes(d.id) ? touch({ ...d, locked }) : d)));
      },
      setHidden: (key, ids, hidden) => {
        get().mutate(key, (drawings) => drawings.map((d) => (ids.includes(d.id) ? touch({ ...d, hidden }) : d)));
      },
      bringForward: (key, id) => {
        get().mutate(key, (drawings) => {
          const maxZ = drawings.reduce((m, d) => Math.max(m, d.zIndex), 0);
          return drawings.map((d) => (d.id === id ? touch({ ...d, zIndex: maxZ + 1 }) : d));
        });
      },
      sendBackward: (key, id) => {
        get().mutate(key, (drawings) => {
          const minZ = drawings.reduce((m, d) => Math.min(m, d.zIndex), 0);
          return drawings.map((d) => (d.id === id ? touch({ ...d, zIndex: minZ - 1 }) : d));
        });
      },
      remove: (key, ids) => {
        get().mutate(key, (drawings) => drawings.filter((d) => !ids.includes(d.id)));
        get().clearSelection();
      },

      undo: (key) => {
        const h = get().history[key];
        if (!h || h.past.length === 0) return;
        const prev = h.past[h.past.length - 1];
        const current = get().byPane[key] ?? [];
        set({
          byPane: { ...get().byPane, [key]: prev },
          history: {
            ...get().history,
            [key]: { past: h.past.slice(0, -1), future: [...h.future, current].slice(-MAX_HISTORY) },
          },
        });
      },

      redo: (key) => {
        const h = get().history[key];
        if (!h || h.future.length === 0) return;
        const next = h.future[h.future.length - 1];
        const current = get().byPane[key] ?? [];
        set({
          byPane: { ...get().byPane, [key]: next },
          history: {
            ...get().history,
            [key]: { past: [...h.past, current].slice(-MAX_HISTORY), future: h.future.slice(0, -1) },
          },
        });
      },

      canUndo: (key) => (get().history[key]?.past.length ?? 0) > 0,
      canRedo: (key) => (get().history[key]?.future.length ?? 0) > 0,
    }),
    {
      // bumped from "terminal.drawings" to wipe whatever had accumulated
      // during development/testing - the old key is simply orphaned, not
      // read from anymore, which is the standard way to reset persisted
      // state for a browser this app can't otherwise reach into.
      name: "terminal.drawings.v2",
      version: 2,
      partialize: (state) => ({ byPane: state.byPane }), // history and selection are session-only
      migrate: (persisted) => {
        const state = persisted as { byPane?: Record<string, Partial<DrawingObject>[]> };
        const byPane: Record<string, DrawingObject[]> = {};
        for (const [key, drawings] of Object.entries(state.byPane ?? {})) {
          byPane[key] = drawings.map((d, i) => ({
            id: d.id ?? "d" + Date.now().toString(36) + i,
            type: d.type as DrawingObject["type"],
            points: d.points ?? [],
            style: d.style ?? { color: "#e7ebf3", lineWidth: 2 },
            props: d.props ?? {},
            meta: d.meta,
            locked: d.locked ?? false,
            hidden: d.hidden ?? false,
            zIndex: d.zIndex ?? i,
            createdAt: d.createdAt ?? Date.now(),
            updatedAt: d.updatedAt ?? Date.now(),
          }));
        }
        return { byPane };
      },
    }
  )
);

export function paneKey(symbol: string, timeframe: string): string {
  return `${symbol}:${timeframe}`;
}
