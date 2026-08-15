import { useEffect, useState } from "react";
import { useUiStore } from "../workspace/uiStore";
import { useAnalysisStore, type SmcOverlayId } from "./analysisStore";
import { SESSIONS } from "./sessions";
import { useIndicatorStore, INDICATOR_LABELS, type IndicatorType } from "../indicators/indicatorStore";
import { useCustomIndicatorStore, DEFAULT_CUSTOM_CODE, type CustomIndicator } from "../indicators/customIndicatorStore";
import { runCustomIndicator } from "../indicators/runCustomIndicator";
import { usePineIndicatorStore, DEFAULT_PINE_CODE, type PineIndicator } from "../pine/pineIndicatorStore";
import { runPineScript } from "../pine/usePineIndicators";
import type { InputDef } from "../pine/interpreter";
import { dataLayer } from "../data/DataLayer";
import type { CandleBar } from "../data/types";
import { useActiveWorkspace } from "../workspace/workspaceStore";
import "./AnalysisHub.css";

type TabId = "indicators" | "smc" | "sessions" | "volume" | "ai" | "custom" | "pine";

const TABS: { id: TabId; label: string }[] = [
  { id: "indicators", label: "Indicators" },
  { id: "smc", label: "SMC" },
  { id: "sessions", label: "Sessions" },
  { id: "volume", label: "Volume" },
  { id: "ai", label: "AI" },
  { id: "custom", label: "Custom" },
  { id: "pine", label: "Pine Script" },
];

const CHART_ELEMENTS: { id: SmcOverlayId; label: string; hint: string }[] = [
  { id: "swings", label: "Swing Labels", hint: "H / HH / LH / L / LL / HL structure markers" },
  { id: "trades", label: "Trade Zones", hint: "SL/TP boxes for each backtest trade" },
];

const SMC_CONCEPTS: { id: SmcOverlayId; label: string; hint: string }[] = [
  { id: "bos", label: "Break of Structure", hint: "Continuation break in the direction of the established trend" },
  { id: "choch", label: "Change of Character", hint: "First break against the prior established trend" },
  { id: "fvg", label: "Fair Value Gap", hint: "3-candle wick imbalance, pure pattern match" },
  { id: "orderBlock", label: "Order Block", hint: "Origin candle of the impulse leg behind each trade setup" },
  { id: "liquidity", label: "Liquidity", hint: "Equal highs/lows within a tight tolerance - resting stop/entry orders" },
  { id: "volumeImbalance", label: "Volume Imbalance", hint: "2-candle body gap, ignoring wicks - same idea as FVG" },
];

const SMC_RESERVED = ["Market Structure Shift", "Mitigation Block"];

function ToggleRow({ id, label, hint }: { id: SmcOverlayId; label: string; hint: string }) {
  const checked = useAnalysisStore((s) => s.smcVisible[id]);
  const toggle = useAnalysisStore((s) => s.toggleSmc);
  return (
    <label className="ah-row">
      <input type="checkbox" checked={checked} onChange={() => toggle(id)} />
      <span className="ah-row-label">{label}</span>
      <span className="ah-row-hint">{hint}</span>
    </label>
  );
}

function SmcTab() {
  return (
    <div className="ah-list">
      <div className="settings-section-title">Chart</div>
      {CHART_ELEMENTS.map((c) => (
        <ToggleRow key={c.id} {...c} />
      ))}
      <div className="settings-section-title">SMC Concepts</div>
      {SMC_CONCEPTS.map((c) => (
        <ToggleRow key={c.id} {...c} />
      ))}
      {SMC_RESERVED.map((label) => (
        <div key={label} className="ah-row ah-row-disabled" title="Not yet wired">
          <input type="checkbox" disabled />
          <span className="ah-row-label">{label}</span>
          <span className="ah-row-hint">Not yet wired</span>
        </div>
      ))}
    </div>
  );
}

function SessionsTab() {
  const sessionsVisible = useAnalysisStore((s) => s.sessionsVisible);
  const toggleSession = useAnalysisStore((s) => s.toggleSession);
  return (
    <div className="ah-list">
      {SESSIONS.map((s) => (
        <label key={s.id} className="ah-row">
          <input type="checkbox" checked={sessionsVisible[s.id]} onChange={() => toggleSession(s.id)} />
          <span className="ah-row-label">{s.label}</span>
          <span className="ah-row-hint">
            {String(s.startHour).padStart(2, "0")}:00–{String(s.endHour).padStart(2, "0")}:00 UTC
          </span>
        </label>
      ))}
      <div className="ah-placeholder">Shaded on the chart as background bands; hidden once zoomed out past ~30 days.</div>
    </div>
  );
}

const INDICATOR_TYPES: IndicatorType[] = ["sma", "ema", "bb"];

function IndicatorsTab() {
  const active = useIndicatorStore((s) => s.active);
  const add = useIndicatorStore((s) => s.add);
  const remove = useIndicatorStore((s) => s.remove);
  const updatePeriod = useIndicatorStore((s) => s.updatePeriod);
  const [type, setType] = useState<IndicatorType>("sma");
  const [period, setPeriod] = useState(20);

  return (
    <div className="ah-list">
      <div className="ind-add-row">
        <select className="ind-select" value={type} onChange={(e) => setType(e.target.value as IndicatorType)}>
          {INDICATOR_TYPES.map((t) => (
            <option key={t} value={t}>
              {INDICATOR_LABELS[t]}
            </option>
          ))}
        </select>
        <input
          type="number"
          className="ind-period-input"
          value={period}
          min={2}
          max={500}
          onChange={(e) => setPeriod(Math.max(2, parseInt(e.target.value, 10) || 20))}
        />
        <button type="button" className="ind-add-btn" onClick={() => add(type, period)}>
          + Add
        </button>
      </div>

      {active.length === 0 && <div className="ah-placeholder">No indicators added yet.</div>}

      {active.map((ind) => (
        <div key={ind.id} className="ah-row">
          <span className="ind-swatch" style={{ background: ind.color }} />
          <span className="ah-row-label">
            {INDICATOR_LABELS[ind.type]} {ind.period}
          </span>
          <input
            type="number"
            className="ind-period-input ind-period-edit"
            value={ind.period}
            min={2}
            max={500}
            onChange={(e) => updatePeriod(ind.id, Math.max(2, parseInt(e.target.value, 10) || ind.period))}
          />
          <button type="button" className="ind-remove-btn" onClick={() => remove(ind.id)}>
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}

/** A Pine-Script-inspired custom indicator editor - not literal Pine Script
 * (that's a whole DSL/compiler, well beyond what a chart feature like this
 * needs), but the same workflow: write code, see it plotted, flip it on/off
 * with one click. Code is plain JS run via runCustomIndicator(); this tab
 * only handles authoring/validation, ChartPane owns actually rendering it. */
function CustomTab() {
  const ws = useActiveWorkspace();
  const items = useCustomIndicatorStore((s) => s.items);
  const add = useCustomIndicatorStore((s) => s.add);
  const update = useCustomIndicatorStore((s) => s.update);
  const remove = useCustomIndicatorStore((s) => s.remove);
  const toggleVisible = useCustomIndicatorStore((s) => s.toggleVisible);

  const [name, setName] = useState("");
  const [code, setCode] = useState(DEFAULT_CUSTOM_CODE);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewBars, setPreviewBars] = useState<CandleBar[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    dataLayer.getSymbolData(ws.symbol, "1h").then((d) => {
      if (!cancelled) setPreviewBars(d.bars);
    });
    return () => {
      cancelled = true;
    };
  }, [ws.symbol]);

  function resetEditor() {
    setEditingId(null);
    setName("");
    setCode(DEFAULT_CUSTOM_CODE);
    setError(null);
  }

  function handleSave() {
    if (!name.trim()) {
      setError("Give the indicator a name first.");
      return;
    }
    if (previewBars) {
      const { error: runError } = runCustomIndicator(code, previewBars.slice(-500));
      if (runError) {
        setError(runError);
        return;
      }
    }
    if (editingId) {
      update(editingId, { name, code });
    } else {
      add(name, code);
    }
    resetEditor();
  }

  function startEdit(item: CustomIndicator) {
    setEditingId(item.id);
    setName(item.name);
    setCode(item.code);
    setError(null);
  }

  return (
    <div className="ah-list">
      <div className="ci-editor">
        <input className="ci-name-input" placeholder="Indicator name" value={name} onChange={(e) => setName(e.target.value)} />
        <textarea
          className="ci-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          spellCheck={false}
          rows={11}
        />
        {error && <div className="ci-error">{error}</div>}
        <div className="ci-editor-actions">
          <button type="button" className="ind-add-btn" onClick={handleSave}>
            {editingId ? "Save Changes" : "+ Add Indicator"}
          </button>
          {editingId && (
            <button type="button" className="ah-link-btn" onClick={resetEditor}>
              Cancel edit
            </button>
          )}
        </div>
      </div>

      {items.length === 0 && <div className="ah-placeholder">No custom indicators yet - write some code above and add one.</div>}

      {items.map((item) => (
        <div key={item.id} className="ah-row ci-row">
          <button
            type="button"
            className={`ci-visibility-btn${item.visible ? " visible" : ""}`}
            title={item.visible ? "Hide on chart" : "Show on chart"}
            onClick={() => toggleVisible(item.id)}
          >
            {item.visible ? "●" : "○"}
          </button>
          <span className="ind-swatch" style={{ background: item.color }} />
          <span className="ah-row-label ci-clickable" title="Click to edit" onClick={() => startEdit(item)}>
            {item.name}
          </span>
          <button type="button" className="ind-remove-btn" onClick={() => remove(item.id)}>
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}

/** A real (scoped) Pine Script v5 interpreter - see terminal/src/pine/.
 * Supports the subset most self-contained overlay indicators use: series/
 * var/varip, functions, if/for/for-in, ta./math./array./str./color.*, and
 * the line./box./label.* drawing primitives (rendered by
 * PineIndicatorLayer, not lightweight-charts' own series). NOT supported:
 * request.security (multi-timeframe), strategy.* (order simulation),
 * user-defined `type` structs, or scripts that import an external
 * library beyond a no-op-safe reference. */
function PineTab() {
  const ws = useActiveWorkspace();
  const items = usePineIndicatorStore((s) => s.items);
  const add = usePineIndicatorStore((s) => s.add);
  const update = usePineIndicatorStore((s) => s.update);
  const remove = usePineIndicatorStore((s) => s.remove);
  const toggleVisible = usePineIndicatorStore((s) => s.toggleVisible);
  const setInputOverride = usePineIndicatorStore((s) => s.setInputOverride);

  const [name, setName] = useState("");
  const [code, setCode] = useState(DEFAULT_PINE_CODE);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewBars, setPreviewBars] = useState<CandleBar[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    dataLayer.getSymbolData(ws.symbol, "1h").then((d) => {
      if (!cancelled) setPreviewBars(d.bars);
    });
    return () => {
      cancelled = true;
    };
  }, [ws.symbol]);

  const editingItem = items.find((i) => i.id === editingId);
  const preview =
    previewBars && editingItem ? runPineScript({ ...editingItem, code, name }, previewBars.slice(-1000)) : null;

  function resetEditor() {
    setEditingId(null);
    setName("");
    setCode(DEFAULT_PINE_CODE);
    setError(null);
  }

  function handleSave() {
    if (!name.trim()) {
      setError("Give the indicator a name first.");
      return;
    }
    if (previewBars) {
      const result = runPineScript(
        {
          id: editingId ?? "preview",
          name,
          code,
          visible: true,
          inputOverrides: editingItem?.inputOverrides ?? {},
          startDate: editingItem?.startDate ?? null,
        },
        previewBars.slice(-1000)
      );
      if (result.fatalError) {
        setError(result.fatalError);
        return;
      }
    }
    if (editingId) {
      update(editingId, { name, code });
    } else {
      add(name, code);
    }
    resetEditor();
  }

  function startEdit(item: PineIndicator) {
    setEditingId(item.id);
    setName(item.name);
    setCode(item.code);
    setError(null);
  }

  const groupedInputs = new Map<string, InputDef[]>();
  if (preview) {
    for (const def of preview.inputDefs) {
      const g = def.group ?? "Settings";
      if (!groupedInputs.has(g)) groupedInputs.set(g, []);
      groupedInputs.get(g)!.push(def);
    }
  }

  return (
    <div className="ah-list">
      <div className="ci-editor">
        <input className="ci-name-input" placeholder="Indicator name" value={name} onChange={(e) => setName(e.target.value)} />
        <textarea
          className="ci-code pine-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          spellCheck={false}
          rows={14}
        />
        {error && <div className="ci-error">{error}</div>}
        {preview && !preview.fatalError && editingId && (
          <div className="pine-run-summary">
            {preview.outputs.lines.length} lines · {preview.outputs.boxes.length} boxes · {preview.outputs.labels.length} labels ·{" "}
            {preview.outputs.plots.length} plots
          </div>
        )}
        <div className="ci-editor-actions">
          <button type="button" className="ind-add-btn" onClick={handleSave}>
            {editingId ? "Save Changes" : "+ Add Indicator"}
          </button>
          {editingId && (
            <button type="button" className="ah-link-btn" onClick={resetEditor}>
              Cancel edit
            </button>
          )}
        </div>
      </div>

      {editingItem && groupedInputs.size > 0 && (
        <div className="pine-inputs">
          <div className="settings-section-title">Inputs</div>
          {[...groupedInputs.entries()].map(([group, defs]) => (
            <div key={group} className="pine-input-group">
              <div className="pine-input-group-title">{group}</div>
              {defs.map((def) => (
                <label key={def.key} className="pine-input-row">
                  <span className="pine-input-label">{def.title}</span>
                  {def.kind === "bool" ? (
                    <input
                      type="checkbox"
                      checked={!!(editingItem.inputOverrides[def.key] ?? def.defaultValue)}
                      onChange={(e) => setInputOverride(editingItem.id, def.key, e.target.checked)}
                    />
                  ) : def.kind === "int" || def.kind === "float" ? (
                    <input
                      type="number"
                      step={def.kind === "int" ? 1 : "any"}
                      min={def.minval}
                      max={def.maxval}
                      value={Number(editingItem.inputOverrides[def.key] ?? def.defaultValue ?? 0)}
                      onChange={(e) => setInputOverride(editingItem.id, def.key, Number(e.target.value))}
                    />
                  ) : def.options && def.options.length > 0 ? (
                    <select
                      value={String(editingItem.inputOverrides[def.key] ?? def.defaultValue ?? "")}
                      onChange={(e) => setInputOverride(editingItem.id, def.key, e.target.value)}
                    >
                      {def.options.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={String(editingItem.inputOverrides[def.key] ?? def.defaultValue ?? "")}
                      onChange={(e) => setInputOverride(editingItem.id, def.key, e.target.value)}
                    />
                  )}
                </label>
              ))}
            </div>
          ))}
        </div>
      )}

      {items.length === 0 && <div className="ah-placeholder">No Pine scripts yet - paste one above and add it.</div>}

      {items.map((item) => (
        <div key={item.id} className="ah-row ci-row">
          <button
            type="button"
            className={`ci-visibility-btn${item.visible ? " visible" : ""}`}
            title={item.visible ? "Hide on chart" : "Show on chart"}
            onClick={() => toggleVisible(item.id)}
          >
            {item.visible ? "●" : "○"}
          </button>
          <span className="ah-row-label ci-clickable" title="Click to edit" onClick={() => startEdit(item)}>
            {item.name}
          </span>
          <button type="button" className="ind-remove-btn" onClick={() => remove(item.id)}>
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}

function PlaceholderTab({ label }: { label: string }) {
  return <div className="ah-placeholder">{label} isn't wired up yet - arrives in a later milestone.</div>;
}

export function AnalysisHub() {
  const open = useUiStore((s) => s.analysisHubOpen);
  const setOpen = useUiStore((s) => s.setAnalysisHubOpen);
  const [tab, setTab] = useState<TabId>("smc");

  if (!open) return null;

  return (
    <div className="ah-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="ah-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ah-header">
          <span className="ah-title">Analysis</span>
          <button type="button" className="ah-close" onClick={() => setOpen(false)}>
            &times;
          </button>
        </div>
        <div className="ah-body">
          <div className="ah-tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`ah-tab${tab === t.id ? " active" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="ah-content">
            {tab === "smc" ? (
              <SmcTab />
            ) : tab === "sessions" ? (
              <SessionsTab />
            ) : tab === "indicators" ? (
              <IndicatorsTab />
            ) : tab === "custom" ? (
              <CustomTab />
            ) : tab === "pine" ? (
              <PineTab />
            ) : (
              <PlaceholderTab label={TABS.find((t) => t.id === tab)!.label} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
