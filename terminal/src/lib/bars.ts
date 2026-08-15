/** Binary search for the item whose time is closest to `time`, without
 * remapping the array first - callers pass a getTime() accessor so this
 * works directly against CandleBar[] (drawing snap) or a plain number[]
 * (replay jump-to-date) with no per-call allocation. Items must be
 * ascending by time. */
export function nearestIndexByTime<T>(items: T[], time: number, getTime: (item: T) => number): number {
  if (items.length === 0) return -1;
  let lo = 0;
  let hi = items.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (getTime(items[mid]) < time) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(getTime(items[lo - 1]) - time) <= Math.abs(getTime(items[lo]) - time)) return lo - 1;
  return lo;
}
