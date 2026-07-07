import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDefaultPolicy,
  createRun,
  createSessionFileRunStoreFactory,
  createSessionRunStoreFactory,
  createWorkspaceReadScopePolicy,
  defineTool,
  FileSessionStore,
  LocalWorkspace,
  type ModelAdapter,
  type PendingNotification,
  type RunId,
  type ToolDefinition,
} from "@sparkwright/core";
import {
  InMemoryTaskNotificationQueue,
  InMemoryTaskStore,
  TaskManager,
  type TaskId,
  type TaskNotification,
} from "@sparkwright/agent-runtime";
import {
  createDynamicSpawnAgentTool,
  runHostAgentTask,
} from "../src/runtime.js";
import { createReadFileTool } from "../src/tools.js";

/**
 * The session run store flushes to disk asynchronously, so a trace/session file
 * may not be fully written the instant `spawn_agent` resolves. Reading it
 * immediately races that flush — fine on fast Linux/macOS CI, but it
 * intermittently ENOENTs on the slower Windows runner. Poll until the file
 * exists AND contains the marker we are about to assert on, rather than reading
 * once and hoping the flush already landed.
 */
async function readFileWhenReady(
  path: string,
  contains: string,
  timeoutMs = 12000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const content = await readFile(path, "utf8");
      if (content.includes(contains)) {
        return content;
      }
    } catch {
      // File not created yet — keep waiting.
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${path} to contain "${contains}"`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function createTestTaskRevivalBridge(input: {
  queue: InMemoryTaskNotificationQueue;
  manager: TaskManager;
  getRunId: () => RunId | undefined;
}) {
  const matchesRun = (notification: TaskNotification): boolean =>
    input.getRunId() === notification.parentRunId;
  const matchesAwaited = (notification: TaskNotification): boolean => {
    if (!matchesRun(notification)) return false;
    return input.manager.store.get(notification.taskId)?.awaited !== false;
  };
  const toPending = (notification: TaskNotification): PendingNotification => ({
    content: `Task ${notification.taskId} ${notification.status}.\n${notification.summary}`,
    source: { kind: "task", uri: `task:${notification.taskId}` },
    metadata: {
      taskId: notification.taskId,
      parentRunId: notification.parentRunId,
      status: notification.status,
      kind: notification.kind,
    },
  });
  return {
    notificationSource: {
      drain: () => input.queue.drain(matchesRun).map(toPending),
    },
    taskRevivalSource: {
      hasAwaitedPending: () => {
        const runId = input.getRunId();
        if (!runId) return false;
        return (
          input.manager.store
            .list({ parentRunId: runId, awaited: true })
            .some(
              (task) =>
                !["completed", "failed", "cancelled"].includes(task.status),
            ) || input.queue.peek().some(matchesAwaited)
        );
      },
      waitUntilAvailable: ({ signal }: { signal?: AbortSignal } = {}) =>
        input.queue.waitUntilAvailable({ signal, predicate: matchesAwaited }),
    },
  };
}

/**
 * Regression guard for the host spawn_agent wiring. Two bugs were observed in a
 * real TUI trace: the spawned child agent's trace was never persisted (only
 * `agents/main/` existed on disk), and the child's token/tool usage was not
 * rolled up into the parent run's usage snapshot (the TUI under-reported spend
 * as "2 model / 1 tool", hiding the child entirely).
 *
 * The fix threads `runStore` + `parentUsageTracker` into `spawnSubAgent` from
 * `createDynamicSpawnAgentTool`. This test invokes that tool directly with a
 * scripted child model and asserts both fixes hold.
 */
describe("host spawn_agent wiring", () => {
  it("persists the child trace into the session and rolls usage into the parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-host-spawn-"));
    try {
      const sessionId = "session_spawn_test";
      const sessionRootDir = root;
      const sessionStore = new FileSessionStore({ rootDir: sessionRootDir });
      const childRunStoreFactory = (childAgentId: string) =>
        createSessionRunStoreFactory({
          sessionStore,
          sessionId,
          runStoreFactory: createSessionFileRunStoreFactory({
            sessionRootDir,
            sessionId,
            agentId: childAgentId,
            traceLevel: "standard",
          }),
          metadata: { source: "host" },
        });

      // Child model: one glob call, then a final answer.
      const childModel: ModelAdapter = {
        async complete(input) {
          const used = input.context.some((item) =>
            item.content.includes("glob"),
          );
          if (!used) {
            return {
              toolCalls: [{ toolName: "glob", arguments: { pattern: "*" } }],
            };
          }
          return { message: "top-level: README.md, package.json" };
        },
      };

      const globTool: ToolDefinition = defineTool({
        name: "glob",
        description: "Fake glob for the test.",
        inputSchema: {
          type: "object",
          properties: { pattern: { type: "string" } },
        },
        async execute() {
          return { paths: ["README.md", "package.json"] };
        },
      });

      const parent = createRun({
        goal: "ask a child to list files",
        model: {
          async complete() {
            return { message: "parent done" };
          },
        },
        maxSteps: 1,
        runStore: createSessionRunStoreFactory({
          sessionStore,
          sessionId,
          runStoreFactory: createSessionFileRunStoreFactory({
            sessionRootDir,
            sessionId,
            agentId: "main",
            traceLevel: "standard",
          }),
          metadata: { source: "host" },
        }),
      });

      const spawnTool = createDynamicSpawnAgentTool({
        getParent: () => parent,
        model: childModel,
        childTools: [globTool],
        parentRunPolicy: createDefaultPolicy(),
        childRunStoreFactory,
      });

      const output = (await spawnTool.execute(
        {
          goal: "list top-level files",
          role: "inspector",
          prompt: "List the files. Use glob only.",
          allowedTools: ["glob"],
          maxSteps: 3,
        },
        { run: parent.record } as never,
      )) as {
        signal: string;
        childRunId: string;
        stepLimitReached?: boolean;
      };

      expect(output.signal).toBe("completed");
      // Child finished on step 2 of 3 — it had budget to spare.
      expect(output.stepLimitReached).toBe(false);

      // (1) The child's own trace is persisted under its agent directory.
      const childTrace = await readFileWhenReady(
        join(
          sessionRootDir,
          sessionId,
          "agents",
          "dynamic_inspector",
          "trace.jsonl",
        ),
        output.childRunId,
      );
      expect(childTrace.length).toBeGreaterThan(0);
      expect(childTrace).toContain(output.childRunId);
      expect(childTrace).toContain("glob");
      const promptBuilt = childTrace
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((event) => event.type === "prompt.built") as
        | {
            payload?: {
              systemPrefixRef?: string;
            };
          }
        | undefined;
      const systemRef = promptBuilt?.payload?.systemPrefixRef;
      expect(systemRef).toBeTypeOf("string");
      const childSystemPrefix = await readFileWhenReady(
        join(sessionRootDir, sessionId, "blobs", `${systemRef}.json`),
        "Delegated agent contract:",
      );
      expect(childSystemPrefix).toContain("Do not ask the user directly");
      expect(childSystemPrefix).toContain("needs_clarification");

      // (2) The child agent is registered in session.json (not just "main").
      const sessionJson = JSON.parse(
        await readFileWhenReady(
          join(sessionRootDir, sessionId, "session.json"),
          "dynamic_inspector",
        ),
      ) as { agents: string[] };
      expect(sessionJson.agents).toContain("dynamic_inspector");

      // (3) The child's tool + model usage rolled up into the parent tracker,
      //     even though the parent's own loop never ran here.
      const usage = parent.usage();
      expect(usage.toolCalls).toBeGreaterThanOrEqual(1);
      expect(usage.byTool.glob?.calls).toBeGreaterThanOrEqual(1);
      expect(usage.modelCalls).toBeGreaterThanOrEqual(2);
    } finally {
      // Child session-store writes can still be flushing as the run resolves;
      // retry the cleanup rather than racing them into an ENOTEMPTY.
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
    // Generous timeout: the session-store flush is async, so readFileWhenReady
    // may poll for a while on a loaded CI runner (windows-latest has been seen
    // taking >5s). The test budget must exceed the helper's own 12s deadline.
  }, 20000);

  it("promotes slow dynamic spawn_agent work while preserving projection and ledger", async () => {
    const sink = new InMemoryTaskNotificationQueue();
    const taskManager = new TaskManager({
      store: new InMemoryTaskStore(),
      notificationSink: sink,
    });
    let childCalls = 0;
    const childModel: ModelAdapter = {
      async complete() {
        childCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { message: "promoted child done" };
      },
    };
    const globTool: ToolDefinition = defineTool({
      name: "glob",
      description: "Fake glob for the test.",
      inputSchema: {
        type: "object",
        properties: { pattern: { type: "string" } },
      },
      async execute() {
        return { paths: ["README.md"] };
      },
    });
    const parent = createRun({
      goal: "ask a slow child",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      maxSteps: 1,
    });
    const spawnTool = createDynamicSpawnAgentTool({
      getParent: () => parent,
      model: childModel,
      childTools: [globTool],
      parentRunPolicy: createDefaultPolicy(),
      childRunStoreFactory: () => undefined as never,
      foregroundTimeoutMs: 1,
      taskManager,
    });
    const args = {
      goal: "answer slowly",
      role: "slow reader",
      prompt: "Answer after thinking.",
      allowedTools: ["glob"],
      maxSteps: 2,
    };

    const ticket = (await spawnTool.execute(args, {
      run: parent.record,
    } as never)) as {
      promoted: boolean;
      taskId: string;
      childRunId: string;
      spanId: string;
      awaited: boolean;
    };

    expect(ticket).toMatchObject({
      promoted: true,
      awaited: true,
      childRunId: expect.any(String),
      spanId: expect.any(String),
    });
    const terminal = await taskManager
      .handle(ticket.taskId as unknown as TaskId)
      ?.wait();
    expect(terminal).toMatchObject({
      status: "completed",
      awaited: true,
      result: {
        childRunId: ticket.childRunId,
        signal: "completed",
        message: "promoted child done",
      },
    });
    expect(sink.drain()).toMatchObject([
      {
        taskId: ticket.taskId,
        status: "completed",
        kind: "agent",
        title: "spawn_agent: slow reader",
      },
    ]);
    const parentEventTypes = parent.events.all().map((event) => event.type);
    expect(parentEventTypes).toContain("subagent.requested");
    expect(parentEventTypes).toContain("subagent.started");
    expect(parentEventTypes).toContain("subagent.completed");
    const terminalEvent = parent.events
      .all()
      .find((event) => event.type === "subagent.completed");
    expect(terminalEvent?.payload).toMatchObject({
      childRunId: ticket.childRunId,
      terminalState: "completed",
      finality: "complete",
    });
    expect(parent.usage().modelCalls).toBeGreaterThanOrEqual(1);

    const cached = (await spawnTool.execute(args, {
      run: parent.record,
    } as never)) as { alreadyCompleted?: boolean; message?: string };
    expect(cached).toMatchObject({
      alreadyCompleted: true,
      message: "promoted child done",
    });
    expect(childCalls).toBe(1);
  });

  it("task cancellation stops a promoted dynamic spawn_agent child", async () => {
    const taskManager = new TaskManager({ store: new InMemoryTaskStore() });
    const childModel: ModelAdapter = {
      async complete(input) {
        await new Promise((_resolve, reject) => {
          const onAbort = () => {
            const error = new Error("child aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (input.abortSignal?.aborted) onAbort();
          else
            input.abortSignal?.addEventListener("abort", onAbort, {
              once: true,
            });
        });
        return { message: "should not complete" };
      },
    };
    const globTool: ToolDefinition = defineTool({
      name: "glob",
      description: "Fake glob for the test.",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        return { paths: [] };
      },
    });
    const parent = createRun({
      goal: "ask a cancellable child",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      maxSteps: 1,
    });
    const spawnTool = createDynamicSpawnAgentTool({
      getParent: () => parent,
      model: childModel,
      childTools: [globTool],
      parentRunPolicy: createDefaultPolicy(),
      childRunStoreFactory: () => undefined as never,
      foregroundTimeoutMs: 1,
      taskManager,
    });

    const ticket = (await spawnTool.execute(
      {
        goal: "wait until cancelled",
        role: "cancellable",
        prompt: "Wait.",
        allowedTools: ["glob"],
        maxSteps: 2,
      },
      { run: parent.record } as never,
    )) as { taskId: string };

    const handle = taskManager.handle(ticket.taskId as unknown as TaskId);
    await handle?.cancel();

    expect(handle?.record.status).toBe("cancelled");
    const failedEvent = parent.events
      .all()
      .find((event) => event.type === "subagent.failed");
    expect(failedEvent?.payload).toMatchObject({
      reason: "cancelled",
      terminalState: "cancelled",
      finality: "partial",
    });
  });

  it("foreground-only background policy keeps dynamic spawn_agent inline", async () => {
    const taskManager = new TaskManager({ store: new InMemoryTaskStore() });
    const childModel: ModelAdapter = {
      async complete() {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { message: "inline child done" };
      },
    };
    const globTool: ToolDefinition = defineTool({
      name: "glob",
      description: "Fake glob for the test.",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        return { paths: [] };
      },
    });
    const parent = createRun({
      goal: "ask a foreground-only child",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      maxSteps: 1,
    });
    const spawnTool = createDynamicSpawnAgentTool({
      getParent: () => parent,
      model: childModel,
      childTools: [globTool],
      parentRunPolicy: createDefaultPolicy(),
      childRunStoreFactory: () => undefined as never,
      foregroundTimeoutMs: 1,
      taskManager,
      backgroundTasks: "foreground-only",
    });

    const output = (await spawnTool.execute(
      {
        goal: "answer slowly inline",
        role: "inline",
        prompt: "Wait then answer.",
        allowedTools: ["glob"],
        maxSteps: 2,
      },
      { run: parent.record } as never,
    )) as { promoted?: boolean; message?: string };

    expect(output).toMatchObject({ message: "inline child done" });
    expect(output.promoted).toBeUndefined();
    expect(taskManager.store.list()).toHaveLength(0);
  });

  it("allows opt-in depth-bounded sub-agents to create awaited agent tasks", async () => {
    const queue = new InMemoryTaskNotificationQueue();
    const taskManager = new TaskManager({
      store: new InMemoryTaskStore(),
      notificationSink: queue,
    });
    const runById = new Map<RunId, ReturnType<typeof createRun>>();
    const parentPolicy = createDefaultPolicy();
    const globTool: ToolDefinition = defineTool({
      name: "glob",
      description: "Fake glob for the test.",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        return { paths: [] };
      },
    });
    const grandchildModel: ModelAdapter = {
      async complete() {
        return { message: "grandchild nested result" };
      },
    };
    taskManager.registerKind("agent", (controller, payload) => {
      const task = taskManager.store.get(controller.taskId);
      const parent = task ? runById.get(task.parentRunId) : undefined;
      return runHostAgentTask(controller, payload, {
        getParent: () => parent,
        model: grandchildModel,
        modelForSpawn: async () => grandchildModel,
        childTools: [globTool],
        parentRunPolicy: parentPolicy,
        childRunStoreFactory: () => undefined as never,
        maxDepth: 2,
        taskManager,
        backgroundTasks: "enabled",
        foregroundTimeoutMs: 1,
        allowNestedBackgroundTasks: true,
        createTaskRevivalBridge: (getRunId) =>
          createTestTaskRevivalBridge({
            queue,
            manager: taskManager,
            getRunId,
          }),
        registerSubagentRun: (run) => {
          runById.set(run.record.id, run);
          return () => runById.delete(run.record.id);
        },
      });
    });
    let childCalls = 0;
    const childModel: ModelAdapter = {
      async complete(input) {
        const taskNotification = input.context.find((item) =>
          item.content.includes("Task "),
        );
        if (taskNotification) {
          return { message: "child saw nested completion" };
        }
        childCalls += 1;
        if (childCalls === 1) {
          return {
            toolCalls: [
              {
                toolName: "task_create",
                arguments: {
                  kind: "agent",
                  mode: "awaited",
                  payload: {
                    goal: "answer from nested child",
                    role: "nested",
                    prompt: "Return the nested result.",
                    allowedTools: ["glob"],
                    maxSteps: 1,
                  },
                },
              },
            ],
          };
        }
        return { message: "waiting for nested task" };
      },
    };
    const parent = createRun({
      goal: "ask a child to create a nested background task",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      maxSteps: 1,
    });
    const spawnTool = createDynamicSpawnAgentTool({
      getParent: () => parent,
      model: childModel,
      childTools: [globTool],
      parentRunPolicy: parentPolicy,
      childRunStoreFactory: () => undefined as never,
      taskManager,
      backgroundTasks: "enabled",
      foregroundTimeoutMs: 1_000,
      allowNestedBackgroundTasks: true,
      createTaskRevivalBridge: (getRunId) =>
        createTestTaskRevivalBridge({ queue, manager: taskManager, getRunId }),
      registerSubagentRun: (run) => {
        runById.set(run.record.id, run);
        return () => runById.delete(run.record.id);
      },
    });

    const output = (await spawnTool.execute(
      {
        goal: "create a nested agent task and wait for it",
        role: "nested coordinator",
        prompt: "Use task_create and report when the nested task completes.",
        allowedTools: ["task_create"],
        maxSteps: 5,
      },
      { run: parent.record } as never,
    )) as { message?: string; signal?: string };

    const nestedTasks = taskManager.store.list({ kind: "agent" });
    expect(output).toMatchObject({
      signal: "completed",
      message: "child saw nested completion",
    });
    expect(nestedTasks).toHaveLength(1);
    expect(nestedTasks[0]).toMatchObject({
      status: "completed",
      awaited: false,
    });
    expect(nestedTasks[0]?.parentRunId).not.toBe(parent.record.id);
  });

  it("keeps nested background agent spawning bounded by maxDepth", async () => {
    const parent = createRun({
      goal: "nested parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      metadata: {
        parentRunId: "run_top",
        subagentDepth: 1,
      },
      maxSteps: 1,
    });
    const spawnTool = createDynamicSpawnAgentTool({
      getParent: () => parent,
      model: {
        async complete() {
          return { message: "nested done" };
        },
      },
      childTools: [createReadFileTool()],
      parentRunPolicy: createDefaultPolicy(),
      childRunStoreFactory: () => undefined as never,
      maxDepth: 1,
      allowNestedBackgroundTasks: true,
    });

    await expect(
      spawnTool.execute(
        {
          goal: "exceed max depth",
          role: "too deep",
          prompt: "Return.",
          allowedTools: ["read"],
        },
        { run: parent.record } as never,
      ),
    ).rejects.toThrow("capabilities.agents.maxDepth (1)");
  });

  it("enforces maxDepth before spawning a dynamic child", async () => {
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      maxSteps: 1,
    });
    const spawnTool = createDynamicSpawnAgentTool({
      getParent: () => parent,
      model: {
        async complete() {
          return { message: "child done" };
        },
      },
      childTools: [createReadFileTool()],
      parentRunPolicy: createDefaultPolicy(),
      maxDepth: 0,
      childRunStoreFactory: (childAgentId: string) =>
        createSessionRunStoreFactory({
          sessionStore: new FileSessionStore({
            rootDir: join(tmpdir(), "sparkwright-unused-session"),
          }),
          sessionId: "unused",
          runStoreFactory: createSessionFileRunStoreFactory({
            sessionRootDir: tmpdir(),
            sessionId: "unused",
            agentId: childAgentId,
            traceLevel: "standard",
          }),
          metadata: { source: "test" },
        }),
    });

    await expect(
      spawnTool.execute(
        {
          goal: "read",
          role: "reader",
          prompt: "Read.",
          allowedTools: ["read_file"],
        },
        { run: parent.record } as never,
      ),
    ).rejects.toThrow("capabilities.agents.maxDepth (0)");
  });

  it("applies parent read-scope policy to dynamic child workspace reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-host-spawn-read-"));
    try {
      await writeFile(join(root, "secret.txt"), "child-must-not-see\n", "utf8");
      const sessionId = "session_spawn_read_scope";
      const childRunStoreFactory = (childAgentId: string) =>
        createSessionFileRunStoreFactory({
          sessionRootDir: root,
          sessionId,
          agentId: childAgentId,
          traceLevel: "standard",
        });
      let childCalls = 0;
      const childModel: ModelAdapter = {
        async complete() {
          childCalls += 1;
          if (childCalls === 1) {
            return {
              toolCalls: [
                { toolName: "read_file", arguments: { path: "secret.txt" } },
              ],
            };
          }
          return { message: "read denied" };
        },
      };
      const parentPolicy = createWorkspaceReadScopePolicy({
        confidentialPaths: ["secret.txt"],
      });
      const parent = createRun({
        goal: "ask a child to read a confidential file",
        model: {
          async complete() {
            return { message: "parent done" };
          },
        },
        workspace: new LocalWorkspace(root),
        policy: parentPolicy,
        maxSteps: 1,
      });
      const spawnTool = createDynamicSpawnAgentTool({
        getParent: () => parent,
        model: childModel,
        childTools: [createReadFileTool()],
        parentRunPolicy: parentPolicy,
        childRunStoreFactory,
      });

      const output = (await spawnTool.execute(
        {
          goal: "read secret.txt",
          role: "reader",
          prompt: "Read secret.txt and report what happens.",
          allowedTools: ["read_file"],
          maxSteps: 3,
        },
        { run: parent.record } as never,
      )) as { message?: string };

      expect(output.message).toBe("read denied");
      const childTrace = await readFileWhenReady(
        join(root, sessionId, "agents", "dynamic_reader", "trace.jsonl"),
        "READ_SCOPE_DENIED",
      );
      expect(childTrace).toContain("workspace.read.denied");
      expect(childTrace).not.toContain("child-must-not-see");
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  }, 20000);

  it("flags stepLimitReached when the child answers on its last allowed step", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-host-spawn-cap-"));
    try {
      const sessionId = "session_spawn_cap";
      const sessionStore = new FileSessionStore({ rootDir: root });
      const childRunStoreFactory = (childAgentId: string) =>
        createSessionRunStoreFactory({
          sessionStore,
          sessionId,
          runStoreFactory: createSessionFileRunStoreFactory({
            sessionRootDir: root,
            sessionId,
            agentId: childAgentId,
            traceLevel: "standard",
          }),
          metadata: { source: "host" },
        });

      // Child answers immediately (step 1) but maxSteps is 1, so it finishes
      // with zero budget left: a final_answer that may have been cut short.
      const childModel: ModelAdapter = {
        async complete() {
          return { message: "partial list: README.md, ... (more omitted)" };
        },
      };

      const parent = createRun({
        goal: "ask a child to list files under a tight budget",
        model: {
          async complete() {
            return { message: "parent done" };
          },
        },
        maxSteps: 1,
        runStore: childRunStoreFactory("main"),
      });

      const spawnTool = createDynamicSpawnAgentTool({
        getParent: () => parent,
        model: childModel,
        childTools: [
          defineTool({
            name: "glob",
            description: "Fake glob.",
            inputSchema: { type: "object", properties: {} },
            async execute() {
              return { paths: [] };
            },
          }),
        ],
        parentRunPolicy: createDefaultPolicy(),
        childRunStoreFactory,
      });

      const output = (await spawnTool.execute(
        {
          goal: "list files",
          role: "inspector",
          prompt: "List the files.",
          allowedTools: ["glob"],
          maxSteps: 1,
        },
        { run: parent.record } as never,
      )) as {
        signal: string;
        stopReason: string;
        stepLimitReached?: boolean;
        truncated?: boolean;
        finality?: string;
        message?: string;
      };

      expect(output.signal).toBe("completed");
      expect(output.stopReason).toBe("final_answer");
      expect(output.stepLimitReached).toBe(true);
      expect(output.truncated).toBe(true);
      expect(output.finality).toBe("partial");
      expect(output.message).toContain("hit its step budget");
      expect(output.message).toContain("partial list");
    } finally {
      // Child session-store writes can still be flushing as the run resolves;
      // retry the cleanup rather than racing them into an ENOTEMPTY.
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  // The parent allocates the child's step budget via `maxSteps`. Omitted child
  // budgets inherit the parent run's effective ceiling; explicit child budgets
  // are honored without a host-side cap. The effective value is observable
  // through the promotion hint's suggested profile.
  it("inherits parent maxSteps by default and honors explicit high budgets", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sparkwright-host-spawn-budget-"),
    );
    try {
      const sessionId = "session_spawn_budget";
      const sessionStore = new FileSessionStore({ rootDir: root });
      const childRunStoreFactory = (childAgentId: string) =>
        createSessionRunStoreFactory({
          sessionStore,
          sessionId,
          runStoreFactory: createSessionFileRunStoreFactory({
            sessionRootDir: root,
            sessionId,
            agentId: childAgentId,
            traceLevel: "standard",
          }),
          metadata: { source: "host" },
        });

      const makeParent = () =>
        createRun({
          goal: "allocate a child budget",
          model: {
            async complete() {
              return { message: "parent done" };
            },
          },
          maxSteps: 27,
          runStore: childRunStoreFactory("main"),
        });

      const childModel: ModelAdapter = {
        async complete() {
          return { message: "done" };
        },
      };
      const childTools = [
        defineTool({
          name: "glob",
          description: "Fake glob.",
          inputSchema: { type: "object", properties: {} },
          async execute() {
            return { paths: [] };
          },
        }),
      ];

      type Output = {
        promotionHint: { suggestedProfile: { maxSteps: number } };
      };
      const allocate = async (maxSteps?: number): Promise<number> => {
        const parent = makeParent();
        const spawnTool = createDynamicSpawnAgentTool({
          getParent: () => parent,
          model: childModel,
          childTools,
          parentRunPolicy: createDefaultPolicy(),
          childRunStoreFactory,
        });
        const output = (await spawnTool.execute(
          {
            goal: "list files",
            role: "inspector",
            prompt: "List the files.",
            allowedTools: ["glob"],
            ...(maxSteps === undefined ? {} : { maxSteps }),
          },
          { run: parent.record } as never,
        )) as Output;
        return output.promotionHint.suggestedProfile.maxSteps;
      };

      expect(await allocate(100)).toBe(100);
      expect(await allocate()).toBe(27);
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  // A real trace showed a search child burn its whole step budget on filename
  // globs and never find a *function named* frobnicate — because glob
  // only matches paths and the child had no content search. grep must be
  // an allowed, executable child tool so "find symbol X" is one call.
  it("lets a spawned child request and run grep", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-host-spawn-grep-"));
    try {
      const sessionId = "session_spawn_grep";
      const sessionStore = new FileSessionStore({ rootDir: root });
      const childRunStoreFactory = (childAgentId: string) =>
        createSessionRunStoreFactory({
          sessionStore,
          sessionId,
          runStoreFactory: createSessionFileRunStoreFactory({
            sessionRootDir: root,
            sessionId,
            agentId: childAgentId,
            traceLevel: "standard",
          }),
          metadata: { source: "host" },
        });

      let grepCalls = 0;
      const grepTool = defineTool({
        name: "grep",
        description: "Fake content search.",
        inputSchema: {
          type: "object",
          properties: { pattern: { type: "string" } },
        },
        async execute() {
          grepCalls += 1;
          return { matches: [] };
        },
      });

      // Child uses grep once, then concludes.
      const childModel: ModelAdapter = {
        async complete(input) {
          const used = input.context.some((item) =>
            item.content.includes("grep"),
          );
          return used
            ? { message: "no symbol named frobnicate found" }
            : {
                toolCalls: [
                  {
                    toolName: "grep",
                    arguments: { pattern: "frobnicate" },
                  },
                ],
              };
        },
      };

      const parent = createRun({
        goal: "find a symbol by name",
        model: {
          async complete() {
            return { message: "parent done" };
          },
        },
        maxSteps: 1,
        runStore: childRunStoreFactory("main"),
      });

      const spawnTool = createDynamicSpawnAgentTool({
        getParent: () => parent,
        model: childModel,
        childTools: [grepTool],
        parentRunPolicy: createDefaultPolicy(),
        childRunStoreFactory,
      });

      const output = (await spawnTool.execute(
        {
          goal: "find frobnicate",
          role: "scout",
          prompt: "Find a function named frobnicate.",
          allowedTools: ["grep"],
        },
        { run: parent.record } as never,
      )) as { signal: string };

      expect(output.signal).toBe("completed");
      expect(grepCalls).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  // Models sometimes feed a prior child's derived id (e.g. `dynamic_inspector`)
  // back in as the new `role`. The id derivation must collapse the redundant
  // prefix instead of compounding it into `dynamic_dynamic_inspector`.
  it("does not double the dynamic_ prefix when role already carries it", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sparkwright-host-spawn-prefix-"),
    );
    try {
      const sessionId = "session_spawn_prefix";
      const sessionStore = new FileSessionStore({ rootDir: root });
      const childRunStoreFactory = (childAgentId: string) =>
        createSessionRunStoreFactory({
          sessionStore,
          sessionId,
          runStoreFactory: createSessionFileRunStoreFactory({
            sessionRootDir: root,
            sessionId,
            agentId: childAgentId,
            traceLevel: "standard",
          }),
          metadata: { source: "host" },
        });

      const childModel: ModelAdapter = {
        async complete() {
          return { message: "done" };
        },
      };

      const noopTool = defineTool({
        name: "glob",
        description: "Fake glob for the test.",
        inputSchema: { type: "object", properties: {} },
        async execute() {
          return { paths: [] };
        },
      });

      const parent = createRun({
        goal: "spawn with a pre-prefixed role",
        model: {
          async complete() {
            return { message: "parent done" };
          },
        },
        maxSteps: 1,
        runStore: childRunStoreFactory("main"),
      });

      const spawnTool = createDynamicSpawnAgentTool({
        getParent: () => parent,
        model: childModel,
        childTools: [noopTool],
        parentRunPolicy: createDefaultPolicy(),
        childRunStoreFactory,
      });

      const output = (await spawnTool.execute(
        {
          goal: "noop",
          role: "dynamic_inspector",
          prompt: "Answer immediately.",
          allowedTools: ["glob"],
        },
        { run: parent.record } as never,
      )) as { agentId: string };

      expect(output.agentId).toBe("dynamic_inspector");
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  // A child that discovered data but then tripped the doom-loop guard must not
  // hand the parent only an error string — its last successful tool results are
  // salvaged into `partialObservations` so the parent can use the work instead
  // of re-spawning to rediscover it.
  it("surfaces the child's last successful tool results when the run fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-host-spawn-fail-"));
    try {
      const sessionId = "session_spawn_fail";
      const sessionStore = new FileSessionStore({ rootDir: root });
      const childRunStoreFactory = (childAgentId: string) =>
        createSessionRunStoreFactory({
          sessionStore,
          sessionId,
          runStoreFactory: createSessionFileRunStoreFactory({
            sessionRootDir: root,
            sessionId,
            agentId: childAgentId,
            traceLevel: "standard",
          }),
          metadata: { source: "host" },
        });

      // The child glob succeeds once, then the model keeps re-issuing the exact
      // same call until the doom-loop guard stops the run (failed, no answer).
      const childModel: ModelAdapter = {
        async complete() {
          return {
            toolCalls: [{ toolName: "glob", arguments: { patterns: ["*"] } }],
          };
        },
      };

      const globTool: ToolDefinition = defineTool({
        name: "glob",
        description: "Fake glob for the test.",
        inputSchema: {
          type: "object",
          properties: {
            patterns: { type: "array", items: { type: "string" } },
          },
        },
        async execute() {
          return { paths: ["packages/a/a.test.ts"], totalPaths: 1 };
        },
      });

      const parent = createRun({
        goal: "spawn a child that will doom-loop",
        model: {
          async complete() {
            return { message: "parent done" };
          },
        },
        maxSteps: 1,
        runStore: childRunStoreFactory("main"),
      });

      const spawnTool = createDynamicSpawnAgentTool({
        getParent: () => parent,
        model: childModel,
        childTools: [globTool],
        parentRunPolicy: createDefaultPolicy(),
        childRunStoreFactory,
      });

      let thrown: unknown;
      try {
        await spawnTool.execute(
          {
            goal: "count test files",
            role: "counter",
            prompt: "Count test files with glob.",
            allowedTools: ["glob"],
            maxSteps: 5,
          },
          { run: parent.record } as never,
        );
      } catch (error) {
        thrown = error;
      }

      // Failure is surfaced as a thrown tool error carrying a structured
      // `code` + `metadata` (so `normalizeExecutionError` preserves it and the
      // observation formatter renders metadata untruncated). The human message
      // stays short — the salvaged data lives in metadata, not a JSON blob that
      // the 500-char message truncation would cut off.
      expect(thrown).toBeInstanceOf(Error);
      const err = thrown as Error & {
        code?: string;
        metadata?: {
          signal?: string;
          stopReason?: string;
          truncated?: boolean;
          finality?: string;
          partialObservations?: { toolName: string; output: string }[];
        };
      };
      expect(err.code).toBe("SPAWN_AGENT_CHILD_INCOMPLETE");
      expect(err.message).not.toContain("{");
      expect(err.metadata?.signal).toBe("failed");
      expect(err.metadata?.stopReason).toBe("tool_doom_loop");
      expect(err.metadata?.truncated).toBe(false);
      expect(err.metadata?.finality).toBe("partial");

      // The child's discovered data rides along in metadata for the parent.
      const observations = err.metadata?.partialObservations;
      expect(observations).toBeDefined();
      expect(observations?.length).toBeGreaterThanOrEqual(1);
      expect(observations?.[0]?.toolName).toBe("glob");
      expect(observations?.[0]?.output).toContain("packages/a/a.test.ts");
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });
});
