import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/state/event-store.js";
import { RunController } from "../src/state/run-controller.js";

/**
 * /retry re-runs the most recent goal in the same session. Driven end-to-end
 * against a deterministic host (same harness as fork.test.ts).
 */
function waitForRun(store: EventStore): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let sawRunning = false;
    const unsub = store.subscribe(() => {
      const s = store.getSnapshot();
      if (s.status === "running") sawRunning = true;
      if (sawRunning && (s.status === "done" || s.status === "error")) {
        unsub();
        if (s.status === "error") reject(new Error(s.lastError ?? "run error"));
        else resolve();
      }
    });
  });
}

describe("RunController /retry", () => {
  it("is a no-op before any goal has run", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "spark-retry-"));
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: workspace,
      modelName: "deterministic",
      store,
    });
    expect(controller.getLastGoal()).toBe(null);
    expect(await controller.retry()).toBe(false);
    controller.shutdown();
  });

  it("re-runs the last goal in the same session", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "spark-retry-"));
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: workspace,
      modelName: "deterministic",
      store,
    });

    const first = waitForRun(store);
    await controller.start("audit the repo");
    await first;
    const sessionId = controller.getSessionId();
    expect(controller.getLastGoal()).toBe("audit the repo");

    const second = waitForRun(store);
    expect(await controller.retry()).toBe(true);
    await second;

    // same session id, and the goal was submitted twice
    expect(controller.getSessionId()).toBe(sessionId);
    const goals = store
      .getSnapshot()
      .events.filter((e) => e.type === "tui.user")
      .map((e) => (e.payload as { goal?: string }).goal);
    expect(goals.filter((g) => g === "audit the repo").length).toBe(2);

    controller.shutdown();
  }, 30_000);

  it("clears the retry target when a new session starts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "spark-retry-"));
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: workspace,
      modelName: "deterministic",
      store,
    });

    const first = waitForRun(store);
    await controller.start("first goal");
    await first;
    expect(controller.getLastGoal()).toBe("first goal");

    // A fresh session must not carry the previous session's goal — /retry in
    // an empty new session is "nothing to retry", not "re-run the old goal".
    controller.newSession();
    expect(controller.getLastGoal()).toBe(null);
    expect(await controller.retry()).toBe(false);

    controller.shutdown();
  }, 30_000);
});
