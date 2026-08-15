import { useEffect } from "react";
import { useActiveWorkspace } from "../workspace/workspaceStore";
import { useUiStore } from "../workspace/uiStore";
import "./StatusBar.css";

export function StatusBar() {
  const ws = useActiveWorkspace();
  const hint = useUiStore((s) => s.statusHint);
  const setHint = useUiStore((s) => s.setStatusHint);

  useEffect(() => {
    if (!hint) return;
    const t = window.setTimeout(() => setHint(null), 3200);
    return () => window.clearTimeout(t);
  }, [hint, setHint]);

  return (
    <div className="statusbar mono">
      <span>{ws.symbol}</span>
      <span className="dim">·</span>
      <span>{ws.timeframe.toUpperCase()}</span>
      <span className="dim">·</span>
      <span>workspace: {ws.name}</span>
      <div className="statusbar-spacer" />
      {hint && <span className="statusbar-hint">{hint}</span>}
    </div>
  );
}
