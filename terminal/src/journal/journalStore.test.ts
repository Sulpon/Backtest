import { beforeEach, describe, expect, it } from "vitest";
import { scanTradeKey, tradeKey, useJournalStore } from "./journalStore";

describe("tradeKey", () => {
  it("matches today's plain format when no indicatorId is given (backend trades - zero behavior change)", () => {
    expect(tradeKey("EURUSD", 42)).toBe("EURUSD:42");
  });

  it("produces a distinct key format when an indicatorId is given", () => {
    const backend = tradeKey("EURUSD", 42);
    const pine = tradeKey("EURUSD", 42, "pi-1");
    expect(pine).not.toBe(backend);
  });

  it("gives two different indicators sharing the same symbol+entryBar independent keys (no collision)", () => {
    const a = tradeKey("EURUSD", 42, "pi-1");
    const b = tradeKey("EURUSD", 42, "pi-2");
    expect(a).not.toBe(b);
  });

  it("is stable for the same symbol/entryBar/indicatorId combination", () => {
    expect(tradeKey("EURUSD", 42, "pi-1")).toBe(tradeKey("EURUSD", 42, "pi-1"));
  });
});

describe("scanTradeKey", () => {
  it("is stable for the same symbol/timeframe/entryTime/exitTime/indicatorId combination", () => {
    expect(scanTradeKey("EURUSD", "1h", 1_700_000_000, 1_700_003_600, "pi-1")).toBe(
      scanTradeKey("EURUSD", "1h", 1_700_000_000, 1_700_003_600, "pi-1")
    );
  });

  it("never collides with tradeKey's backend or bar-indexed Pine shapes, even reusing the same numeric value", () => {
    // A scan trade's entryTime (~1.7 billion) and a live-chart trade's
    // entryBar (a small bar-index int) are different units, but nothing
    // stops them sharing the same digits in a test - the key FORMAT itself
    // (the literal "scan" segment) is what must keep these apart, not luck.
    const n = 1_700_000_000;
    const backend = tradeKey("EURUSD", n);
    const pine = tradeKey("EURUSD", n, "pi-1");
    const scan = scanTradeKey("EURUSD", "1h", n, n + 3600, "pi-1");
    expect(scan).not.toBe(backend);
    expect(scan).not.toBe(pine);
  });

  it("gives two different timeframes of the same symbol/indicator/entryTime/exitTime independent keys", () => {
    const oneHour = scanTradeKey("EURUSD", "1h", 1_700_000_000, 1_700_003_600, "pi-1");
    const fourHour = scanTradeKey("EURUSD", "4h", 1_700_000_000, 1_700_003_600, "pi-1");
    expect(oneHour).not.toBe(fourHour);
  });

  it("gives two different indicators sharing symbol/timeframe/entryTime/exitTime independent keys", () => {
    const a = scanTradeKey("EURUSD", "1h", 1_700_000_000, 1_700_003_600, "pi-a");
    const b = scanTradeKey("EURUSD", "1h", 1_700_000_000, 1_700_003_600, "pi-b");
    expect(a).not.toBe(b);
  });

  it("regression: two trades sharing the same entryTime but different exitTime get independent keys (the bug found during live validation - a same-bar-exit trade and a separately-running trade opening on the same bar were colliding and one was silently dropped)", () => {
    const sameBarExit = scanTradeKey("EURUSD", "1h", 1_736_758_800, 1_736_758_800, "pi-1");
    const laterExit = scanTradeKey("EURUSD", "1h", 1_736_758_800, 1_736_946_000, "pi-1");
    expect(sameBarExit).not.toBe(laterExit);
  });
});

describe("useJournalStore", () => {
  beforeEach(() => {
    useJournalStore.setState({ entries: {} });
  });

  it("keeps notes independent across two indicators that both record a trade at the same entryBar", () => {
    const keyA = tradeKey("EURUSD", 7, "pi-a");
    const keyB = tradeKey("EURUSD", 7, "pi-b");

    useJournalStore.getState().setNote(keyA, "Indicator A's read on this trade");
    useJournalStore.getState().setNote(keyB, "Indicator B's read on this trade");

    const entries = useJournalStore.getState().entries;
    expect(entries[keyA].note).toBe("Indicator A's read on this trade");
    expect(entries[keyB].note).toBe("Indicator B's read on this trade");
  });

  it("keeps ratings and tags independent across indicators sharing an entryBar", () => {
    const keyA = tradeKey("EURUSD", 7, "pi-a");
    const keyB = tradeKey("EURUSD", 7, "pi-b");

    useJournalStore.getState().setRating(keyA, 5);
    useJournalStore.getState().addTag(keyA, "clean-break");

    const entries = useJournalStore.getState().entries;
    expect(entries[keyA].rating).toBe(5);
    expect(entries[keyA].tags).toEqual(["clean-break"]);
    expect(entries[keyB]).toBeUndefined();
  });

  it("does not let a Pine-indicator-scoped key collide with the plain backend key for the same symbol/entryBar", () => {
    const backendKey = tradeKey("EURUSD", 7);
    const pineKey = tradeKey("EURUSD", 7, "pi-a");

    useJournalStore.getState().setNote(backendKey, "Backend trade note");
    useJournalStore.getState().setNote(pineKey, "Pine trade note");

    const entries = useJournalStore.getState().entries;
    expect(entries[backendKey].note).toBe("Backend trade note");
    expect(entries[pineKey].note).toBe("Pine trade note");
  });
});
