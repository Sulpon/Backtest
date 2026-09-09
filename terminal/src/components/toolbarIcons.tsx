import type { ReactElement } from "react";

/**
 * Hand-authored inline SVG icon set for TopToolbar.tsx and RightSidebar.tsx.
 * Mirrors drawingIcons.tsx's exact pattern (see that file's own header
 * comment for the full rationale) - no icon-library dependency, every icon
 * is just the <svg> CHILDREN keyed by id, with the shared <svg> wrapper
 * (viewBox, stroke, fill) living in <ToolbarIcon> below so every icon has
 * identical dimensions/stroke treatment by construction.
 */

const ICONS: Record<string, ReactElement> = {
  // ---- chart type (TopToolbar's chart-type flyout) ----
  "chart-candles": (
    <>
      <line x1="6" y1="4" x2="6" y2="20" strokeWidth={1} />
      <rect x="4" y="8" width="4" height="7" />
      <line x1="12" y1="2" x2="12" y2="22" strokeWidth={1} />
      <rect x="10" y="5" width="4" height="10" />
      <line x1="18" y1="6" x2="18" y2="18" strokeWidth={1} />
      <rect x="16" y="9" width="4" height="6" />
    </>
  ),
  "chart-line": <polyline points="3,17 8,11 12,14 16,7 21,10" />,
  "chart-area": (
    <>
      <polyline points="3,15 8,9 12,12 16,6 21,9" />
      <path d="M21 9 L21 19 L3 19 L3 15 Z" fill="currentColor" fillOpacity={0.22} stroke="none" />
    </>
  ),

  // ---- far-right utility group ----
  indicators: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M5.5 15 L9 10 L12 13 L18.5 6" strokeWidth={1.4} />
    </>
  ),
  replay: (
    <>
      <path d="M4.5 12 A7.5 7.5 0 1 1 7 17.2" />
      <path d="M4.5 7 L4.5 12 L9.5 12" />
    </>
  ),
  search: (
    <>
      <circle cx="10" cy="10" r="6.5" />
      <line x1="15" y1="15" x2="20.5" y2="20.5" />
    </>
  ),
  watchlist: (
    <>
      <circle cx="5" cy="6" r="1.3" fill="currentColor" stroke="none" />
      <line x1="9" y1="6" x2="20" y2="6" />
      <circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <line x1="9" y1="12" x2="20" y2="12" />
      <circle cx="5" cy="18" r="1.3" fill="currentColor" stroke="none" />
      <line x1="9" y1="18" x2="20" y2="18" />
    </>
  ),
  marketstructure: <polyline points="3,16 8,6 12,13 16,4 21,11" />,
  "theme-sun": (
    <>
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="2" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="2" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="22" y2="12" />
      <line x1="4.6" y1="4.6" x2="6.7" y2="6.7" />
      <line x1="17.3" y1="17.3" x2="19.4" y2="19.4" />
      <line x1="4.6" y1="19.4" x2="6.7" y2="17.3" />
      <line x1="17.3" y1="6.7" x2="19.4" y2="4.6" />
    </>
  ),
  "theme-moon": <path d="M20 14.5 A8.5 8.5 0 1 1 9.5 4 A6.5 6.5 0 0 0 20 14.5 Z" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3 L12 5.5 M12 18.5 L12 21 M21 12 L18.5 12 M5.5 12 L3 12 M18.4 5.6 L16.6 7.4 M7.4 16.6 L5.6 18.4 M18.4 18.4 L16.6 16.6 M7.4 7.4 L5.6 5.6" />
    </>
  ),
  "fullscreen-enter": (
    <>
      <path d="M4 9 L4 4 L9 4" />
      <path d="M15 4 L20 4 L20 9" />
      <path d="M20 15 L20 20 L15 20" />
      <path d="M9 20 L4 20 L4 15" />
    </>
  ),
  "fullscreen-exit": (
    <>
      <path d="M9 4 L9 9 L4 9" />
      <path d="M15 9 L20 9 L20 4" />
      <path d="M15 20 L15 15 L20 15" />
      <path d="M4 15 L9 15 L9 20" />
    </>
  ),

  // ---- RightSidebar rail buttons ----
  symbolinfo: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <circle cx="12" cy="7.5" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  objecttree: (
    <>
      <line x1="6" y1="4" x2="6" y2="20" />
      <line x1="6" y1="8" x2="14" y2="8" />
      <line x1="6" y1="14" x2="14" y2="14" />
      <line x1="6" y1="20" x2="14" y2="20" />
      <circle cx="17.5" cy="8" r="2" />
      <circle cx="17.5" cy="14" r="2" />
      <circle cx="17.5" cy="20" r="2" />
    </>
  ),
};

// Small dot - shown for any id the lookup above doesn't (yet) cover, so a
// new toolbar control added without a matching icon renders something
// deliberate instead of a blank button. Mirrors drawingIcons.tsx's FALLBACK.
const FALLBACK = <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />;

export function ToolbarIcon({ name, size = 16 }: { name: string; size?: number }): ReactElement {
  return (
    <svg
      className="toolbar-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name] ?? FALLBACK}
    </svg>
  );
}
