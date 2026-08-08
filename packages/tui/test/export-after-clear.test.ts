import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventStore } from "../src/state/event-store.js";
import { RunController } from "../src/state/run-controller.js";

describe("transcript export vs visible document epoch", () => {
  it("keeps the session export buffer after /clear resets the viewport", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "spark-export-clear-"));
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: workspace,
      modelName: "deterministic",
      store,
    });
    const done = new Promise<void>((resolve, reject) => {
      const unsubscribe = store.subscribe(() => {
        const state = store.getSnapshot();
        if (state.status !== "done" && state.status !== "error") return;
        unsubscribe();
        if (state.status === "error") {
          reject(new Error(state.lastError ?? "run failed"));
        } else {
          resolve();
        }
      });
    });

    await controller.start("preserve this exported goal");
    await done;
    const before = store.getSnapshot().clearGeneration;
    store.clearEvents();
    expect(store.getSnapshot().events).toEqual([]);
    expect(store.getSnapshot().clearGeneration).toBe(before + 1);

    const path = await controller.exportTranscript();
    const markdown = await readFile(path, "utf8");
    expect(markdown).toContain("preserve this exported goal");
    controller.shutdown();
  }, 30_000);
});
