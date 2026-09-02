import { beforeEach, describe, expect, it } from "vitest";
import { useIndicatorStore } from "./indicatorStore";

// Reset persisted zustand state between tests - "add" reads current length
// for palette cycling, so a clean slate keeps assertions independent of
// test execution order.
beforeEach(() => {
  useIndicatorStore.setState({ active: [] });
});

describe("indicatorStore", () => {
  it("defaults a newly added indicator to visible", () => {
    useIndicatorStore.getState().add("sma", 20);
    const [ind] = useIndicatorStore.getState().active;
    expect(ind.visible).toBe(true);
  });

  it("toggleVisible flips visible on the matching indicator only", () => {
    useIndicatorStore.getState().add("sma", 20);
    useIndicatorStore.getState().add("ema", 50);
    const [first, second] = useIndicatorStore.getState().active;

    useIndicatorStore.getState().toggleVisible(first.id);

    const after = useIndicatorStore.getState().active;
    expect(after.find((i) => i.id === first.id)?.visible).toBe(false);
    expect(after.find((i) => i.id === second.id)?.visible).toBe(true);

    useIndicatorStore.getState().toggleVisible(first.id);
    expect(useIndicatorStore.getState().active.find((i) => i.id === first.id)?.visible).toBe(true);
  });

  it("toggleVisible is a no-op for an unknown id", () => {
    useIndicatorStore.getState().add("sma", 20);
    const before = useIndicatorStore.getState().active;

    useIndicatorStore.getState().toggleVisible("does-not-exist");

    expect(useIndicatorStore.getState().active).toEqual(before);
  });
});
