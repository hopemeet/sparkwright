import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDefaultPolicy,
  createRun,
  createSessionRunStoreFactory,
  defineTool,
  FileSessionStore,
  type ModelAdapter,
  type RuntimeContext,
  type ToolDefinition,
} from "@sparkwright/core";
import { createSessionFileRunStoreFactory } from "@sparkwright/core/internal";
import {
  IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT,
  InMemoryTaskStore,
  TaskManager,
  type TaskRunner,
} from "@sparkwright/agent-runtime";
import { runHostAgentTask } from "../src/runtime.js";
import { createReadAgentReportTool } from "../src/agent-report-tool.js";
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
 *   1. `task(action="stop")` (handle.cancel) tears down the child and marks the task
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
      maxSteps: 4,
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

  it("task stop cancels the child run and marks the task cancelled", async () => {
    const harness = await makeHarness("session_agent_task_control_stop");
    try {
      const manager = new TaskManager({ store: new InMemoryTaskStore() });
      let started: () => void = () => {};
      const startedGate = new Promise<void>((resolve) => {
        started = resolve;
      });
      // A child tool that parks until the run is aborted — simulating a
      // long-running background agent that task(action="stop") must tear down. No
      // step-limit race: the child is blocked inside the tool call until abort.
      const waitTool = defineTool({
        name: "grep",
        description: "Parks until the child run is cancelled.",
        inputSchema: {
          type: "object",
          properties: { pattern: { type: "string" } },
        },
        delegation: "child",
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
          label: "watcher",
          context: "Keep grepping.",
        },
      });

      await startedGate; // child has issued its first tool call and parked
      await withTimeout(handle.cancel(), 2000, "agent task cancel");

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
        delegation: "child",
        async execute() {
          globCalls += 1;
          return { paths: ["README.md"] };
        },
      });
      let firstChildPrompt: unknown;
      const childModel: ModelAdapter = {
        async complete(input) {
          firstChildPrompt ??= input.prompt;
          const used = input.context.some(
            (item) =>
              item.type === "tool_result" && item.metadata.toolName === "glob",
          );
          return used
            ? {
                message: "top-level: README.md",
              }
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
          label: "inspector",
          context: "List files with glob.",
        },
      });

      const record = await handle.wait();
      expect(record.status).toBe("completed");
      const result = record.result as {
        childRunId: string;
        status: string;
        report: string;
        workspace: { writes: number };
      };
      expect(result).toMatchObject({
        status: "completed",
        report: "top-level: README.md",
        workspace: { writes: 0 },
      });
      expect(result.childRunId).toMatch(/^run_/);
      expect(globCalls).toBe(1);
      const promptMessages = firstChildPrompt as Array<{
        role?: unknown;
        content?: unknown;
      }>;
      const systemText = promptMessages
        .filter((message) => message.role === "system")
        .map((message) => String(message.content ?? ""))
        .join("\n");
      const userText = promptMessages
        .filter((message) => message.role === "user")
        .map((message) => String(message.content ?? ""))
        .join("\n");
      expect(systemText).toContain(IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT);
      expect(systemText).not.toContain("List files with glob.");
      expect(userText).toContain("list top-level files");
      expect(userText).toContain("Parent handoff context:");
      expect(userText).toContain("List files with glob.");
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

  it("normalizes persisted legacy task fields without restoring authority", async () => {
    const harness = await makeHarness("session_agent_task_legacy_payload");
    try {
      const manager = new TaskManager({ store: new InMemoryTaskStore() });
      let observedTools: string[] = [];
      const childModel: ModelAdapter = {
        async complete(input) {
          observedTools = input.tools.map((tool) => tool.name);
          return { message: "legacy task completed" };
        },
      };
      registerAgentKind(manager, harness, childModel, []);

      const handle = manager.spawn({
        parentRunId: harness.parent.record.id,
        kind: "agent",
        payload: {
          goal: "inspect persisted work",
          role: "legacy reviewer",
          allowedTools: ["bash"],
          grant: { workspaceWrite: true },
        },
      });

      const record = await handle.wait();
      expect(record.error).toBeUndefined();
      expect(record).toMatchObject({
        status: "completed",
        result: {
          status: "completed",
          report: "legacy task completed",
        },
      });
      expect(observedTools).toEqual([]);
    } finally {
      await rmWhenReady(harness.root);
    }
  });

  it("keeps the full task result while emitting an explicit bounded receipt", async () => {
    const sessionId = "session_agent_task_long_report";
    const harness = await makeHarness(sessionId);
    try {
      const manager = new TaskManager({ store: new InMemoryTaskStore() });
      const report = "background child report ".repeat(300).trim();
      registerAgentKind(
        manager,
        harness,
        {
          async complete() {
            return { message: report };
          },
        },
        [
          defineTool({
            name: "read",
            description: "Unused read capability.",
            inputSchema: { type: "object" },
            delegation: "child",
            execute: () => ({ content: "unused" }),
          }),
        ],
      );

      const handle = manager.spawn({
        parentRunId: harness.parent.record.id,
        kind: "agent",
        payload: {
          goal: "return a long report",
          label: "long reporter",
        },
      });

      const record = await handle.wait();
      expect(record.status).toBe("completed");
      expect((record.result as { report?: string } | undefined)?.report).toBe(
        report,
      );
      const chunks = [];
      for await (const chunk of handle.output()) chunks.push(chunk);
      const receipt = JSON.parse(chunks[0]?.data ?? "{}");
      expect(receipt).toMatchObject({
        type: "agent.completed",
        taskId: record.id,
        report: report.slice(0, 4_000),
        reportTruncated: true,
        reportChars: report.length,
        reportOmittedChars: report.length - 4_000,
        resultRef: {
          tool: "task",
          action: "get",
          taskId: record.id,
        },
      });

      const childRunId = (record.result as { childRunId: string }).childRunId;
      const sessionStore = new FileSessionStore({ rootDir: harness.root });
      await sessionStore.append(sessionId, harness.parent.record.id as never);
      const reportTool = createReadAgentReportTool({
        sessionRootDir: harness.root,
        sessionId,
      });
      const firstPage = (await reportTool.execute(
        { childRunId, limit: 4_000 },
        {} as never,
      )) as {
        report: string;
        nextOffset: number;
        totalChars: number;
        hasMore: boolean;
      };
      expect(firstPage).toMatchObject({
        report: report.slice(0, 4_000),
        totalChars: report.length,
        hasMore: true,
        nextOffset: 4_000,
      });
      await expect(
        reportTool.execute(
          { childRunId, offset: firstPage.nextOffset, limit: 4_000 },
          {} as never,
        ),
      ).resolves.toMatchObject({
        report: report.slice(4_000),
        totalChars: report.length,
        hasMore: false,
      });
    } finally {
      await rmWhenReady(harness.root);
    }
  });

  it("retains child failure evidence on the failed task record", async () => {
    const harness = await makeHarness("session_agent_task_failure_evidence");
    try {
      const manager = new TaskManager({ store: new InMemoryTaskStore() });
      const globTool = defineTool({
        name: "glob",
        description: "Return one useful partial observation.",
        inputSchema: { type: "object" },
        delegation: "child",
        execute: () => ({ paths: ["README.md"] }),
      });
      registerAgentKind(
        manager,
        harness,
        {
          async complete(input) {
            const used = input.context.some(
              (item) =>
                item.type === "tool_result" &&
                item.metadata.toolName === "glob",
            );
            if (used) {
              const error = new Error("child model aborted unexpectedly");
              error.name = "AbortError";
              throw error;
            }
            return {
              toolCalls: [{ toolName: "glob", arguments: { pattern: "*" } }],
            };
          },
        },
        [globTool],
      );

      const handle = manager.spawn({
        parentRunId: harness.parent.record.id,
        kind: "agent",
        payload: {
          goal: "collect evidence, then fail",
          label: "partial reporter",
        },
      });

      const record = await handle.wait();
      expect(record).toMatchObject({
        status: "failed",
        error: {
          code: "SPAWN_AGENT_CHILD_INCOMPLETE",
          metadata: {
            childRunId: expect.stringMatching(/^run_/),
            agentId: expect.stringMatching(/^dynamic_agent_/),
            role: "partial reporter",
            status: "partial",
            assessment: expect.objectContaining({
              schemaVersion: "run-assessment.v1",
            }),
            stepLimitReached: false,
            truncated: false,
            workspace: { writes: 0 },
            partialObservations: [
              {
                toolName: "glob",
                output: '{"paths":["README.md"]}',
              },
            ],
          },
        },
      });
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
