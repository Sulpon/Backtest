import { create } from "zustand";
import { nearestIndexByTime } from "../lib/bars";
import { SESSION_OPEN_HOURS } from "../analysis/sessions";

/**
 * The Replay Engine (architecture doc, Section 09): the single source of
 * truth for "what's visible right now." ChartPane and TopToolbar are
 * siblings - this store is the bridge between them, exactly the role the
 * doc describes. ChartPane populates it with the current dataset's shape
 * (setDataset) and reacts to cursor changes; TopToolbar only ever calls
 * the transport actions below, never touches bar data directly.
 *
 * Every control reduces to seek(bar) and play(speed)/pause(), per the doc -
 * First/Prev/Next/JumpToDate/JumpToTrade are all just seek() with different
 * math for picking the target bar.
 */

const BASE_INTERVAL_MS = 600;
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16] as const;
const BIG_STEP_BARS = 10;

interface ReplayStore {
  active: boolean;
  cursorBar: number;
  totalBars: number;
  barTimes: number[]; // unix seconds, ascending - for jump-to-date + progress display
  tradeEntryBars: number[]; // ascending - for jump-to-trade
  isPlaying: boolean;
  speed: number;
  /** Bumped by every jump-style move (begin/seek and anything built on them),
   * never by a single step or a play tick. ChartPane uses a change here to
   * tell "reframe the viewport" apart from "nudge it forward one bar" -
   * more reliable than inferring intent from how far the cursor moved. */
  jumpNonce: number;
  /** True while "Replay" has been clicked but a start point hasn't been
   * confirmed yet - the setup step from the architecture doc's "Select
   * Replay Start" interaction. Chart clicks are only interpreted as a
   * replay-start pick while this is true. */
  setupArmed: boolean;
  /** The bar the user has picked (by clicking the chart) while armed but
   * not yet confirmed - distinct from cursorBar so a still-live chart isn't
   * disturbed until the user actually confirms. */
  pendingBar: number | null;

  setDataset: (totalBars: number, barTimes: number[], tradeEntryBars: number[]) => void;
  begin: (fromBar?: number) => void;
  exit: () => void;
  seek: (bar: number) => void;
  /** Continuous-drag variant of seek() - moves the cursor without bumping
   * jumpNonce, so ChartPane's soft "comfortable zone" follow logic decides
   * whether to reframe instead of force-recentering on every pixel of drag.
   * Call seek() once at drag-end to force a clean final reframe. */
  scrub: (bar: number) => void;
  seekToDate: (dateMs: number) => void;
  first: () => void;
  last: () => void;
  stepBackward: () => void;
  stepForward: () => void;
  bigStepBackward: () => void;
  bigStepForward: () => void;
  nextTrade: () => void;
  prevTrade: () => void;
  nextSession: () => void;
  prevSession: () => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  setSpeed: (speed: number) => void;
  cycleSpeed: (direction: 1 | -1) => void;
  armSetup: () => void;
  cancelSetup: () => void;
  pickBar: (bar: number) => void;
  confirmSetup: () => void;
}

let timer: ReturnType<typeof setInterval> | null = null;
function stopTimer() {
  if (timer != null) {
    clearInterval(timer);
    timer = null;
  }
}

export const useReplayStore = create<ReplayStore>((set, get) => ({
  active: false,
  cursorBar: 0,
  totalBars: 0,
  barTimes: [],
  tradeEntryBars: [],
  isPlaying: false,
  speed: 1,
  jumpNonce: 0,
  setupArmed: false,
  pendingBar: null,

  setDataset: (totalBars, barTimes, tradeEntryBars) => {
    stopTimer();
    set((s) => ({
      totalBars,
      barTimes,
      tradeEntryBars,
      active: false,
      isPlaying: false,
      setupArmed: false,
      pendingBar: null,
      cursorBar: Math.max(0, totalBars - 1),
      jumpNonce: s.jumpNonce + 1,
    }));
  },

  begin: (fromBar) => {
    const { totalBars, cursorBar, jumpNonce } = get();
    if (totalBars === 0) return;
    const bar = fromBar ?? cursorBar;
    set({
      active: true,
      setupArmed: false,
      pendingBar: null,
      cursorBar: Math.max(0, Math.min(totalBars - 1, bar)),
      jumpNonce: jumpNonce + 1,
    });
  },

  exit: () => {
    stopTimer();
    set((s) => ({
      active: false,
      isPlaying: false,
      setupArmed: false,
      pendingBar: null,
      cursorBar: Math.max(0, s.totalBars - 1),
      jumpNonce: s.jumpNonce + 1,
    }));
  },

  seek: (bar) => {
    const { totalBars, jumpNonce } = get();
    if (totalBars === 0) return;
    const clamped = Math.max(0, Math.min(totalBars - 1, Math.round(bar)));
    set({ active: true, cursorBar: clamped, jumpNonce: jumpNonce + 1 });
  },

  scrub: (bar) => {
    const { totalBars } = get();
    if (totalBars === 0) return;
    const clamped = Math.max(0, Math.min(totalBars - 1, Math.round(bar)));
    set({ active: true, cursorBar: clamped });
  },

  seekToDate: (dateMs) => {
    const { barTimes } = get();
    const idx = nearestIndexByTime(barTimes, Math.floor(dateMs / 1000), (t) => t);
    if (idx < 0) return;
    get().begin(idx);
  },

  first: () => get().begin(0),
  last: () => get().begin(get().totalBars - 1),

  stepBackward: () => {
    if (!get().active) get().begin();
    set((s) => ({ cursorBar: Math.max(0, s.cursorBar - 1) }));
  },

  stepForward: () => {
    if (!get().active) get().begin();
    set((s) => ({ cursorBar: Math.min(s.totalBars - 1, s.cursorBar + 1) }));
  },

  bigStepBackward: () => {
    if (!get().active) get().begin();
    set((s) => ({ cursorBar: Math.max(0, s.cursorBar - BIG_STEP_BARS) }));
  },

  bigStepForward: () => {
    if (!get().active) get().begin();
    set((s) => ({ cursorBar: Math.min(s.totalBars - 1, s.cursorBar + BIG_STEP_BARS) }));
  },

  nextTrade: () => {
    const { tradeEntryBars, cursorBar } = get();
    const next = tradeEntryBars.find((b) => b > cursorBar);
    if (next != null) get().begin(next);
  },

  prevTrade: () => {
    const { tradeEntryBars, cursorBar } = get();
    const prev = [...tradeEntryBars].reverse().find((b) => b < cursorBar);
    if (prev != null) get().begin(prev);
  },

  nextSession: () => {
    const { barTimes, cursorBar } = get();
    for (let i = cursorBar + 1; i < barTimes.length; i++) {
      if (SESSION_OPEN_HOURS.includes(new Date(barTimes[i] * 1000).getUTCHours())) {
        get().begin(i);
        return;
      }
    }
  },

  prevSession: () => {
    const { barTimes, cursorBar } = get();
    for (let i = cursorBar - 1; i >= 0; i--) {
      if (SESSION_OPEN_HOURS.includes(new Date(barTimes[i] * 1000).getUTCHours())) {
        get().begin(i);
        return;
      }
    }
  },

  play: () => {
    if (!get().active) get().begin();
    stopTimer();
    set({ isPlaying: true });
    const tick = () => {
      const s = get();
      if (s.cursorBar >= s.totalBars - 1) {
        get().pause();
        return;
      }
      set({ cursorBar: s.cursorBar + 1 });
    };
    timer = setInterval(tick, BASE_INTERVAL_MS / get().speed);
  },

  pause: () => {
    stopTimer();
    set({ isPlaying: false });
  },

  toggle: () => (get().isPlaying ? get().pause() : get().play()),

  setSpeed: (speed) => {
    const clamped = SPEEDS.includes(speed as (typeof SPEEDS)[number]) ? speed : 1;
    set({ speed: clamped });
    if (get().isPlaying) get().play(); // restart the ticker at the new interval
  },

  cycleSpeed: (direction) => {
    const i = SPEEDS.indexOf(get().speed as (typeof SPEEDS)[number]);
    const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? SPEEDS.indexOf(1) : i) + direction))];
    get().setSpeed(next);
  },

  armSetup: () => {
    stopTimer();
    set({ setupArmed: true, pendingBar: null, isPlaying: false });
  },

  cancelSetup: () => set({ setupArmed: false, pendingBar: null }),

  pickBar: (bar) => {
    if (!get().setupArmed) return;
    const { totalBars } = get();
    if (totalBars === 0) return;
    set({ pendingBar: Math.max(0, Math.min(totalBars - 1, Math.round(bar))) });
  },

  confirmSetup: () => {
    const { pendingBar, cursorBar } = get();
    get().begin(pendingBar ?? cursorBar);
  },
}));

export { SPEEDS };
