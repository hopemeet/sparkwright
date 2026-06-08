import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/state/event-store.js";
import { RunController } from "../src/state/run-controller.js";

/**
 * End-to-end smoke for the SDK cutover: a RunController spawns a real
 * host child via @sparkwright/sdk-node, runs a deterministic goal, and
 * the EventStore observes a terminal state through the protocol.
 *
 * This test is the architecture guarantee — it would fail to compile if
 * the TUI accidentally re-introduced @sparkwright/core as a dependency.
 */
describe("TUI ↔ host via sdk-node", () => {
  it("rejects unsafe session ids before using them in trace paths", () => {
    const store = new EventStore();
    expect(
      () =>
        new RunController({
          workspaceRoot: process.cwd(),
          modelName: "deterministic",
          store,
          initialSessionId: "../escape",
        }),
    ).toThrow(/safe path segment/);
  });

  it("runs a deterministic goal through the host", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-"));
    await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
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
            reject(new Error(s.lastError ?? "unknown error"));
          } else {
            resolve();
          }
        }
      });
    });

    await controller.start("smoke through sdk");
    await done;

    const snap = store.getSnapshot();
    expect(snap.status).toBe("done");
    expect(snap.events.length).toBeGreaterThan(0);
    controller.shutdown();
  }, 30_000);

  it("marks default interactive runs as write-enabled for host approvals", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-"));
    await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
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
            reject(new Error(s.lastError ?? "unknown error"));
          } else {
            resolve();
          }
        }
      });
    });

    await controller.start("metadata smoke");
    await done;

    const runsDir = join(
      workspace,
      ".sparkwright",
      "sessions",
      controller.getSessionId(),
      "agents",
      "main",
      "runs",
    );
    const runIds = await readdir(runsDir);
    const runJson = JSON.parse(
      await readFile(join(runsDir, runIds[0]!, "run.json"), "utf8"),
    ) as { metadata?: Record<string, unknown> };
    expect(runJson.metadata?.shouldWrite).toBe(true);

    controller.shutdown();
  }, 30_000);
});
