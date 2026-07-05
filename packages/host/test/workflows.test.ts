import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileWorkflowStore,
  type WorkflowDefinition,
  type WorkflowRunId,
  type WorkflowRunRecord,
} from "@sparkwright/agent-runtime";
import {
  loadLayeredWorkflowAssets,
  parseWorkflowMarkdownAsset,
} from "../src/workflows.js";
import { HostRuntime } from "../src/runtime.js";
import type { HostEvent } from "@sparkwright/protocol";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sparkwright-workflows-"));
}

async function writeWorkflow(
  root: string,
  name: string,
  workflow: string,
  config?: string,
): Promise<void> {
  const dir = join(root, ".sparkwright", "workflows", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "workflow.md"), workflow, "utf8");
  if (config) await writeFile(join(dir, "config.yaml"), config, "utf8");
}

async function waitForHostEvent(
  events: HostEvent[],
  predicate: (event: HostEvent) => boolean,
): Promise<HostEvent> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const found = events.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for host event.");
}

function runEventPayload(
  event: HostEvent,
): { type?: string; payload?: unknown } | undefined {
  if (event.kind !== "run.event") return undefined;
  const payload = event.payload as { event?: unknown };
  if (!payload.event || typeof payload.event !== "object") return undefined;
  const runEvent = payload.event as { type?: unknown; payload?: unknown };
  return {
    ...(typeof runEvent.type === "string" ? { type: runEvent.type } : {}),
    ...(runEvent.payload !== undefined ? { payload: runEvent.payload } : {}),
  };
}

function toolRunEventPayload(
  event: { type?: string; payload?: unknown } | undefined,
  type: string,
  toolName: string,
): Record<string, unknown> | undefined {
  if (event?.type !== type || !isRecord(event.payload)) return undefined;
  return event.payload.toolName === toolName ? event.payload : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workflowStoreRoot(workspace: string, sessionId: string): string {
  return join(
    workspace,
    ".sparkwright",
    "sessions",
    sessionId,
    "workflow-runs",
  );
}

async function waitForWorkflowRecord(
  rootDir: string,
): Promise<WorkflowRunRecord> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const records = new FileWorkflowStore({
      rootDir,
      createRoot: false,
    }).list().records;
    if (records[0]) return records[0];
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for workflow record.");
}

describe("workflow assets", () => {
  it("parses workflow folder assets on the shared markdown-folder primitive", async () => {
    const workspace = await tempWorkspace();
    await writeWorkflow(
      workspace,
      "bugfix",
      [
        "---",
        "version: 1.2.3",
        "description: Fix a bug with evidence.",
        "nodes:",
        "  - id: reproduce",
        "    title: Reproduce",
        "    model: cheap",
        "    runBudget:",
        "      maxModelCalls: 2",
        "  - id: patch",
        "    execute: model",
        "---",
        "## reproduce",
        "Run the failing command.",
        "",
        "## patch",
        "Patch the code.",
      ].join("\n"),
      ["modelTiers:", "  cheap: deterministic"].join("\n"),
    );

    const report = await loadLayeredWorkflowAssets(workspace, {
      XDG_CONFIG_HOME: join(workspace, "xdg"),
    });

    expect(report.errors).toEqual([]);
    expect(report.assets).toHaveLength(1);
    expect(report.assets[0]).toMatchObject({
      assetName: "bugfix",
      layer: "project",
      version: "1.2.3",
      description: "Fix a bug with evidence.",
      nodeCount: 2,
    });
    expect(report.assets[0]?.definition.nodes).toEqual([
      {
        id: "reproduce",
        title: "Reproduce",
        execute: "model",
        model: "cheap",
        runBudget: { maxModelCalls: 2 },
        body: "Run the failing command.",
      },
      {
        id: "patch",
        execute: "model",
        body: "Patch the code.",
      },
    ]);
    expect(report.assets[0]?.definition.config).toEqual({
      modelTiers: { cheap: "deterministic" },
    });
  });

  it("parses human nodes and still rejects ask_user", () => {
    const detail = parseWorkflowMarkdownAsset({
      assetName: "wait-for-human",
      dir: "/tmp/wait-for-human",
      sourcePath: "/tmp/wait-for-human/workflow.md",
      raw: [
        "---",
        "nodes:",
        "  - id: wait",
        "    execute: human",
        "    human:",
        "      prompt: Confirm the deployment.",
        "      wait:",
        "        kind: input",
        "        reason: Need deployment approval.",
        "---",
        "## wait",
        "Ask later.",
      ].join("\n"),
    });

    expect(detail.definition.nodes[0]).toMatchObject({
      id: "wait",
      execute: "human",
      human: {
        prompt: "Confirm the deployment.",
        wait: { kind: "input", reason: "Need deployment approval." },
      },
    });

    expect(() =>
      parseWorkflowMarkdownAsset({
        assetName: "ask-user",
        dir: "/tmp/ask-user",
        sourcePath: "/tmp/ask-user/workflow.md",
        raw: [
          "---",
          "nodes:",
          "  - id: wait",
          "    execute: ask_user",
          "---",
          "## wait",
          "Ask later.",
        ].join("\n"),
      }),
    ).toThrow(/reserved for a later phase/);
  });

  it("parses P1 verifier and transition fields", () => {
    const detail = parseWorkflowMarkdownAsset({
      assetName: "bugfix",
      dir: "/tmp/bugfix",
      sourcePath: "/tmp/bugfix/workflow.md",
      raw: [
        "---",
        "nodes:",
        "  - id: reproduce",
        "    execute: model",
        "    tools: [read_file, shell]",
        "    verify:",
        "      - id: failing-test",
        "        kind: command",
        "        command: node",
        "        args: [--version]",
        "        expect: zero",
        "        authorized: true",
        "    onPass: patch",
        "    onFail: { retry: 2, then: fail }",
        "  - id: patch",
        "    execute: model",
        "---",
        "## reproduce",
        "Reproduce.",
        "",
        "## patch",
        "Patch.",
      ].join("\n"),
    });

    expect(detail.definition.nodes[0]).toMatchObject({
      id: "reproduce",
      tools: ["read_file", "shell"],
      verify: [
        {
          id: "failing-test",
          kind: "command",
          command: "node",
          args: ["--version"],
          expect: "zero",
          authorized: true,
        },
      ],
      onPass: "patch",
      onFail: { retry: 2, then: "fail" },
    });
  });

  it("parses P3 non-model nodes and diff_scope verifiers", () => {
    const detail = parseWorkflowMarkdownAsset({
      assetName: "p3-nodes",
      dir: "/tmp/p3-nodes",
      sourcePath: "/tmp/p3-nodes/workflow.md",
      raw: [
        "---",
        "nodes:",
        "  - id: command-check",
        "    execute: command",
        "    command: node",
        "    args: [--version]",
        "    authorization: trusted",
        "    onPass: delegate-review",
        "    verify:",
        "      - kind: diff_scope",
        "        include: ['src/**']",
        "        exclude: ['src/generated/**']",
        "  - id: delegate-review",
        "    execute: delegate",
        "    agentId: reviewer",
        "    goal: Review the patch.",
        "    onPass: task-followup",
        "  - id: task-followup",
        "    execute: task",
        "    kind: agent",
        "    mode: awaited",
        "    payload:",
        "      goal: Check docs.",
        "    onPass: human-review",
        "  - id: human-review",
        "    execute: human",
        "    prompt: Confirm the release.",
        "    wait:",
        "      kind: input",
        "      reason: Need release confirmation.",
        "---",
        "## command-check",
        "Run the command.",
      ].join("\n"),
    });

    expect(detail.definition.nodes).toEqual([
      expect.objectContaining({
        id: "command-check",
        execute: "command",
        command: {
          command: "node",
          args: ["--version"],
          authorized: true,
        },
        verify: [
          {
            id: "command-check:diff_scope:1",
            kind: "diff_scope",
            include: ["src/**"],
            exclude: ["src/generated/**"],
          },
        ],
      }),
      expect.objectContaining({
        id: "delegate-review",
        execute: "delegate",
        delegate: {
          agentId: "reviewer",
          goal: "Review the patch.",
        },
      }),
      expect.objectContaining({
        id: "task-followup",
        execute: "task",
        task: {
          kind: "agent",
          mode: "awaited",
          payload: { goal: "Check docs." },
        },
      }),
      expect.objectContaining({
        id: "human-review",
        execute: "human",
        human: {
          prompt: "Confirm the release.",
          wait: {
            kind: "input",
            reason: "Need release confirmation.",
          },
        },
      }),
    ]);
  });

  it("keeps stronger workflow layers and records shadows", async () => {
    const workspace = await tempWorkspace();
    const xdg = join(workspace, "xdg");
    await writeWorkflow(
      workspace,
      "release",
      ["---", "version: project", "---", "Project"].join("\n"),
    );
    const userDir = join(xdg, "sparkwright", "workflows", "release");
    await mkdir(userDir, { recursive: true });
    await writeFile(
      join(userDir, "workflow.md"),
      ["---", "version: user", "---", "User"].join("\n"),
      "utf8",
    );

    const report = await loadLayeredWorkflowAssets(workspace, {
      XDG_CONFIG_HOME: xdg,
    });

    expect(report.assets[0]).toMatchObject({
      assetName: "release",
      layer: "project",
      version: "project",
    });
    expect(report.shadows).toEqual([
      expect.objectContaining({ assetName: "release" }),
    ]);
  });

  it("exposes workflow assets through capability snapshots", async () => {
    const workspace = await tempWorkspace();
    await writeWorkflow(
      workspace,
      "inspectable",
      ["---", "version: 0.1", "nodes: [main]", "---", "Main"].join("\n"),
    );
    const runtime = new HostRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      emit: () => {},
    });

    const inspected = await runtime.inspectCapabilities();

    expect(inspected).toMatchObject({ ok: true });
    if (!inspected.ok) throw new Error(inspected.error.message);
    expect(inspected.snapshot.workflows?.assets).toEqual([
      expect.objectContaining({
        assetName: "inspectable",
        version: "0.1",
        nodeCount: 1,
      }),
    ]);
  });

  it("instantiates workflow runs without an experimental release gate", async () => {
    const workspace = await tempWorkspace();
    await writeWorkflow(
      workspace,
      "gated",
      [
        "---",
        "nodes:",
        "  - id: main",
        "    execute: model",
        "---",
        "## main",
        "Run only when enabled.",
      ].join("\n"),
    );
    const runtime = new HostRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      emit: () => {},
    });

    const started = await runtime.startRun({
      goal: "try gated workflow",
      workflow: "gated",
    });

    expect(started).toMatchObject({ ok: true });
    if (!started.ok) throw new Error(started.error.message);
    runtime.cancelRun(started.runId, "test cleanup");
  });

  it("persists workflow run records under the session root", async () => {
    const workspace = await tempWorkspace();
    const sessionId = "sess_workflow_p2";
    await writeWorkflow(
      workspace,
      "durable",
      ["---", "nodes: [main]", "---", "Main durable workflow."].join("\n"),
    );
    const events: HostEvent[] = [];
    const runtime = new HostRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      emit: (event) => events.push(event),
    });

    const started = await runtime.startRun({
      goal: "run durable workflow",
      sessionId,
      workflow: "durable",
    });

    expect(started).toMatchObject({ ok: true });
    const terminal = await waitForHostEvent(
      events,
      (event) => event.kind === "run.completed",
    );
    expect(terminal.kind).toBe("run.completed");
    const workflowStarted = events.find(
      (event) => runEventPayload(event)?.type === "workflow.started",
    );
    if (!workflowStarted || workflowStarted.kind !== "run.event") {
      throw new Error("Expected workflow.started event.");
    }
    const workflowPayload = runEventPayload(workflowStarted)?.payload;
    const workflowRunId =
      workflowPayload &&
      typeof workflowPayload === "object" &&
      "workflowRunId" in workflowPayload &&
      typeof workflowPayload.workflowRunId === "string"
        ? (workflowPayload.workflowRunId as WorkflowRunId)
        : undefined;
    if (!workflowRunId) throw new Error("Expected workflowRunId.");
    const store = new FileWorkflowStore({
      rootDir: workflowStoreRoot(workspace, sessionId),
      createRoot: false,
    });
    const record = store.get(workflowRunId);

    expect(record).toMatchObject({
      id: workflowRunId,
      status: "completed",
      assetName: "durable",
      sessionId,
      metadata: {
        episodeDriver: "workflow_actor",
        episodeKind: "run_start",
      },
      definitionSnapshot: {
        assetName: "durable",
        nodes: [expect.objectContaining({ id: "main" })],
      },
    });
    expect(record?.runIds).toContain(started.ok ? started.runId : "");
    expect(record?.evidenceRefs).toContainEqual({
      kind: "run",
      ref: started.ok ? started.runId : "",
    });
    const notifications = await runtime
      .workflowActorInbox()
      .drain((notification) => notification.source.kind === "workflow");
    expect(notifications).toEqual([
      expect.objectContaining({
        type: "completed",
        payload: expect.objectContaining({
          workflowId: workflowRunId,
          name: "durable",
        }),
      }),
    ]);
  });

  it("narrows model worker catalogs to the active workflow node tools", async () => {
    const workspace = await tempWorkspace();
    const sessionId = "sess_workflow_catalog";
    await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
    await writeWorkflow(
      workspace,
      "catalog",
      [
        "---",
        "nodes:",
        "  - id: main",
        "    execute: model",
        "    tools: [read_file]",
        "---",
        "## main",
        "Only read tools are available.",
      ].join("\n"),
    );
    const previousScript = process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
    process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = JSON.stringify([
      {
        toolCalls: [
          {
            toolName: "read",
            arguments: { path: "README.md" },
          },
        ],
      },
      {
        toolCalls: [
          {
            toolName: "write",
            arguments: { path: "README.md", content: "should not write" },
          },
        ],
      },
      { message: "done" },
    ]);
    const events: HostEvent[] = [];
    const runtime = new HostRuntime({
      workspaceRoot: workspace,
      defaultModel: "scripted",
      emit: (event) => events.push(event),
    });

    try {
      const started = await runtime.startRun({
        goal: "run catalog workflow",
        sessionId,
        workflow: "catalog",
      });

      expect(started).toMatchObject({ ok: true });
      await waitForHostEvent(events, (event) => event.kind === "run.completed");
      const readResult = events
        .map(runEventPayload)
        .map((event) => toolRunEventPayload(event, "tool.completed", "read"))
        .find((payload) => payload !== undefined);
      expect(readResult).toMatchObject({ toolName: "read" });
      const toolFailure = events
        .map(runEventPayload)
        .map((event) => toolRunEventPayload(event, "tool.failed", "write"))
        .find((payload) => payload !== undefined);
      expect(toolFailure).toMatchObject({
        toolName: "write",
        error: { code: "TOOL_NOT_FOUND" },
      });
      expect(toolFailure).not.toMatchObject({
        error: { code: "TOOL_BLOCKED_BY_WORKFLOW_HOOK" },
      });
      const record = await waitForWorkflowRecord(
        workflowStoreRoot(workspace, sessionId),
      );
      expect(record).toMatchObject({
        status: "completed",
        metadata: {
          episodeDriver: "workflow_actor",
          episodeKind: "run_start",
          episodeAllowedTools: ["read"],
        },
      });
      await expect(
        readFile(join(workspace, "README.md"), "utf8"),
      ).resolves.toBe("# Demo\n");
    } finally {
      if (previousScript === undefined) {
        delete process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
      } else {
        process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = previousScript;
      }
    }
  });

  it("keeps scoped tool_search when a workflow node allows deferred tools", async () => {
    const workspace = await tempWorkspace();
    const sessionId = "sess_workflow_deferred_catalog";
    await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
    await writeWorkflow(
      workspace,
      "deferred-catalog",
      [
        "---",
        "nodes:",
        "  - id: main",
        "    execute: model",
        "    tools: [read_anchored_text]",
        "---",
        "## main",
        "Use anchored reads only.",
      ].join("\n"),
    );
    const previousScript = process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
    process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = JSON.stringify([
      {
        toolCalls: [
          {
            toolName: "tool_search",
            arguments: { query: "select:read_anchored_text,write" },
          },
        ],
      },
      { message: "done" },
    ]);
    const events: HostEvent[] = [];
    const runtime = new HostRuntime({
      workspaceRoot: workspace,
      defaultModel: "scripted",
      emit: (event) => events.push(event),
    });

    try {
      const started = await runtime.startRun({
        goal: "run deferred catalog workflow",
        sessionId,
        workflow: "deferred-catalog",
      });

      expect(started).toMatchObject({ ok: true });
      await waitForHostEvent(events, (event) => event.kind === "run.completed");
      const toolFailures = events
        .map(runEventPayload)
        .filter((event) => event?.type === "tool.failed");
      expect(toolFailures).toEqual([]);
      const toolSearchResult = events
        .map(runEventPayload)
        .find((event) => event?.type === "tool.completed")?.payload;
      expect(toolSearchResult).toMatchObject({
        toolName: "tool_search",
        output: {
          matches: [
            expect.objectContaining({
              name: "read_anchored_text",
              deferred: true,
            }),
          ],
        },
      });
      expect(
        (
          toolSearchResult as {
            output?: { matches?: Array<{ name?: string }> };
          }
        ).output?.matches?.map((match) => match.name),
      ).toEqual(["read_anchored_text"]);
      const record = await waitForWorkflowRecord(
        workflowStoreRoot(workspace, sessionId),
      );
      expect(record).toMatchObject({
        status: "completed",
        metadata: {
          episodeDriver: "workflow_actor",
          episodeKind: "run_start",
          episodeAllowedTools: ["read_anchored_text"],
        },
      });
    } finally {
      if (previousScript === undefined) {
        delete process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
      } else {
        process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = previousScript;
      }
    }
  });

  it("routes workflow actor episodes through node model and budget metadata", async () => {
    const workspace = await tempWorkspace();
    await writeWorkflow(
      workspace,
      "d6",
      [
        "---",
        "nodes:",
        "  - id: main",
        "    execute: model",
        "    model: cheap",
        "    runBudget:",
        "      maxModelCalls: 1",
        "---",
        "## main",
        "Use the node model.",
      ].join("\n"),
      ["modelTiers:", "  cheap: scripted/d6"].join("\n"),
    );
    const previousScript = process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
    process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = JSON.stringify([
      { message: "node model answered" },
    ]);
    const sessionId = "sess_workflow_d6";
    const events: HostEvent[] = [];
    const runtime = new HostRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      emit: (event) => events.push(event),
    });

    try {
      const started = await runtime.startRun({
        goal: "run d6 workflow",
        sessionId,
        workflow: "d6",
      });

      expect(started).toMatchObject({ ok: true });
      await waitForHostEvent(events, (event) => event.kind === "run.completed");
      const record = await waitForWorkflowRecord(
        workflowStoreRoot(workspace, sessionId),
      );
      expect(record.metadata.workflowEpisode).toMatchObject({
        nodeId: "main",
        attempt: 1,
        modelRef: "scripted/d6",
        runBudget: { maxModelCalls: 1 },
      });
      expect(record.metadata.workflowUsage).toMatchObject({
        episodes: 1,
        modelCalls: 1,
      });
      expect(record.metadata.workflowEpisodeUsage).toEqual([
        expect.objectContaining({
          runId: started.ok ? started.runId : "",
          episode: expect.objectContaining({
            nodeId: "main",
            attempt: 1,
            modelRef: "scripted/d6",
          }),
          usage: expect.objectContaining({
            modelCalls: 1,
          }),
        }),
      ]);
    } finally {
      if (previousScript === undefined) {
        delete process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
      } else {
        process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = previousScript;
      }
    }
  });

  it("emits durable waiting notifications and consumes input waits on workflow resume", async () => {
    const workspace = await tempWorkspace();
    const sessionId = "sess_workflow_human_wait";
    await writeWorkflow(
      workspace,
      "human-gate",
      [
        "---",
        "nodes:",
        "  - id: draft",
        "    execute: model",
        "    onPass: review",
        "  - id: review",
        "    execute: human",
        "    wait:",
        "      kind: input",
        "      reason: Need human review.",
        "    onPass: finish",
        "  - id: finish",
        "    execute: model",
        "---",
        "## draft",
        "Draft the change.",
        "",
        "## finish",
        "Finish after review.",
      ].join("\n"),
    );
    const events: HostEvent[] = [];
    const runtime = new HostRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      emit: (event) => events.push(event),
    });

    const started = await runtime.startRun({
      goal: "run human gated workflow",
      sessionId,
      workflow: "human-gate",
    });

    expect(started).toMatchObject({ ok: true });
    await waitForHostEvent(events, (event) => event.kind === "run.completed");
    const waitingRecord = await waitForWorkflowRecord(
      workflowStoreRoot(workspace, sessionId),
    );
    expect(waitingRecord).toMatchObject({
      status: "waiting",
      currentNodeId: "review",
      wait: { kind: "input", reason: "Need human review." },
    });
    expect(
      await runtime
        .workflowActorInbox()
        .peek(
          (notification) =>
            notification.type === "waiting" &&
            notification.source.id === waitingRecord.id,
        ),
    ).toMatchObject([
      {
        type: "waiting",
        qos: "reliable",
        payload: {
          workflowId: waitingRecord.id,
          wait: { kind: "input", reason: "Need human review." },
        },
      },
    ]);
    const listed = await runtime.listWorkflowRuns({
      sessionId,
      status: "waiting",
    });
    expect(listed).toMatchObject({ ok: true });
    if (!listed.ok) throw new Error(listed.error.message);
    expect(listed.workflows).toHaveLength(1);
    expect(listed.workflows[0]).toMatchObject({
      id: waitingRecord.id,
      status: "waiting",
      wait: expect.objectContaining({
        kind: "input",
        reason: "Need human review.",
      }),
    });

    events.length = 0;
    const resumed = await runtime.resumeWorkflowRun({
      workflowRunId: waitingRecord.id,
      sessionId,
      metadata: { humanDecision: "approved" },
    });

    expect(resumed).toMatchObject({
      ok: true,
      workflowRunId: waitingRecord.id,
      sessionId,
    });
    await waitForHostEvent(events, (event) => event.kind === "run.completed");
    const store = new FileWorkflowStore({
      rootDir: workflowStoreRoot(workspace, sessionId),
      createRoot: false,
    });
    const completed = store.get(waitingRecord.id);
    expect(completed).toMatchObject({
      status: "completed",
      metadata: {
        episodeDriver: "workflow_actor",
        episodeKind: "workflow_resume",
      },
    });
    expect(completed?.wait).toBeUndefined();
    const inputEvent = store
      .eventLog(waitingRecord.id)
      .events.find((event) => event.type === "input");
    expect(inputEvent).toMatchObject({
      status: "running",
      metadata: expect.objectContaining({
        nodeId: "review",
        resumeMetadata: { humanDecision: "approved" },
        wait: expect.objectContaining({
          kind: "input",
          reason: "Need human review.",
        }),
      }),
    });
  });

  it("holds a workflow lease for fresh run records", async () => {
    const workspace = await tempWorkspace();
    const sessionId = "sess_workflow_fresh_lease";
    await writeFile(join(workspace, "README.md"), "# Lease test\n", "utf8");
    await writeWorkflow(
      workspace,
      "leased",
      [
        "---",
        "nodes:",
        "  - id: main",
        "    verify:",
        "      - id: slow-pass",
        "        kind: command",
        `        command: ${JSON.stringify(process.execPath)}`,
        "        args:",
        "          - -e",
        "          - setTimeout(() => process.exit(0), 1200)",
        "        authorized: true",
        "---",
        "## main",
        "Hold the workflow lease while this verifier is still running.",
      ].join("\n"),
    );
    const events: HostEvent[] = [];
    const runtime = new HostRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      emit: (event) => events.push(event),
    });

    const started = await runtime.startRun({
      goal: "run leased workflow",
      sessionId,
      workflow: "leased",
    });

    expect(started).toMatchObject({ ok: true });
    const record = await waitForWorkflowRecord(
      workflowStoreRoot(workspace, sessionId),
    );
    const store = new FileWorkflowStore({
      rootDir: workflowStoreRoot(workspace, sessionId),
      createRoot: false,
    });
    const competingLease = await store.acquireLease(record.id, {
      owner: "test-adopter",
      ttlMs: 60_000,
    });
    expect(competingLease).toBeNull();

    const competingRuntime = new HostRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      emit: () => {},
    });
    const resumed = await competingRuntime.resumeWorkflowRun({
      workflowRunId: record.id,
      sessionId,
    });
    expect(resumed).toMatchObject({
      ok: false,
      error: {
        code: "invalid_payload",
        message: expect.stringContaining("already adopted"),
      },
    });
    await waitForHostEvent(events, (event) => event.kind === "run.completed");
  });

  it("fails workflow records when the actor episode chain rejects", async () => {
    const workspace = await tempWorkspace();
    const sessionId = "sess_workflow_supervisor_reject";
    await writeWorkflow(
      workspace,
      "rejecting",
      ["---", "nodes: [main]", "---", "Main workflow."].join("\n"),
    );
    const events: HostEvent[] = [];
    let brokeStream = false;
    const runtime = new HostRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      emit: (event) => {
        events.push(event);
        if (
          !brokeStream &&
          event.kind === "run.event" &&
          runEventPayload(event)?.type === "run.started"
        ) {
          brokeStream = true;
          throw new Error("client stream failed");
        }
      },
    });

    const started = await runtime.startRun({
      goal: "run rejecting workflow",
      sessionId,
      workflow: "rejecting",
    });

    expect(started).toMatchObject({ ok: true });
    await waitForHostEvent(events, (event) => event.kind === "run.failed");
    const store = new FileWorkflowStore({
      rootDir: workflowStoreRoot(workspace, sessionId),
      createRoot: false,
    });
    const record = store.list().records[0];
    expect(record).toMatchObject({
      status: "failed",
      failure: {
        kind: "runtime",
        code: "workflow.runtime",
        message: expect.stringContaining("client stream failed"),
      },
      metadata: { finalizedFromSupervisorError: true },
    });
    if (!record) throw new Error("Expected workflow record.");
    const notifications = await runtime
      .workflowActorInbox()
      .drain((notification) => notification.source.kind === "workflow");
    expect(notifications).toEqual([
      expect.objectContaining({
        type: "failed",
        payload: expect.objectContaining({
          workflowId: record.id,
          error: expect.objectContaining({ code: "workflow.runtime" }),
        }),
      }),
    ]);
    const releasedLease = await store.acquireLease(record.id, {
      owner: "test-after-failure",
      ttlMs: 60_000,
    });
    expect(releasedLease).not.toBeNull();
    await releasedLease?.release();

    const resumed = await new HostRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      emit: () => {},
    }).resumeWorkflowRun({
      workflowRunId: record.id,
      sessionId,
    });
    expect(resumed).toMatchObject({
      ok: false,
      error: {
        code: "invalid_payload",
        message: expect.stringContaining("already failed"),
      },
    });
  });

  it("resumes workflow records from the pinned definition snapshot", async () => {
    const workspace = await tempWorkspace();
    const sessionId = "sess_workflow_resume";
    const definition: WorkflowDefinition = {
      assetName: "pinned",
      contentHash: "hash-pinned",
      nodes: [{ id: "main", body: "Pinned body." }],
    };
    const store = new FileWorkflowStore({
      rootDir: join(
        workspace,
        ".sparkwright",
        "sessions",
        sessionId,
        "workflow-runs",
      ),
    });
    const workflowRunId = "workflow_resume_pinned" as WorkflowRunId;
    store.create({
      id: workflowRunId,
      sessionId,
      assetName: definition.assetName,
      contentHash: definition.contentHash,
      currentNodeId: "main",
      attempts: { main: 1 },
      definitionSnapshot: definition,
      metadata: { goal: "resume pinned workflow" },
    });
    await writeWorkflow(
      workspace,
      "pinned",
      ["---", "nodes:", "  - id: edited", "---", "Edited live asset."].join(
        "\n",
      ),
    );
    const events: HostEvent[] = [];
    const runtime = new HostRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      emit: (event) => events.push(event),
    });

    const resumed = await runtime.resumeWorkflowRun({
      workflowRunId,
      sessionId,
    });

    expect(resumed).toMatchObject({ ok: true, workflowRunId, sessionId });
    await waitForHostEvent(events, (event) => event.kind === "run.completed");
    const record = new FileWorkflowStore({
      rootDir: workflowStoreRoot(workspace, sessionId),
      createRoot: false,
    }).get(workflowRunId);

    expect(record).toMatchObject({
      id: workflowRunId,
      status: "completed",
      definitionSnapshot: {
        nodes: [expect.objectContaining({ id: "main" })],
      },
    });
    expect(record?.definitionSnapshot?.nodes).not.toEqual([
      expect.objectContaining({ id: "edited" }),
    ]);
    expect(record?.runIds).toContain(resumed.ok ? resumed.runId : "");
  });

  it("does not re-verify failed historical nodes on workflow resume", async () => {
    const workspace = await tempWorkspace();
    const sessionId = "sess_workflow_resume_failed_verdict";
    const marker = join(workspace, "failed-historical-verifier.txt");
    const definition: WorkflowDefinition = {
      assetName: "failed-history",
      contentHash: "hash-failed-history",
      nodes: [
        {
          id: "first",
          body: "Historical failing node.",
          verify: [
            {
              id: "historical-fail",
              kind: "command",
              command: process.execPath,
              args: [
                "-e",
                `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); process.exit(1);`,
              ],
              authorized: true,
            },
          ],
          onFail: "second",
        },
        { id: "second", body: "Resume here." },
      ],
    };
    const store = new FileWorkflowStore({
      rootDir: workflowStoreRoot(workspace, sessionId),
    });
    const workflowRunId = "workflow_failed_history" as WorkflowRunId;
    store.create({
      id: workflowRunId,
      sessionId,
      assetName: definition.assetName,
      contentHash: definition.contentHash,
      currentNodeId: "second",
      attempts: { first: 1, second: 1 },
      definitionSnapshot: definition,
      verdictLog: [
        {
          at: "2026-07-05T00:00:00.000Z",
          nodeId: "first",
          attempt: 1,
          verdict: { status: "failed", reason: "historical failure" },
        },
      ],
      transitionLog: [
        {
          at: "2026-07-05T00:00:00.000Z",
          verdict: { status: "failed", reason: "historical failure" },
          decision: {
            type: "goto",
            fromNodeId: "first",
            toNodeId: "second",
            reason: "node_failed",
          },
        },
      ],
      metadata: { goal: "resume failed-history workflow" },
    });
    const events: HostEvent[] = [];
    const runtime = new HostRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      emit: (event) => events.push(event),
    });

    const resumed = await runtime.resumeWorkflowRun({
      workflowRunId,
      sessionId,
    });

    expect(resumed).toMatchObject({ ok: true });
    await waitForHostEvent(events, (event) => event.kind === "run.completed");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects terminal workflow records instead of force-resuming them", async () => {
    const workspace = await tempWorkspace();
    const sessionId = "sess_workflow_terminal";
    const definition: WorkflowDefinition = {
      assetName: "terminal",
      contentHash: "hash-terminal",
      nodes: [{ id: "main", body: "Terminal body." }],
    };
    const store = new FileWorkflowStore({
      rootDir: workflowStoreRoot(workspace, sessionId),
    });
    const workflowRunId = "workflow_terminal" as WorkflowRunId;
    store.update(
      store.create({
        id: workflowRunId,
        sessionId,
        assetName: definition.assetName,
        contentHash: definition.contentHash,
        currentNodeId: "main",
        definitionSnapshot: definition,
      }).id,
      { status: "completed" },
    );
    const runtime = new HostRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      emit: () => {},
    });

    const resumed = await runtime.resumeWorkflowRun({
      workflowRunId,
      sessionId,
    });

    expect(resumed).toMatchObject({
      ok: false,
      error: {
        code: "invalid_payload",
        message: expect.stringContaining("already completed"),
      },
    });
  });

  it("rejects unsafe workflow resume ids before building paths", async () => {
    const workspace = await tempWorkspace();
    const runtime = new HostRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      emit: () => {},
    });

    const unsafeRun = await runtime.resumeWorkflowRun({
      workflowRunId: "../escape" as WorkflowRunId,
    });
    const unsafeSession = await runtime.resumeWorkflowRun({
      workflowRunId: "workflow_safe" as WorkflowRunId,
      sessionId: "../escape",
    });

    expect(unsafeRun).toMatchObject({
      ok: false,
      error: { code: "invalid_payload" },
    });
    expect(unsafeSession).toMatchObject({
      ok: false,
      error: { code: "invalid_payload" },
    });
  });
});
