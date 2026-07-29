import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDefaultPolicy,
  createLayeredPolicy,
  createRun,
  createWorkspaceReadScopePolicy,
  defineTool,
  type ModelInput,
  type RuntimeContext,
} from "@sparkwright/core";
import { LocalWorkspace } from "@sparkwright/core/internal";
import {
  IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT,
  InMemoryTaskStore,
  TaskManager,
} from "@sparkwright/agent-runtime";
import { createDynamicSpawnAgentTool } from "../src/runtime.js";
import {
  createAgentSpawnPayloadSchema,
  createDynamicChildToolCatalog,
} from "../src/tool-catalog.js";
import { createReadFileTool } from "../src/tools.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function childReadTool() {
  return defineTool({
    name: "read",
    description: "Read a test fact.",
    inputSchema: { type: "object" },
    delegation: "child",
    governance: { sideEffects: ["read"] },
    execute: () => ({ content: "fact" }),
  });
}

function terminalChildModel(
  onCall?: (
    toolNames: string[],
    prompt: Array<{ role?: string; content?: string }>,
  ) => void,
) {
  return {
    async complete(input: ModelInput) {
      onCall?.(
        input.tools.map((tool) => tool.name),
        input.prompt ?? [],
      );
      return {
        message: "Child completed the delegated task.",
        toolCalls: [
          {
            toolName: "submit_agent_result",
            arguments: {
              status: "completed",
              summary: "Delegated task complete",
              accomplishments: ["Inspected the requested scope"],
              blockers: [],
            },
          },
        ],
      };
    },
  };
}

function dynamicTool(input: {
  parent: ReturnType<typeof createRun>;
  childTools?: ReturnType<typeof childReadTool>[];
  onModelCall?: (
    toolNames: string[],
    prompt: Array<{ role?: string; content?: string }>,
  ) => void;
}) {
  return createDynamicSpawnAgentTool({
    getParent: () => input.parent,
    model: terminalChildModel(input.onModelCall),
    childTools: input.childTools ?? [childReadTool()],
    parentRunPolicy: createDefaultPolicy(),
    childRunStoreFactory: () => undefined as never,
  });
}

describe("host spawn_agent execution control plane", () => {
  it("exposes only goal/context/label in the model-facing handoff schema", () => {
    const schema = createAgentSpawnPayloadSchema() as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };

    expect(Object.keys(schema.properties).sort()).toEqual([
      "context",
      "goal",
      "label",
    ]);
    expect(schema.required).toEqual(["goal"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("derives child tools automatically and injects the terminal result tool", async () => {
    const parent = createRun({
      goal: "parent",
      model: terminalChildModel(),
      maxSteps: 4,
    });
    let observedTools: string[] = [];
    let observedSystemText = "";
    const tool = dynamicTool({
      parent,
      onModelCall: (tools, prompt) => {
        observedTools = tools;
        observedSystemText = prompt
          .filter((message) => message.role === "system")
          .map((message) => message.content ?? "")
          .join("\n");
      },
    });

    const output = (await tool.execute(
      {
        goal: "Inspect the implementation",
        context: "Focus on Host.",
        label: "reviewer",
      },
      { run: parent.record } as never,
    )) as Record<string, unknown>;

    expect(observedTools).toEqual(
      expect.arrayContaining(["read", "submit_agent_result"]),
    );
    expect(observedSystemText).toContain(
      IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT,
    );
    expect(output).toMatchObject({
      status: "completed",
      report: "Child completed the delegated task.",
      workspace: { writes: 0 },
    });
  });

  it("accepts persisted legacy payloads without restoring their authority", async () => {
    const parent = createRun({
      goal: "parent",
      model: terminalChildModel(),
      maxSteps: 2,
    });
    const tool = dynamicTool({ parent });

    const output = (await tool.execute(
      {
        goal: "Inspect a persisted task",
        role: "legacy reviewer",
        allowedTools: ["dangerous_parent_tool"],
        grant: { workspaceWrite: true },
        maxSteps: 999,
        metadata: { elevated: true },
      },
      { run: parent.record } as never,
    )) as Record<string, unknown>;

    expect(output).toMatchObject({
      status: "completed",
      report: "Child completed the delegated task.",
      workspace: { writes: 0 },
    });
  });

  it("keeps dynamic identities unique while caching exact reusable work", async () => {
    let childCalls = 0;
    const parent = createRun({
      goal: "parent",
      model: terminalChildModel(),
      maxSteps: 4,
    });
    const tool = createDynamicSpawnAgentTool({
      getParent: () => parent,
      model: terminalChildModel(() => {
        childCalls += 1;
      }),
      childTools: [childReadTool()],
      parentRunPolicy: createDefaultPolicy(),
      childRunStoreFactory: () => undefined as never,
    });
    const firstInput = {
      goal: "Inspect the resolver",
      context: "Revision A",
      label: "reviewer",
    };

    const first = (await tool.execute(firstInput, {
      run: parent.record,
    } as never)) as { childRunId: string };
    const cached = (await tool.execute(firstInput, {
      run: parent.record,
    } as never)) as { childRunId: string; warnings?: string[] };
    const changed = (await tool.execute(
      { ...firstInput, context: "Revision B" },
      { run: parent.record } as never,
    )) as { childRunId: string };

    expect(cached).toMatchObject({
      childRunId: first.childRunId,
      warnings: [
        "The runtime reused this completed child result; no new child ran.",
      ],
    });
    expect(changed.childRunId).not.toBe(first.childRunId);
    expect(childCalls).toBe(2);
  });

  it("cancels an awaited promoted child when the parent run is cancelled", async () => {
    const manager = new TaskManager({ store: new InMemoryTaskStore() });
    let childStarted: () => void = () => {};
    const childStartedGate = new Promise<void>((resolve) => {
      childStarted = resolve;
    });
    const waitTool = defineTool({
      name: "grep",
      description: "Wait until the child lifecycle is cancelled.",
      inputSchema: { type: "object" },
      delegation: "child",
      async execute(_args, ctx) {
        childStarted();
        const signal = (ctx as RuntimeContext).abortSignal;
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { matches: [] };
      },
    });
    const parent = createRun({
      goal: "parent",
      model: terminalChildModel(),
      maxSteps: 4,
    });
    const tool = createDynamicSpawnAgentTool({
      getParent: () => parent,
      model: {
        async complete() {
          return {
            toolCalls: [{ toolName: "grep", arguments: {} }],
          };
        },
      },
      childTools: [waitTool],
      parentRunPolicy: createDefaultPolicy(),
      childRunStoreFactory: () => undefined as never,
      taskManager: manager,
      foregroundTimeoutMs: 0,
    });

    const receipt = (await tool.execute(
      { goal: "wait for cancellation", label: "waiter" },
      { run: parent.record } as never,
    )) as {
      taskId: string;
      childRunId: string;
      promoted: boolean;
      awaited: boolean;
      parentWillWait: boolean;
    };
    expect(receipt).toMatchObject({
      promoted: true,
      awaited: true,
      parentWillWait: true,
    });
    await withTimeout(childStartedGate, 2000, "promoted child start");

    parent.cancel({ reason: "test parent cancellation" });
    const task = manager.handle(receipt.taskId as never);
    expect(task).toBeDefined();
    const terminal = await withTimeout(
      task!.wait(),
      2000,
      "promoted child cancellation",
    );

    expect(terminal.status).toBe("cancelled");
    expect(
      parent.events
        .all()
        .find(
          (event) =>
            event.type === "subagent.failed" &&
            (event.payload as { childRunId?: unknown }).childRunId ===
              receipt.childRunId,
        )?.payload,
    ).toMatchObject({
      terminalState: "cancelled",
    });
  });

  it("rejects authority-bearing legacy fields on the live model tool surface", async () => {
    const parentRef: { current?: ReturnType<typeof createRun> } = {};
    const spawn = createDynamicSpawnAgentTool({
      getParent: () => parentRef.current,
      model: terminalChildModel(),
      childTools: [childReadTool()],
      parentRunPolicy: createDefaultPolicy(),
      childRunStoreFactory: () => undefined as never,
    });
    let modelCalls = 0;
    const parent = createRun({
      goal: "try legacy handoff",
      tools: [spawn],
      maxSteps: 3,
      model: {
        async complete() {
          modelCalls += 1;
          return modelCalls === 1
            ? {
                toolCalls: [
                  {
                    toolName: "spawn_agent",
                    arguments: {
                      goal: "Inspect",
                      role: "writer",
                      grant: { workspaceWrite: true },
                    },
                  },
                ],
              }
            : { message: "Handled invalid handoff." };
        },
      },
    });
    parentRef.current = parent;

    await parent.start();

    expect(
      parent.events.all().find((event) => event.type === "tool.failed")
        ?.payload,
    ).toMatchObject({
      toolName: "spawn_agent",
      error: {
        code: "TOOL_ARGUMENTS_INVALID",
        message: expect.stringContaining("additional property"),
      },
    });
  });

  it("inherits the parent read-scope policy inside the child", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-spawn-scope-"));
    tempDirs.push(root);
    await writeFile(join(root, "secret.txt"), "secret\n", "utf8");
    const policy = createLayeredPolicy([
      createDefaultPolicy(),
      createWorkspaceReadScopePolicy({
        confidentialPaths: ["secret.txt"],
      }),
    ]);
    const parent = createRun({
      goal: "parent",
      workspace: new LocalWorkspace(root),
      policy,
      model: terminalChildModel(),
      maxSteps: 4,
    });
    let childCalls = 0;
    const tool = createDynamicSpawnAgentTool({
      getParent: () => parent,
      childTools: [createReadFileTool()],
      parentRunPolicy: policy,
      childRunStoreFactory: () => undefined as never,
      model: {
        async complete() {
          childCalls += 1;
          if (childCalls === 1) {
            return {
              toolCalls: [
                { toolName: "read", arguments: { path: "secret.txt" } },
              ],
            };
          }
          return {
            toolCalls: [
              {
                toolName: "submit_agent_result",
                arguments: {
                  status: "blocked",
                  summary: "Confidential read was denied",
                  accomplishments: [],
                  blockers: [
                    {
                      code: "READ_SCOPE_DENIED",
                      kind: "permission",
                      owner: "parent",
                      message: "The parent read scope denies secret.txt.",
                      retry: "after_capability_change",
                    },
                  ],
                },
              },
            ],
          };
        },
      },
    });

    const output = (await tool.execute(
      { goal: "Read secret.txt", label: "reader" },
      { run: parent.record } as never,
    )) as Record<string, unknown>;

    expect(output).toMatchObject({
      status: "blocked",
      report: "Confidential read was denied",
      workspace: { writes: 0 },
      blockers: [{ code: "READ_SCOPE_DENIED" }],
    });
  });

  it("builds a child catalog from explicit delegation classifications", () => {
    const names = createDynamicChildToolCatalog({
      workspaceRoot: process.cwd(),
    }).map((entry) => entry.definition.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "read",
        "glob",
        "grep",
        "list_dir",
        "create",
        "replace",
        "edit_anchored_text",
        "edit",
        "bash",
      ]),
    );
    expect(names).not.toContain("write");
  });
});

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
