import type { ReactElement } from "react";

/**
 * Hand-authored inline SVG icon set for the drawing toolbar (LeftToolRail).
 * Deliberately NOT an icon library dependency - package.json has none, and
 * this repo's convention (CLAUDE.md §9) is to ask before adding one. ~50
 * simple line pictograms on a 24x24 grid is well within reach by hand and
 * keeps every icon inheriting `currentColor`, so the rail's existing hover/
 * active/disabled CSS states keep working with zero extra JS.
 *
 * Every entry is just the <svg> CHILDREN (lines/paths/circles/etc) - the
 * shared <svg> wrapper (viewBox, stroke, fill) lives in <DrawingIcon> below
 * so every icon has identical dimensions and stroke treatment by
 * construction, not by convention each author has to remember.
 */

// Reused across a couple of keys that are deliberately the same pictogram
// (e.g. the "navigation" group glyph and the "cursor" tool inside it).
const CURSOR = (
  <path d="M5 3 L5 19 L9.2 15.4 L12 21 L14.6 19.8 L11.8 14 L18 14 Z" fill="currentColor" stroke="none" />
);

const ICONS: Record<string, ReactElement> = {
  // ---- group glyphs (rail buttons) ----
  navigation: CURSOR,
  lines: (
    <>
      <line x1="5" y1="19" x2="19" y2="5" />
      <circle cx="5" cy="19" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="19" cy="5" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  channels: (
    <>
      <line x1="4" y1="18" x2="15" y2="7" />
      <line x1="9" y1="20" x2="20" y2="9" />
    </>
  ),
  fibonacci: (
    <>
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="11" x2="16" y2="11" />
      <line x1="3" y1="16" x2="21" y2="16" />
      <line x1="3" y1="21" x2="12" y2="21" />
    </>
  ),
  shapes: <rect x="4" y="6" width="16" height="12" rx="1.5" />,
  annotations: (
    <>
      <line x1="5" y1="6" x2="19" y2="6" />
      <line x1="12" y1="6" x2="12" y2="19" />
    </>
  ),
  risk: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <circle cx="12" cy="12" r="3.5" />
      <circle cx="12" cy="12" r="0.8" fill="currentColor" stroke="none" />
    </>
  ),
  measurement: (
    <>
      <line x1="4" y1="12" x2="20" y2="12" />
      <path d="M4 12 L7 9 M4 12 L7 15" />
      <path d="M20 12 L17 9 M20 12 L17 15" />
      <line x1="8" y1="9" x2="8" y2="15" strokeWidth={1} />
      <line x1="12" y1="9" x2="12" y2="15" strokeWidth={1} />
      <line x1="16" y1="9" x2="16" y2="15" strokeWidth={1} />
    </>
  ),
  brushes: (
    <>
      <path d="M15 4 L20 9 L9 20 L4 21 L5 16 Z" />
      <line x1="13" y1="6" x2="18" y2="11" />
    </>
  ),
  marketstructure: <polyline points="3,17 8,7 12,15 16,5 21,13" />,

  // ---- navigation ----
  cursor: CURSOR,
  crosshair: (
    <>
      <circle cx="12" cy="12" r="3" />
      <line x1="12" y1="2" x2="12" y2="7" />
      <line x1="12" y1="17" x2="12" y2="22" />
      <line x1="2" y1="12" x2="7" y2="12" />
      <line x1="17" y1="12" x2="22" y2="12" />
    </>
  ),
  hand: (
    <>
      <line x1="12" y1="3" x2="12" y2="21" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <path d="M9 6 L12 3 L15 6" />
      <path d="M9 18 L12 21 L15 18" />
      <path d="M6 9 L3 12 L6 15" />
      <path d="M18 9 L21 12 L18 15" />
    </>
  ),

  // ---- lines ----
  trendline: (
    <>
      <line x1="4" y1="19" x2="20" y2="5" />
      <circle cx="4" cy="19" r="1.8" fill="currentColor" stroke="none" />
      <circle cx="20" cy="5" r="1.8" fill="currentColor" stroke="none" />
    </>
  ),
  infoline: (
    <>
      <line x1="4" y1="19" x2="18" y2="6" />
      <circle cx="20" cy="4" r="2" />
    </>
  ),
  extendedline: (
    <>
      <line x1="7" y1="17" x2="17" y2="7" />
      <line x1="3" y1="21" x2="5" y2="19" />
      <line x1="19" y1="5" x2="21" y2="3" />
    </>
  ),
  hline: (
    <>
      <line x1="3" y1="12" x2="21" y2="12" />
      <circle cx="6" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  vline: (
    <>
      <line x1="12" y1="3" x2="12" y2="21" />
      <circle cx="12" cy="6" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  ray: (
    <>
      <circle cx="4" cy="19" r="1.6" fill="currentColor" stroke="none" />
      <line x1="4" y1="19" x2="19" y2="5" />
      <path d="M14 5 L19 5 L19 10" />
    </>
  ),
  arrow: (
    <>
      <line x1="5" y1="19" x2="16" y2="8" />
      <path d="M11 6 L18 6 L18 13 Z" fill="currentColor" stroke="none" />
    </>
  ),
  polyline: <polyline points="3,18 8,10 13,15 21,5" />,
  path: <path d="M3 17 C7 5, 13 21, 21 7" />,

  // ---- channels ----
  parallelchannel: (
    <>
      <line x1="3" y1="18" x2="15" y2="6" />
      <line x1="8" y1="21" x2="20" y2="9" />
      <line x1="9" y1="12" x2="12.5" y2="12" strokeWidth={1} />
    </>
  ),
  regressionchannel: (
    <>
      <line x1="4" y1="19" x2="17" y2="6" />
      <line x1="2" y1="15" x2="13" y2="4" strokeWidth={1} />
      <line x1="9" y1="21" x2="20" y2="10" strokeWidth={1} />
    </>
  ),
  flatchannel: (
    <>
      <line x1="3" y1="7" x2="21" y2="7" />
      <line x1="3" y1="17" x2="21" y2="17" />
      <line x1="6" y1="7" x2="6" y2="17" strokeWidth={1} />
    </>
  ),

  // ---- fibonacci ----
  fibretracement: (
    <>
      <line x1="4" y1="20" x2="20" y2="4" />
      <line x1="3" y1="16" x2="10" y2="16" strokeWidth={1} />
      <line x1="3" y1="12" x2="14" y2="12" strokeWidth={1} />
      <line x1="3" y1="8" x2="18" y2="8" strokeWidth={1} />
    </>
  ),
  fibextension: (
    <>
      <line x1="4" y1="20" x2="20" y2="4" />
      <line x1="3" y1="16" x2="10" y2="16" strokeWidth={1} />
      <line x1="3" y1="12" x2="14" y2="12" strokeWidth={1} />
      <line x1="3" y1="8" x2="18" y2="8" strokeWidth={1} />
      <line x1="3" y1="4" x2="9" y2="4" strokeWidth={1} strokeDasharray="2 2" />
    </>
  ),
  trendfib: (
    <>
      <line x1="4" y1="20" x2="20" y2="4" />
      <line x1="6" y1="15" x2="11" y2="15" strokeWidth={1} />
      <line x1="10" y1="9" x2="15" y2="9" strokeWidth={1} />
      <path d="M16 4 L20 4 L20 8" />
    </>
  ),
  fibchannel: (
    <>
      <line x1="3" y1="19" x2="14" y2="6" />
      <line x1="9" y1="21" x2="20" y2="8" />
      <line x1="6" y1="15" x2="9" y2="15" strokeWidth={1} />
      <line x1="10" y1="10" x2="13" y2="10" strokeWidth={1} />
    </>
  ),
  fibtimezone: (
    <>
      <line x1="4" y1="4" x2="4" y2="20" />
      <line x1="8" y1="4" x2="8" y2="20" />
      <line x1="13" y1="4" x2="13" y2="20" />
      <line x1="20" y1="4" x2="20" y2="20" />
    </>
  ),

  // ---- shapes ----
  rectangle: <rect x="4" y="6" width="16" height="12" rx="1" />,
  circle: <circle cx="12" cy="12" r="8" />,
  ellipse: <ellipse cx="12" cy="12" rx="9" ry="6" />,
  triangle: <polygon points="12,4 21,19 3,19" />,
  polygon: <polygon points="12,3 21,9.5 17.5,20 6.5,20 3,9.5" />,

  // ---- annotations ----
  text: (
    <>
      <line x1="5" y1="6" x2="19" y2="6" />
      <line x1="12" y1="6" x2="12" y2="19" />
      <line x1="16" y1="14" x2="16" y2="19" strokeWidth={1} strokeDasharray="2 2" />
    </>
  ),
  note: (
    <>
      <path d="M5 4 H16 L19 7 V20 H5 Z" />
      <path d="M16 4 V7 H19" />
      <line x1="8" y1="11" x2="15" y2="11" strokeWidth={1} />
      <line x1="8" y1="15" x2="15" y2="15" strokeWidth={1} />
    </>
  ),
  callout: (
    <>
      <path d="M4 5 H20 V15 H10 L6 19 V15 H4 Z" />
      <line x1="8" y1="9" x2="16" y2="9" strokeWidth={1} />
      <line x1="8" y1="12" x2="13" y2="12" strokeWidth={1} />
    </>
  ),
  pricelabel: (
    <>
      <path d="M4 12 L12 4 L20 4 L20 12 L12 20 Z" />
      <circle cx="15" cy="7" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),

  // ---- risk ----
  long: (
    <>
      <line x1="4" y1="19" x2="20" y2="19" strokeWidth={1} />
      <path d="M6 16 L11 10 L15 13 L19 6" />
      <path d="M15 6 L19 6 L19 10" />
    </>
  ),
  short: (
    <>
      <line x1="4" y1="5" x2="20" y2="5" strokeWidth={1} />
      <path d="M6 8 L11 14 L15 11 L19 18" />
      <path d="M15 18 L19 18 L19 14" />
    </>
  ),
  riskreward: (
    <>
      <line x1="12" y1="3" x2="12" y2="21" />
      <path d="M9 6 L12 3 L15 6" />
      <path d="M9 18 L12 21 L15 18" />
      <line x1="6" y1="12" x2="18" y2="12" strokeWidth={1} />
    </>
  ),

  // ---- market structure ----
  bosbull: (
    <>
      <line x1="3" y1="14" x2="14" y2="14" strokeWidth={1} strokeDasharray="2.5 2" />
      <polyline points="3,19 8,12 11,16 14,14" />
      <path d="M14 14 L20 6" />
      <path d="M16 6 L20 6 L20 10" />
    </>
  ),
  bosbear: (
    <>
      <line x1="3" y1="10" x2="14" y2="10" strokeWidth={1} strokeDasharray="2.5 2" />
      <polyline points="3,5 8,12 11,8 14,10" />
      <path d="M14 10 L20 18" />
      <path d="M16 18 L20 18 L20 14" />
    </>
  ),
  chochbull: (
    <>
      <line x1="3" y1="14" x2="14" y2="14" strokeWidth={1} strokeDasharray="2.5 2" />
      <polyline points="3,19 8,12 11,16 14,14" />
      <path d="M14 14 L20 6" />
      <circle cx="14" cy="14" r="1.8" fill="currentColor" stroke="none" />
    </>
  ),
  chochbear: (
    <>
      <line x1="3" y1="10" x2="14" y2="10" strokeWidth={1} strokeDasharray="2.5 2" />
      <polyline points="3,5 8,12 11,8 14,10" />
      <path d="M14 10 L20 18" />
      <circle cx="14" cy="10" r="1.8" fill="currentColor" stroke="none" />
    </>
  ),

  // ---- measurement ----
  pricerange: (
    <>
      <line x1="12" y1="4" x2="12" y2="20" />
      <path d="M9 7 L12 4 L15 7" />
      <path d="M9 17 L12 20 L15 17" />
      <line x1="8" y1="4" x2="16" y2="4" strokeWidth={1} />
      <line x1="8" y1="20" x2="16" y2="20" strokeWidth={1} />
    </>
  ),
  daterange: (
    <>
      <line x1="4" y1="12" x2="20" y2="12" />
      <path d="M7 9 L4 12 L7 15" />
      <path d="M17 9 L20 12 L17 15" />
      <line x1="4" y1="8" x2="4" y2="16" strokeWidth={1} />
      <line x1="20" y1="8" x2="20" y2="16" strokeWidth={1} />
    </>
  ),

  // ---- brushes ----
  brush: (
    <>
      <path d="M14 4 L20 10 L11 19 L7 19 L7 15 Z" />
      <line x1="5" y1="21" x2="7" y2="19" />
    </>
  ),
  highlighter: (
    <>
      <path d="M6 20 L9 20 L20 9 L17 6 L6 17 Z" />
      <line x1="4" y1="21" x2="6" y2="19" />
    </>
  ),
  eraser: (
    <>
      <rect x="6" y="10" width="14" height="8" rx="1.5" transform="rotate(-35 12 14)" />
      <line x1="4" y1="20" x2="12" y2="20" strokeWidth={1} />
    </>
  ),

  // ---- rail toggles / placeholder ----
  magnet: (
    <>
      <path d="M7 4 V12 A5 5 0 0 0 17 12 V4" />
      <path d="M5 3 H9 V7 H5 Z" />
      <path d="M15 3 H19 V7 H15 Z" />
      <line x1="7" y1="9" x2="9" y2="9" strokeWidth={1} />
      <line x1="15" y1="9" x2="17" y2="9" strokeWidth={1} />
    </>
  ),
  pin: (
    <>
      <path d="M12 3 C15 3 17 5 17 8 C17 11.5 12 17 12 17 C12 17 7 11.5 7 8 C7 5 9 3 12 3 Z" />
      <circle cx="12" cy="8" r="2.2" fill="currentColor" stroke="none" />
    </>
  ),
  analysis: <path d="M8 18 H10 L9 15 A5 5 0 1 1 15 15 L14 18 H16" />,
};

// Small dot - shown for any id the lookup above doesn't (yet) cover, so a
// new tool id added to toolDefinitions.ts without a matching icon renders
// something deliberate instead of a blank button.
const FALLBACK = <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />;

export function DrawingIcon({ name, size = 18 }: { name: string; size?: number }): ReactElement {
  return (
    <svg
      className="drawing-icon"
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
