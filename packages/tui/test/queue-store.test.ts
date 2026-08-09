import { describe, expect, it, vi } from "vitest";
import { QueueStore } from "../src/state/queue-store.js";

describe("QueueStore", () => {
  it("enqueues and dequeues FIFO", () => {
    const q = new QueueStore();
    q.enqueue("one");
    q.enqueue("two");
    expect(q.size).toBe(2);
    expect(q.dequeue()).toBe("one");
    expect(q.dequeue()).toBe("two");
    expect(q.dequeue()).toBeUndefined();
    expect(q.size).toBe(0);
  });

  it("preserves Host-resolved project command identity while rendering text", () => {
    const q = new QueueStore();
    q.enqueueSubmission({
      goal: "/review src",
      projectCommand: { name: "review", rest: "src" },
    });

    expect(q.getSnapshot()).toEqual([
      {
        goal: "/review src",
        projectCommand: { name: "review", rest: "src" },
      },
    ]);
    expect(q.dequeueSubmission()).toEqual({
      goal: "/review src",
      projectCommand: { name: "review", rest: "src" },
    });
  });

  it("ignores blank submissions", () => {
    const q = new QueueStore();
    q.enqueue("   ");
    q.enqueue("\n\t");
    expect(q.size).toBe(0);
  });

  it("removeLast pops the most recently queued item", () => {
    const q = new QueueStore();
    q.enqueue("a");
    q.enqueue("b");
    expect(q.removeLast()).toBe("b");
    expect(q.size).toBe(1);
    expect(q.dequeue()).toBe("a");
  });

  it("removeAt drops the indexed item and clamps out-of-range", () => {
    const q = new QueueStore();
    q.enqueue("a");
    q.enqueue("b");
    q.enqueue("c");
    q.removeAt(1);
    expect(q.getSnapshot()).toEqual([{ goal: "a" }, { goal: "c" }]);
    q.removeAt(99); // no-op
    expect(q.getSnapshot()).toEqual([{ goal: "a" }, { goal: "c" }]);
  });

  it("keeps Host-managed follow-ups out of the local drain", () => {
    const q = new QueueStore();
    q.enqueueSubmission({
      goal: "next hosted run",
      commandId: "command_follow_up",
    });
    q.enqueue("local fallback");

    expect(q.dequeueLocalSubmission()).toBeUndefined();
    expect(q.removeByCommandId("command_follow_up")).toBe(true);
    expect(q.dequeueLocalSubmission()).toEqual({ goal: "local fallback" });
    expect(q.removeByCommandId("missing")).toBe(false);
  });

  it("returns a stable snapshot identity that only changes on mutation", () => {
    const q = new QueueStore();
    const empty = q.getSnapshot();
    expect(q.getSnapshot()).toBe(empty); // identical between reads
    q.enqueue("a");
    const afterAdd = q.getSnapshot();
    expect(afterAdd).not.toBe(empty);
    expect(afterAdd).toEqual([{ goal: "a" }]);
  });

  it("notifies subscribers on change and stops after unsubscribe", () => {
    const q = new QueueStore();
    const listener = vi.fn();
    const unsub = q.subscribe(listener);
    q.enqueue("a");
    expect(listener).toHaveBeenCalledTimes(1);
    q.dequeue();
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();
    q.enqueue("b");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("clear empties the queue (and is a no-op when already empty)", () => {
    const q = new QueueStore();
    const listener = vi.fn();
    q.subscribe(listener);
    q.clear(); // empty → no emit
    expect(listener).not.toHaveBeenCalled();
    q.enqueue("a");
    q.clear();
    expect(q.size).toBe(0);
  });
});
