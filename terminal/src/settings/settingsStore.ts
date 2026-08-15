import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * The three things the topbar's Settings stub has promised since Milestone 5:
 * hotkeys, colors, fonts. Hotkeys covers only the handful of shortcuts that
 * are actually wired to something (replay transport, delete-drawing) - this
 * store holds the current binding, and the hooks/handlers that used to
 * hardcode a key literal now read it from here instead. Colors/fonts are
 * applied as CSS custom-property overrides by SettingsEffects, the same
 * "declared directly on the element wins" trick DockviewRoot's re-skin used.
 */
export type HotkeyAction = "playPause" | "stepBack" | "stepForward" | "deleteDrawing";
export type AccentPreset = "blue" | "teal" | "purple" | "amber";
export type UiFont = "system" | "classic" | "mono";
export type ChartFontSize = 10 | 11 | 13;

export const DEFAULT_HOTKEYS: Record<HotkeyAction, string> = {
  playPause: " ",
  stepBack: "ArrowLeft",
  stepForward: "ArrowRight",
  deleteDrawing: "Delete",
};

export const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  playPause: "Play / Pause",
  stepBack: "Step Back",
  stepForward: "Step Forward",
  deleteDrawing: "Delete Selected Drawing",
};

interface SettingsStore {
  hotkeys: Record<HotkeyAction, string>;
  accentPreset: AccentPreset;
  uiFont: UiFont;
  chartFontSize: ChartFontSize;

  setHotkey: (action: HotkeyAction, key: string) => void;
  resetHotkeys: () => void;
  setAccentPreset: (preset: AccentPreset) => void;
  setUiFont: (font: UiFont) => void;
  setChartFontSize: (size: ChartFontSize) => void;
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      hotkeys: { ...DEFAULT_HOTKEYS },
      accentPreset: "blue",
      uiFont: "system",
      chartFontSize: 11,

      setHotkey: (action, key) => set((s) => ({ hotkeys: { ...s.hotkeys, [action]: key } })),
      resetHotkeys: () => set({ hotkeys: { ...DEFAULT_HOTKEYS } }),
      setAccentPreset: (accentPreset) => set({ accentPreset }),
      setUiFont: (uiFont) => set({ uiFont }),
      setChartFontSize: (chartFontSize) => set({ chartFontSize }),
    }),
    { name: "terminal.settings" }
  )
);

/** Human-readable label for a raw KeyboardEvent.key, for display next to a binding. */
export function keyLabel(key: string): string {
  if (key === " ") return "Space";
  return key;
}
