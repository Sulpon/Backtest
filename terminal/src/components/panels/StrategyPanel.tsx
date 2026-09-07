import { useState } from "react";
import { useSymbols } from "../../data/useSymbols";
import { TIMEFRAMES, TIMEFRAME_LABELS } from "../../data/timeframes";
import type { Timeframe } from "../../data/types";
import { usePineIndicatorStore } from "../../pine/pineIndicatorStore";
import { useStrategyScanStore } from "../../strategy/strategyScanStore";
import { runHistoricalScan } from "../../strategy/historicalScanner";
import type { ScanConfig } from "../../strategy/types";
import "./panels.css";
import "./StrategyPanel.css";

function todayMinusDaysISO(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function dateInputToSec(value: string): number {
  return Math.floor(Date.parse(`${value}T00:00:00Z`) / 1000);
}

function secToDateInput(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

/**
 * Historical scan configuration form. Purely a config UI + trigger - all
 * actual work happens in strategy/historicalScanner.ts (called only from
 * handleScan below, never automatically), and all results/progress live in
 * strategy/strategyScanStore.ts, which the "Strategy Scan" source in
 * TradesPanel/StatsPanel read from directly - this component owns no trade
 * data of its own.
 */
export function StrategyPanel() {
  const symbols = useSymbols();
  const indicators = usePineIndicatorStore((s) => s.items);
  const status = useStrategyScanStore((s) => s.status);
  const progress = useStrategyScanStore((s) => s.progress);
  const trades = useStrategyScanStore((s) => s.trades);

  const [startDate, setStartDate] = useState(todayMinusDaysISO(365));
  const [symbolMode, setSymbolMode] = useState<"all" | "custom">("all");
  const [customSymbols, setCustomSymbols] = useState<string[]>([]);
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const [indicatorId, setIndicatorId] = useState<string>("");

  const selectedIndicator = indicators.find((i) => i.id === indicatorId) ?? indicators[0] ?? null;
  const scanning = status === "scanning";
  const doneCount = progress.filter((p) => p.status === "done" || p.status === "error").length;
  const totalTradesFound = Object.keys(trades).length;

  function toggleCustomSymbol(sym: string) {
    setCustomSymbols((cur) => (cur.includes(sym) ? cur.filter((s) => s !== sym) : [...cur, sym]));
  }

  async function handleScan() {
    if (!selectedIndicator) return;
    const targetSymbols = symbolMode === "all" ? symbols : customSymbols;
    if (targetSymbols.length === 0) return;
    const config: ScanConfig = {
      startDate: dateInputToSec(startDate),
      symbolMode,
      customSymbols,
      timeframe,
      indicatorId: selectedIndicator.id,
    };
    useStrategyScanStore.getState().setConfig(config);
    await runHistoricalScan(config, selectedIndicator, targetSymbols);
  }

  function handleCancel() {
    useStrategyScanStore.getState().cancel();
  }

  const canScan = !scanning && !!selectedIndicator && (symbolMode === "all" ? symbols.length > 0 : customSymbols.length > 0);

  return (
    <div className="panel-scroll strategy-panel">
      <div className="strategy-form">
        <div className="strategy-row">
          <label className="strategy-label">Start Date</label>
          <input
            type="date"
            className="strategy-input"
            value={startDate}
            max={secToDateInput(Math.floor(Date.now() / 1000))}
            onChange={(e) => setStartDate(e.target.value)}
            disabled={scanning}
          />
        </div>

        <div className="strategy-row">
          <label className="strategy-label">Symbols</label>
          <select
            className="strategy-input"
            value={symbolMode}
            onChange={(e) => setSymbolMode(e.target.value as "all" | "custom")}
            disabled={scanning}
          >
            <option value="all">All Symbols</option>
            <option value="custom">Custom</option>
          </select>
        </div>

        {symbolMode === "custom" && (
          <div className="strategy-symbol-picker">
            <div className="strategy-symbol-actions">
              <button type="button" className="strategy-link-btn" onClick={() => setCustomSymbols(symbols)} disabled={scanning}>
                Select All
              </button>
              <button type="button" className="strategy-link-btn" onClick={() => setCustomSymbols([])} disabled={scanning}>
                Clear All
              </button>
            </div>
            <div className="strategy-symbol-list">
              {symbols.map((sym) => (
                <label key={sym} className="strategy-symbol-item">
                  <input
                    type="checkbox"
                    checked={customSymbols.includes(sym)}
                    onChange={() => toggleCustomSymbol(sym)}
                    disabled={scanning}
                  />
                  {sym}
                </label>
              ))}
              {symbols.length === 0 && <span className="panel-dim">No symbols available</span>}
            </div>
          </div>
        )}

        <div className="strategy-row">
          <label className="strategy-label">Timeframe</label>
          <select
            className="strategy-input"
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value as Timeframe)}
            disabled={scanning}
          >
            {TIMEFRAMES.map((tf) => (
              <option key={tf} value={tf}>
                {TIMEFRAME_LABELS[tf]}
              </option>
            ))}
          </select>
        </div>

        <div className="strategy-row">
          <label className="strategy-label">Indicator</label>
          {indicators.length === 0 ? (
            <span className="panel-dim">No indicators added yet - add one in the Pine tab</span>
          ) : (
            <select
              className="strategy-input"
              value={selectedIndicator?.id ?? ""}
              onChange={(e) => setIndicatorId(e.target.value)}
              disabled={scanning}
            >
              {indicators.map((ind) => (
                <option key={ind.id} value={ind.id}>
                  {ind.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="strategy-actions">
          {scanning ? (
            <button type="button" className="strategy-scan-btn strategy-cancel-btn" onClick={handleCancel}>
              Cancel
            </button>
          ) : (
            <button type="button" className="strategy-scan-btn" onClick={handleScan} disabled={!canScan}>
              Scan Historical Trades
            </button>
          )}
        </div>
      </div>

      {(scanning || progress.length > 0) && (
        <div className="strategy-progress">
          <div className="panel-dim">
            {scanning
              ? `Scanning Historical Trades... ${doneCount} / ${progress.length} symbols`
              : status === "cancelled"
                ? `Scan cancelled - ${totalTradesFound} trades found so far`
                : `Scan Complete - ${totalTradesFound} trades found`}
          </div>
          <div className="strategy-progress-list">
            {progress.map((p) => (
              <span key={p.symbol} className={`strategy-progress-item ${p.status}`}>
                {p.symbol} {p.status === "done" ? "✓" : p.status === "error" ? "✗" : p.status === "running" ? "…" : ""}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
