import { useEffect } from "react";

/** Closes via `onClose` on an outside mousedown or Escape - shared by every
 * popover hung off the Replay Bar / TopToolbar (speed menu, overflow menu,
 * date popover, the setup menu), so each doesn't need its own copy. */
export function useCloseOnOutside(ref: React.RefObject<HTMLElement | null>, active: boolean, onClose: () => void) {
  useEffect(() => {
    if (!active) return;
    function onDocDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [active, ref, onClose]);
}
