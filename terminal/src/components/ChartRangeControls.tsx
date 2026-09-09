import { CHART_RANGE_PRESETS, type ChartRangePreset } from "./chartRangePresets";
import "./ChartRangeControls.css";

export function ChartRangeControls({
  active,
  onSelect,
}: {
  active: ChartRangePreset | null;
  onSelect: (preset: ChartRangePreset) => void;
}) {
  return (
    <div className="pane-range-controls">
      {CHART_RANGE_PRESETS.map((preset) => (
        <button
          key={preset}
          type="button"
          className={preset === active ? "active" : ""}
          onClick={() => onSelect(preset)}
        >
          {preset}
        </button>
      ))}
    </div>
  );
}
