import { beforeEach, describe, expect, it } from "vitest";
import { tradeKey, useJournalStore } from "./journalStore";

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
