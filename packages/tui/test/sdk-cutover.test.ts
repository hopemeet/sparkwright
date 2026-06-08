import { describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/state/event-store.js";
import { RunController } from "../src/state/run-controller.js";

async function waitForDone(store: EventStore): Promise<void> {
  await new Promise<void>((resolve, reject) => {
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
}

async function waitForError(store: EventStore): Promise<void> {
  await new Promise<void>((resolve) => {
    const current = store.getSnapshot();
    if (current.status === "error") {
      resolve();
      return;
    }
    const unsub = store.subscribe(() => {
      if (store.getSnapshot().status === "error") {
        unsub();
        resolve();
      }
    });
  });
}

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

    await controller.start("smoke through sdk");
    await waitForDone(store);

    const snap = store.getSnapshot();
    expect(snap.status).toBe("done");
    expect(snap.events.length).toBeGreaterThan(0);
    controller.shutdown();
  }, 30_000);

  it("does not pass config-sourced model as a request override", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-"));
    await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
    await mkdir(join(workspace, ".sparkwright"), { recursive: true });
    await writeFile(
      join(workspace, ".sparkwright", "config.json"),
      JSON.stringify({ model: "deterministic" }),
      "utf8",
    );
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: workspace,
      modelName: "deterministic",
      modelNameSource: "config",
      store,
    });

    await controller.start("config model smoke");
    await waitForDone(store);

    const events = await readTrace(
      join(
        workspace,
        ".sparkwright",
        "sessions",
        controller.getSessionId(),
        "trace.jsonl",
      ),
    );
    expect(
      events.find((event) => event.type === "run.started")?.payload,
    ).toMatchObject({
      resolvedModel: {
        adapterId: "deterministic",
        modelSource: { layer: "project" },
      },
    });

    controller.shutdown();
  }, 30_000);

  it("passes explicit model selection as a request override", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-"));
    await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: workspace,
      modelName: "deterministic",
      modelNameSource: "request",
      store,
    });

    await controller.start("request model smoke");
    await waitForDone(store);

    const events = await readTrace(
      join(
        workspace,
        ".sparkwright",
        "sessions",
        controller.getSessionId(),
        "trace.jsonl",
      ),
    );
    expect(
      events.find((event) => event.type === "run.started")?.payload,
    ).toMatchObject({
      resolvedModel: {
        adapterId: "deterministic",
        modelSource: { layer: "request" },
      },
    });

    controller.shutdown();
  }, 30_000);

  it("passes a custom session root through to the spawned host", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-"));
    const sessionRoot = await mkdtemp(
      join(tmpdir(), "sparkwright-tui-sessions-"),
    );
    await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: workspace,
      sessionRootDir: sessionRoot,
      modelName: "deterministic",
      store,
    });

    await controller.start("session root smoke");
    await waitForDone(store);

    const sessionId = controller.getSessionId();
    expect(controller.getSessionRootDir()).toBe(sessionRoot);
    await expect(
      readFile(join(sessionRoot, sessionId, "trace.jsonl"), "utf8"),
    ).resolves.toContain("run.completed");
    await expect(
      stat(join(workspace, ".sparkwright", "sessions")),
    ).rejects.toThrow();

    controller.shutdown();
  }, 30_000);

  it("surfaces skill index failures from the host event stream", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-"));
    await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
    await mkdir(join(workspace, ".sparkwright", "skills", "bad"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, ".sparkwright", "skills", "bad", "SKILL.md"),
      ["---", "name: bad", "---", "Missing description.", ""].join("\n"),
      "utf8",
    );
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: workspace,
      modelName: "deterministic",
      store,
    });

    await controller.start("skill failure smoke");
    await waitForError(store);

    const snap = store.getSnapshot();
    expect(snap.lastError).toContain("Skill description");
    expect(
      snap.events
        .map((event) => event.type)
        .filter((type) => type !== "tui.user"),
    ).toEqual(["run.created", "capability.index.failed", "run.failed"]);
    const trace = await readFile(
      join(
        workspace,
        ".sparkwright",
        "sessions",
        controller.getSessionId(),
        "trace.jsonl",
      ),
      "utf8",
    );
    expect(trace).toContain('"type":"capability.index.failed"');

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

    await controller.start("metadata smoke");
    await waitForDone(store);

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

async function readTrace(path: string): Promise<
  Array<{
    type: string;
    payload?: unknown;
  }>
> {
  const raw = await readFile(path, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; payload?: unknown });
}
