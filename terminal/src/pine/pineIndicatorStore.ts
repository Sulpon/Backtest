import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface PineIndicator {
  id: string;
  name: string;
  code: string;
  visible: boolean;
  /** Keyed by the Pine variable name each input() call is assigned to -
   * see Interpreter.callInput in interpreter.ts. */
  inputOverrides: Record<string, unknown>;
  /** Unix seconds. When set, bars before this time are never handed to the
   * interpreter (see usePineIndicators.ts) - the script's own state
   * (structureHigh/structureLow, open trades, etc.) starts completely
   * fresh from this point, exactly as if history began here. This is also
   * why trades recorded before this date can never appear: the script has
   * no visibility into bars earlier than it. null/undefined means "from
   * the start of available history", matching prior behavior. */
  startDate: number | null;
}

export const DEFAULT_PINE_CODE = `//@version=5
indicator("My Script", overlay=true)

// A minimal starting point - paste a real Pine v5 script over this (see
// the Pine tab's note on what's supported) or build on this example: a
// horizontal line at the highest high of the last 20 bars.

len = input.int(20, "Length")
plot(ta.highest(len), title="Highest", color=color.blue)
`;

const PALETTE = ["#4f8cff", "#e0a64c", "#26a69a", "#ef5350", "#a78bfa", "#2dd4d0"];

interface PineIndicatorStore {
  items: PineIndicator[];
  add: (name: string, code: string) => string;
  update: (id: string, changes: Partial<Pick<PineIndicator, "name" | "code">>) => void;
  remove: (id: string) => void;
  toggleVisible: (id: string) => void;
  setVisible: (id: string, visible: boolean) => void;
  setStartDate: (id: string, startDate: number | null) => void;
  setInputOverride: (id: string, key: string, value: unknown) => void;
  /** Bulk-replaces every override at once - used by the settings dialog's
   * Cancel (restore the snapshot taken on open) and Defaults (clear to the
   * script's own coded defaults) actions, so those work as one atomic
   * change instead of one setInputOverride call per field. */
  setInputOverrides: (id: string, overrides: Record<string, unknown>) => void;
}

export const usePineIndicatorStore = create<PineIndicatorStore>()(
  persist(
    (set) => ({
      items: [],
      add: (name, code) => {
        const id = `pi-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        set((s) => ({
          items: [...s.items, { id, name, code, visible: true, inputOverrides: {}, startDate: null }],
        }));
        return id;
      },
      update: (id, changes) => set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...changes } : i)) })),
      remove: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
      toggleVisible: (id) => set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, visible: !i.visible } : i)) })),
      setVisible: (id, visible) => set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, visible } : i)) })),
      setStartDate: (id, startDate) => set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, startDate } : i)) })),
      setInputOverride: (id, key, value) =>
        set((s) => ({
          items: s.items.map((i) => (i.id === id ? { ...i, inputOverrides: { ...i.inputOverrides, [key]: value } } : i)),
        })),
      setInputOverrides: (id, overrides) =>
        set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, inputOverrides: overrides } : i)) })),
    }),
    { name: "terminal.pineIndicators" }
  )
);

export function nextPaletteColor(index: number): string {
  return PALETTE[index % PALETTE.length];
}
