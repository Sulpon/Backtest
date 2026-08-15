import type { AccentPreset, UiFont } from "./settingsStore";

export const ACCENT_PRESETS: Record<AccentPreset, { label: string; dark: string; light: string }> = {
  blue: { label: "Blue", dark: "#4f8cff", light: "#2f6fe0" },
  teal: { label: "Teal", dark: "#2dd4d0", light: "#0891b2" },
  purple: { label: "Purple", dark: "#a78bfa", light: "#7c3aed" },
  amber: { label: "Amber", dark: "#e0a64c", light: "#a8752a" },
};

export const FONT_PRESETS: Record<UiFont, { label: string; stack: string }> = {
  system: { label: "System", stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif` },
  classic: { label: "Classic", stack: `Georgia, "Times New Roman", Times, serif` },
  mono: { label: "Monospace", stack: `"IBM Plex Mono", "SF Mono", "Cascadia Mono", Consolas, monospace` },
};

export function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
