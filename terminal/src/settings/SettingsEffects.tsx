import { useEffect } from "react";
import { useSettingsStore } from "./settingsStore";
import { ACCENT_PRESETS, FONT_PRESETS, hexToRgba } from "./presets";
import { useTheme } from "../theme/ThemeProvider";

/** Headless - applies the accent/font settings as inline overrides on
 * :root. Inline styles set directly on an element beat the same custom
 * property declared in a stylesheet rule for that element, regardless of
 * specificity (the lesson from re-skinning Dockview in Milestone 1), so this
 * doesn't need to fight tokens.css's own --accent/--font-ui declarations. */
export function SettingsEffects() {
  const accentPreset = useSettingsStore((s) => s.accentPreset);
  const uiFont = useSettingsStore((s) => s.uiFont);
  const { theme } = useTheme();

  useEffect(() => {
    const accent = ACCENT_PRESETS[accentPreset];
    const hex = theme === "dark" ? accent.dark : accent.light;
    const root = document.documentElement.style;
    root.setProperty("--accent", hex);
    root.setProperty("--accent-soft", hexToRgba(hex, theme === "dark" ? 0.16 : 0.12));
    return () => {
      root.removeProperty("--accent");
      root.removeProperty("--accent-soft");
    };
  }, [accentPreset, theme]);

  useEffect(() => {
    document.documentElement.style.setProperty("--font-ui", FONT_PRESETS[uiFont].stack);
    return () => {
      document.documentElement.style.removeProperty("--font-ui");
    };
  }, [uiFont]);

  return null;
}
