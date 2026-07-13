import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDefaultPolicy,
  createRun,
  createSessionFileRunStoreFactory,
  createSessionRunStoreFactory,
  defineTool,
  FileSessionStore,
  type ModelAdapter,
  type RuntimeContext,
  type ToolDefinition,
} from "@sparkwright/core";
import {
  InMemoryTaskStore,
  TaskManager,
  type TaskRunner,
} from "@sparkwright/agent-runtime";
import { runHostAgentTask } from "../src/runtime.js";
import {
  lifecycleTypes,
  projectAgentLifecycle,
  terminalLifecycleCount,
} from "./helpers/agent-lifecycle.js";

/**
 * Coverage for the background `agent` task kind. `HostRuntime.runAgentTask`
 * delegates to `runHostAgentTask`, which drives a read-only child run with the
 * child's external abort bound to the *task* controller's signal
 * (`abortSignal: controller.signal`), so the task, not the foreground turn,
 * owns the child lifecycle. These tests exercise that shared runner through a
 * TaskManager and assert the two behaviors the design hinges on:
 *   1. `task_stop` (handle.cancel) tears down the child and marks the task
 *      cancelled;
 *   2. an un-stopped agent task runs the child to completion.
 */
describe("background agent task runner", () => {
  interface Harness {
    root: string;
    parent: ReturnType<typeof createRun>;
    childRunStoreFactory: (
      childAgentId: string,
    ) => ReturnType<typeof createSessionRunStoreFactory>;
  }

  async function makeHarness(sessionId: string): Promise<Harness> {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-agent-task-"));
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
    const parent = createRun({
      goal: "run a background agent",
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
          sessionRootDir: root,
          sessionId,
          agentId: "main",
          traceLevel: "standard",
        }),
        metadata: { source: "host" },
      }),
    });
    return { root, parent, childRunStoreFactory };
  }

  function registerAgentKind(
    manager: TaskManager,
    harness: Harness,
    childModel: ModelAdapter,
    childTools: ToolDefinition[],
  ): void {
    const runner: TaskRunner = async (controller, payload) => {
      return runHostAgentTask(controller, payload, {
        getParent: () => harness.parent,
        model: childModel,
        modelForSpawn: async () => childModel,
        childTools,
        parentRunPolicy: createDefaultPolicy(),
        childRunStoreFactory: harness.childRunStoreFactory,
      });
    };
    manager.registerKind("agent", runner);
  }

  it("task_stop cancels the child run and marks the task cancelled", async () => {
    const harness = await makeHarness("session_agent_task_stop");
    try {
      const manager = new TaskManager({ store: new InMemoryTaskStore() });
      let started: () => void = () => {};
      const startedGate = new Promise<void>((resolve) => {
        started = resolve;
      });
      // A child tool that parks until the run is aborted — simulating a
      // long-running background agent that task_stop must tear down. No
      // step-limit race: the child is blocked inside the tool call until abort.
      const waitTool = defineTool({
        name: "grep",
        description: "Parks until the child run is cancelled.",
        inputSchema: {
          type: "object",
          properties: { pattern: { type: "string" } },
        },
        async execute(_args, ctx) {
          started();
          const signal = (ctx as RuntimeContext).abortSignal;
          await new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return { matches: [] };
        },
      });
      const childModel: ModelAdapter = {
        async complete() {
          // Never answers on its own — keeps working until cancelled.
          return {
            toolCalls: [{ toolName: "grep", arguments: { pattern: "x" } }],
          };
        },
      };
      registerAgentKind(manager, harness, childModel, [waitTool]);

      const handle = manager.spawn({
        parentRunId: harness.parent.record.id,
        kind: "agent",
        payload: {
          goal: "watch the repo",
          role: "watcher",
          prompt: "Keep grepping.",
          allowedTools: ["grep"],
          maxSteps: 20,
        },
      });

      await startedGate; // child has issued its first tool call and parked
      await withTimeout(handle.cancel(), 2000, "agent task cancel"); // <- task_stop

      expect(handle.record.status).toBe("cancelled");
      expect(lifecycleTypes(harness.parent.events.all())).toEqual([
        "subagent.requested",
        "subagent.started",
        "subagent.failed",
      ]);
      expect(terminalLifecycleCount(harness.parent.events.all())).toBe(1);
      expect(projectAgentLifecycle(harness.parent.events.all())).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            entrypoint: "agent_task",
            taskId: handle.record.id,
            identityConsistent: true,
          }),
          expect.objectContaining({
            type: "subagent.failed",
            terminalState: "cancelled",
          }),
        ]),
      );
    } finally {
      await rmWhenReady(harness.root);
    }
  });

  it("runs the child to completion when the task is not stopped", async () => {
    const harness = await makeHarness("session_agent_task_done");
    try {
      const manager = new TaskManager({ store: new InMemoryTaskStore() });
      let globCalls = 0;
      const globTool = defineTool({
        name: "glob",
        description: "Fake glob for the test.",
        inputSchema: {
          type: "object",
          properties: { pattern: { type: "string" } },
        },
        async execute() {
          globCalls += 1;
          return { paths: ["README.md"] };
        },
      });
      const childModel: ModelAdapter = {
        async complete(input) {
          const used = input.context.some((item) =>
            item.content.includes("glob"),
          );
          return used
            ? { message: "top-level: README.md" }
            : {
                toolCalls: [{ toolName: "glob", arguments: { pattern: "*" } }],
              };
        },
      };
      registerAgentKind(manager, harness, childModel, [globTool]);

      const handle = manager.spawn({
        parentRunId: harness.parent.record.id,
        kind: "agent",
        payload: {
          goal: "list top-level files",
          role: "inspector",
          prompt: "List files with glob.",
          allowedTools: ["glob"],
          maxSteps: 4,
        },
      });

      const record = await handle.wait();
      expect(record.status).toBe("completed");
      const result = record.result as {
        childRunId: string;
        signal: string;
      };
      expect(result.signal).toBe("completed");
      expect(result.childRunId).toMatch(/^run_/);
      expect(globCalls).toBe(1);
      expect(
        lifecycleTypes(harness.parent.events.all(), result.childRunId),
      ).toEqual([
        "subagent.requested",
        "subagent.started",
        "subagent.completed",
      ]);
      expect(
        projectAgentLifecycle(
          harness.parent.events.all(),
          result.childRunId,
        ).every(
          (event) =>
            event.entrypoint === "agent_task" &&
            event.taskId === handle.record.id &&
            event.identityConsistent,
        ),
      ).toBe(true);
      expect(
        terminalLifecycleCount(harness.parent.events.all(), result.childRunId),
      ).toBe(1);
    } finally {
      await rmWhenReady(harness.root);
    }
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

async function rmWhenReady(path: string, attempts = 5): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EPERM" && code !== "EACCES") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}
