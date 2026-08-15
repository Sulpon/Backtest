/**
 * Process-wide (not per-pane) input state shared by every DrawingLayer
 * instance in a multi-pane workspace. Two things live here:
 *
 * 1. Which modifier keys are currently held - tracked with ONE set of
 *    window listeners (not one per pane), read synchronously by whichever
 *    DrawingLayer needs it via getModifierKeys().
 * 2. Which pane the pointer is currently over - so global keyboard
 *    shortcuts (Delete, Ctrl+D, Ctrl+Z/Shift+Z) act on that one pane
 *    instead of firing identically in every open chart pane at once.
 */
export interface ModifierKeyState {
  shift: boolean;
  ctrl: boolean; // ctrlKey OR metaKey (Cmd on Mac)
  alt: boolean;
}

const modifierKeys: ModifierKeyState = { shift: false, ctrl: false, alt: false };
let activePaneKey: string | null = null;

function sync(e: KeyboardEvent | MouseEvent) {
  modifierKeys.shift = e.shiftKey;
  modifierKeys.ctrl = e.ctrlKey || e.metaKey;
  modifierKeys.alt = e.altKey;
}
window.addEventListener("keydown", sync, { capture: true });
window.addEventListener("keyup", sync, { capture: true });
window.addEventListener("mousemove", sync, { capture: true });

export function getModifierKeys(): ModifierKeyState {
  return modifierKeys;
}

export function setActivePaneKey(key: string | null): void {
  activePaneKey = key;
}

export function getActivePaneKey(): string | null {
  return activePaneKey;
}
