import { create } from "zustand";
import { persist } from "zustand/middleware";

export type IndicatorType = "sma" | "ema" | "bb";

export interface IndicatorInstance {
  id: string;
  type: IndicatorType;
  period: number;
  color: string;
  bbMult?: number; // only meaningful for "bb"
}

export const INDICATOR_LABELS: Record<IndicatorType, string> = {
  sma: "SMA",
  ema: "EMA",
  bb: "Bollinger Bands",
};

const PALETTE = ["#4f8cff", "#e0a64c", "#26a69a", "#ef5350", "#a78bfa", "#2dd4d0"];

interface IndicatorStore {
  active: IndicatorInstance[];
  add: (type: IndicatorType, period: number) => void;
  remove: (id: string) => void;
  updatePeriod: (id: string, period: number) => void;
}

export const useIndicatorStore = create<IndicatorStore>()(
  persist(
    (set, get) => ({
      active: [],
      add: (type, period) =>
        set((s) => ({
          active: [
            ...s.active,
            {
              id: `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              type,
              period,
              color: PALETTE[get().active.length % PALETTE.length],
              bbMult: type === "bb" ? 2 : undefined,
            },
          ],
        })),
      remove: (id) => set((s) => ({ active: s.active.filter((i) => i.id !== id) })),
      updatePeriod: (id, period) => set((s) => ({ active: s.active.map((i) => (i.id === id ? { ...i, period } : i)) })),
    }),
    { name: "terminal.indicators" }
  )
);
