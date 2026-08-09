import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

    const done = waitForTerminal(store);

    await controller.start("fork me");
    await done;

    const sourceId = controller.getSessionId();
    const result = await controller.forkSession(sourceId);
    expect(result).not.toBeNull();
    expect(result!.forkedSessionId).toBeTruthy();
    expect(result!.forkedSessionId).not.toBe(sourceId);
    expect(result!.copiedRunCount).toBeGreaterThan(0);

    expect(await controller.switchSession(result!.forkedSessionId)).toBe(true);
    expect(store.getSnapshot().events.length).toBeGreaterThan(0);

    const followUpDone = waitForTerminal(store);
    await controller.start("continue from fork");
    await followUpDone;
    const transcript = await readFile(
      join(
        workspace,
        ".sparkwright",
        "sessions",
        result!.forkedSessionId,
        "transcript.jsonl",
      ),
      "utf8",
    );
    expect(transcript).toContain("fork me");

    controller.shutdown();
    await rm(workspace, { recursive: true, force: true });
  }, 30_000);
});

function waitForTerminal(store: EventStore): Promise<void> {
  return new Promise((resolve, reject) => {
    const unsub = store.subscribe(() => {
      const snapshot = store.getSnapshot();
      if (snapshot.status !== "done" && snapshot.status !== "error") return;
      unsub();
      if (snapshot.status === "error") {
        reject(new Error(snapshot.lastError ?? "run error"));
      } else {
        resolve();
      }
    });
  });
}
