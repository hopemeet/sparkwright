import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { ToastStore } from "../src/state/toast-store.js";

describe("ToastStore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows first push immediately and queues the rest", () => {
    const s = new ToastStore();
    s.push({ message: "one" });
    s.push({ message: "two" });
    s.push({ message: "three" });
    expect(s.getSnapshot().current?.message).toBe("one");
    expect(s.getSnapshot().queueDepth).toBe(2);
  });

  it("auto-dismisses by duration and advances queue", () => {
    const s = new ToastStore();
    s.push({ message: "one", durationMs: 1000 });
    s.push({ message: "two", durationMs: 1000 });
    vi.advanceTimersByTime(1001);
    expect(s.getSnapshot().current?.message).toBe("two");
  });

  it("error variant is sticky by default", () => {
    const s = new ToastStore();
    s.push({ message: "boom", variant: "error" });
    vi.advanceTimersByTime(60_000);
    expect(s.getSnapshot().current?.message).toBe("boom");
  });
});
