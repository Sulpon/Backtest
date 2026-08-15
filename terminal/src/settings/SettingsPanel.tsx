import { useEffect, useState } from "react";
import { useUiStore } from "../workspace/uiStore";
import { useTheme } from "../theme/ThemeProvider";
import {
  useSettingsStore,
  HOTKEY_LABELS,
  keyLabel,
  type HotkeyAction,
  type AccentPreset,
  type UiFont,
  type ChartFontSize,
} from "./settingsStore";
import { ACCENT_PRESETS, FONT_PRESETS } from "./presets";
import "./SettingsPanel.css";

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);
const HOTKEY_ACTIONS: HotkeyAction[] = ["playPause", "stepBack", "stepForward", "deleteDrawing"];
const ACCENTS: AccentPreset[] = ["blue", "teal", "purple", "amber"];
const FONTS: UiFont[] = ["system", "classic", "mono"];
const CHART_SIZES: ChartFontSize[] = [10, 11, 13];

function HotkeysTab() {
  const hotkeys = useSettingsStore((s) => s.hotkeys);
  const setHotkey = useSettingsStore((s) => s.setHotkey);
  const resetHotkeys = useSettingsStore((s) => s.resetHotkeys);
  const [listeningFor, setListeningFor] = useState<HotkeyAction | null>(null);

  useEffect(() => {
    if (!listeningFor) return;
    function onKeyDown(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (MODIFIER_KEYS.has(e.key)) return;
      if (e.key === "Escape") {
        setListeningFor(null);
        return;
      }
      setHotkey(listeningFor!, e.key);
      setListeningFor(null);
    }
    // capture phase so this wins over DrawingLayer/replay hotkeys while recording
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [listeningFor, setHotkey]);

  return (
    <div className="ah-list">
      {HOTKEY_ACTIONS.map((action) => (
        <div key={action} className="hk-row">
          <span className="ah-row-label">{HOTKEY_LABELS[action]}</span>
          <button
            type="button"
            className={`hk-key${listeningFor === action ? " listening" : ""}`}
            onClick={() => setListeningFor(action)}
          >
            {listeningFor === action ? "Press a key…" : keyLabel(hotkeys[action])}
          </button>
        </div>
      ))}
      <button type="button" className="hk-reset" onClick={resetHotkeys}>
        Reset to defaults
      </button>
      <div className="ah-placeholder">Also fixed: Ctrl/Cmd+K (Command Palette), Escape (close/deselect).</div>
    </div>
  );
}

function AppearanceTab() {
  const { theme, toggleTheme } = useTheme();
  const accentPreset = useSettingsStore((s) => s.accentPreset);
  const setAccentPreset = useSettingsStore((s) => s.setAccentPreset);
  const uiFont = useSettingsStore((s) => s.uiFont);
  const setUiFont = useSettingsStore((s) => s.setUiFont);
  const chartFontSize = useSettingsStore((s) => s.chartFontSize);
  const setChartFontSize = useSettingsStore((s) => s.setChartFontSize);

  return (
    <div className="ah-list">
      <div className="settings-section-title">Theme</div>
      <button type="button" className="hk-key" onClick={toggleTheme}>
        {theme === "dark" ? "Dark" : "Light"} — click to switch
      </button>

      <div className="settings-section-title">Accent Color</div>
      <div className="swatch-row">
        {ACCENTS.map((preset) => (
          <button
            key={preset}
            type="button"
            className={`accent-swatch${accentPreset === preset ? " active" : ""}`}
            style={{ background: ACCENT_PRESETS[preset][theme] }}
            title={ACCENT_PRESETS[preset].label}
            onClick={() => setAccentPreset(preset)}
          />
        ))}
      </div>

      <div className="settings-section-title">UI Font</div>
      <div className="option-row">
        {FONTS.map((font) => (
          <button
            key={font}
            type="button"
            className={`option-btn${uiFont === font ? " active" : ""}`}
            style={{ fontFamily: FONT_PRESETS[font].stack }}
            onClick={() => setUiFont(font)}
          >
            {FONT_PRESETS[font].label}
          </button>
        ))}
      </div>

      <div className="settings-section-title">Chart Font Size</div>
      <div className="option-row">
        {CHART_SIZES.map((size) => (
          <button
            key={size}
            type="button"
            className={`option-btn${chartFontSize === size ? " active" : ""}`}
            onClick={() => setChartFontSize(size)}
          >
            {size}px
          </button>
        ))}
      </div>
    </div>
  );
}

export function SettingsPanel() {
  const open = useUiStore((s) => s.settingsOpen);
  const setOpen = useUiStore((s) => s.setSettingsOpen);
  const [tab, setTab] = useState<"hotkeys" | "appearance">("hotkeys");

  if (!open) return null;

  return (
    <div className="ah-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="ah-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ah-header">
          <span className="ah-title">Settings</span>
          <button type="button" className="ah-close" onClick={() => setOpen(false)}>
            &times;
          </button>
        </div>
        <div className="ah-body">
          <div className="ah-tabs">
            <button type="button" className={`ah-tab${tab === "hotkeys" ? " active" : ""}`} onClick={() => setTab("hotkeys")}>
              Hotkeys
            </button>
            <button
              type="button"
              className={`ah-tab${tab === "appearance" ? " active" : ""}`}
              onClick={() => setTab("appearance")}
            >
              Appearance
            </button>
          </div>
          <div className="ah-content">{tab === "hotkeys" ? <HotkeysTab /> : <AppearanceTab />}</div>
        </div>
      </div>
    </div>
  );
}
