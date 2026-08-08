import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { ToastStore } from "../src/state/toast-store.js";
import { presentationPolicy } from "../src/lib/ui-signal.js";

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

  it("keeps an ordinary error visible long enough to read, then resolves it", () => {
    const s = new ToastStore();
    s.push({ message: "boom", variant: "error" });
    vi.advanceTimersByTime(7_999);
    expect(s.getSnapshot().current?.message).toBe("boom");
    vi.advanceTimersByTime(2);
    expect(s.getSnapshot().current).toBeNull();
  });

  it("dismisses an error early and advances queued status toasts", () => {
    const s = new ToastStore();
    s.push({ message: "manual_cancelled", variant: "error" });
    s.push({ message: "run cancelled", variant: "info" });
    s.dismiss();
    expect(s.getSnapshot().current?.message).toBe("run cancelled");
    expect(s.getSnapshot().queueDepth).toBe(0);
  });

  it("dedupes a repeated background signal into one updated history item", () => {
    const s = new ToastStore();
    const kind = "error" as const;
    const scope = "BackgroundTask" as const;
    const policy = presentationPolicy({ kind, scope });
    const firstId = s.publish({
      kind,
      scope,
      source: "test.task",
      title: "task failed",
      message: "attempt 1",
      dedupeKey: "task:one",
      createdAt: 10,
      ...policy,
    });
    const secondId = s.publish({
      kind,
      scope,
      source: "test.task",
      title: "task failed",
      message: "attempt 2",
      dedupeKey: "task:one",
      createdAt: 20,
      ...policy,
    });

    expect(secondId).toBe(firstId);
    expect(s.getSnapshot().history).toHaveLength(1);
    expect(s.getSnapshot().history[0]).toMatchObject({
      message: "attempt 2",
      createdAt: 10,
      updatedAt: 20,
    });
  });

  it("lets an error preempt ordinary feedback without being overwritten", () => {
    const s = new ToastStore();
    s.push({ message: "ordinary" });
    s.push({ message: "failure", variant: "error" });
    s.push({ message: "later success", variant: "success" });

    expect(s.getSnapshot().current?.message).toBe("failure");
    expect(s.getSnapshot().queueDepth).toBe(2);
    vi.advanceTimersByTime(1000);
    expect(s.getSnapshot().current?.message).toBe("failure");
  });

  it("tracks seen and resolved state separately for durable signals", () => {
    const s = new ToastStore();
    const kind = "error" as const;
    const scope = "RunFailure" as const;
    const id = s.publish({
      kind,
      scope,
      source: "test.run",
      message: "run failed",
      ...presentationPolicy({ kind, scope }),
    });

    s.markAllSeen();
    expect(s.getSnapshot().history[0]).toMatchObject({
      seen: true,
      resolved: false,
    });
    s.resolve(id);
    expect(s.getSnapshot().history[0]).toMatchObject({
      seen: true,
      resolved: true,
    });
  });

  it("clears an until-seen background error when history is opened", () => {
    const s = new ToastStore();
    const kind = "error" as const;
    const scope = "BackgroundTask" as const;
    s.publish({
      kind,
      scope,
      source: "test.task",
      message: "task failed",
      ...presentationPolicy({ kind, scope }),
    });
    expect(s.getSnapshot().current?.message).toBe("task failed");

    s.markAllSeen();
    expect(s.getSnapshot().current).toBeNull();
    expect(s.getSnapshot().history[0]).toMatchObject({
      seen: true,
      resolved: true,
    });
  });
});
