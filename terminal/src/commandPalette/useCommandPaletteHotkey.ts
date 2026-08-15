import { useEffect } from "react";
import { useUiStore } from "../workspace/uiStore";

/** Ctrl/Cmd+K opens the palette from anywhere, including while typing in an
 * input - that's the whole point of a command palette. Escape closes it;
 * that part IS guarded so it doesn't eat every Escape press in the app when
 * the palette isn't even open. */
export function useCommandPaletteHotkey() {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        useUiStore.getState().setCommandPaletteOpen(true);
        return;
      }
      if (e.key === "Escape" && useUiStore.getState().commandPaletteOpen) {
        useUiStore.getState().setCommandPaletteOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
