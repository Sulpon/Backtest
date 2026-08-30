/**
 * Phase 1 rollout switch for the rectangle ISeriesPrimitive (see
 * rectanglePrimitive.ts). OFF by default - the existing DrawingLayer canvas
 * renderer (kinds.ts's `rectangle` DrawingKind) remains the production path
 * until the side-by-side regression checks pass. Toggle via:
 *
 *   - URL:        ?rectPrimitive=1   (persists to localStorage; =0 turns back off)
 *   - devtools:    localStorage.setItem("terminal.drawing.rectanglePrimitive", "1")
 *
 * Deliberately NOT wired into any settings UI yet - this is a dev/QA flag for
 * the side-by-side comparison, not a user-facing preference.
 */
const STORAGE_KEY = "terminal.drawing.rectanglePrimitive";

function readFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    const override = params.get("rectPrimitive");
    if (override === "1") {
      window.localStorage.setItem(STORAGE_KEY, "1");
      return true;
    }
    if (override === "0") {
      window.localStorage.setItem(STORAGE_KEY, "0");
      return false;
    }
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // localStorage can throw in some privacy modes - fail closed (old renderer).
    return false;
  }
}

export function isRectanglePrimitiveEnabled(): boolean {
  return readFlag();
}

/**
 * Phase 2 rollout switch for the other 11 live drawing tools' primitives
 * (trendline, ray, hline, vline, fibretracement, long, short, bosbull,
 * bosbear, chochbull, chochbear - see the individual *Primitive.ts files
 * and useDrawingPrimitives.ts). Deliberately a SEPARATE flag from
 * isRectanglePrimitiveEnabled() above - rectangle's flag is already
 * manually verified in production use; this flag lets the Phase 2 batch be
 * toggled (and, if something regresses, rolled back) independently of it.
 * Same override mechanism, different key/param:
 *
 *   - URL:        ?drawPrimitives=1   (persists to localStorage; =0 turns back off)
 *   - devtools:    localStorage.setItem("terminal.drawing.primitives", "1")
 */
const LINE_STORAGE_KEY = "terminal.drawing.primitives";

function readLineFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    const override = params.get("drawPrimitives");
    if (override === "1") {
      window.localStorage.setItem(LINE_STORAGE_KEY, "1");
      return true;
    }
    if (override === "0") {
      window.localStorage.setItem(LINE_STORAGE_KEY, "0");
      return false;
    }
    return window.localStorage.getItem(LINE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function isDrawingPrimitivesEnabled(): boolean {
  return readLineFlag();
}
