import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface CustomIndicator {
  id: string;
  name: string;
  code: string;
  color: string;
  visible: boolean;
}

const PALETTE = ["#4f8cff", "#e0a64c", "#26a69a", "#ef5350", "#a78bfa", "#2dd4d0"];

export const DEFAULT_CUSTOM_CODE = `// Available: bars - an array of { time, open, high, low, close } (time is
// unix seconds, oldest first). Return an array of { time, value } points
// to plot as a line.
//
// Example below: a 20-period SMA of the close price.

const period = 20;
const out = [];
let sum = 0;
for (let i = 0; i < bars.length; i++) {
  sum += bars[i].close;
  if (i >= period) sum -= bars[i - period].close;
  if (i >= period - 1) out.push({ time: bars[i].time, value: sum / period });
}
return out;
`;

interface CustomIndicatorStore {
  items: CustomIndicator[];
  add: (name: string, code: string) => void;
  update: (id: string, changes: Partial<Pick<CustomIndicator, "name" | "code">>) => void;
  remove: (id: string) => void;
  toggleVisible: (id: string) => void;
}

export const useCustomIndicatorStore = create<CustomIndicatorStore>()(
  persist(
    (set, get) => ({
      items: [],
      add: (name, code) =>
        set((s) => ({
          items: [
            ...s.items,
            {
              id: `ci-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              name,
              code,
              color: PALETTE[get().items.length % PALETTE.length],
              visible: true,
            },
          ],
        })),
      update: (id, changes) => set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...changes } : i)) })),
      remove: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
      toggleVisible: (id) => set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, visible: !i.visible } : i)) })),
    }),
    { name: "terminal.customIndicators" }
  )
);
