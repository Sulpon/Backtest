import { useEffect, useMemo, useRef, useState } from "react";
import { useUiStore } from "../workspace/uiStore";
import { useCommands } from "./commands";
import "./CommandPalette.css";

export function CommandPalette() {
  const open = useUiStore((s) => s.commandPaletteOpen);
  const setOpen = useUiStore((s) => s.setCommandPaletteOpen);
  const commands = useCommands();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => `${c.category} ${c.label}`.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      // wait a frame - the input isn't in the DOM yet on the same render that flips `open`
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector(".cp-item.selected")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (!open) return null;

  function run(index: number) {
    const cmd = filtered[index];
    if (!cmd) return;
    setOpen(false);
    cmd.run();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(selected);
    }
    // Escape is handled globally by useCommandPaletteHotkey
  }

  return (
    <div className="cp-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="cp-modal" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cp-input"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="cp-list" ref={listRef}>
          {filtered.length === 0 && <div className="cp-empty">No matching commands</div>}
          {filtered.map((c, i) => (
            <div
              key={c.id}
              className={`cp-item${i === selected ? " selected" : ""}`}
              onMouseEnter={() => setSelected(i)}
              onClick={() => run(i)}
            >
              <span className="cp-category">{c.category}</span>
              <span className="cp-label">{c.label}</span>
              {c.hint && <span className="cp-hint">{c.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
