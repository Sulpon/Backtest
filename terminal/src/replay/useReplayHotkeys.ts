import { useEffect } from "react";
import { useReplayStore } from "./replayStore";
import { useSettingsStore } from "../settings/settingsStore";

/** Play/pause and step bindings come from settingsStore (Settings →
 * Hotkeys), read fresh on every keypress via getState() so a rebind takes
 * effect immediately without re-subscribing. Global, guarded against typing
 * in inputs the same way DrawingLayer guards its own shortcuts.
 *
 * The rest (big-step, speed, home/end, esc) are fixed for now rather than
 * routed through settingsStore.hotkeys - the architecture doc only asks for
 * the transport basics to be user-rebindable today ("configurable later
 * through the global Hotkey system" for the others). */
export function useReplayHotkeys() {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const typing = document.activeElement && ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName);
      if (typing) return;
      const replay = useReplayStore.getState();
      const { playPause, stepBack, stepForward } = useSettingsStore.getState().hotkeys;

      if (e.key === "Escape") {
        if (replay.setupArmed) {
          e.preventDefault();
          replay.cancelSetup();
        }
        return;
      }
      if (e.shiftKey && e.key === stepBack) {
        e.preventDefault();
        replay.bigStepBackward();
      } else if (e.shiftKey && e.key === stepForward) {
        e.preventDefault();
        replay.bigStepForward();
      } else if (e.key === playPause) {
        e.preventDefault();
        replay.toggle();
      } else if (e.key === stepBack) {
        replay.stepBackward();
      } else if (e.key === stepForward) {
        replay.stepForward();
      } else if (e.key === "Home") {
        e.preventDefault();
        replay.first();
      } else if (e.key === "End") {
        e.preventDefault();
        replay.last();
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        replay.cycleSpeed(1);
      } else if (e.key === "-") {
        e.preventDefault();
        replay.cycleSpeed(-1);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
