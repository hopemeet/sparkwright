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
import { SESSION_COMPACT_SCHEMA_VERSION } from "@sparkwright/core";
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

async function waitForApproval(store: EventStore): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const current = store.getSnapshot();
    if (current.pendingApproval) {
      resolve();
      return;
    }
    if (current.status === "error") {
      reject(new Error(current.lastError ?? "unknown error"));
      return;
    }
    const unsub = store.subscribe(() => {
      const s = store.getSnapshot();
      if (s.pendingApproval) {
        unsub();
        resolve();
      } else if (s.status === "error") {
        unsub();
        reject(new Error(s.lastError ?? "unknown error"));
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

  it("compacts the current session through the host", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-"));
    await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: workspace,
      modelName: "deterministic",
      store,
    });

    await controller.start(
      [
        "compact smoke for packages/tui/src/app.tsx.",
        "Must preserve skippedReason warnings and do not hide compaction failures.",
        "Wrote packages/tui/src/state/run-controller.ts after validation.",
        "Repeat realistic session context ".repeat(120),
      ].join("\n"),
    );
    await waitForDone(store);
    const result = await controller.compactSession();

    expect(result).toMatchObject({
      compactedRunCount: 1,
      throughRunId: expect.any(String),
    });
    expect(result?.freedChars).toBeGreaterThan(0);
    expect(result?.skippedReason).toBeUndefined();
    const events = store.getSnapshot().events;
    expect(events[events.length - 1]).toMatchObject({
      type: "tui.notice",
      payload: { text: expect.stringContaining("compacted 1 prior turn") },
    });
    const artifact = JSON.parse(
      await readFile(
        join(
          workspace,
          ".sparkwright",
          "sessions",
          controller.getSessionId(),
          "compact.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(artifact).toMatchObject({
      schemaVersion: SESSION_COMPACT_SCHEMA_VERSION,
      compactedRunCount: 1,
      freedChars: result?.freedChars,
    });
    const diagnostics = await controller.inspectSession(
      controller.getSessionId(),
    );
    expect(diagnostics?.compaction).toMatchObject({
      status: "compacted",
      artifact: {
        throughRunId: result?.throughRunId,
        compactedRunCount: 1,
        freedChars: result?.freedChars,
      },
      latestEvent: {
        type: "session.compaction.completed",
        throughRunId: result?.throughRunId,
      },
      consistency: {
        ok: true,
        artifactMatchesLatestCompletedEvent: true,
      },
    });
    expect(JSON.stringify(diagnostics?.compaction)).not.toContain(
      "Session deterministic-summary preview.",
    );
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

  it("inspects capabilities with the explicit model selection", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-"));
    await mkdir(join(workspace, ".sparkwright"), { recursive: true });
    await writeFile(
      join(workspace, ".sparkwright", "config.json"),
      JSON.stringify({
        model: "openai/gpt-5.4-nano",
        providers: {
          openai: {},
        },
      }),
      "utf8",
    );
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: workspace,
      modelName: "openai/gpt-5.4-mini",
      modelNameSource: "request",
      store,
    });

    const snapshot = await controller.inspectCapabilities();

    expect(snapshot?.model?.modelRef).toBe("openai/gpt-5.4-mini");
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

  it("replays an existing session trace when switching sessions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-"));
    const sessionRoot = await mkdtemp(
      join(tmpdir(), "sparkwright-tui-sessions-"),
    );
    const sessionId = "session_existing";
    await mkdir(join(sessionRoot, sessionId), { recursive: true });
    await writeFile(
      join(sessionRoot, sessionId, "trace.jsonl"),
      [
        JSON.stringify({
          id: "evt_1",
          runId: "run_1",
          type: "run.started",
          sequence: 1,
          payload: { goal: "review existing proposal" },
        }),
        JSON.stringify({
          id: "evt_2",
          runId: "run_1",
          type: "model.stream.chunk",
          sequence: 2,
          payload: { text: "stream-only" },
        }),
        JSON.stringify({
          id: "evt_3",
          runId: "run_1",
          type: "run.completed",
          sequence: 3,
          payload: { stopReason: "final_answer" },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: workspace,
      sessionRootDir: sessionRoot,
      modelName: "deterministic",
      store,
    });

    await controller.switchSession(sessionId);

    expect(controller.getSessionId()).toBe(sessionId);
    expect(store.getSnapshot().events.map((event) => event.type)).toEqual([
      "tui.user",
      "run.started",
      "run.completed",
    ]);
    expect(controller.getLastGoal()).toBe("review existing proposal");

    controller.shutdown();
  });

  it("surfaces skill load failures from the host event stream", async () => {
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
    await waitForDone(store);

    const snap = store.getSnapshot();
    expect(snap.lastError).toBeNull();
    const eventTypes = snap.events
      .map((event) => event.type)
      .filter((type) => type !== "tui.user");
    expect(eventTypes).toContain("skill.failed");
    expect(eventTypes).toContain("run.completed");
    expect(eventTypes).not.toContain("capability.index.failed");
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
    expect(trace).toContain('"type":"skill.failed"');

    controller.shutdown();
  }, 30_000);

  it("writes a trace when host startup fails before run events stream", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-"));
    await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
    await mkdir(join(workspace, ".sparkwright"), { recursive: true });
    await writeFile(
      join(workspace, ".sparkwright", "config.json"),
      JSON.stringify({
        model: "openai/gpt-test",
        providers: { openai: {} },
      }),
      "utf8",
    );
    const sessionRoot = await mkdtemp(
      join(tmpdir(), "sparkwright-tui-sessions-"),
    );
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: workspace,
      sessionRootDir: sessionRoot,
      modelName: "openai/gpt-test",
      modelNameSource: "config",
      store,
    });

    await controller.start("provider failure smoke");
    await waitForError(store);

    const sessionId = controller.getSessionId();
    const trace = await readTrace(join(sessionRoot, sessionId, "trace.jsonl"));
    expect(trace.map((event) => event.type)).toEqual([
      "run.created",
      "run.failed",
    ]);
    expect(
      trace.find((event) => event.type === "run.failed")?.payload,
    ).toMatchObject({
      reason: "host_start_failed",
      code: "HOST_START_FAILED",
      metadata: { source: "tui" },
    });
    expect(store.getSnapshot().events.map((event) => event.type)).toContain(
      "run.failed",
    );

    controller.shutdown();
  }, 30_000);

  it("marks default interactive runs as ask-mode write-enabled", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-"));
    await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: workspace,
      modelName: "deterministic",
      traceLevel: "debug",
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
    expect(runJson.metadata?.permissionMode).toBe("default");
    expect(runJson.metadata?.shouldWrite).toBe(true);
    expect(runJson.metadata).not.toHaveProperty("allowWorkspaceWriteApproval");
    expect(runJson.metadata?.source).toBe("tui");
    expect(runJson.metadata?.traceLevel).toBe("debug");
    expect(runJson.metadata?.workspaceRoot).toBe(workspace);
    expect(runJson.metadata?.capabilitySnapshot).toMatchObject({
      tools: expect.any(Number),
    });

    controller.shutdown();
  }, 30_000);

  it("marks read-only TUI runs as non-write", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-"));
    await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
    const previousScript = process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
    process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = JSON.stringify([
      { message: "done" },
    ]);
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: workspace,
      modelName: "scripted",
      tuiPermissionMode: "read-only",
      store,
    });

    try {
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
      expect(runJson.metadata?.permissionMode).toBe("plan");
      expect(runJson.metadata?.shouldWrite).toBe(false);
      expect(runJson.metadata).not.toHaveProperty(
        "allowWorkspaceWriteApproval",
      );
    } finally {
      controller.shutdown();
      if (previousScript === undefined) {
        delete process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
      } else {
        process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = previousScript;
      }
    }
  }, 30_000);

  it("asks for approval before running write-capable shell in default TUI runs", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-"));
    await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
    const previousScript = process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
    process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = JSON.stringify([
      {
        message: "run a short shell command",
        toolCalls: [
          {
            toolName: "shell",
            arguments: { command: "sleep 0" },
          },
        ],
      },
      { message: "done" },
    ]);
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: workspace,
      modelName: "scripted",
      store,
    });

    try {
      await controller.start("run sleep briefly");
      await waitForApproval(store);

      const pending = store.getSnapshot().pendingApproval;
      expect(pending).toMatchObject({
        action: "tool.execute",
        toolName: "shell",
        toolArgs: { command: "sleep 0" },
        policy: {
          reason: "Allowed by default policy.",
        },
      });

      controller.resolveApproval("approved");
      await waitForDone(store);

      const snap = store.getSnapshot();
      expect(
        snap.events.some((event) => {
          const payload = event.payload as { toolName?: string } | undefined;
          return (
            event.type === "tool.completed" && payload?.toolName === "shell"
          );
        }),
      ).toBe(true);
      expect(
        snap.events.some((event) => {
          const payload = event.payload as
            | { toolName?: string; error?: { code?: string } }
            | undefined;
          return (
            event.type === "tool.failed" &&
            payload?.toolName === "shell" &&
            payload.error?.code === "TOOL_DENIED"
          );
        }),
      ).toBe(false);
    } finally {
      controller.shutdown();
      if (previousScript === undefined) {
        delete process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
      } else {
        process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = previousScript;
      }
    }
  }, 30_000);

  it("keeps approval auto-policy fixed for the active run", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-"));
    await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
    const previousScript = process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
    process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = JSON.stringify([
      {
        message: "run a short shell command",
        toolCalls: [
          {
            toolName: "shell",
            arguments: { command: "sleep 0" },
          },
        ],
      },
      { message: "done" },
    ]);
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: workspace,
      modelName: "scripted",
      store,
    });

    try {
      await controller.start("run sleep briefly");
      controller.updateTuiPermissionMode("bypass");
      await waitForApproval(store);

      expect(store.getSnapshot().pendingApproval).toMatchObject({
        action: "tool.execute",
        toolName: "shell",
      });

      controller.resolveApproval("approved");
      await waitForDone(store);
    } finally {
      controller.shutdown();
      if (previousScript === undefined) {
        delete process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
      } else {
        process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = previousScript;
      }
    }
  }, 30_000);

  it("auto-resolves approval prompts in bypass mode without standalone approval defaults", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-"));
    await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
    const previousScript = process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
    process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = JSON.stringify([
      {
        message: "run a short shell command",
        toolCalls: [
          {
            toolName: "shell",
            arguments: { command: "sleep 0" },
          },
        ],
      },
      { message: "done" },
    ]);
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: workspace,
      modelName: "scripted",
      tuiPermissionMode: "bypass",
      store,
    });

    try {
      await controller.start("run sleep without prompts");
      await waitForDone(store);

      const snap = store.getSnapshot();
      expect(snap.pendingApproval).toBeNull();
      expect(
        snap.events.some((event) => event.type === "approval.requested"),
      ).toBe(true);
      expect(
        snap.events.some((event) => {
          const payload = event.payload as
            | { decision?: string; autoApproved?: boolean }
            | undefined;
          return (
            event.type === "approval.resolved" &&
            payload?.decision === "approved" &&
            payload.autoApproved === true
          );
        }),
      ).toBe(true);
    } finally {
      controller.shutdown();
      if (previousScript === undefined) {
        delete process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
      } else {
        process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = previousScript;
      }
    }
  }, 30_000);

  it("does not auto-resolve workspace write prompts in ask mode", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-"));
    await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
    const previousScript = process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
    process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = JSON.stringify([
      {
        message: "patch readme",
        toolCalls: [
          {
            toolName: "apply_patch",
            arguments: {
              path: "README.md",
              patch:
                "--- README.md\n+++ README.md\n@@\n-# Demo\n+# Demo patched\n",
              reason: "test auto approval",
            },
          },
        ],
      },
      { message: "done" },
    ]);
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: workspace,
      modelName: "scripted",
      store,
    });

    try {
      await controller.start("patch the readme");
      await waitForApproval(store);

      const pending = store.getSnapshot().pendingApproval;
      expect(pending).toMatchObject({
        action: "workspace.write",
        path: "README.md",
      });

      controller.resolveApproval("approved");
      await waitForDone(store);

      const snap = store.getSnapshot();
      expect(snap.pendingApproval).toBeNull();
      const approvalResolved = snap.events.find(
        (event) => event.type === "approval.resolved",
      );
      expect(approvalResolved?.payload).toMatchObject({
        decision: "approved",
      });
      expect(
        snap.events.some(
          (event) =>
            event.type === "tool.completed" &&
            typeof event.payload === "object" &&
            event.payload !== null &&
            "toolName" in event.payload &&
            event.payload.toolName === "apply_patch",
        ),
      ).toBe(true);
      await expect(
        readFile(join(workspace, "README.md"), "utf8"),
      ).resolves.toBe("# Demo patched\n");
    } finally {
      controller.shutdown();
      if (previousScript === undefined) {
        delete process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
      } else {
        process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = previousScript;
      }
    }
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
