import { useEffect, useState } from "react";
import { dataLayer } from "./DataLayer";

let cached: Promise<string[]> | null = null;

/** Every symbol/timeframe selector reads from this instead of a hardcoded
 * option list, so adding a symbol later (or one failing to load) never
 * needs a matching UI change - it's whatever the backend's `symbols` table
 * actually has. Module-level cache: the list doesn't change within a
 * session, and every caller mounting around the same time (TopToolbar,
 * every ChartPane) shares the one underlying fetch instead of each firing
 * their own. */
export function useSymbols(): string[] {
  const [symbols, setSymbols] = useState<string[]>([]);
  useEffect(() => {
    if (!cached) cached = dataLayer.listSymbols();
    let cancelled = false;
    cached.then((s) => {
      if (!cancelled) setSymbols(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return symbols;
}
