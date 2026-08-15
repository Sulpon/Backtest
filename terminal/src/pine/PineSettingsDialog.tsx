import { useEffect, useMemo, useRef, useState } from "react";
import { useUiStore } from "../workspace/uiStore";
import { usePineIndicatorStore } from "./pineIndicatorStore";
import { runPineScript } from "./usePineIndicators";
import type { InputDef } from "./interpreter";
import { colorToHex, hexToColor, type PineColor } from "./stdlib";
import type { CandleBar } from "../data/types";
import "./PineSettingsDialog.css";

// input() calls always evaluate the same regardless of price data (they
// only depend on the script's own code + overrides), so a single throwaway
// bar is enough to run the script far enough to collect input/plot
// metadata - no need to fetch real market data just to open this dialog.
const SYNTHETIC_BARS: CandleBar[] = [{ time: 0, open: 1, high: 1, low: 1, close: 1 }];

type TabId = "inputs" | "style" | "visibility";

export function PineSettingsDialog() {
  const targetId = useUiStore((s) => s.pineEditTarget);
  const setTargetId = useUiStore((s) => s.setPineEditTarget);
  const items = usePineIndicatorStore((s) => s.items);
  const setInputOverride = usePineIndicatorStore((s) => s.setInputOverride);
  const setInputOverrides = usePineIndicatorStore((s) => s.setInputOverrides);
  const setVisible = usePineIndicatorStore((s) => s.setVisible);
  const setStartDate = usePineIndicatorStore((s) => s.setStartDate);

  const [tab, setTab] = useState<TabId>("inputs");
  const snapshotRef = useRef<{ overrides: Record<string, unknown>; visible: boolean; startDate: number | null } | null>(null);

  const item = items.find((i) => i.id === targetId) ?? null;

  useEffect(() => {
    if (item) {
      snapshotRef.current = { overrides: { ...item.inputOverrides }, visible: item.visible, startDate: item.startDate };
      setTab("inputs");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId]);

  const run = useMemo(() => (item ? runPineScript(item, SYNTHETIC_BARS) : null), [item]);

  if (!item) return null;

  function close() {
    setTargetId(null);
  }

  function handleCancel() {
    if (item && snapshotRef.current) {
      setInputOverrides(item.id, snapshotRef.current.overrides);
      setVisible(item.id, snapshotRef.current.visible);
      setStartDate(item.id, snapshotRef.current.startDate);
    }
    close();
  }

  function handleDefaults() {
    if (item) setInputOverrides(item.id, {});
  }

  const groups = new Map<string, InputDef[]>();
  for (const def of run?.inputDefs ?? []) {
    const g = def.group ?? "Settings";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(def);
  }

  return (
    <div className="psd-backdrop" onMouseDown={handleCancel}>
      <div className="psd-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="psd-header">
          <span className="psd-title">{item.name}</span>
          <button type="button" className="psd-close" onClick={handleCancel}>
            &times;
          </button>
        </div>

        <div className="psd-tabs">
          {(["inputs", "style", "visibility"] as TabId[]).map((t) => (
            <button key={t} type="button" className={`psd-tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
              {t === "inputs" ? "Inputs" : t === "style" ? "Style" : "Visibility"}
            </button>
          ))}
        </div>

        <div className="psd-body">
          {tab === "inputs" && (
            <>
              <div className="psd-group">
                <div className="psd-group-title">Backtest Range</div>
                <div className="psd-row">
                  <span className="psd-row-label">Apply From Date</span>
                  <input
                    type="date"
                    className="psd-number-input"
                    value={item.startDate ? new Date(item.startDate * 1000).toISOString().slice(0, 10) : ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      setStartDate(item.id, v ? Math.floor(new Date(v + "T00:00:00Z").getTime() / 1000) : null);
                    }}
                  />
                </div>
                <div className="psd-hint">
                  The script only sees bars from this date onward - its structure tracking starts fresh here, and only trades from this
                  point are recorded. Leave empty to use all available history.
                </div>
              </div>
              {run?.fatalError && <div className="psd-error">Script error: {run.fatalError}</div>}
              {groups.size === 0 && !run?.fatalError && <div className="psd-empty">This script has no configurable inputs.</div>}
              {[...groups.entries()].map(([group, defs]) => (
                <div key={group} className="psd-group">
                  <div className="psd-group-title">{group}</div>
                  {defs.map((def) => (
                    <InputRow key={def.key} def={def} item={item} setInputOverride={setInputOverride} />
                  ))}
                </div>
              ))}
            </>
          )}

          {tab === "style" && (
            <>
              {(!run || run.outputs.plots.length === 0) && (
                <div className="psd-empty">This script doesn't define any plot() outputs to style.</div>
              )}
              {run?.outputs.plots.map((p) => (
                <div key={p.name} className="psd-row">
                  <span className="psd-row-label">{p.name}</span>
                  <span className="psd-swatch" style={{ background: p.color }} />
                </div>
              ))}
            </>
          )}

          {tab === "visibility" && (
            <div className="psd-row">
              <span className="psd-row-label">Visible on chart</span>
              <input type="checkbox" checked={item.visible} onChange={(e) => setVisible(item.id, e.target.checked)} />
            </div>
          )}
        </div>

        <div className="psd-footer">
          <button type="button" className="psd-btn-defaults" onClick={handleDefaults}>
            Defaults
          </button>
          <div className="psd-footer-spacer" />
          <button type="button" className="psd-btn-cancel" onClick={handleCancel}>
            Cancel
          </button>
          <button type="button" className="psd-btn-ok" onClick={close}>
            Ok
          </button>
        </div>
      </div>
    </div>
  );
}

function InputRow({
  def,
  item,
  setInputOverride,
}: {
  def: InputDef;
  item: { id: string; inputOverrides: Record<string, unknown> };
  setInputOverride: (id: string, key: string, value: unknown) => void;
}) {
  const current = Object.prototype.hasOwnProperty.call(item.inputOverrides, def.key) ? item.inputOverrides[def.key] : def.defaultValue;

  if (def.kind === "bool") {
    return (
      <label className="psd-row psd-row-bool">
        <input type="checkbox" checked={!!current} onChange={(e) => setInputOverride(item.id, def.key, e.target.checked)} />
        <span className="psd-row-label">{def.title}</span>
      </label>
    );
  }

  if (def.kind === "color") {
    const hex = colorToHex(current);
    const alpha = current && typeof current === "object" ? (current as PineColor).a : 1;
    return (
      <div className="psd-row">
        <span className="psd-row-label">{def.title}</span>
        <input
          type="color"
          className="psd-color-input"
          value={hex}
          onChange={(e) => {
            const picked = hexToColor(e.target.value.replace("#", ""));
            setInputOverride(item.id, def.key, { ...picked, a: alpha });
          }}
          title={hex}
        />
      </div>
    );
  }

  if (def.kind === "int" || def.kind === "float") {
    return (
      <div className="psd-row">
        <span className="psd-row-label">{def.title}</span>
        <input
          type="number"
          className="psd-number-input"
          step={def.kind === "int" ? 1 : "any"}
          min={def.minval}
          max={def.maxval}
          value={Number(current ?? 0)}
          onChange={(e) => setInputOverride(item.id, def.key, def.kind === "int" ? parseInt(e.target.value, 10) || 0 : Number(e.target.value))}
        />
      </div>
    );
  }

  if (def.options && def.options.length > 0) {
    return (
      <div className="psd-row">
        <span className="psd-row-label">{def.title}</span>
        <select className="psd-select-input" value={String(current ?? "")} onChange={(e) => setInputOverride(item.id, def.key, e.target.value)}>
          {def.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div className="psd-row">
      <span className="psd-row-label">{def.title}</span>
      <input
        type="text"
        className="psd-text-input"
        value={String(current ?? "")}
        onChange={(e) => setInputOverride(item.id, def.key, e.target.value)}
      />
    </div>
  );
}
