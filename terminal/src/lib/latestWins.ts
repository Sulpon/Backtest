/**
 * Coordinates a sequence of async operations where only the most recently
 * started one's result should ever be accepted - e.g. "the last symbol the
 * user selected" beating an earlier, slower-to-resolve request for a
 * symbol they've since navigated away from (request A = EURUSD, B =
 * GBPUSD; if A resolves after B, A must never overwrite what B produced).
 *
 * Each call to start() bumps an internal generation counter and returns a
 * token whose isCurrent() reports whether THIS call is still the most
 * recent one by the time the caller's async work finishes - independent of
 * setState timing, .then() ordering, or anything else about how the
 * caller stores its eventual result. The caller is responsible for
 * checking isCurrent() itself immediately before applying a result.
 */
export class LatestWins {
  private generation = 0;

  start(): { isCurrent: () => boolean } {
    const mine = ++this.generation;
    return { isCurrent: () => mine === this.generation };
  }
}
