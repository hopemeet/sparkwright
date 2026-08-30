import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/state/event-store.js";
import { RunController } from "../src/state/run-controller.js";

/**
 * End-to-end fork: run a deterministic goal so a real on-disk session exists,
 * then fork it through the host protocol and assert we get a new session id.
 */
describe("session fork via host", () => {
  it("forks the current session into a new one", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "spark-fork-"));
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: workspace,
      modelName: "deterministic",
      store,
    });

    const done = new Promise<void>((resolve, reject) => {
      const unsub = store.subscribe(() => {
        const s = store.getSnapshot();
        if (s.status === "done" || s.status === "error") {
          unsub();
          if (s.status === "error") {
            reject(new Error(s.lastError ?? "run error"));
          } else {
            resolve();
          }
        }
      });
    });

    await controller.start("fork me");
    await done;

    const sourceId = controller.getSessionId();
    const result = await controller.forkSession(sourceId);
    expect(result).not.toBeNull();
    expect(result!.forkedSessionId).toBeTruthy();
    expect(result!.forkedSessionId).not.toBe(sourceId);

    controller.shutdown();
  }, 30_000);
});
