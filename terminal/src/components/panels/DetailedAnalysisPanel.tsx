import { useMemo, useState } from "react";
import { useStrategyScanStore } from "../../strategy/strategyScanStore";
import {
  computeKpis,
  cumulativeRRSeries,
  filterTrades,
  groupByExitDay,
  groupByExitMonth,
  groupByExitYear,
  maximumDrawdown,
  maximumLosingStreak,
  maximumWinningStreak,
  tradeFrequencyAnalytics,
} from "../../strategy/analysis/dateAnalytics";
import { CumulativeRRChart } from "./CumulativeRRChart";
import { MonthlyPerformanceWidget } from "./MonthlyPerformanceWidget";
import { DailyPerformanceCalendar } from "./DailyPerformanceCalendar";
import { YearlyPerformanceTable } from "./YearlyPerformanceTable";
import "./panels.css";
import "./StrategyPanel.css";
import "./DetailedAnalysis.css";

function dateInputToSec(value: string): number {
  return Math.floor(Date.parse(`${value}T00:00:00Z`) / 1000);
}

function signed(n: number, digits = 2): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}R`;
}

/**
 * Root of the Detailed Analysis tab - a pure read/aggregation layer over
 * strategy/strategyScanStore.ts's `trades`, never a second trade source.
 * Symbols/Setups filter option lists are derived from the trades
 * THEMSELVES (not useSymbols()'s global backend list), since a symbol with
 * zero scanned trades isn't a meaningful filter option here.
 *
 * filterTrades is called with plain primitive args (not a `filters` object
 * literal rebuilt every render) so the useMemo chain below only
 * recomputes when something actually changed - see dateAnalytics.ts's own
 * doc comment on filterTrades for why that matters for the "must remain
 * responsive with thousands of trades" requirement.
 */
export function DetailedAnalysisPanel() {
  const tradesMap = useStrategyScanStore((s) => s.trades);
  const allTrades = useMemo(() => Object.values(tradesMap), [tradesMap]);

  const symbolOptions = useMemo(() => [...new Set(allTrades.map((t) => t.symbol))].sort(), [allTrades]);
  const setupOptions = useMemo(() => [...new Set(allTrades.map((t) => t.setup))].sort(), [allTrades]);

  const [symbolMode, setSymbolMode] = useState<"all" | "custom">("all");
  const [customSymbols, setCustomSymbols] = useState<string[]>([]);
  const [setup, setSetup] = useState<string>("all");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");

  const fromSec = fromDate ? dateInputToSec(fromDate) : null;
  // Inclusive through the END of the selected "to" day.
  const toSec = toDate ? dateInputToSec(toDate) + 86400 - 1 : null;

  const filtered = useMemo(
    () => filterTrades(allTrades, symbolMode === "all" ? "all" : customSymbols, setup, fromSec, toSec),
    [allTrades, symbolMode, customSymbols, setup, fromSec, toSec]
  );

  const kpis = useMemo(() => computeKpis(filtered), [filtered]);
  const dailyMap = useMemo(() => groupByExitDay(filtered), [filtered]);
  const monthlyMap = useMemo(() => groupByExitMonth(filtered), [filtered]);
  const yearlyMap = useMemo(() => groupByExitYear(filtered), [filtered]);
  const cumulativeSeries = useMemo(() => cumulativeRRSeries(filtered), [filtered]);
  // Streak/Risk + Trading Frequency metrics - each its own pure function in
  // dateAnalytics.ts, computed on the exact same `filtered` array everything
  // else above already uses, so they update with every filter change and
  // never diverge from Cumulative RR/the rest of the KPI row (maxDrawdown in
  // particular is built ON TOP OF cumulativeSeries's own source function,
  // not a second equity calculation - see that function's own doc comment).
  const maxWinStreak = useMemo(() => maximumWinningStreak(filtered), [filtered]);
  const maxLoseStreak = useMemo(() => maximumLosingStreak(filtered), [filtered]);
  const maxDrawdown = useMemo(() => maximumDrawdown(filtered), [filtered]);
  const frequency = useMemo(() => tradeFrequencyAnalytics(filtered), [filtered]);

  const now = new Date();
  const availableYears = useMemo(() => [...yearlyMap.keys()].sort((a, b) => a - b), [yearlyMap]);
  const defaultYear = availableYears.length > 0 ? availableYears[availableYears.length - 1] : now.getUTCFullYear();
  const availableMonthKeys = useMemo(() => [...monthlyMap.keys()].sort(), [monthlyMap]);
  const lastMonthKey = availableMonthKeys.length > 0 ? availableMonthKeys[availableMonthKeys.length - 1] : null;
  const defaultCalendarYear = lastMonthKey ? Number(lastMonthKey.split("-")[0]) : now.getUTCFullYear();
  const defaultCalendarMonth = lastMonthKey ? Number(lastMonthKey.split("-")[1]) : now.getUTCMonth() + 1;

  function toggleCustomSymbol(sym: string) {
    setCustomSymbols((cur) => (cur.includes(sym) ? cur.filter((s) => s !== sym) : [...cur, sym]));
  }

  return (
    <div className="panel-scroll da-panel">
      <div className="da-filter-bar">
        <div className="strategy-row">
          <label className="strategy-label">Symbols</label>
          <select className="strategy-input" value={symbolMode} onChange={(e) => setSymbolMode(e.target.value as "all" | "custom")}>
            <option value="all">All Symbols</option>
            <option value="custom">Custom</option>
          </select>
        </div>
        {symbolMode === "custom" && (
          <div className="strategy-symbol-picker">
            <div className="strategy-symbol-actions">
              <button type="button" className="strategy-link-btn" onClick={() => setCustomSymbols(symbolOptions)}>
                Select All
              </button>
              <button type="button" className="strategy-link-btn" onClick={() => setCustomSymbols([])}>
                Clear All
              </button>
            </div>
            <div className="strategy-symbol-list">
              {symbolOptions.map((sym) => (
                <label key={sym} className="strategy-symbol-item">
                  <input type="checkbox" checked={customSymbols.includes(sym)} onChange={() => toggleCustomSymbol(sym)} />
                  {sym}
                </label>
              ))}
              {symbolOptions.length === 0 && <span className="panel-dim">No trades yet</span>}
            </div>
          </div>
        )}

        <div className="strategy-row">
          <label className="strategy-label">Setups</label>
          <select className="strategy-input" value={setup} onChange={(e) => setSetup(e.target.value)}>
            <option value="all">All Setups</option>
            {setupOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="strategy-row">
          <label className="strategy-label">Date Range</label>
          <input type="date" className="strategy-input da-date-input" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          <span className="panel-dim">→</span>
          <input type="date" className="strategy-input da-date-input" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
      </div>

      <div className="panel-summary mono">
        <div>
          <span className="panel-dim">Total Trades</span>
          <span>{kpis.total}</span>
        </div>
        <div>
          <span className="panel-dim">Win Rate</span>
          <span>{kpis.winRate.toFixed(1)}%</span>
        </div>
        <div>
          <span className="panel-dim">Total RR</span>
          <span className={kpis.totalRR >= 0 ? "pos" : "neg"}>{signed(kpis.totalRR)}</span>
        </div>
        <div>
          <span className="panel-dim">Expected Value</span>
          <span className={kpis.expectancy >= 0 ? "pos" : "neg"}>{signed(kpis.expectancy)}</span>
        </div>
        <div>
          <span className="panel-dim">Avg. Trade RR</span>
          <span className={kpis.avgRR >= 0 ? "pos" : "neg"}>{signed(kpis.avgRR)}</span>
        </div>
        <div>
          <span className="panel-dim">Best Day</span>
          {kpis.bestDay ? (
            <>
              <span className={kpis.bestDay.totalRR >= 0 ? "pos" : "neg"}>{signed(kpis.bestDay.totalRR, 1)}</span>
              <span className="panel-dim">{kpis.bestDay.dateKey}</span>
            </>
          ) : (
            <span className="panel-dim">—</span>
          )}
        </div>
        <div>
          <span className="panel-dim">Worst Day</span>
          {kpis.worstDay ? (
            <>
              <span className={kpis.worstDay.totalRR >= 0 ? "pos" : "neg"}>{signed(kpis.worstDay.totalRR, 1)}</span>
              <span className="panel-dim">{kpis.worstDay.dateKey}</span>
            </>
          ) : (
            <span className="panel-dim">—</span>
          )}
        </div>
        <div>
          <span className="panel-dim">Max Win Streak</span>
          <span>
            {maxWinStreak} {maxWinStreak === 1 ? "trade" : "trades"}
          </span>
        </div>
        <div>
          <span className="panel-dim">Max Loss Streak</span>
          <span>
            {maxLoseStreak} {maxLoseStreak === 1 ? "trade" : "trades"}
          </span>
        </div>
        <div>
          <span className="panel-dim">Max Drawdown</span>
          <span className={maxDrawdown >= 0 ? "pos" : "neg"}>{signed(maxDrawdown)}</span>
        </div>
        <div>
          <span className="panel-dim">Avg Trades / Day</span>
          <span>{frequency.avgTradesPerDay.toFixed(2)} / day</span>
        </div>
        <div>
          <span className="panel-dim">Avg Trades / Week</span>
          <span>{frequency.avgTradesPerWeek.toFixed(2)} / week</span>
        </div>
        <div>
          <span className="panel-dim">Avg Trades / Month</span>
          <span>{frequency.avgTradesPerMonth.toFixed(2)} / month</span>
        </div>
        <div>
          <span className="panel-dim">Avg Trades / Year</span>
          <span>{frequency.avgTradesPerYear.toFixed(2)} / year</span>
        </div>
      </div>

      <CumulativeRRChart series={cumulativeSeries} />
      <MonthlyPerformanceWidget monthlyMap={monthlyMap} defaultYear={defaultYear} />
      <DailyPerformanceCalendar dailyMap={dailyMap} defaultYear={defaultCalendarYear} defaultMonth={defaultCalendarMonth} />
      <YearlyPerformanceTable yearlyMap={yearlyMap} />
    </div>
  );
}
