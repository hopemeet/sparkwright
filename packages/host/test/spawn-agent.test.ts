import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDefaultPolicy,
  createLayeredPolicy,
  createPermissionModePolicy,
  createRun,
  createSessionFileRunStoreFactory,
  createSessionRunStoreFactory,
  createWorkspaceMutationPolicy,
  createWorkspaceReadScopePolicy,
  defineTool,
  FileSessionStore,
  isToolConcurrencySafe,
  LocalWorkspace,
  type ModelAdapter,
  type ToolDefinition,
} from "@sparkwright/core";
import {
  InMemoryTaskNotificationQueue,
  InMemoryTaskStore,
  TaskManager,
  type TaskId,
} from "@sparkwright/agent-runtime";
import {
  assertReadOnlyChildCanSatisfyGoal,
  createDynamicSpawnAgentTool,
  detectReadOnlyChildIntent,
} from "../src/runtime.js";
import { createReadFileTool } from "../src/tools.js";
import { createDynamicChildToolCatalog } from "../src/tool-catalog.js";
import {
  lifecycleTypes,
  projectAgentLifecycle,
  terminalLifecycleCount,
} from "./helpers/agent-lifecycle.js";

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
  it("allows read-only spawn calls to batch but serializes write grants", () => {
    const spawnTool = createDynamicSpawnAgentTool({
      getParent: () => undefined,
      model: {
        async complete() {
          return { message: "unused" };
        },
      },
      childTools: [],
      parentRunPolicy: createDefaultPolicy(),
      childRunStoreFactory: () => undefined as never,
    });
    const base = {
      goal: "Inspect the project.",
      role: "reader",
      prompt: "Read and report.",
    };

    expect(isToolConcurrencySafe(spawnTool, base)).toBe(true);
    expect(
      isToolConcurrencySafe(spawnTool, {
        ...base,
        grant: { workspaceWrite: true },
      }),
    ).toBe(false);
    expect(
      isToolConcurrencySafe(spawnTool, {
        ...base,
        allowedTools: ["edit"],
      }),
    ).toBe(false);
    expect(isToolConcurrencySafe(spawnTool, { ...base, grant: "write" })).toBe(
      false,
    );
  });

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

  it("gates dynamic workspace write grants through the parent run before spawning", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-host-spawn-gate-"));
    try {
      let childCalls = 0;
      const childModel: ModelAdapter = {
        async complete() {
          childCalls += 1;
          if (childCalls === 1) {
            return {
              toolCalls: [
                {
                  toolName: "write",
                  arguments: {
                    path: "child.txt",
                    content: "written after approval\n",
                    reason: "spawn gate regression",
                  },
                },
              ],
            };
          }
          return { message: "child wrote the file" };
        },
      };
      const policy = createLayeredPolicy([
        createDefaultPolicy(),
        createWorkspaceMutationPolicy({ allowWorkspaceWrites: true }),
      ]);
      const parentRef: { current?: ReturnType<typeof createRun> } = {};
      const childTools = createDynamicChildToolCatalog({
        workspaceRoot: root,
      }).map((entry) => entry.definition);
      const spawnTool = createDynamicSpawnAgentTool({
        getParent: () => parentRef.current,
        model: childModel,
        childTools,
        parentRunPolicy: policy,
        childRunStoreFactory: () => undefined as never,
      });
      let parentCalls = 0;
      let approvalCalls = 0;
      let approvedBeforeChildStarted = false;
      const parent = (parentRef.current = createRun({
        goal: "spawn a writer",
        workspace: new LocalWorkspace(root),
        tools: [spawnTool],
        policy,
        maxSteps: 5,
        approvalResolver(request) {
          approvalCalls += 1;
          approvedBeforeChildStarted = childCalls === 0;
          expect(request.summary).toContain(
            'Grant workspace write to child "writer"',
          );
          return {
            approvalId: request.id,
            decision: "approved",
            message: "approved",
          };
        },
        model: {
          async complete() {
            parentCalls += 1;
            return parentCalls === 1
              ? {
                  toolCalls: [
                    {
                      toolName: "spawn_agent",
                      arguments: {
                        goal: "write child.txt",
                        role: "writer",
                        prompt: "Write child.txt.",
                        grant: { workspaceWrite: true },
                        maxSteps: 3,
                      },
                    },
                  ],
                }
              : { message: "parent done" };
          },
        },
      }));

      await parent.start();

      expect(approvalCalls).toBe(1);
      expect(approvedBeforeChildStarted).toBe(true);
      expect(
        parent.events
          .all()
          .filter((event) => event.type === "approval.requested"),
      ).toHaveLength(1);
      await expect(readFile(join(root, "child.txt"), "utf8")).resolves.toBe(
        "written after approval\n",
      );
      expect(parent.record.state).toBe("completed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records auto-approved spawn write grants in bypass-style runs", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sparkwright-host-spawn-bypass-gate-"),
    );
    try {
      let childCalls = 0;
      const childModel: ModelAdapter = {
        async complete() {
          childCalls += 1;
          if (childCalls === 1) {
            return {
              toolCalls: [
                {
                  toolName: "write",
                  arguments: {
                    path: "child.txt",
                    content: "written by bypass grant\n",
                    reason: "spawn bypass grant regression",
                  },
                },
              ],
            };
          }
          return { message: "child wrote the file" };
        },
      };
      const policy = createLayeredPolicy([
        createPermissionModePolicy({ mode: "bypass_permissions" }),
        createWorkspaceMutationPolicy({ allowWorkspaceWrites: true }),
      ]);
      const parentRef: { current?: ReturnType<typeof createRun> } = {};
      const spawnTool = createDynamicSpawnAgentTool({
        getParent: () => parentRef.current,
        model: childModel,
        childTools: createDynamicChildToolCatalog({
          workspaceRoot: root,
        }).map((entry) => entry.definition),
        parentRunPolicy: policy,
        childRunStoreFactory: () => undefined as never,
      });
      let parentCalls = 0;
      const parent = (parentRef.current = createRun({
        goal: "spawn a bypass writer",
        workspace: new LocalWorkspace(root),
        tools: [spawnTool],
        policy,
        maxSteps: 5,
        approvalResolver(request) {
          expect(request.summary).toContain(
            'Grant workspace write to child "writer"',
          );
          return {
            approvalId: request.id,
            decision: "approved",
            message: "Auto-approved by bypass_permissions.",
            autoApproved: true,
          };
        },
        model: {
          async complete() {
            parentCalls += 1;
            return parentCalls === 1
              ? {
                  toolCalls: [
                    {
                      toolName: "spawn_agent",
                      arguments: {
                        goal: "write child.txt",
                        role: "writer",
                        prompt: "Write child.txt.",
                        grant: { workspaceWrite: true },
                        maxSteps: 3,
                      },
                    },
                  ],
                }
              : { message: "parent done" };
          },
        },
      }));

      await parent.start();

      expect(
        parent.events.all().find((event) => event.type === "approval.resolved")
          ?.payload,
      ).toMatchObject({
        decision: "approved",
        autoApproved: true,
      });
      await expect(readFile(join(root, "child.txt"), "utf8")).resolves.toBe(
        "written by bypass grant\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not spawn a child when the parent denies the write grant approval", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sparkwright-host-spawn-denied-approval-"),
    );
    try {
      let childCalls = 0;
      const childModel: ModelAdapter = {
        async complete() {
          childCalls += 1;
          return { message: "unexpected child start" };
        },
      };
      const policy = createLayeredPolicy([
        createDefaultPolicy(),
        createWorkspaceMutationPolicy({ allowWorkspaceWrites: true }),
      ]);
      const parentRef: { current?: ReturnType<typeof createRun> } = {};
      const spawnTool = createDynamicSpawnAgentTool({
        getParent: () => parentRef.current,
        model: childModel,
        childTools: createDynamicChildToolCatalog({
          workspaceRoot: root,
        }).map((entry) => entry.definition),
        parentRunPolicy: policy,
        childRunStoreFactory: () => undefined as never,
      });
      let parentCalls = 0;
      const parent = (parentRef.current = createRun({
        goal: "spawn a denied writer",
        workspace: new LocalWorkspace(root),
        tools: [spawnTool],
        policy,
        maxSteps: 3,
        approvalResolver(request) {
          return {
            approvalId: request.id,
            decision: "denied",
            message: "denied",
          };
        },
        model: {
          async complete() {
            parentCalls += 1;
            return parentCalls === 1
              ? {
                  toolCalls: [
                    {
                      toolName: "spawn_agent",
                      arguments: {
                        goal: "write blocked.txt",
                        role: "writer",
                        prompt: "Write blocked.txt.",
                        grant: { workspaceWrite: true },
                        maxSteps: 3,
                      },
                    },
                  ],
                }
              : { message: "parent saw denial" };
          },
        },
      }));

      await parent.start();

      expect(childCalls).toBe(0);
      expect(
        parent.events.all().find((event) => event.type === "tool.failed")
          ?.payload,
      ).toMatchObject({
        toolName: "spawn_agent",
        error: { code: "TOOL_APPROVAL_DENIED" },
      });
      await expect(
        readFile(join(root, "blocked.txt"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies spawn write grants in read-only parent runs before approval", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sparkwright-host-spawn-readonly-gate-"),
    );
    try {
      let childCalls = 0;
      const childModel: ModelAdapter = {
        async complete() {
          childCalls += 1;
          return { message: "unexpected child start" };
        },
      };
      const policy = createWorkspaceMutationPolicy({
        allowWorkspaceWrites: false,
      });
      const parentRef: { current?: ReturnType<typeof createRun> } = {};
      const spawnTool = createDynamicSpawnAgentTool({
        getParent: () => parentRef.current,
        model: childModel,
        childTools: createDynamicChildToolCatalog({
          workspaceRoot: root,
        }).map((entry) => entry.definition),
        parentRunPolicy: policy,
        childRunStoreFactory: () => undefined as never,
      });
      let parentCalls = 0;
      const parent = (parentRef.current = createRun({
        goal: "spawn a read-only writer",
        workspace: new LocalWorkspace(root),
        tools: [spawnTool],
        policy,
        maxSteps: 3,
        approvalResolver() {
          throw new Error("read-only grant denial must happen before approval");
        },
        model: {
          async complete() {
            parentCalls += 1;
            return parentCalls === 1
              ? {
                  toolCalls: [
                    {
                      toolName: "spawn_agent",
                      arguments: {
                        goal: "write blocked.txt",
                        role: "writer",
                        prompt: "Write blocked.txt.",
                        grant: { workspaceWrite: true },
                        maxSteps: 3,
                      },
                    },
                  ],
                }
              : { message: "parent saw read-only denial" };
          },
        },
      }));

      await parent.start();

      expect(childCalls).toBe(0);
      expect(
        parent.events
          .all()
          .some((event) => event.type === "approval.requested"),
      ).toBe(false);
      expect(
        parent.events.all().find((event) => event.type === "tool.failed")
          ?.payload,
      ).toMatchObject({
        toolName: "spawn_agent",
        error: {
          code: "TOOL_DENIED",
          message:
            "Tools with write side effects require an explicit write-enabled run.",
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps default read-only spawn calls approval-free", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sparkwright-host-spawn-readonly-default-"),
    );
    try {
      let childCalls = 0;
      const childModel: ModelAdapter = {
        async complete() {
          childCalls += 1;
          return { message: "child inspected" };
        },
      };
      const policy = createWorkspaceMutationPolicy({
        allowWorkspaceWrites: false,
      });
      const parentRef: { current?: ReturnType<typeof createRun> } = {};
      const spawnTool = createDynamicSpawnAgentTool({
        getParent: () => parentRef.current,
        model: childModel,
        childTools: createDynamicChildToolCatalog({
          workspaceRoot: root,
        }).map((entry) => entry.definition),
        parentRunPolicy: policy,
        childRunStoreFactory: () => undefined as never,
      });
      let parentCalls = 0;
      const parent = (parentRef.current = createRun({
        goal: "spawn a reader",
        workspace: new LocalWorkspace(root),
        tools: [spawnTool],
        policy,
        maxSteps: 3,
        approvalResolver() {
          throw new Error("default read-only spawn must not request approval");
        },
        model: {
          async complete() {
            parentCalls += 1;
            return parentCalls === 1
              ? {
                  toolCalls: [
                    {
                      toolName: "spawn_agent",
                      arguments: {
                        goal: "inspect README",
                        role: "reader",
                        prompt: "Inspect README and report.",
                        maxSteps: 1,
                      },
                    },
                  ],
                }
              : { message: "parent done" };
          },
        },
      }));

      await parent.start();

      expect(childCalls).toBe(1);
      expect(
        parent.events
          .all()
          .some((event) => event.type === "approval.requested"),
      ).toBe(false);
      expect(parent.record.state).toBe("completed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("grants managed workspace writes to a dynamic child at spawn time", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-host-spawn-write-"));
    try {
      let childCalls = 0;
      const childModel: ModelAdapter = {
        async complete() {
          childCalls += 1;
          if (childCalls === 1) {
            return {
              toolCalls: [
                {
                  toolName: "write",
                  arguments: {
                    path: "child.txt",
                    content: "written by child\n",
                    reason: "spawn grant regression",
                  },
                },
              ],
            };
          }
          return { message: "child wrote the file" };
        },
      };
      const parent = createRun({
        goal: "ask a child to write",
        model: {
          async complete() {
            return { message: "parent done" };
          },
        },
        workspace: new LocalWorkspace(root),
        maxSteps: 1,
      });
      const childTools = createDynamicChildToolCatalog({
        workspaceRoot: root,
      }).map((entry) => entry.definition);
      const spawnTool = createDynamicSpawnAgentTool({
        getParent: () => parent,
        model: childModel,
        childTools,
        parentRunPolicy: createLayeredPolicy([
          createDefaultPolicy(),
          createWorkspaceMutationPolicy({ allowWorkspaceWrites: true }),
        ]),
        childRunStoreFactory: () => undefined as never,
        workspaceRoot: root,
      });

      expect(
        spawnTool.policyForArgs?.({
          goal: "write child.txt",
          role: "writer",
          prompt: "Write child.txt.",
          grant: { workspaceWrite: true },
        }),
      ).toMatchObject({
        policy: { risk: "risky", requiresApproval: true },
        governance: { sideEffects: ["write"] },
      });
      expect(
        spawnTool.approvalSummaryForArgs?.(
          {
            goal: "write child.txt",
            role: "writer",
            prompt: "Write child.txt.",
            grant: { workspaceWrite: true },
          },
          { maxChars: 200 },
        ),
      ).toContain('Grant workspace write to child "writer"');
      expect(() =>
        spawnTool.policyForArgs?.({
          goal: "write child.txt",
          role: "writer",
          prompt: "Write child.txt.",
          allowedTools: ["read"],
          grant: { workspaceWrite: true },
        }),
      ).toThrow(/allowedTools does not include workspace write tools/);

      const output = (await spawnTool.execute(
        {
          goal: "write child.txt",
          role: "writer",
          prompt: "Write child.txt.",
          grant: { workspaceWrite: true },
          maxSteps: 3,
        },
        { run: parent.record } as never,
      )) as { childRunId: string; signal: string; message?: string };

      expect(output).toMatchObject({
        signal: "completed",
        message: "child wrote the file",
      });
      await expect(readFile(join(root, "child.txt"), "utf8")).resolves.toBe(
        "written by child\n",
      );
      expect(
        parent.events.all().find((event) => event.type === "subagent.completed")
          ?.payload,
      ).toMatchObject({
        workspaceWrites: 1,
      });
      expect(
        parent.events
          .all()
          .find(
            (event) =>
              event.type === "subagent.requested" &&
              (event.payload as { childRunId?: string }).childRunId ===
                output.childRunId,
          )?.metadata,
      ).toMatchObject({
        workspaceAccess: "read_write",
        agentConcurrency: "serial",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let a spawn write grant bypass a read-only parent policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-host-spawn-deny-"));
    try {
      let childCalls = 0;
      const childModel: ModelAdapter = {
        async complete(input) {
          childCalls += 1;
          if (childCalls === 1) {
            return {
              toolCalls: [
                {
                  toolName: "write",
                  arguments: {
                    path: "blocked.txt",
                    content: "should not be written\n",
                    reason: "spawn grant deny regression",
                  },
                },
              ],
            };
          }
          const contextText = input.context
            .map((item) =>
              typeof item.content === "string"
                ? item.content
                : JSON.stringify(item.content),
            )
            .join("\n");
          const sawDeny =
            contextText.includes("TOOL_DENIED") ||
            contextText.includes("workspace write") ||
            contextText.includes("write side effect");
          return { message: sawDeny ? "write denied" : "unexpected" };
        },
      };
      const parent = createRun({
        goal: "ask a child to write in read-only mode",
        model: {
          async complete() {
            return { message: "parent done" };
          },
        },
        workspace: new LocalWorkspace(root),
        maxSteps: 1,
      });
      const childTools = createDynamicChildToolCatalog({
        workspaceRoot: root,
      }).map((entry) => entry.definition);
      const spawnTool = createDynamicSpawnAgentTool({
        getParent: () => parent,
        model: childModel,
        childTools,
        parentRunPolicy: createWorkspaceMutationPolicy({
          allowWorkspaceWrites: false,
        }),
        childRunStoreFactory: () => undefined as never,
      });

      const output = (await spawnTool.execute(
        {
          goal: "write blocked.txt",
          role: "writer",
          prompt: "Write blocked.txt.",
          grant: { workspaceWrite: true },
          maxSteps: 3,
        },
        { run: parent.record } as never,
      )) as { signal: string; message?: string };

      expect(output).toMatchObject({
        signal: "completed",
        message: "write denied",
      });
      await expect(
        readFile(join(root, "blocked.txt"), "utf8"),
      ).rejects.toThrow();
      expect(
        parent.events.all().find((event) => event.type === "subagent.completed")
          ?.payload,
      ).not.toMatchObject({
        workspaceWrites: expect.any(Number),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows a spawn write grant in a --target run but clamps the child to the target scope", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sparkwright-host-spawn-target-"),
    );
    try {
      let childCalls = 0;
      const childModel: ModelAdapter = {
        async complete(input) {
          childCalls += 1;
          if (childCalls === 1) {
            // In-target write is inside the clamped envelope and succeeds.
            return {
              toolCalls: [
                {
                  toolName: "write",
                  arguments: {
                    path: "target.txt",
                    content: "in-target write\n",
                    reason: "target scope regression",
                  },
                },
              ],
            };
          }
          if (childCalls === 2) {
            // Out-of-target write must be denied even with the grant.
            return {
              toolCalls: [
                {
                  toolName: "write",
                  arguments: {
                    path: "off-target.txt",
                    content: "should be clamped\n",
                    reason: "target scope regression",
                  },
                },
              ],
            };
          }
          const contextText = input.context
            .map((item) =>
              typeof item.content === "string"
                ? item.content
                : JSON.stringify(item.content),
            )
            .join("\n");
          const sawDeny =
            contextText.includes("TOOL_DENIED") ||
            contextText.includes("allowed target scope");
          return {
            message: sawDeny ? "off-target write denied" : "unexpected",
          };
        },
      };
      const policy = createLayeredPolicy([
        createDefaultPolicy(),
        createWorkspaceMutationPolicy({
          allowWorkspaceWrites: true,
          allowedPaths: ["target.txt"],
          maxWriteFiles: 1,
        }),
      ]);
      const parentRef: { current?: ReturnType<typeof createRun> } = {};
      const spawnTool = createDynamicSpawnAgentTool({
        getParent: () => parentRef.current,
        model: childModel,
        childTools: createDynamicChildToolCatalog({
          workspaceRoot: root,
        }).map((entry) => entry.definition),
        parentRunPolicy: policy,
        childRunStoreFactory: () => undefined as never,
      });
      let parentCalls = 0;
      let approvalCalls = 0;
      const parent = (parentRef.current = createRun({
        goal: "spawn a target-scoped writer",
        workspace: new LocalWorkspace(root),
        tools: [spawnTool],
        policy,
        maxSteps: 5,
        approvalResolver(request) {
          approvalCalls += 1;
          return {
            approvalId: request.id,
            decision: "approved",
            message: "approved",
          };
        },
        model: {
          async complete() {
            parentCalls += 1;
            return parentCalls === 1
              ? {
                  toolCalls: [
                    {
                      toolName: "spawn_agent",
                      arguments: {
                        goal: "write within the target scope",
                        role: "writer",
                        prompt: "Write files.",
                        grant: { workspaceWrite: true },
                        maxSteps: 4,
                      },
                    },
                  ],
                }
              : { message: "parent done" };
          },
        },
      }));

      await parent.start();

      // The grant is honored at the spawn gate (approved once), not denied.
      expect(approvalCalls).toBe(1);
      // In-target write lands; the out-of-target write is clamped by the
      // parent envelope, so the grant never exceeds the --target scope.
      await expect(readFile(join(root, "target.txt"), "utf8")).resolves.toBe(
        "in-target write\n",
      );
      await expect(
        readFile(join(root, "off-target.txt"), "utf8"),
      ).rejects.toThrow();
      expect(parent.record.state).toBe("completed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
    expect(lifecycleTypes(parent.events.all(), ticket.childRunId)).toEqual([
      "subagent.requested",
      "subagent.started",
      "subagent.completed",
    ]);
    expect(
      projectAgentLifecycle(parent.events.all(), ticket.childRunId).every(
        (event) => event.identityConsistent,
      ),
    ).toBe(true);
    expect(terminalLifecycleCount(parent.events.all(), ticket.childRunId)).toBe(
      1,
    );
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
    )) as { taskId: string; childRunId: string };

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
    expect(lifecycleTypes(parent.events.all(), ticket.childRunId)).toEqual([
      "subagent.requested",
      "subagent.started",
      "subagent.failed",
    ]);
    expect(terminalLifecycleCount(parent.events.all(), ticket.childRunId)).toBe(
      1,
    );
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

  it("keeps dynamic spawn_agent lifecycle flat for sub-agent parents", async () => {
    const parent = createRun({
      goal: "nested parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      metadata: { parentRunId: "run_top", subagentDepth: 1 },
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
      maxDepth: 2,
    });

    await expect(
      spawnTool.execute(
        {
          goal: "attempt nested spawn",
          role: "nested",
          prompt: "Return.",
          allowedTools: ["read"],
        },
        { run: parent.record } as never,
      ),
    ).rejects.toThrow("parent run is itself a sub-agent");
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

describe("read-only child goal guard (F2)", () => {
  it("flags execution intent in English and Chinese", () => {
    expect(detectReadOnlyChildIntent("Run this in the background")).toBe(
      "execute",
    );
    expect(detectReadOnlyChildIntent("在后台执行这个 python 脚本")).toBe(
      "execute",
    );
    expect(detectReadOnlyChildIntent("后台运行任务，每秒打印一个数字")).toBe(
      "execute",
    );
    expect(
      detectReadOnlyChildIntent("launch the server and keep running"),
    ).toBe("execute");
  });

  it("flags filesystem-write intent but not code production", () => {
    expect(detectReadOnlyChildIntent("write it to a file on disk")).toBe(
      "write",
    );
    expect(detectReadOnlyChildIntent("把脚本保存到 out.py")).toBe("write");
    // Producing code as text is NOT a filesystem write.
    expect(
      detectReadOnlyChildIntent("Write a Python program that prints 1..20"),
    ).toBeNull();
    expect(
      detectReadOnlyChildIntent("用 sub agent 去写一个 python 任务"),
    ).toBeNull();
  });

  it("does not flag inspection/reasoning goals (no noun false positives)", () => {
    expect(detectReadOnlyChildIntent("分析运行日志里的错误")).toBeNull();
    expect(
      detectReadOnlyChildIntent("Summarize the runtime and list every export"),
    ).toBeNull();
    expect(detectReadOnlyChildIntent("grep for TODO comments")).toBeNull();
    // A background *delivery* mode is not execution intent: the work here is
    // read-only inspection, which a read-only child can legitimately do.
    expect(
      detectReadOnlyChildIntent("Inspect the repository in the background."),
    ).toBeNull();
    expect(detectReadOnlyChildIntent("在后台分析这个仓库的结构")).toBeNull();
  });

  it("throws when a read-only child is asked to execute", () => {
    expect(() =>
      assertReadOnlyChildCanSatisfyGoal({
        goal: "在后台启动一个 Python 脚本：每1秒打印一个数字",
        prompt: "",
        childTools: [{ name: "read" }, { name: "grep" }],
        entrypoint: "agent_task",
      }),
    ).toThrowError(/read-only and cannot run processes/i);
  });

  it("routes write-required read-only children toward a workspace write grant", () => {
    expect(() =>
      assertReadOnlyChildCanSatisfyGoal({
        goal: "write the file child.txt",
        prompt: "",
        childTools: [{ name: "read" }, { name: "grep" }],
        entrypoint: "spawn_agent",
      }),
    ).toThrowError(/grant: \{ workspaceWrite: true \}/i);
  });

  it("permits an execution goal when the child actually has bash", () => {
    expect(() =>
      assertReadOnlyChildCanSatisfyGoal({
        goal: "run the script in the background",
        prompt: "",
        childTools: [{ name: "read" }, { name: "bash" }],
        entrypoint: "spawn_agent",
      }),
    ).not.toThrow();
  });

  it("permits inspection goals for a read-only child", () => {
    expect(() =>
      assertReadOnlyChildCanSatisfyGoal({
        goal: "Write a Python program that prints 1..20 and give the code",
        prompt: "Provide only the code.",
        childTools: [{ name: "read" }, { name: "glob" }, { name: "grep" }],
        entrypoint: "spawn_agent",
      }),
    ).not.toThrow();
  });
});
