import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineTool, type ModelAdapter } from "@sparkwright/core";
import {
  FileTaskNotificationOutbox,
  FileTaskStore,
  FileWorkflowControlInbox,
  FileWorkflowNotificationOutbox,
  TaskManager,
} from "@sparkwright/agent-runtime";
import { InFlightCommandDispatcher } from "@sparkwright/server-runtime";
import { loadLayeredWorkflowAssets } from "../src/workflows.js";
import { resolveRunAccessFields } from "../src/run-access.js";
import { TaskRuntimeOperations } from "../src/runtime/task-runtime-operations.js";
import {
  WorkflowEpisodeRuntime,
  resolveWorkflowActorEpisodePlan,
} from "../src/runtime/workflow-episode-runtime.js";
import { WorkflowRuntimeOperations } from "../src/runtime/workflow-runtime-operations.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("WorkflowEpisodeRuntime", () => {
  it("prepares fresh projection state and resolves the node episode surface", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-workflow-episode-"),
    );
    tempDirs.push(workspace);
    const workflowDir = join(
      workspace,
      ".sparkwright",
      "workflows",
      "episode-owner",
    );
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      join(workflowDir, "workflow.md"),
      [
        "---",
        "nodes:",
        "  - id: inspect",
        "    execute: model",
        "    tools: [read]",
        "    runBudget:",
        "      maxModelCalls: 2",
        "---",
        "## inspect",
        "Inspect the requested file.",
      ].join("\n"),
      "utf8",
    );

    const workflows = new WorkflowRuntimeOperations({
      workspaceRoot: workspace,
      notifications: new FileWorkflowNotificationOutbox({
        rootDir: join(workspace, ".sparkwright", "workflow-actors"),
      }),
      controls: new FileWorkflowControlInbox({
        rootDir: join(workspace, ".sparkwright", "workflow-runs"),
      }),
      dispatcher: new InFlightCommandDispatcher(),
    });
    const taskRoot = join(workspace, ".sparkwright", "tasks");
    const tasks = new TaskRuntimeOperations({
      workspaceRoot: workspace,
      manager: new TaskManager({
        store: new FileTaskStore({ rootDir: taskRoot }),
        notificationSink: new FileTaskNotificationOutbox({
          rootDir: taskRoot,
        }),
      }),
      notifications: new FileTaskNotificationOutbox({ rootDir: taskRoot }),
    });
    const episodes = new WorkflowEpisodeRuntime({
      workflows,
      tasks,
      emit: () => {},
      releaseExecution: () => {},
    });
    const loaded = await loadLayeredWorkflowAssets(workspace, {
      XDG_CONFIG_HOME: join(workspace, "xdg"),
    });
    const prepared = await episodes.prepare({
      goal: "inspect through workflow",
      sessionId: "session_episode_owner",
      sessionRootDir: join(workspace, ".sparkwright", "sessions"),
      workspaceRoot: workspace,
      workflows: loaded,
      parentModelRef: "deterministic",
      workflowName: "episode-owner",
      access: resolveRunAccessFields(
        { accessMode: "read-only" },
        { defaultBackgroundTasks: "enabled" },
      ),
      skillRoots: [],
      configPaths: [],
      parentRunRef: {},
      tools: [
        defineTool({
          name: "read",
          description: "Read a file.",
          inputSchema: { type: "object", properties: {} },
          execute: async () => ({ ok: true }),
        }),
      ],
    });

    expect(prepared).toMatchObject({
      ok: true,
      prepared: {
        workflowRecord: {
          assetName: "episode-owner",
          currentNodeId: "inspect",
          status: "running",
        },
      },
    });
    if (!prepared.ok || !prepared.prepared.workflowRecord) {
      throw new Error("Workflow episode preparation failed.");
    }
    const parentModel: ModelAdapter = {
      complete: async () => ({ message: "done" }),
    };
    const plan = resolveWorkflowActorEpisodePlan(
      {
        model: parentModel,
        modelRef: "deterministic",
        resolvedModel: {
          modelRef: "deterministic",
          providerKey: "deterministic",
          modelId: "deterministic",
          adapterId: "deterministic",
          modelSource: { layer: "request" },
        },
        workflowModelAdapters: prepared.prepared.workflowModelAdapters,
        tools: [
          defineTool({
            name: "read",
            description: "Read a file.",
            inputSchema: { type: "object", properties: {} },
            execute: async () => ({ ok: true }),
          }),
          defineTool({
            name: "write",
            description: "Write a file.",
            inputSchema: { type: "object", properties: {} },
            execute: async () => ({ ok: true }),
          }),
        ],
        workflowRecord: prepared.prepared.workflowRecord,
      },
      {
        purpose: "main_agent",
        fallbackRunBudget: { maxModelCalls: 5, maxToolCalls: 8 },
      },
    );

    expect(plan).toMatchObject({
      model: parentModel,
      modelRef: "deterministic",
      nodeId: "inspect",
      attempt: 1,
      runBudget: { maxModelCalls: 2, maxToolCalls: 8 },
      toolSurface: { tools: [{ name: "read" }] },
    });
    await prepared.prepared.workflowLease?.release();
  });
});
