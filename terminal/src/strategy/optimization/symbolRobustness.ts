import type { ScanTradeRecord } from "../types";
import { mean, median } from "../monteCarlo/statistics";
import type { SymbolBreakdownRow, SymbolRobustnessResult } from "./types";

/**
 * Per-symbol breakdown and consistency measures - pure, reuses the
 * existing Monte Carlo module's median()/mean() (statistics.ts) rather
 * than a second implementation, per spec's general reuse principle. Not
 * date-based, so this file has no relationship to dateAnalytics.ts's
 * exitTime rule.
 */
export function computeSymbolRobustness(trades: ScanTradeRecord[]): SymbolRobustnessResult {
  const bySymbolMap = new Map<string, { totalR: number; count: number; wins: number }>();
  for (const t of trades) {
    const prev = bySymbolMap.get(t.symbol) ?? { totalR: 0, count: 0, wins: 0 };
    prev.totalR += t.r;
    prev.count += 1;
    if (t.result === "Win") prev.wins += 1;
    bySymbolMap.set(t.symbol, prev);
  }

  const bySymbol: SymbolBreakdownRow[] = [...bySymbolMap.entries()]
    .map(([symbol, v]) => ({ symbol, trades: v.count, totalR: v.totalR, winRate: (v.wins / v.count) * 100 }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  if (bySymbol.length === 0) {
    return { bySymbol: [], profitableSymbolsPct: 0, medianSymbolR: 0, worstSymbolR: 0, bestSymbolR: 0, dispersion: null };
  }

  const totalRs = bySymbol.map((s) => s.totalR);
  const profitableSymbolsPct = (totalRs.filter((r) => r > 0).length / totalRs.length) * 100;
  const medianSymbolR = median(totalRs);
  const worstSymbolR = Math.min(...totalRs);
  const bestSymbolR = Math.max(...totalRs);

  // Coefficient of variation - undefined (null) for a single symbol
  // (dispersion across one sample is meaningless) or a zero mean (division
  // undefined, never fabricated as Infinity).
  let dispersion: number | null = null;
  if (totalRs.length >= 2) {
    const m = mean(totalRs);
    if (m !== 0) {
      const variance = totalRs.reduce((acc, r) => acc + (r - m) ** 2, 0) / totalRs.length;
      dispersion = Math.sqrt(variance) / Math.abs(m);
    }
  }

  return { bySymbol, profitableSymbolsPct, medianSymbolR, worstSymbolR, bestSymbolR, dispersion };
}
