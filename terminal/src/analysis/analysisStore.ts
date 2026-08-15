import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SessionId } from "./sessions";

/**
 * Analysis hub state (architecture doc, Section 05/06): SMC concepts are
 * engine-detected overlays, not user drawings, so their visibility lives
 * here rather than in drawingStore. BOS/CHoCH/FVG/OrderBlock/Liquidity/
 * VolumeImbalance are wired to real data; Market Structure Shift and
 * Mitigation Block stay reserved - both are genuinely ambiguous/overlapping
 * with concepts already covered (MSS with CHoCH, Mitigation Block as a
 * lifecycle state of Order Block) rather than clearly distinct patterns, so
 * they're not worth forcing in just to empty the reserved list. `swings`
 * (the H/HH/LH/L/LL/HL structure labels) and `trades` (backtest SL/TP
 * zones) aren't SMC concepts either, but they're rendered through this same
 * toggle mechanism in ChartPane, so they live here too rather than
 * inventing a second toggle system. Session band visibility lives alongside
 * it for the same reason - it's engine/calendar-derived, not a user
 * drawing.
 *
 * Everything defaults OFF: a fresh chart should be naked candles, with the
 * trader opting into whatever analysis they want layered on top, not the
 * other way around.
 */
export type SmcOverlayId = "swings" | "bos" | "choch" | "fvg" | "orderBlock" | "liquidity" | "volumeImbalance" | "trades";

interface AnalysisStore {
  smcVisible: Record<SmcOverlayId, boolean>;
  sessionsVisible: Record<SessionId, boolean>;
  toggleSmc: (id: SmcOverlayId) => void;
  toggleSession: (id: SessionId) => void;
}

export const useAnalysisStore = create<AnalysisStore>()(
  persist(
    (set) => ({
      smcVisible: {
        swings: false,
        bos: false,
        choch: false,
        fvg: false,
        orderBlock: false,
        liquidity: false,
        volumeImbalance: false,
        trades: false,
      },
      sessionsVisible: { asian: false, london: false, newYork: false },
      toggleSmc: (id) => set((s) => ({ smcVisible: { ...s.smcVisible, [id]: !s.smcVisible[id] } })),
      toggleSession: (id) => set((s) => ({ sessionsVisible: { ...s.sessionsVisible, [id]: !s.sessionsVisible[id] } })),
    }),
    // bumped from "terminal.analysis" - defaults flipped from all-on to
    // all-off, and a version bump is the only way to make that reach a
    // browser that already persisted the old all-on state
    { name: "terminal.analysis.v2" }
  )
);
