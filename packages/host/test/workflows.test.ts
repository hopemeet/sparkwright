import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileWorkflowStore,
  type WorkflowDefinition,
  type WorkflowRunId,
  type WorkflowRunRecord,
  type CreateWorkflowRunRecordInput,
  type WorkflowRunRecordPatch,
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

function workflowStoreRoot(workspace: string, _sessionId?: string): string {
  return join(workspace, ".sparkwright", "workflow-runs");
}

function legacyWorkflowStoreRoot(workspace: string, sessionId: string): string {
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

async function seedWorkflowRecord(
  store: FileWorkflowStore,
  input: CreateWorkflowRunRecordInput,
  patch?: WorkflowRunRecordPatch,
): Promise<WorkflowRunRecord> {
  const writer = await store.acquireWriter(input.id, { owner: "test-fixture" });
  if (!writer) throw new Error(`Could not claim ${input.id}`);
  let record = await writer.create(input);
  if (patch) {
    const status = patch.status ?? record.status;
    record = await writer.mutate({
      expectedRevision: record.recordRevision ?? 0,
      patch,
      event: {
        at: new Date().toISOString(),
        type:
          status === "completed"
            ? "completed"
            : status === "waiting"
              ? "waiting"
              : "updated",
        workflowRunId: record.id,
        status,
      },
    });
  }
  await writer.release();
  return record;
}

describe("workflow assets", () => {
  it("returns durable workflow/job identity and records control-session attribution", async () => {
    const workspace = await tempWorkspace();
    await writeWorkflow(
      workspace,
      "job-identity",
      [
        "---",
        "nodes:",
        "  - id: main",
        "    execute: model",
        "---",
        "## main",
        "Finish once.",
      ].join("\n"),
    );
    const events: HostEvent[] = [];
    const runtime = new HostRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      emit: (event) => events.push(event),
    });

    const started = await runtime.startRun({
      goal: "isolated workflow job",
      sessionId: "session_workflow_job",
      controlSessionId: "session_main_control",
      workflow: "job-identity",
    });

    expect(started).toMatchObject({
      ok: true,
      sessionId: "session_workflow_job",
      workflowRunId: expect.stringMatching(/^workflow_/),
    });
    if (!started.ok || !started.workflowRunId) {
      throw new Error("Expected workflow identity.");
    }
    const record = new FileWorkflowStore({
      rootDir: workflowStoreRoot(workspace),
      createRoot: false,
    }).get(started.workflowRunId as WorkflowRunId);
    expect(record).toMatchObject({
      id: started.workflowRunId,
      sessionId: "session_workflow_job",
      metadata: { controlSessionId: "session_main_control" },
    });
    await waitForHostEvent(events, (event) => event.kind === "run.completed");

    const invalid = await new HostRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      emit: () => {},
    }).startRun({
      goal: "invalid shared identity",
      sessionId: "session_same",
      controlSessionId: "session_same",
      workflow: "job-identity",
    });
    expect(invalid).toMatchObject({
      ok: false,
      error: expect.objectContaining({
        message: expect.stringContaining("must differ"),
      }),
    });
  });

  it("uses a service-fixed workflow id as the fresh-start idempotency backstop", async () => {
    const workspace = await tempWorkspace();
    await writeWorkflow(
      workspace,
      "service-fixed",
      [
        "---",
        "nodes:",
        "  - id: main",
        "    execute: model",
        "---",
        "## main",
        "Finish once.",
      ].join("\n"),
    );
    const workflowRunId =
      "workflow_service_0123456789abcdef0123456789abcdef" as WorkflowRunId;
    const events: HostEvent[] = [];
    const first = await new HostRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      emit: (event) => events.push(event),
    }).startDetachedWorkflowRun(
      {
        goal: "one durable handoff",
        sessionId: "session_workflow_service_fixed",
        workflow: "service-fixed",
        metadata: { serviceHandoffId: "handoff_fixed" },
      },
      workflowRunId,
    );
    expect(first).toMatchObject({ ok: true, workflowRunId });
    await waitForHostEvent(events, (event) => event.kind === "run.completed");

    const duplicate = await new HostRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      emit: () => {},
    }).startDetachedWorkflowRun(
      {
        goal: "one durable handoff",
        sessionId: "session_workflow_service_fixed",
        workflow: "service-fixed",
        metadata: { serviceHandoffId: "handoff_fixed" },
      },
      workflowRunId,
    );
    expect(duplicate).toMatchObject({ ok: false });
    const records = new FileWorkflowStore({
      rootDir: workflowStoreRoot(workspace),
      createRoot: false,
    })
      .list()
      .records.filter((record) => record.id === workflowRunId);
    expect(records).toHaveLength(1);
    expect(records[0]?.metadata).toMatchObject({
      serviceHandoffId: "handoff_fixed",
    });
  });

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
    const bugfix = report.assets.find((asset) => asset.assetName === "bugfix");
    expect(bugfix).toMatchObject({
      assetName: "bugfix",
      layer: "project",
      version: "1.2.3",
      description: "Fix a bug with evidence.",
      nodeCount: 2,
    });
    expect(bugfix?.definition.nodes).toEqual([
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
    expect(bugfix?.definition.config).toEqual({
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

  it("parses todo_clear verifiers", () => {
    const detail = parseWorkflowMarkdownAsset({
      assetName: "todo-clear",
      dir: "/tmp/todo-clear",
      sourcePath: "/tmp/todo-clear/workflow.md",
      raw: [
        "---",
        "nodes:",
        "  - id: finish",
        "    execute: model",
        "    verify:",
        "      - kind: todo_clear",
        "        name: todos-done",
        "        metadata:",
        "          owner: self-hosting",
        "---",
        "## finish",
        "Finish the todo-backed work.",
      ].join("\n"),
    });

    expect(detail.definition.nodes[0]?.verify).toEqual([
      {
        id: "todos-done",
        kind: "todo_clear",
        metadata: { owner: "self-hosting" },
      },
    ]);
  });

  it("parses P4 script nodes with asset-local paths and capability declarations", () => {
    const detail = parseWorkflowMarkdownAsset({
      assetName: "scripted-release",
      dir: "/tmp/scripted-release",
      sourcePath: "/tmp/scripted-release/workflow.md",
      raw: [
        "---",
        "nodes:",
        "  - id: release-probe",
        "    execute: script",
        "    script:",
        "      path: scripts/release-probe.mjs",
        "      args: [--focused]",
        "      cwd: .",
        "      env:",
        "        CI: '1'",
        "      timeoutMs: 120000",
        "      maxOutputBytes: 32768",
        "      capabilities: [read, shell, read]",
        "    onPass: done",
        "  - id: done",
        "    execute: model",
        "---",
        "## release-probe",
        "Run the release probe.",
        "",
        "## done",
        "Summarize.",
      ].join("\n"),
    });

    expect(detail.definition).toMatchObject({
      sourceDir: "/tmp/scripted-release",
      sourcePath: "/tmp/scripted-release/workflow.md",
    });
    expect(detail.definition.nodes[0]).toMatchObject({
      id: "release-probe",
      execute: "script",
      script: {
        path: "scripts/release-probe.mjs",
        args: ["--focused"],
        cwd: ".",
        env: { CI: "1" },
        timeoutMs: 120000,
        maxOutputBytes: 32768,
        capabilities: ["read", "shell"],
      },
      onPass: "done",
    });
  });

  it("parses P5 parallel and join nodes", () => {
    const detail = parseWorkflowMarkdownAsset({
      assetName: "parallel-release",
      dir: "/tmp/parallel-release",
      sourcePath: "/tmp/parallel-release/workflow.md",
      raw: [
        "---",
        "nodes:",
        "  - id: fanout",
        "    execute: parallel",
        "    parallel:",
        "      branches: [lint, types]",
        "      maxConcurrency: 2",
        "    onPass: join",
        "  - id: lint",
        "    execute: command",
        "    command:",
        "      command: npm",
        "      args: [run, lint]",
        "      authorized: true",
        "  - id: types",
        "    execute: command",
        "    command:",
        "      command: npm",
        "      args: [run, typecheck]",
        "      authorized: true",
        "  - id: join",
        "    execute: join",
        "    join:",
        "      waitFor: [lint, types]",
        "    onPass: done",
        "  - id: done",
        "    execute: model",
        "---",
        "## fanout",
        "Run checks.",
        "",
        "## done",
        "Summarize.",
      ].join("\n"),
    });

    expect(detail.definition.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "fanout",
          execute: "parallel",
          parallel: {
            branches: ["lint", "types"],
            maxConcurrency: 2,
          },
          onPass: "join",
        }),
        expect.objectContaining({
          id: "join",
          execute: "join",
          join: { waitFor: ["lint", "types"] },
          onPass: "done",
        }),
      ]),
    );
  });

  it("rejects duplicate parallel branches", () => {
    expect(() =>
      parseWorkflowMarkdownAsset({
        assetName: "parallel-duplicate",
        dir: "/tmp/parallel-duplicate",
        sourcePath: "/tmp/parallel-duplicate/workflow.md",
        raw: [
          "---",
          "nodes:",
          "  - id: fanout",
          "    execute: parallel",
          "    parallel:",
          "      branches: [lint, lint]",
          "---",
          "## fanout",
          "Run checks.",
        ].join("\n"),
      }),
    ).toThrow(/duplicates/);
  });

  it("rejects script paths that escape the workflow asset", () => {
    expect(() =>
      parseWorkflowMarkdownAsset({
        assetName: "script-escape",
        dir: "/tmp/script-escape",
        sourcePath: "/tmp/script-escape/workflow.md",
        raw: [
          "---",
          "nodes:",
          "  - id: bad",
          "    execute: script",
          "    script:",
          "      path: ../outside.mjs",
          "---",
          "## bad",
          "Nope.",
        ].join("\n"),
      }),
    ).toThrow(/relative path inside the workflow asset/);
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

    const release = report.assets.find(
      (asset) => asset.assetName === "release",
    );
    expect(release).toMatchObject({
      assetName: "release",
      layer: "project",
      version: "project",
    });
    expect(report.shadows).toEqual([
      expect.objectContaining({ assetName: "release" }),
    ]);
  });

  it("keeps internal smoke workflows out of the default builtin catalog", async () => {
    const workspace = await tempWorkspace();
    const report = await loadLayeredWorkflowAssets(workspace, {
      XDG_CONFIG_HOME: join(workspace, "xdg"),
    });

    expect(report.assets.map((asset) => asset.assetName)).not.toEqual(
      expect.arrayContaining([
        "release-check-focused",
        "workflow-runtime-p4-smoke",
      ]),
    );
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
    expect(inspected.snapshot.workflows?.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assetName: "inspectable",
          version: "0.1",
          nodeCount: 1,
        }),
      ]),
    );
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
    await expect(
      access(legacyWorkflowStoreRoot(workspace, sessionId)),
    ).rejects.toThrow();
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

  it("blocks parent catalog tools after a script node transitions to a narrowed model node", async () => {
    const workspace = await tempWorkspace();
    const sessionId = "sess_workflow_script_catalog_clamp";
    await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
    await writeWorkflow(
      workspace,
      "script-catalog",
      [
        "---",
        "nodes:",
        "  - id: prep",
        "    execute: script",
        "    script:",
        "      path: scripts/pass.mjs",
        "      capabilities: [read]",
        "    onPass: summarize",
        "  - id: summarize",
        "    execute: model",
        "    tools: [read]",
        "---",
        "## prep",
        "Pass through to the model node.",
        "",
        "## summarize",
        "Only read tools are available.",
      ].join("\n"),
    );
    await mkdir(
      join(workspace, ".sparkwright", "workflows", "script-catalog", "scripts"),
      { recursive: true },
    );
    await writeFile(
      join(
        workspace,
        ".sparkwright",
        "workflows",
        "script-catalog",
        "scripts",
        "pass.mjs",
      ),
      [
        'import readline from "node:readline";',
        "const pending = new Map();",
        "let nextId = 1;",
        "const rl = readline.createInterface({ input: process.stdin });",
        'rl.on("line", (line) => {',
        "  const response = JSON.parse(line);",
        "  const waiter = pending.get(response.id);",
        "  if (!waiter) return;",
        "  pending.delete(response.id);",
        "  if (response.error) waiter.reject(new Error(response.error.message));",
        "  else waiter.resolve(response.result);",
        "});",
        "function request(method, params = {}) {",
        "  const id = nextId++;",
        '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");',
        "  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));",
        "}",
        "await request('initialize');",
        "await request('complete', { result: { ok: true } });",
        "rl.close();",
      ].join("\n"),
      "utf8",
    );
    const previousScript = process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
    process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = JSON.stringify([
      {
        toolCalls: [
          {
            toolName: "tool_search",
            arguments: { query: "select:task,glob,grep" },
          },
          {
            toolName: "task",
            arguments: { action: "list" },
          },
          {
            toolName: "glob",
            arguments: { patterns: ["**/*"] },
          },
          {
            toolName: "grep",
            arguments: { pattern: "Demo" },
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
        goal: "run script catalog workflow",
        sessionId,
        workflow: "script-catalog",
      });

      expect(started).toMatchObject({ ok: true });
      await waitForHostEvent(events, (event) => event.kind === "run.completed");
      for (const toolName of ["tool_search", "task", "glob", "grep"]) {
        const failure = events
          .map(runEventPayload)
          .map((event) => toolRunEventPayload(event, "tool.failed", toolName))
          .find((payload) => payload !== undefined);
        expect(failure).toMatchObject({
          toolName,
          error: { code: "TOOL_BLOCKED_BY_WORKFLOW_HOOK" },
        });
        const completed = events
          .map(runEventPayload)
          .map((event) =>
            toolRunEventPayload(event, "tool.completed", toolName),
          )
          .find((payload) => payload !== undefined);
        expect(completed).toBeUndefined();
      }
      const record = await waitForWorkflowRecord(
        workflowStoreRoot(workspace, sessionId),
      );
      expect(record).toMatchObject({
        status: "completed",
        metadata: {
          workflowEpisode: expect.objectContaining({
            nodeId: "summarize",
          }),
          episodeAllowedTools: ["read"],
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

  it("keeps waiting input intact when workflow resume cannot prepare a run", async () => {
    const workspace = await tempWorkspace();
    const sessionId = "sess_workflow_resume_prepare_failure";
    const definition: WorkflowDefinition = {
      assetName: "human-gate",
      contentHash: "hash-human-gate",
      nodes: [
        {
          id: "review",
          execute: "human",
          body: "Review.",
          human: {
            wait: { kind: "input", reason: "Need human review." },
          },
          onPass: "finish",
        },
        { id: "finish", body: "Finish after review." },
      ],
    };
    const store = new FileWorkflowStore({
      rootDir: workflowStoreRoot(workspace, sessionId),
    });
    const workflowRunId = "workflow_prepare_failure" as WorkflowRunId;
    const waiting = await seedWorkflowRecord(
      store,
      {
        id: workflowRunId,
        sessionId,
        assetName: definition.assetName,
        contentHash: definition.contentHash,
        currentNodeId: "review",
        attempts: { review: 1 },
        definitionSnapshot: definition,
        metadata: { goal: "resume human-gate" },
      },
      {
        status: "waiting",
        wait: { kind: "input", reason: "Need human review." },
      },
    );
    const runtime = new HostRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      emit: () => {},
    });

    const resumed = await runtime.resumeWorkflowRun({
      workflowRunId,
      sessionId,
      model: "missing-provider/model",
    });

    expect(resumed).toMatchObject({ ok: false });
    expect(store.get(workflowRunId)).toMatchObject({
      status: "waiting",
      currentNodeId: "review",
      wait: { kind: "input", reason: "Need human review." },
      attempts: waiting.attempts,
      verdictLog: waiting.verdictLog,
      transitionLog: waiting.transitionLog,
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
    const competingLease = await store.acquireWriter(record.id, {
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
    const releasedLease = await store.acquireWriter(record.id, {
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
      rootDir: legacyWorkflowStoreRoot(workspace, sessionId),
    });
    const workflowRunId = "workflow_resume_pinned" as WorkflowRunId;
    await seedWorkflowRecord(store, {
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
    const listed = await runtime.listWorkflowRuns({ sessionId });
    expect(listed).toMatchObject({ ok: true });
    if (!listed.ok) throw new Error(listed.error.message);
    expect(listed.workflows).toEqual([
      expect.objectContaining({ id: workflowRunId, sessionId }),
    ]);

    const resumed = await runtime.resumeWorkflowRun({
      workflowRunId,
      sessionId,
    });

    expect(resumed).toMatchObject({ ok: true, workflowRunId, sessionId });
    await waitForHostEvent(events, (event) => event.kind === "run.completed");
    const record = new FileWorkflowStore({
      rootDir: legacyWorkflowStoreRoot(workspace, sessionId),
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

  it("runs a supervisor-claimed workflow without acquiring a second writer", async () => {
    const workspace = await tempWorkspace();
    const sessionId = "sess_workflow_claimed_resume";
    const workflowRunId = "workflow_claimed_resume" as WorkflowRunId;
    const definition: WorkflowDefinition = {
      assetName: "claimed",
      contentHash: "hash-claimed",
      nodes: [{ id: "main", body: "Claimed body." }],
    };
    const store = new FileWorkflowStore({
      rootDir: legacyWorkflowStoreRoot(workspace, sessionId),
    });
    await seedWorkflowRecord(store, {
      id: workflowRunId,
      sessionId,
      assetName: definition.assetName,
      contentHash: definition.contentHash,
      currentNodeId: "main",
      attempts: { main: 1 },
      definitionSnapshot: definition,
      metadata: { goal: "resume claimed workflow" },
    });
    const writer = await store.acquireWriter(workflowRunId, {
      owner: "worker:supervisor:instance",
    });
    expect(writer).not.toBeNull();
    const events: HostEvent[] = [];
    const runtime = new HostRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      emit: (event) => events.push(event),
    });

    const resumed = await runtime.resumeClaimedWorkflowRun(
      { workflowRunId, sessionId },
      writer!,
    );

    expect(resumed).toMatchObject({ ok: true, workflowRunId, sessionId });
    await waitForHostEvent(events, (event) => event.kind === "run.completed");
    expect(
      new FileWorkflowStore({
        rootDir: legacyWorkflowStoreRoot(workspace, sessionId),
        createRoot: false,
      }).get(workflowRunId),
    ).toMatchObject({ status: "completed", generation: writer!.generation });
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
    await seedWorkflowRecord(store, {
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

  it("prefers workspace workflow records over matching legacy session copies on resume", async () => {
    const workspace = await tempWorkspace();
    const sessionId = "sess_workflow_workspace_legacy_duplicate";
    const definition: WorkflowDefinition = {
      assetName: "pinned",
      contentHash: "hash-pinned",
      nodes: [{ id: "main", body: "Resume from workspace record." }],
    };
    const workflowRunId = "workflow_workspace_duplicate" as WorkflowRunId;
    const workspaceStore = new FileWorkflowStore({
      rootDir: workflowStoreRoot(workspace, sessionId),
    });
    await seedWorkflowRecord(workspaceStore, {
      id: workflowRunId,
      sessionId,
      assetName: definition.assetName,
      contentHash: definition.contentHash,
      currentNodeId: "main",
      definitionSnapshot: definition,
      metadata: { goal: "resume duplicate workflow" },
    });
    const legacyStore = new FileWorkflowStore({
      rootDir: legacyWorkflowStoreRoot(workspace, sessionId),
    });
    await seedWorkflowRecord(legacyStore, {
      id: workflowRunId,
      sessionId,
      assetName: definition.assetName,
      contentHash: definition.contentHash,
      currentNodeId: "main",
      definitionSnapshot: definition,
      metadata: { goal: "resume duplicate workflow" },
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
    expect(
      new FileWorkflowStore({
        rootDir: workflowStoreRoot(workspace, sessionId),
        createRoot: false,
      }).get(workflowRunId)?.runIds,
    ).toHaveLength(1);
    expect(
      new FileWorkflowStore({
        rootDir: legacyWorkflowStoreRoot(workspace, sessionId),
        createRoot: false,
      }).get(workflowRunId)?.runIds,
    ).toHaveLength(0);
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
    await seedWorkflowRecord(
      store,
      {
        id: workflowRunId,
        sessionId,
        assetName: definition.assetName,
        contentHash: definition.contentHash,
        currentNodeId: "main",
        definitionSnapshot: definition,
      },
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

  it("applies durable cancel from a different Host runtime", async () => {
    const workspace = await tempWorkspace();
    const sessionId = "sess_workflow_control_cancel";
    const workflowRunId = "workflow_control_cancel" as WorkflowRunId;
    const store = new FileWorkflowStore({
      rootDir: workflowStoreRoot(workspace, sessionId),
    });
    const record = await seedWorkflowRecord(store, {
      id: workflowRunId,
      sessionId,
      assetName: "controlled",
      contentHash: "hash-controlled",
      currentNodeId: "main",
      definitionSnapshot: {
        assetName: "controlled",
        contentHash: "hash-controlled",
        nodes: [{ id: "main", body: "Controlled body." }],
      },
    });
    const runtime = new HostRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      emit: () => {},
    });

    const controlled = await runtime.controlWorkflow({
      workflowRunId,
      sessionId,
      idempotencyKey: "cancel-from-other-host",
      source: {
        kind: "api",
        principalId: "test-client",
        authenticatedBy: "host-test",
      },
      expected: { generation: record.generation, status: "running" },
      command: { kind: "cancel", reason: "remote stop" },
    });

    expect(controlled).toMatchObject({
      ok: true,
      status: "applied",
      code: "applied",
    });
    expect(
      new FileWorkflowStore({
        rootDir: workflowStoreRoot(workspace, sessionId),
        createRoot: false,
      }).get(workflowRunId),
    ).toMatchObject({ status: "cancelled" });
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
