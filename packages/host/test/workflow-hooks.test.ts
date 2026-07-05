import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRun,
  createRunId,
  defineTool,
  EventLog,
  FactLedger,
  runWorkflowHooks,
} from "@sparkwright/core";
import {
  createPlatformShellSandboxRuntime,
  type ShellSandboxRuntime,
} from "@sparkwright/shell-sandbox";
import {
  bindConfiguredEventHooks,
  createConfiguredWorkflowHooks,
  createInvariantProjectionHooks,
  createWorkflowProjectionHooks,
  createVerificationWorkflowHooks,
} from "../src/index.js";
import { assembleRuntimeWorkflowHooks } from "../src/runtime.js";
import type { WorkflowProjectionStateSnapshot } from "../src/workflow-projection.js";

function runRecord() {
  const now = new Date().toISOString();
  return {
    id: createRunId(),
    goal: "g",
    state: "running" as const,
    createdAt: now,
    updatedAt: now,
    metadata: {},
  };
}

async function waitForEvent(events: EventLog, type: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (events.all().some((event) => event.type === type)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${type}`);
}

describe("runtime workflow hook assembly", () => {
  it("keeps configured hooks before implicit workflow projections", () => {
    const hooks = assembleRuntimeWorkflowHooks({
      workspaceRoot: process.cwd(),
      workflowHooks: [
        {
          name: "config-guard",
          hook: "RunStart",
          action: { type: "context", content: "configured" },
        },
      ],
      verification: {
        mode: "require",
        defaultProfile: "fast",
        profiles: {
          fast: [{ id: "test", command: "npm", args: ["test"] }],
        },
      },
      documentedCommand: {
        goal: "fix tests and verify documented commands pass",
        shouldWrite: true,
      },
    });

    expect(hooks[0]?.name).toBe("config-guard");
    expect(hooks.slice(1).map((hook) => hook.name)).toEqual(
      expect.arrayContaining([
        "workflow:verification_fast",
        "workflow:documented_command",
      ]),
    );
    expect(hooks.some((hook) => hook.name.startsWith("verification:"))).toBe(
      false,
    );
  });

  it("appends workflow projection hooks after existing producers", () => {
    const hooks = assembleRuntimeWorkflowHooks({
      workspaceRoot: process.cwd(),
      workflowHooks: [
        {
          name: "config-guard",
          hook: "RunStart",
          action: { type: "context", content: "configured" },
        },
      ],
      projectionHooks: [
        {
          name: "workflow:wf_test",
          hook: "RunStart",
          handle: () => undefined,
        },
      ],
      documentedCommand: {
        goal: "just answer",
        shouldWrite: false,
      },
    });

    expect(hooks.map((hook) => hook.name)).toEqual([
      "config-guard",
      "workflow:wf_test",
    ]);
  });

  it("does not treat built-in invariant hooks as active governing workflows", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-hook-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const facts = new FactLedger();
      events.subscribe((event) => facts.observeEvent(event));
      const hooks = assembleRuntimeWorkflowHooks({
        workspaceRoot: workspace,
        workflowHooks: [
          {
            name: "configured-advance",
            hook: "Stop",
            onError: "block",
            action: {
              type: "command",
              command: process.execPath,
              args: [
                "-e",
                "console.log(JSON.stringify({status:'advance', reason:'configured advance'}));",
              ],
              resultMode: "stdoutJson",
            },
          },
        ],
        verification: {
          mode: "require",
          defaultProfile: "fast",
          profiles: {
            fast: [
              {
                id: "unit",
                command: process.execPath,
                args: ["-e", "process.exit(0)"],
              },
            ],
          },
        },
        documentedCommand: {
          goal: "prepare handoff and verify documented commands",
          shouldWrite: true,
        },
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        payload: {},
        events,
        facts,
      });

      expect(result.status).toBe("advanced");
      if (result.status !== "advanced") {
        throw new Error(`expected advanced, got ${result.status}`);
      }
      expect(result.advance.reason).toBe("configured advance");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("createInvariantProjectionHooks", () => {
  it("skips verifier commands when the run has no writes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-invariant-"));
    const marker = join(workspace, "ran.txt");
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const ledger = new FactLedger();
      events.subscribe((event) => ledger.observeEvent(event));
      const projection = createInvariantProjectionHooks({
        workspaceRoot: workspace,
        workflowRunId: "verification_fast",
        assetName: "verification:fast",
        contentHash: "builtin:test",
        verificationSource: "profile",
        profile: "fast",
        verifiers: [
          {
            id: "lint",
            kind: "command",
            command: process.execPath,
            args: [
              "-e",
              `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`,
            ],
          },
        ],
      });

      const stop = await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "Stop",
        run,
        payload: { message: "done" },
        events,
        facts: ledger,
      });

      expect(stop.status).toBe("continued");
      await expect(readFile(marker, "utf8")).rejects.toThrow();
      expect(ledger.snapshot().verificationResults).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not re-run commands once the current epoch is clean", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-invariant-"));
    const marker = join(workspace, "count.txt");
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const ledger = new FactLedger();
      events.subscribe((event) => ledger.observeEvent(event));
      events.emit("workspace.write.completed", { path: "src/app.ts" });
      const projection = createInvariantProjectionHooks({
        workspaceRoot: workspace,
        workflowRunId: "verification_fast",
        assetName: "verification:fast",
        contentHash: "builtin:test",
        verificationSource: "profile",
        profile: "fast",
        verifiers: [
          {
            id: "lint",
            kind: "command",
            command: process.execPath,
            args: [
              "-e",
              [
                "const fs = require('node:fs');",
                `const path = ${JSON.stringify(marker)};`,
                "const count = fs.existsSync(path) ? Number(fs.readFileSync(path, 'utf8')) : 0;",
                "fs.writeFileSync(path, String(count + 1));",
              ].join(" "),
            ],
          },
        ],
      });

      const first = await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "Stop",
        run,
        payload: { message: "done" },
        events,
        facts: ledger,
      });
      const second = await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "Stop",
        run,
        payload: { message: "done again" },
        events,
        facts: ledger,
      });

      expect(first.status).toBe("continued");
      expect(second.status).toBe("continued");
      await expect(readFile(marker, "utf8")).resolves.toBe("1");
      expect(ledger.snapshot().verificationResults).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("advances with failure evidence when the current epoch is dirty", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-invariant-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const ledger = new FactLedger();
      events.subscribe((event) => ledger.observeEvent(event));
      events.emit("workspace.write.completed", { path: "src/app.ts" });
      const projection = createInvariantProjectionHooks({
        workspaceRoot: workspace,
        workflowRunId: "verification_fast",
        assetName: "verification:fast",
        contentHash: "builtin:test",
        verificationSource: "profile",
        profile: "fast",
        injectOutput: "onFailure",
        verifiers: [
          {
            id: "lint",
            kind: "command",
            command: process.execPath,
            args: ["-e", "console.log('lint failed'); process.exit(2)"],
          },
        ],
      });

      const stop = await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "Stop",
        run,
        payload: { message: "done" },
        events,
        facts: ledger,
      });

      expect(stop.status).toBe("advanced");
      expect(stop.context[0]?.content).toContain("lint failed");
      expect(ledger.snapshot().verificationResults[0]).toMatchObject({
        hookName: "workflow:verification_fast",
        verifierId: "lint",
        verificationSource: "profile",
        profile: "fast",
        satisfied: false,
        stale: false,
        writeEpoch: 1,
        exitCode: 2,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("records invariant failure when a pending retry is refused by budget", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-invariant-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const ledger = new FactLedger();
      events.subscribe((event) => ledger.observeEvent(event));
      events.emit("workspace.write.completed", { path: "src/app.ts" });
      const projection = createInvariantProjectionHooks({
        workspaceRoot: workspace,
        workflowRunId: "verification_fast",
        assetName: "verification:fast",
        contentHash: "builtin:test",
        verificationSource: "profile",
        profile: "fast",
        verifiers: [
          {
            id: "lint",
            kind: "command",
            command: process.execPath,
            args: ["-e", "process.exit(2)"],
          },
        ],
      });

      const stop = await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "Stop",
        run,
        payload: { message: "done" },
        events,
        facts: ledger,
      });
      const signal = await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "RuntimeSignal",
        run,
        payload: { signal: "budget.exceeded", source: "workflow" },
        events,
        facts: ledger,
      });

      expect(stop.status).toBe("advanced");
      expect(signal.status).toBe("continued");
      expect(
        events.all().find((event) => event.type === "workflow.failed")?.payload,
      ).toMatchObject({
        workflowRunId: "verification_fast",
        projectionKind: "invariant",
        verificationSource: "profile",
        failure: { kind: "verification", code: "VERIFICATION_PROFILE_FAILED" },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("createWorkflowProjectionHooks", () => {
  it("rejects command verifiers without instantiation-time authorization", () => {
    expect(() =>
      createWorkflowProjectionHooks({
        workspaceRoot: process.cwd(),
        workflowRunId: "wf_unauthorized",
        definition: {
          assetName: "unauthorized",
          contentHash: "hash",
          nodes: [
            {
              id: "verify",
              execute: "model",
              body: "Verify.",
              verify: [
                {
                  id: "missing-auth",
                  kind: "command",
                  command: process.execPath,
                  args: ["-e", "process.exit(0)"],
                  expect: "zero",
                },
              ],
            },
          ],
        },
      }),
    ).toThrow(/not authorized/);
  });

  it("runs a command verifier and completes a single-node workflow", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-workflow-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const ledger = new FactLedger();
      events.subscribe((event) => ledger.observeEvent(event));
      const projection = createWorkflowProjectionHooks({
        workspaceRoot: workspace,
        workflowRunId: "wf_single",
        definition: {
          assetName: "single",
          contentHash: "hash",
          nodes: [
            {
              id: "verify",
              execute: "model",
              body: "Verify the result.",
              verify: [
                {
                  id: "node-ok",
                  kind: "command",
                  command: process.execPath,
                  args: ["-e", "process.exit(0)"],
                  expect: "zero",
                  authorized: true,
                },
              ],
            },
          ],
        },
      });

      await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "RunStart",
        run,
        payload: {},
        events,
        facts: ledger,
      });
      const stop = await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "Stop",
        run,
        payload: { message: "done" },
        events,
        facts: ledger,
      });

      expect(stop.status).toBe("continued");
      expect(events.all().map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "workflow.started",
          "workflow_hook.completed",
          "workflow.node.completed",
          "workflow.completed",
        ]),
      );
      expect(ledger.snapshot().verificationResults[0]).toMatchObject({
        hookName: "workflow:wf_single",
        nodeId: "verify",
        verifierId: "node-ok",
        expect: "zero",
        satisfied: true,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("advances linearly between model nodes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-workflow-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const ledger = new FactLedger();
      events.subscribe((event) => ledger.observeEvent(event));
      const projection = createWorkflowProjectionHooks({
        workspaceRoot: workspace,
        workflowRunId: "wf_linear",
        definition: {
          assetName: "linear",
          contentHash: "hash",
          nodes: [
            { id: "first", execute: "model", body: "First.", onPass: "second" },
            { id: "second", execute: "model", body: "Second." },
          ],
        },
      });

      const firstStop = await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "Stop",
        run,
        payload: { message: "first done" },
        events,
        facts: ledger,
      });
      const secondTurn = await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "TurnStart",
        run,
        payload: {},
        events,
        facts: ledger,
      });
      const secondStop = await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "Stop",
        run,
        payload: { message: "second done" },
        events,
        facts: ledger,
      });

      expect(firstStop.status).toBe("advanced");
      expect(secondTurn.context[0]?.content).toContain("Workflow node: second");
      expect(secondStop.status).toBe("continued");
      expect(events.all().map((event) => event.type)).toContain(
        "workflow.completed",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("drains command delegate and task nodes at TurnStart before the next model node", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-workflow-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const ledger = new FactLedger();
      events.subscribe((event) => ledger.observeEvent(event));
      const controller = new AbortController();
      const parentRun = {
        record: run,
        events,
        abortSignal: controller.signal,
      } as never;
      let delegateCalls = 0;
      let taskCalls = 0;
      const agentTool = defineTool<Record<string, unknown>, unknown>({
        name: "delegate_agent",
        description: "Delegate to a configured agent.",
        inputSchema: { type: "object" },
        policy: { risk: "safe" },
        execute(args, ctx) {
          delegateCalls += 1;
          expect(ctx.run.id).toBe(run.id);
          expect(args).toMatchObject({
            agentId: "reviewer",
            goal: "Review command output.",
          });
          return { ok: true };
        },
      });
      const taskTool = defineTool<Record<string, unknown>, unknown>({
        name: "task_create",
        description: "Create a task.",
        inputSchema: { type: "object" },
        policy: { risk: "safe" },
        execute(args, ctx) {
          taskCalls += 1;
          expect(ctx.run.id).toBe(run.id);
          expect(args).toMatchObject({
            kind: "agent",
            mode: "awaited",
            payload: { goal: "Check docs." },
          });
          return { taskId: "task_1", mode: "awaited", awaited: true };
        },
      });
      const projection = createWorkflowProjectionHooks({
        workspaceRoot: workspace,
        workflowRunId: "wf_non_model",
        getRun: () => parentRun,
        agentTool,
        taskTool,
        definition: {
          assetName: "non-model",
          contentHash: "hash",
          nodes: [
            {
              id: "command",
              execute: "command",
              body: "",
              command: {
                command: process.execPath,
                args: ["-e", "process.exit(0)"],
                authorized: true,
              },
              onPass: "delegate",
            },
            {
              id: "delegate",
              execute: "delegate",
              body: "",
              delegate: {
                agentId: "reviewer",
                goal: "Review command output.",
              },
              onPass: "task",
            },
            {
              id: "task",
              execute: "task",
              body: "",
              task: {
                kind: "agent",
                mode: "awaited",
                payload: { goal: "Check docs." },
              },
              onPass: "model",
            },
            { id: "model", execute: "model", body: "Summarize results." },
          ],
        },
      });

      const turn = await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "TurnStart",
        run,
        payload: {},
        events,
        facts: ledger,
      });

      expect(turn.status).toBe("continued");
      expect(delegateCalls).toBe(1);
      expect(taskCalls).toBe(1);
      expect(projection.getState()).toMatchObject({
        status: "running",
        currentNodeId: "model",
      });
      expect(turn.context[0]?.content).toContain("Workflow node: model");
      expect(
        events
          .all()
          .filter((event) => event.type === "workflow.node.completed")
          .map((event) => (event.payload as { nodeId?: string }).nodeId),
      ).toEqual(["command", "delegate", "task"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("runs bounded parallel branches and joins from durable branch state", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-workflow-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const ledger = new FactLedger();
      events.subscribe((event) => ledger.observeEvent(event));
      const snapshots: WorkflowProjectionStateSnapshot[] = [];
      const projection = createWorkflowProjectionHooks({
        workspaceRoot: workspace,
        workflowRunId: "wf_parallel_join",
        onStateSnapshot: (snapshot) => {
          snapshots.push(snapshot);
        },
        definition: {
          assetName: "parallel-join",
          contentHash: "hash",
          nodes: [
            {
              id: "fanout",
              execute: "parallel",
              body: "",
              parallel: { branches: ["lint", "types"], maxConcurrency: 2 },
              onPass: "join",
            },
            {
              id: "lint",
              execute: "command",
              body: "",
              command: {
                command: process.execPath,
                args: ["-e", "process.exit(0)"],
                authorized: true,
              },
            },
            {
              id: "types",
              execute: "command",
              body: "",
              command: {
                command: process.execPath,
                args: ["-e", "process.exit(0)"],
                authorized: true,
              },
            },
            {
              id: "join",
              execute: "join",
              body: "",
              join: { waitFor: ["lint", "types"] },
              onPass: "model",
            },
            { id: "model", execute: "model", body: "Summarize checks." },
          ],
        },
      });

      const turn = await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "TurnStart",
        run,
        payload: {},
        events,
        facts: ledger,
      });

      expect(turn.status).toBe("continued");
      expect(projection.getState()).toMatchObject({
        status: "running",
        currentNodeId: "model",
        parallelBranches: {
          lint: { sourceNodeId: "fanout", status: "passed", attempt: 1 },
          types: { sourceNodeId: "fanout", status: "passed", attempt: 1 },
        },
      });
      expect(
        events
          .all()
          .filter((event) => event.type === "workflow.node.completed")
          .map((event) => (event.payload as { nodeId?: string }).nodeId),
      ).toEqual(["fanout", "join"]);
      expect(
        snapshots.find(
          (snapshot) =>
            snapshot.phase === "node_completed" && snapshot.nodeId === "fanout",
        )?.state.parallelBranches,
      ).toMatchObject({
        lint: { status: "passed" },
        types: { status: "passed" },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects parallel nodes without explicit onPass", () => {
    expect(() =>
      createWorkflowProjectionHooks({
        workspaceRoot: process.cwd(),
        workflowRunId: "wf_parallel_requires_on_pass",
        definition: {
          assetName: "parallel-requires-on-pass",
          contentHash: "hash",
          nodes: [
            {
              id: "fanout",
              execute: "parallel",
              body: "",
              parallel: { branches: ["lint"], maxConcurrency: 1 },
            },
            {
              id: "lint",
              execute: "command",
              body: "",
              command: {
                command: process.execPath,
                args: ["-e", "process.exit(0)"],
                authorized: true,
              },
            },
            { id: "model", execute: "model", body: "Continue." },
          ],
        },
      }),
    ).toThrow(/requires explicit onPass/);
  });

  it("rejects parallel onPass targets that enter a branch", () => {
    expect(() =>
      createWorkflowProjectionHooks({
        workspaceRoot: process.cwd(),
        workflowRunId: "wf_parallel_on_pass_branch",
        definition: {
          assetName: "parallel-on-pass-branch",
          contentHash: "hash",
          nodes: [
            {
              id: "fanout",
              execute: "parallel",
              body: "",
              parallel: { branches: ["lint"], maxConcurrency: 1 },
              onPass: "lint",
            },
            {
              id: "lint",
              execute: "command",
              body: "",
              command: {
                command: process.execPath,
                args: ["-e", "process.exit(0)"],
                authorized: true,
              },
            },
          ],
        },
      }),
    ).toThrow(/onPass must not target branch/);
  });

  it("rejects parallel branch verifiers that P5 would not execute", () => {
    expect(() =>
      createWorkflowProjectionHooks({
        workspaceRoot: process.cwd(),
        workflowRunId: "wf_parallel_branch_verify",
        definition: {
          assetName: "parallel-branch-verify",
          contentHash: "hash",
          nodes: [
            {
              id: "fanout",
              execute: "parallel",
              body: "",
              parallel: { branches: ["lint"], maxConcurrency: 1 },
              onPass: "model",
            },
            {
              id: "lint",
              execute: "command",
              body: "",
              command: {
                command: process.execPath,
                args: ["-e", "process.exit(0)"],
                authorized: true,
              },
              verify: [
                {
                  id: "lint-check",
                  kind: "command",
                  command: process.execPath,
                  args: ["-e", "process.exit(0)"],
                  authorized: true,
                },
              ],
            },
            { id: "model", execute: "model", body: "Continue." },
          ],
        },
      }),
    ).toThrow(/branch "lint" declares verify/);
  });

  it("fails closed when a parallel branch returns a runtime error", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-workflow-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const ledger = new FactLedger();
      events.subscribe((event) => ledger.observeEvent(event));
      const projection = createWorkflowProjectionHooks({
        workspaceRoot: workspace,
        workflowRunId: "wf_parallel_runtime_error",
        definition: {
          assetName: "parallel-runtime-error",
          contentHash: "hash",
          nodes: [
            {
              id: "fanout",
              execute: "parallel",
              body: "",
              parallel: { branches: ["task"], maxConcurrency: 1 },
              onPass: "model",
              onFail: "model",
            },
            {
              id: "task",
              execute: "task",
              body: "",
              task: {
                kind: "agent",
                mode: "awaited",
                payload: { goal: "Check docs." },
              },
            },
            {
              id: "model",
              execute: "model",
              body: "This model node must not run after a branch runtime error.",
            },
          ],
        },
      });

      const turn = await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "TurnStart",
        run,
        payload: {},
        events,
        facts: ledger,
      });

      expect(turn.status).toBe("blocked");
      expect(projection.getState()).toMatchObject({
        status: "failed",
        parallelBranches: {
          task: {
            sourceNodeId: "fanout",
            status: "runtime_error",
            verdict: {
              reason: "Workflow task nodes require the host task_create tool.",
            },
          },
        },
      });
      expect(projection.getState().currentNodeId).toBeUndefined();
      expect(
        events.all().find((event) => event.type === "workflow.failed")?.payload,
      ).toMatchObject({
        workflowRunId: "wf_parallel_runtime_error",
        fromNodeId: "fanout",
        failure: { code: "WORKFLOW_NODE_FAILED" },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("enforces maxConcurrency for task parallel branches", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-workflow-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const ledger = new FactLedger();
      events.subscribe((event) => ledger.observeEvent(event));
      const parentRun = {
        record: run,
        events,
      } as never;
      let inFlight = 0;
      let maxSeen = 0;
      const taskTool = defineTool<Record<string, unknown>, unknown>({
        name: "task_create",
        description: "Create a task.",
        inputSchema: { type: "object" },
        policy: { risk: "safe" },
        async execute(args) {
          inFlight += 1;
          maxSeen = Math.max(maxSeen, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 20));
          inFlight -= 1;
          return {
            taskId: `task_${String((args.payload as { id?: string }).id)}`,
            status: "completed",
          };
        },
      });
      const projection = createWorkflowProjectionHooks({
        workspaceRoot: workspace,
        workflowRunId: "wf_parallel_task_bound",
        getRun: () => parentRun,
        taskTool,
        definition: {
          assetName: "parallel-task-bound",
          contentHash: "hash",
          nodes: [
            {
              id: "fanout",
              execute: "parallel",
              body: "",
              parallel: {
                branches: ["task_a", "task_b", "task_c"],
                maxConcurrency: 2,
              },
              onPass: "model",
            },
            {
              id: "task_a",
              execute: "task",
              body: "",
              task: { kind: "agent", payload: { id: "a" } },
            },
            {
              id: "task_b",
              execute: "task",
              body: "",
              task: { kind: "agent", payload: { id: "b" } },
            },
            {
              id: "task_c",
              execute: "task",
              body: "",
              task: { kind: "agent", payload: { id: "c" } },
            },
            { id: "model", execute: "model", body: "Summarize checks." },
          ],
        },
      });

      const turn = await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "TurnStart",
        run,
        payload: {},
        events,
        facts: ledger,
      });

      expect(turn.status).toBe("continued");
      expect(maxSeen).toBe(2);
      expect(projection.getState()).toMatchObject({
        status: "running",
        currentNodeId: "model",
        parallelBranches: {
          task_a: { status: "passed" },
          task_b: { status: "passed" },
          task_c: { status: "passed" },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses delegate_parallel for all-delegate parallel fan-out", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-workflow-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const ledger = new FactLedger();
      events.subscribe((event) => ledger.observeEvent(event));
      let delegateParallelCalls = 0;
      const delegateParallelTool = defineTool<Record<string, unknown>, unknown>(
        {
          name: "delegate_parallel",
          description: "Delegate several configured agents.",
          inputSchema: { type: "object" },
          policy: { risk: "safe" },
          execute(args) {
            delegateParallelCalls += 1;
            expect(args).toMatchObject({
              delegates: [
                { agentId: "reviewer", goal: "Review the patch." },
                { agentId: "tester", goal: "Run focused tests." },
              ],
            });
            return {
              mode: "parallel",
              completed: 2,
              failed: 0,
              results: [
                {
                  index: 0,
                  signal: "completed",
                  childRunId: "run_reviewer",
                  profileId: "reviewer",
                },
                {
                  index: 1,
                  signal: "completed",
                  childRunId: "run_tester",
                  profileId: "tester",
                },
              ],
            };
          },
        },
      );
      const projection = createWorkflowProjectionHooks({
        workspaceRoot: workspace,
        workflowRunId: "wf_delegate_parallel",
        delegateParallelTool,
        definition: {
          assetName: "delegate-parallel",
          contentHash: "hash",
          nodes: [
            {
              id: "fanout",
              execute: "parallel",
              body: "",
              parallel: { branches: ["review", "test"], maxConcurrency: 2 },
              onPass: "join",
            },
            {
              id: "review",
              execute: "delegate",
              body: "",
              delegate: {
                agentId: "reviewer",
                goal: "Review the patch.",
              },
            },
            {
              id: "test",
              execute: "delegate",
              body: "",
              delegate: {
                agentId: "tester",
                goal: "Run focused tests.",
              },
            },
            {
              id: "join",
              execute: "join",
              body: "",
              join: { waitFor: ["review", "test"] },
              onPass: "model",
            },
            { id: "model", execute: "model", body: "Summarize delegates." },
          ],
        },
      });

      const turn = await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "TurnStart",
        run,
        payload: {},
        events,
        facts: ledger,
      });

      expect(turn.status).toBe("continued");
      expect(delegateParallelCalls).toBe(1);
      expect(projection.getState()).toMatchObject({
        status: "running",
        currentNodeId: "model",
        parallelBranches: {
          review: {
            status: "passed",
            metadata: { delegateParallel: true },
          },
          test: {
            status: "passed",
            metadata: { delegateParallel: true },
          },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("batches all-delegate parallel fan-out by maxConcurrency", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-workflow-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const ledger = new FactLedger();
      events.subscribe((event) => ledger.observeEvent(event));
      const callSizes: number[] = [];
      const delegateParallelTool = defineTool<Record<string, unknown>, unknown>(
        {
          name: "delegate_parallel",
          description: "Delegate several configured agents.",
          inputSchema: { type: "object" },
          policy: { risk: "safe" },
          execute(args) {
            const delegates = args.delegates as Array<{
              agentId: string;
              metadata: { branchNodeId: string };
            }>;
            callSizes.push(delegates.length);
            return {
              mode: "parallel",
              completed: delegates.length,
              failed: 0,
              results: delegates.map((delegate, index) => ({
                index,
                signal: "completed",
                childRunId: `run_${delegate.metadata.branchNodeId}`,
                profileId: delegate.agentId,
              })),
            };
          },
        },
      );
      const projection = createWorkflowProjectionHooks({
        workspaceRoot: workspace,
        workflowRunId: "wf_delegate_parallel_batched",
        delegateParallelTool,
        definition: {
          assetName: "delegate-parallel-batched",
          contentHash: "hash",
          nodes: [
            {
              id: "fanout",
              execute: "parallel",
              body: "",
              parallel: {
                branches: ["review", "test", "docs"],
                maxConcurrency: 2,
              },
              onPass: "model",
            },
            {
              id: "review",
              execute: "delegate",
              body: "",
              delegate: { agentId: "reviewer", goal: "Review." },
            },
            {
              id: "test",
              execute: "delegate",
              body: "",
              delegate: { agentId: "tester", goal: "Test." },
            },
            {
              id: "docs",
              execute: "delegate",
              body: "",
              delegate: { agentId: "docs", goal: "Check docs." },
            },
            { id: "model", execute: "model", body: "Summarize delegates." },
          ],
        },
      });

      const turn = await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "TurnStart",
        run,
        payload: {},
        events,
        facts: ledger,
      });

      expect(turn.status).toBe("continued");
      expect(callSizes).toEqual([2, 1]);
      expect(projection.getState()).toMatchObject({
        status: "running",
        currentNodeId: "model",
        parallelBranches: {
          review: { status: "passed" },
          test: { status: "passed" },
          docs: { status: "passed" },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails all-delegate parallel fan-out on incomplete branch results", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-workflow-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const ledger = new FactLedger();
      events.subscribe((event) => ledger.observeEvent(event));
      const delegateParallelTool = defineTool<Record<string, unknown>, unknown>(
        {
          name: "delegate_parallel",
          description: "Delegate several configured agents.",
          inputSchema: { type: "object" },
          policy: { risk: "safe" },
          execute() {
            return {
              mode: "parallel",
              completed: 1,
              failed: 1,
              results: [
                {
                  index: 0,
                  signal: "completed",
                  childRunId: "run_review",
                  profileId: "reviewer",
                },
                {
                  index: 1,
                  signal: "failed",
                  childRunId: "run_test",
                  profileId: "tester",
                },
              ],
            };
          },
        },
      );
      const projection = createWorkflowProjectionHooks({
        workspaceRoot: workspace,
        workflowRunId: "wf_delegate_parallel_incomplete",
        delegateParallelTool,
        definition: {
          assetName: "delegate-parallel-incomplete",
          contentHash: "hash",
          nodes: [
            {
              id: "fanout",
              execute: "parallel",
              body: "",
              parallel: { branches: ["review", "test"], maxConcurrency: 2 },
              onPass: "done",
            },
            {
              id: "review",
              execute: "delegate",
              body: "",
              delegate: { agentId: "reviewer", goal: "Review." },
            },
            {
              id: "test",
              execute: "delegate",
              body: "",
              delegate: { agentId: "tester", goal: "Test." },
            },
            { id: "done", execute: "model", body: "Continue." },
          ],
        },
      });

      const turn = await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "TurnStart",
        run,
        payload: {},
        events,
        facts: ledger,
      });

      expect(turn.status).toBe("blocked");
      expect(projection.getState()).toMatchObject({
        status: "failed",
        parallelBranches: {
          review: { status: "passed" },
          test: { status: "failed" },
        },
      });
      expect(
        events.all().find((event) => event.type === "workflow.node.completed")
          ?.payload,
      ).toMatchObject({
        nodeId: "fanout",
        verdict: {
          status: "failed",
          reason: "parallel_branch_failed",
          metadata: { failedBranches: ["test"] },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed when delegate_parallel crashes during all-delegate fan-out", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-workflow-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const ledger = new FactLedger();
      events.subscribe((event) => ledger.observeEvent(event));
      const delegateParallelTool = defineTool<Record<string, unknown>, unknown>(
        {
          name: "delegate_parallel",
          description: "Delegate several configured agents.",
          inputSchema: { type: "object" },
          policy: { risk: "safe" },
          execute() {
            throw new Error("transport exploded");
          },
        },
      );
      const projection = createWorkflowProjectionHooks({
        workspaceRoot: workspace,
        workflowRunId: "wf_delegate_parallel_crash",
        delegateParallelTool,
        definition: {
          assetName: "delegate-parallel-crash",
          contentHash: "hash",
          nodes: [
            {
              id: "fanout",
              execute: "parallel",
              body: "",
              parallel: { branches: ["review", "test"], maxConcurrency: 2 },
              onPass: "done",
              onFail: "recover",
            },
            {
              id: "review",
              execute: "delegate",
              body: "",
              delegate: { agentId: "reviewer", goal: "Review." },
            },
            {
              id: "test",
              execute: "delegate",
              body: "",
              delegate: { agentId: "tester", goal: "Test." },
            },
            { id: "done", execute: "model", body: "Continue." },
            { id: "recover", execute: "model", body: "Recover." },
          ],
        },
      });

      const turn = await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "TurnStart",
        run,
        payload: {},
        events,
        facts: ledger,
      });

      expect(turn.status).toBe("blocked");
      expect(projection.getState()).toMatchObject({
        status: "failed",
        parallelBranches: {
          review: {
            status: "runtime_error",
            verdict: { reason: "delegate_parallel_runtime_error" },
          },
          test: {
            status: "runtime_error",
            verdict: { reason: "delegate_parallel_runtime_error" },
          },
        },
      });
      expect(
        events.all().find((event) => event.type === "workflow.failed")?.payload,
      ).toMatchObject({
        workflowRunId: "wf_delegate_parallel_crash",
        fromNodeId: "fanout",
        failure: { code: "WORKFLOW_NODE_FAILED" },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects joins whose branches have ambiguous parallel producers", () => {
    expect(() =>
      createWorkflowProjectionHooks({
        workspaceRoot: process.cwd(),
        workflowRunId: "wf_join_ambiguous",
        definition: {
          assetName: "join-ambiguous",
          contentHash: "hash",
          nodes: [
            {
              id: "fanout_a",
              execute: "parallel",
              body: "",
              parallel: { branches: ["shared"], maxConcurrency: 1 },
              onPass: "join",
            },
            {
              id: "fanout_b",
              execute: "parallel",
              body: "",
              parallel: { branches: ["shared"], maxConcurrency: 1 },
              onPass: "join",
            },
            {
              id: "shared",
              execute: "command",
              body: "",
              command: {
                command: process.execPath,
                args: ["-e", "process.exit(0)"],
                authorized: true,
              },
            },
            {
              id: "join",
              execute: "join",
              body: "",
              join: { waitFor: ["shared"] },
            },
          ],
        },
      }),
    ).toThrow(/produced by multiple parallel nodes/);
  });

  it("fails closed when join sees branch state from another parallel node", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-workflow-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const ledger = new FactLedger();
      events.subscribe((event) => ledger.observeEvent(event));
      const projection = createWorkflowProjectionHooks({
        workspaceRoot: workspace,
        workflowRunId: "wf_join_stale_branch",
        initialState: {
          status: "running",
          currentNodeId: "join",
          attempts: { join: 1 },
          parallelBranches: {
            lint: {
              sourceNodeId: "other_fanout",
              nodeId: "lint",
              attempt: 1,
              status: "passed",
              verdict: { status: "passed", reason: "command_passed" },
              completedAt: new Date().toISOString(),
            },
          },
          transitionLog: [],
        },
        definition: {
          assetName: "join-stale-branch",
          contentHash: "hash",
          nodes: [
            {
              id: "fanout",
              execute: "parallel",
              body: "",
              parallel: { branches: ["lint"], maxConcurrency: 1 },
              onPass: "join",
            },
            {
              id: "lint",
              execute: "command",
              body: "",
              command: {
                command: process.execPath,
                args: ["-e", "process.exit(0)"],
                authorized: true,
              },
            },
            {
              id: "join",
              execute: "join",
              body: "",
              join: { waitFor: ["lint"] },
              onFail: "model",
            },
            {
              id: "model",
              execute: "model",
              body: "This model must not run after stale branch state.",
            },
          ],
        },
      });

      const turn = await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "TurnStart",
        run,
        payload: {},
        events,
        facts: ledger,
      });

      expect(turn.status).toBe("blocked");
      expect(projection.getState()).toMatchObject({
        status: "failed",
        failure: {
          reason: expect.stringContaining(
            "branch state from a different parallel node",
          ),
          nodeId: "join",
        },
      });
      expect(projection.getState().currentNodeId).toBeUndefined();
      expect(
        events.all().find((event) => event.type === "workflow.failed")?.payload,
      ).toMatchObject({
        workflowRunId: "wf_join_stale_branch",
        fromNodeId: "join",
        failure: { code: "WORKFLOW_NODE_FAILED" },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("preserves parallel branch diagnostics when runtime failure ends workflow", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-workflow-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const ledger = new FactLedger();
      events.subscribe((event) => ledger.observeEvent(event));
      const projection = createWorkflowProjectionHooks({
        workspaceRoot: workspace,
        workflowRunId: "wf_runtime_preserves_parallel",
        initialState: {
          status: "running",
          currentNodeId: "model",
          attempts: { model: 1 },
          parallelBranches: {
            lint: {
              sourceNodeId: "fanout",
              nodeId: "lint",
              attempt: 1,
              status: "passed",
              verdict: { status: "passed", reason: "command_passed" },
              completedAt: "2026-07-05T00:00:00.000Z",
            },
          },
          transitionLog: [],
        },
        definition: {
          assetName: "runtime-preserves-parallel",
          contentHash: "hash",
          nodes: [
            {
              id: "fanout",
              execute: "parallel",
              body: "",
              parallel: { branches: ["lint"], maxConcurrency: 1 },
              onPass: "model",
            },
            {
              id: "lint",
              execute: "command",
              body: "",
              command: {
                command: process.execPath,
                args: ["-e", "process.exit(0)"],
                authorized: true,
              },
            },
            { id: "model", execute: "model", body: "Continue." },
          ],
        },
      });

      const signal = await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "RuntimeSignal",
        run,
        payload: { signal: "budget.exceeded", source: "workflow" },
        events,
        facts: ledger,
      });

      expect(signal.status).toBe("continued");
      expect(projection.getState()).toMatchObject({
        status: "failed",
        parallelBranches: {
          lint: { sourceNodeId: "fanout", status: "passed" },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("runs script nodes through the stdio workflow node API", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-workflow-"));
    try {
      const assetDir = join(workspace, "scripted");
      await mkdir(assetDir, { recursive: true });
      await writeFile(
        join(assetDir, "node.mjs"),
        [
          "import readline from 'node:readline';",
          "let id = 1;",
          "const rl = readline.createInterface({ input: process.stdin });",
          "function send(method, params) { console.log(JSON.stringify({ jsonrpc: '2.0', id: id++, method, params })); }",
          "rl.on('line', (line) => {",
          "  const msg = JSON.parse(line);",
          "  if (msg.id === 1) send('getEvidence', { nodeId: 'previous' });",
          "  else if (msg.id === 2) {",
          "    console.error('SPARKWRIGHT_EVENT: ' + JSON.stringify({ type: 'progress', message: 'script saw evidence', data: { count: msg.result.length } }));",
          "    send('complete', { result: { evidence: msg.result.length } });",
          "  } else if (msg.id === 3) process.exit(0);",
          "});",
          "send('initialize', { nodeId: 'script' });",
        ].join("\n"),
        "utf8",
      );
      const run = runRecord();
      const events = new EventLog(run.id);
      const ledger = new FactLedger();
      events.subscribe((event) => ledger.observeEvent(event));
      const projection = createWorkflowProjectionHooks({
        workspaceRoot: workspace,
        workflowRunId: "wf_script",
        allowScriptWrite: false,
        getEvidenceRefs: (nodeId) =>
          nodeId === "previous" ? [{ kind: "fact", ref: "fact:previous" }] : [],
        definition: {
          assetName: "scripted",
          contentHash: "hash",
          sourceDir: assetDir,
          nodes: [
            {
              id: "script",
              execute: "script",
              body: "",
              script: {
                path: "node.mjs",
                capabilities: ["read"],
              },
              onPass: "model",
            },
            { id: "model", execute: "model", body: "Summarize script output." },
          ],
        },
      });

      const turn = await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "TurnStart",
        run,
        payload: {},
        events,
        facts: ledger,
      });

      expect(turn.status).toBe("continued");
      expect(projection.getState()).toMatchObject({
        status: "running",
        currentNodeId: "model",
      });
      expect(
        events
          .all()
          .filter((event) => event.type === "workflow.node.completed")
          .map(
            (event) => event.payload as { nodeId?: string; verdict?: unknown },
          ),
      ).toEqual([
        expect.objectContaining({
          nodeId: "script",
          verdict: expect.objectContaining({
            status: "passed",
            reason: "script_completed",
          }),
        }),
      ]);
      expect(
        events
          .all()
          .find((event) => event.type === "extension.process.progress")
          ?.payload,
      ).toMatchObject({
        message: "script saw evidence",
        data: { count: 1 },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed when script nodes declare unsupported capabilities", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-workflow-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const ledger = new FactLedger();
      events.subscribe((event) => ledger.observeEvent(event));
      const projection = createWorkflowProjectionHooks({
        workspaceRoot: workspace,
        workflowRunId: "wf_script_capability",
        allowScriptWrite: true,
        definition: {
          assetName: "scripted",
          contentHash: "hash",
          sourceDir: workspace,
          nodes: [
            {
              id: "script",
              execute: "script",
              body: "",
              script: {
                path: "node.mjs",
                capabilities: ["network"],
              },
            },
          ],
        },
      });

      const turn = await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "TurnStart",
        run,
        payload: {},
        events,
        facts: ledger,
      });

      expect(turn.status).toBe("blocked");
      expect(projection.getState()).toMatchObject({
        status: "failed",
        failure: {
          reason: expect.stringContaining("unsupported capability"),
        },
      });
      expect(
        events.all().find((event) => event.type === "workflow.failed")?.payload,
      ).toMatchObject({
        workflowRunId: "wf_script_capability",
        failure: { code: "WORKFLOW_NODE_FAILED" },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("parks human nodes as durable waiting snapshots", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-workflow-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const ledger = new FactLedger();
      events.subscribe((event) => ledger.observeEvent(event));
      const snapshots: WorkflowProjectionStateSnapshot[] = [];
      const projection = createWorkflowProjectionHooks({
        workspaceRoot: workspace,
        workflowRunId: "wf_human_wait",
        onStateSnapshot: (snapshot) => {
          snapshots.push(snapshot);
        },
        definition: {
          assetName: "human-wait",
          contentHash: "hash",
          nodes: [
            {
              id: "prepare",
              execute: "command",
              body: "",
              command: {
                command: process.execPath,
                args: ["-e", "process.exit(0)"],
                authorized: true,
              },
              onPass: "review",
            },
            {
              id: "review",
              execute: "human",
              body: "Wait for review.",
              human: {
                prompt: "Review the release.",
                wait: {
                  kind: "input",
                  reason: "Need release approval.",
                },
              },
              onPass: "finish",
            },
            { id: "finish", execute: "model", body: "Finish." },
          ],
        },
      });

      const turn = await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "TurnStart",
        run,
        payload: {},
        events,
        facts: ledger,
      });

      expect(turn.status).toBe("continued");
      expect(projection.getState()).toMatchObject({
        status: "running",
        currentNodeId: "review",
      });
      expect(snapshots.at(-1)).toMatchObject({
        phase: "waiting",
        nodeId: "review",
        wait: {
          kind: "input",
          reason: "Need release approval.",
        },
      });
      expect(
        events.all().find((event) => event.type === "workflow.waiting")
          ?.payload,
      ).toMatchObject({
        workflowRunId: "wf_human_wait",
        nodeId: "review",
        wait: { kind: "input" },
      });
      expect(
        events
          .all()
          .filter((event) => event.type === "workflow.node.completed")
          .map((event) => (event.payload as { nodeId?: string }).nodeId),
      ).toEqual(["prepare"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("evaluates diff_scope from the node-entry write epoch", async () => {
    const run = runRecord();
    const events = new EventLog(run.id);
    const ledger = new FactLedger();
    events.subscribe((event) => ledger.observeEvent(event));
    const projection = createWorkflowProjectionHooks({
      workspaceRoot: process.cwd(),
      workflowRunId: "wf_diff_scope",
      definition: {
        assetName: "diff-scope",
        contentHash: "hash",
        nodes: [
          {
            id: "edit",
            execute: "model",
            body: "Edit src only.",
            verify: [
              {
                id: "src-only",
                kind: "diff_scope",
                include: ["src/**"],
                exclude: ["src/generated/**"],
              },
            ],
          },
        ],
      },
    });

    await runWorkflowHooks({
      hooks: projection.hooks,
      hook: "TurnStart",
      run,
      payload: {},
      events,
      facts: ledger,
    });
    events.emit("workspace.write.completed", { path: "README.md" });
    const stop = await runWorkflowHooks({
      hooks: projection.hooks,
      hook: "Stop",
      run,
      payload: { message: "done" },
      events,
      facts: ledger,
    });

    expect(stop.status).toBe("continued");
    expect(projection.getState()).toMatchObject({
      status: "failed",
      failure: {
        reason: "verification_failed",
      },
    });
    expect(
      events.all().find((event) => event.type === "workflow.failed")?.payload,
    ).toMatchObject({
      workflowRunId: "wf_diff_scope",
      failure: { code: "WORKFLOW_NODE_FAILED" },
    });
  });

  it("passes todo_clear when the host todo ledger has no unfinished items", async () => {
    const run = runRecord();
    const events = new EventLog(run.id);
    const ledger = new FactLedger();
    events.subscribe((event) => ledger.observeEvent(event));
    const projection = createWorkflowProjectionHooks({
      workspaceRoot: process.cwd(),
      workflowRunId: "wf_todo_clear_pass",
      readTodoLedger: () => ({
        schemaVersion: "todo-ledger.v1",
        metadata: {},
        items: [
          { title: "done", status: "completed", depth: 0 },
          { title: "skipped", status: "skipped", depth: 0 },
        ],
      }),
      definition: {
        assetName: "todo-clear",
        contentHash: "hash",
        nodes: [
          {
            id: "finish",
            execute: "model",
            body: "Finish.",
            verify: [{ id: "todos-done", kind: "todo_clear" }],
          },
        ],
      },
    });

    await runWorkflowHooks({
      hooks: projection.hooks,
      hook: "TurnStart",
      run,
      payload: {},
      events,
      facts: ledger,
    });
    const stop = await runWorkflowHooks({
      hooks: projection.hooks,
      hook: "Stop",
      run,
      payload: { message: "done" },
      events,
      facts: ledger,
    });

    expect(stop.status).toBe("continued");
    expect(projection.getState().status).toBe("completed");
    expect(
      events.all().find((event) => event.type === "workflow.node.completed")
        ?.payload,
    ).toMatchObject({
      workflowRunId: "wf_todo_clear_pass",
      nodeId: "finish",
      verdict: {
        status: "passed",
        metadata: { verified: true, verifiers: ["todos-done"] },
      },
      evidenceRefs: [
        {
          kind: "run",
          ref: run.id,
          verifierId: "todos-done",
          metadata: {
            kind: "todo_clear",
            summary: { unfinished: 0, hasUnfinished: false },
          },
        },
      ],
    });
  });

  it("fails todo_clear when the host todo ledger still has unfinished items", async () => {
    const run = runRecord();
    const events = new EventLog(run.id);
    const ledger = new FactLedger();
    events.subscribe((event) => ledger.observeEvent(event));
    const projection = createWorkflowProjectionHooks({
      workspaceRoot: process.cwd(),
      workflowRunId: "wf_todo_clear_fail",
      readTodoLedger: () => ({
        schemaVersion: "todo-ledger.v1",
        metadata: {},
        items: [{ title: "finish docs", status: "pending", depth: 0 }],
      }),
      definition: {
        assetName: "todo-clear",
        contentHash: "hash",
        nodes: [
          {
            id: "finish",
            execute: "model",
            body: "Finish.",
            verify: [{ id: "todos-done", kind: "todo_clear" }],
          },
        ],
      },
    });

    await runWorkflowHooks({
      hooks: projection.hooks,
      hook: "TurnStart",
      run,
      payload: {},
      events,
      facts: ledger,
    });
    const stop = await runWorkflowHooks({
      hooks: projection.hooks,
      hook: "Stop",
      run,
      payload: { message: "done" },
      events,
      facts: ledger,
    });

    expect(stop.status).toBe("continued");
    expect(projection.getState()).toMatchObject({
      status: "failed",
      failure: { reason: "verification_failed" },
    });
    expect(
      events.all().find((event) => event.type === "workflow.node.completed")
        ?.payload,
    ).toMatchObject({
      workflowRunId: "wf_todo_clear_fail",
      nodeId: "finish",
      verdict: {
        status: "failed",
        metadata: {
          failures: [
            {
              verifierId: "todos-done",
              kind: "todo_clear",
              summary: { unfinished: 1, hasUnfinished: true },
              unfinished: [{ title: "finish docs", status: "pending" }],
            },
          ],
        },
      },
    });
  });

  it("fails closed when todo_clear has no host todo ledger provider", async () => {
    const run = runRecord();
    const events = new EventLog(run.id);
    const ledger = new FactLedger();
    events.subscribe((event) => ledger.observeEvent(event));
    const projection = createWorkflowProjectionHooks({
      workspaceRoot: process.cwd(),
      workflowRunId: "wf_todo_clear_missing",
      definition: {
        assetName: "todo-clear",
        contentHash: "hash",
        nodes: [
          {
            id: "finish",
            execute: "model",
            body: "Finish.",
            verify: [{ id: "todos-done", kind: "todo_clear" }],
          },
        ],
      },
    });

    await runWorkflowHooks({
      hooks: projection.hooks,
      hook: "TurnStart",
      run,
      payload: {},
      events,
      facts: ledger,
    });
    const stop = await runWorkflowHooks({
      hooks: projection.hooks,
      hook: "Stop",
      run,
      payload: { message: "done" },
      events,
      facts: ledger,
    });

    expect(stop.status).toBe("continued");
    expect(projection.getState()).toMatchObject({
      status: "failed",
      failure: {
        reason:
          'Workflow todo_clear verifier "todos-done" requires a todo ledger provider.',
      },
    });
    expect(
      events.all().find((event) => event.type === "workflow.node.completed")
        ?.payload,
    ).toMatchObject({
      workflowRunId: "wf_todo_clear_missing",
      nodeId: "finish",
      verdict: {
        status: "runtime_error",
        reason:
          'Workflow todo_clear verifier "todos-done" requires a todo ledger provider.',
      },
    });
  });

  it("re-verifies completed nodes on resume before trusting the saved position", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-workflow-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const ledger = new FactLedger();
      events.subscribe((event) => ledger.observeEvent(event));
      let verifierCalls = 0;
      const snapshots: WorkflowProjectionStateSnapshot[] = [];
      const projection = createWorkflowProjectionHooks({
        workspaceRoot: workspace,
        workflowRunId: "wf_resume_reverify",
        onStateSnapshot: (snapshot) => {
          snapshots.push(snapshot);
        },
        initialState: {
          status: "running",
          currentNodeId: "second",
          attempts: { first: 1, second: 1 },
          transitionLog: [
            {
              at: "2026-07-04T00:00:00.000Z",
              verdict: { status: "passed" },
              decision: {
                type: "goto",
                fromNodeId: "first",
                toNodeId: "second",
                reason: "verification_passed",
              },
            },
          ],
        },
        resumeVerificationNodeIds: ["first"],
        builtinVerifiers: {
          resumeOk: () => {
            verifierCalls += 1;
            return { status: "continue", metadata: { exitCode: 0 } };
          },
        },
        definition: {
          assetName: "resume",
          contentHash: "hash",
          nodes: [
            {
              id: "first",
              execute: "model",
              body: "First.",
              verify: [
                {
                  id: "first-ok",
                  kind: "command",
                  command: "builtin",
                  authorized: true,
                  metadata: { builtinVerifier: "resumeOk" },
                },
              ],
              onPass: "second",
            },
            { id: "second", execute: "model", body: "Second." },
          ],
        },
      });

      const stop = await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "Stop",
        run,
        payload: { message: "resume done" },
        events,
        facts: ledger,
      });

      expect(verifierCalls).toBe(1);
      expect(stop.status).toBe("continued");
      expect(projection.getState().status).toBe("completed");
      expect(ledger.snapshot().verificationResults).toEqual([
        expect.objectContaining({
          nodeId: "first",
          verifierId: "first-ok",
          satisfied: true,
        }),
      ]);
      expect(
        snapshots.find(
          (snapshot) =>
            snapshot.phase === "node_completed" && snapshot.nodeId === "first",
        )?.evidenceRefs,
      ).toEqual([
        expect.objectContaining({
          kind: "fact",
          ref: expect.stringMatching(/^verify:/),
          nodeId: "first",
          verifierId: "first-ok",
        }),
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("feeds resume verifier drift back through the completed node transition", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-workflow-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const ledger = new FactLedger();
      events.subscribe((event) => ledger.observeEvent(event));
      const projection = createWorkflowProjectionHooks({
        workspaceRoot: workspace,
        workflowRunId: "wf_resume_drift",
        initialState: {
          status: "running",
          currentNodeId: "second",
          attempts: { first: 1, second: 1 },
          transitionLog: [
            {
              at: "2026-07-04T00:00:00.000Z",
              verdict: { status: "passed" },
              decision: {
                type: "goto",
                fromNodeId: "first",
                toNodeId: "second",
                reason: "verification_passed",
              },
            },
          ],
        },
        resumeVerificationNodeIds: ["first"],
        builtinVerifiers: {
          resumeDrift: () => ({
            status: "continue",
            metadata: { exitCode: 1 },
          }),
        },
        definition: {
          assetName: "resume",
          contentHash: "hash",
          nodes: [
            {
              id: "first",
              execute: "model",
              body: "First.",
              verify: [
                {
                  id: "first-ok",
                  kind: "command",
                  command: "builtin",
                  authorized: true,
                  metadata: { builtinVerifier: "resumeDrift" },
                },
              ],
              onFail: { retry: 1 },
              onPass: "second",
            },
            { id: "second", execute: "model", body: "Second." },
          ],
        },
      });

      const stop = await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "Stop",
        run,
        payload: { message: "resume done" },
        events,
        facts: ledger,
      });

      expect(stop.status).toBe("advanced");
      expect(projection.getState()).toMatchObject({
        status: "running",
        currentNodeId: "first",
        attempts: { first: 2 },
      });
      expect(ledger.snapshot().verificationResults).toEqual([
        expect.objectContaining({
          nodeId: "first",
          verifierId: "first-ok",
          satisfied: false,
        }),
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("retries on verifier failure before failing the workflow", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-workflow-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const ledger = new FactLedger();
      events.subscribe((event) => ledger.observeEvent(event));
      const projection = createWorkflowProjectionHooks({
        workspaceRoot: workspace,
        workflowRunId: "wf_retry",
        definition: {
          assetName: "retry",
          contentHash: "hash",
          nodes: [
            {
              id: "verify",
              execute: "model",
              body: "Verify.",
              verify: [
                {
                  id: "fails",
                  kind: "command",
                  command: process.execPath,
                  args: ["-e", "process.exit(2)"],
                  expect: "zero",
                  authorized: true,
                },
              ],
              onFail: { retry: 1, then: "fail" },
            },
          ],
        },
      });

      const firstStop = await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "Stop",
        run,
        payload: { message: "try" },
        events,
        facts: ledger,
      });
      const secondStop = await runWorkflowHooks({
        hooks: projection.hooks,
        hook: "Stop",
        run,
        payload: { message: "try again" },
        events,
        facts: ledger,
      });

      expect(firstStop.status).toBe("advanced");
      expect(secondStop.status).toBe("continued");
      expect(
        events
          .all()
          .filter((event) => event.type === "workflow.node.completed")
          .map((event) => (event.payload as { attempt?: unknown }).attempt),
      ).toEqual([1, 2]);
      expect(
        events.all().find((event) => event.type === "workflow.failed")?.payload,
      ).toMatchObject({
        workflowRunId: "wf_retry",
        failure: { code: "WORKFLOW_NODE_FAILED" },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("blocks tools outside the active node allowlist", async () => {
    const projection = createWorkflowProjectionHooks({
      workspaceRoot: process.cwd(),
      workflowRunId: "wf_tools",
      definition: {
        assetName: "tools",
        contentHash: "hash",
        nodes: [
          {
            id: "limited",
            execute: "model",
            body: "Use only read_file.",
            tools: ["read_file"],
          },
        ],
      },
    });
    const run = runRecord();
    const events = new EventLog(run.id);

    const rewrite = await runWorkflowHooks({
      hooks: projection.hooks,
      hook: "PreToolUse",
      preToolUseStage: "rewrite",
      run,
      payload: { toolName: "shell", arguments: {} },
      events,
    });
    expect(rewrite.status).toBe("continued");

    const blocked = await runWorkflowHooks({
      hooks: projection.hooks,
      hook: "PreToolUse",
      preToolUseStage: "governance",
      run,
      payload: { toolName: "shell", arguments: {} },
      events,
    });

    expect(blocked.status).toBe("blocked");
    if (blocked.status !== "blocked") {
      throw new Error("expected blocked workflow hook result");
    }
    expect(blocked.block.metadata).toMatchObject({
      workflowRunId: "wf_tools",
      nodeId: "limited",
      toolName: "shell",
      allowedTools: ["read_file"],
    });
  });

  it("runs configured rewrites before the real workflow tool clamp", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-projection-"));
    try {
      let executed = false;
      let modelCalls = 0;
      const configured = createConfiguredWorkflowHooks({
        workspaceRoot: workspace,
        workflowActive: true,
        hooks: [
          {
            name: "configured-rewrite",
            hook: "PreToolUse",
            onError: "block",
            action: {
              type: "command",
              command: process.execPath,
              args: [
                "-e",
                "console.log(JSON.stringify({status:'rewrite', patch:{arguments:{command:'echo hi', path:'generated/a.ts'}}}))",
              ],
              resultMode: "stdoutJson",
            },
          },
        ],
      });
      const projection = createWorkflowProjectionHooks({
        workspaceRoot: workspace,
        workflowRunId: "wf_rewrite_clamp",
        definition: {
          assetName: "rewrite-clamp",
          contentHash: "hash",
          nodes: [
            {
              id: "limited",
              execute: "model",
              body: "Use only read_file.",
              tools: ["read_file"],
            },
          ],
        },
      });
      const run = createRun({
        goal: "rewrite before projection clamp",
        workflowHooks: [...configured, ...projection.hooks],
        tools: [
          defineTool({
            name: "shell",
            description: "Shell.",
            inputSchema: {
              type: "object",
              properties: {
                command: { type: "string" },
                path: { type: "string" },
              },
              required: ["command"],
            },
            execute() {
              executed = true;
              return { ok: true };
            },
          }),
        ],
        model: {
          async complete(input) {
            modelCalls += 1;
            if (modelCalls === 1) {
              return {
                toolCalls: [
                  {
                    toolName: "shell",
                    arguments: { command: "echo hi", path: "draft.ts" },
                  },
                ],
              };
            }
            expect(input.context[0]?.content).toContain(
              "TOOL_BLOCKED_BY_WORKFLOW_HOOK",
            );
            return { message: "blocked by workflow clamp" };
          },
        },
      });

      const result = await run.start();

      expect(result.state).toBe("failed");
      expect(modelCalls).toBe(2);
      expect(executed).toBe(false);
      expect(
        run.events
          .all()
          .find(
            (event) =>
              event.type === "workflow_hook.blocked" &&
              (event.payload as { hookId?: unknown }).hookId ===
                "workflow-tool-clamp",
          )?.payload,
      ).toMatchObject({
        reason: 'Workflow node "limited" does not allow tool "shell".',
        resultMetadata: {
          workflowRunId: "wf_rewrite_clamp",
          nodeId: "limited",
          toolName: "shell",
          allowedTools: ["read_file"],
          path: "generated/a.ts",
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed at RunStart and TurnStart projection gates", async () => {
    for (const hook of ["RunStart", "TurnStart"] as const) {
      const projection = createWorkflowProjectionHooks({
        workspaceRoot: process.cwd(),
        workflowRunId: `wf_${hook}`,
        faultInjection: { [hook]: `${hook} exploded` },
        definition: {
          assetName: "faulty",
          contentHash: "hash",
          nodes: [{ id: "main", execute: "model", body: "Run." }],
        },
      });
      const run = createRun({
        goal: `${hook} fault`,
        workflowHooks: projection.hooks,
        model: {
          async complete() {
            return { message: "done" };
          },
        },
      });

      const result = await run.start();

      expect(result.state).toBe("failed");
      expect(result.stopReason).toBe("hook_stopped");
      expect(
        run.events.all().find((event) => event.type === "workflow_hook.failed")
          ?.payload,
      ).toMatchObject({ hook });
    }
  });

  it("turns PreToolUse projection errors into synthetic tool failures", async () => {
    let modelCalls = 0;
    const projection = createWorkflowProjectionHooks({
      workspaceRoot: process.cwd(),
      workflowRunId: "wf_pretool_fault",
      faultInjection: { PreToolUse: "pretool exploded" },
      definition: {
        assetName: "pretool",
        contentHash: "hash",
        nodes: [{ id: "main", execute: "model", body: "Run." }],
      },
    });
    const run = createRun({
      goal: "pretool fault",
      workflowHooks: projection.hooks,
      tools: [
        defineTool({
          name: "read_file",
          description: "Read.",
          inputSchema: { type: "object" },
          execute() {
            return { ok: true };
          },
        }),
      ],
      model: {
        async complete() {
          modelCalls += 1;
          return modelCalls === 1
            ? { toolCalls: [{ toolName: "read_file", arguments: {} }] }
            : { message: "done" };
        },
      },
      maxSteps: 3,
    });

    const result = await run.start();

    expect(result.state).toBe("completed");
    expect(
      run.events.all().find((event) => event.type === "tool.failed")?.payload,
    ).toMatchObject({
      toolName: "read_file",
      error: { code: "TOOL_BLOCKED_BY_WORKFLOW_HOOK" },
    });
  });

  it("fails incomplete workflows when Stop projection errors exhaust the workflow source budget", async () => {
    let modelCalls = 0;
    const projection = createWorkflowProjectionHooks({
      workspaceRoot: process.cwd(),
      workflowRunId: "wf_stop_fault",
      stopRuntimeErrorThreshold: 99,
      faultInjection: { Stop: "stop exploded" },
      definition: {
        assetName: "stop",
        contentHash: "hash",
        nodes: [{ id: "main", execute: "model", body: "Run." }],
      },
    });
    const run = createRun({
      goal: "stop fault",
      workflowHooks: projection.hooks,
      model: {
        async complete() {
          modelCalls += 1;
          return { message: `done ${modelCalls}` };
        },
      },
      maxSteps: 1,
      forcedContinuationBudgets: { workflow: 1 },
    });

    const result = await run.start();

    expect(result.state).toBe("completed");
    expect(modelCalls).toBe(2);
    expect(
      run.events.all().filter((event) => event.type === "workflow_hook.failed")
        .length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      run.events.all().find((event) => event.type === "run.budget.exceeded")
        ?.payload,
    ).toMatchObject({ source: "workflow" });
    expect(
      run.events.all().find((event) => event.type === "workflow.interrupted")
        ?.payload,
    ).toMatchObject({
      workflowRunId: "wf_stop_fault",
      kind: "budget",
      source: "workflow",
    });
    expect(
      run.events.all().find((event) => event.type === "workflow.failed")
        ?.payload,
    ).toMatchObject({
      workflowRunId: "wf_stop_fault",
      failure: { kind: "runtime", code: "WORKFLOW_RUNTIME_FAILED" },
    });
    expect(result.metadata).toMatchObject({
      outcome: {
        failing: true,
        workflowFailure: {
          lastCode: "WORKFLOW_RUNTIME_FAILED",
        },
      },
    });
  });

  it("bounds persistent Stop projection errors before maxSteps", async () => {
    let modelCalls = 0;
    const projection = createWorkflowProjectionHooks({
      workspaceRoot: process.cwd(),
      workflowRunId: "wf_stop_threshold",
      stopRuntimeErrorThreshold: 2,
      faultInjection: { Stop: "stop exploded" },
      definition: {
        assetName: "stop-threshold",
        contentHash: "hash",
        nodes: [{ id: "main", execute: "model", body: "Run." }],
      },
    });
    const run = createRun({
      goal: "stop threshold",
      workflowHooks: projection.hooks,
      model: {
        async complete() {
          modelCalls += 1;
          return { message: `done ${modelCalls}` };
        },
      },
      maxSteps: 8,
      forcedContinuationBudgets: { workflow: 5 },
    });

    const result = await run.start();

    expect(result.state).toBe("completed");
    expect(modelCalls).toBe(2);
    expect(result.metadata).toMatchObject({
      outcome: {
        failing: true,
        workflowFailure: {
          lastCode: "WORKFLOW_RUNTIME_FAILED",
        },
      },
    });
    expect(
      run.events.all().find((event) => event.type === "workflow.failed")
        ?.payload,
    ).toMatchObject({
      workflowRunId: "wf_stop_threshold",
      failure: { kind: "runtime", code: "WORKFLOW_RUNTIME_FAILED" },
    });
  });
});

describe("createConfiguredWorkflowHooks", () => {
  it("keeps configured workflow hooks in the awaited workflow hook lane", () => {
    const hooks = createConfiguredWorkflowHooks({
      workspaceRoot: process.cwd(),
      hooks: [
        {
          name: "awaited-check",
          hook: "PostToolUse",
          action: {
            type: "command",
            command: process.execPath,
            args: ["-e", "process.exit(0)"],
          },
        },
      ],
    });

    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({
      name: "awaited-check",
      hook: "PostToolUse",
    });
  });

  it("binds event command hooks through non-blocking user hook events", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-event-hook-"));
    try {
      const record = runRecord();
      const events = new EventLog(record.id);
      const controller = new AbortController();
      const unsubscribe = bindConfiguredEventHooks({
        workspaceRoot: workspace,
        run: {
          record,
          events,
          abortSignal: controller.signal,
        } as never,
        hooks: [
          {
            name: "record-write",
            trigger: "tool.completed",
            matcher: { toolName: "apply_patch", status: "completed" },
            action: {
              type: "command",
              command: process.execPath,
              args: ["-e", "console.log('observed')"],
            },
          },
        ],
      });

      events.emit("tool.completed", {
        toolName: "apply_patch",
        toolCallId: "call_1",
      });
      await waitForEvent(events, "user_hook.completed");
      unsubscribe();

      expect(events.all().map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "user_hook.invoked",
          "extension.process.started",
          "extension.process.completed",
          "user_hook.completed",
        ]),
      );
      expect(
        events.all().find((event) => event.type === "extension.process.started")
          ?.payload,
      ).toMatchObject({ kind: "user_hook", name: "record-write" });
      expect(
        events.all().some((event) => event.type === "workflow_hook.blocked"),
      ).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("converts block actions into blocking WorkflowHooks", async () => {
    const run = runRecord();
    const events = new EventLog(run.id);
    const hooks = createConfiguredWorkflowHooks({
      workspaceRoot: process.cwd(),
      hooks: [
        {
          name: "block-generated",
          hook: "PreToolUse",
          matcher: { toolName: "write_file", pathGlob: "generated/**" },
          action: { type: "block", reason: "Generated files are locked." },
        },
      ],
    });

    const result = await runWorkflowHooks({
      hooks,
      hook: "PreToolUse",
      run,
      payload: { toolName: "write_file", path: "generated/a.ts" },
      events,
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") {
      throw new Error("expected blocked workflow hook result");
    }
    expect(result.block.reason).toBe("Generated files are locked.");
  });

  it("converts context actions into injected ContextItems", async () => {
    const run = runRecord();
    const events = new EventLog(run.id);
    const hooks = createConfiguredWorkflowHooks({
      workspaceRoot: process.cwd(),
      hooks: [
        {
          name: "session-context",
          hook: "RunStart",
          action: {
            type: "context",
            content: "Always run tests before final answer.",
            contextType: "system",
          },
        },
      ],
    });

    const result = await runWorkflowHooks({
      hooks,
      hook: "RunStart",
      run,
      payload: {},
      events,
    });

    expect(result.status).toBe("continued");
    expect(result.context[0]).toMatchObject({
      type: "system",
      content: "Always run tests before final answer.",
    });
  });

  it("can block on command action failures", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-hook-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: workspace,
        hooks: [
          {
            name: "failing-check",
            hook: "Stop",
            action: {
              type: "command",
              command: process.execPath,
              args: ["-e", "console.error('nope'); process.exit(3)"],
              blockOnFailure: true,
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        payload: {},
        events,
      });

      expect(result.status).toBe("blocked");
      if (result.status !== "blocked") {
        throw new Error("expected blocked workflow hook result");
      }
      expect(result.block.reason).toContain("exit code 3");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("can use command stdout JSON as a WorkflowHookResult", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-hook-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: workspace,
        hooks: [
          {
            name: "json-check",
            hook: "Stop",
            action: {
              type: "command",
              command: process.execPath,
              args: [
                "-e",
                [
                  "process.stderr.write(",
                  "  process.env.SPARKWRIGHT_EVENT_TOKEN + ': ' +",
                  "  JSON.stringify({type:'progress', message:'checking policy'}) + '\\n');",
                  "console.log(JSON.stringify({status:'block', reason:'no ship', metadata:{source:'script'}}));",
                ].join("\n"),
              ],
              resultMode: "stdoutJson",
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        payload: {},
        events,
      });

      expect(result.status).toBe("blocked");
      if (result.status !== "blocked") {
        throw new Error("expected blocked workflow hook result");
      }
      expect(result.block.reason).toBe("no ship");
      expect(result.block.metadata).toMatchObject({
        source: "script",
        actionResult: { exitCode: 0 },
      });
      expect(events.all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "extension.process.progress",
            payload: expect.objectContaining({
              channel: "event",
              message: "checking policy",
            }),
          }),
          expect.objectContaining({
            type: "extension.process.completed",
            payload: expect.objectContaining({
              output: expect.not.objectContaining({
                stderrPreview: expect.stringContaining("SPARKWRIGHT_EVENT"),
              }),
            }),
          }),
        ]),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("can use command stdout JSON to advance a workflow hook", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-hook-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: workspace,
        hooks: [
          {
            name: "json-advance",
            hook: "Stop",
            action: {
              type: "command",
              command: process.execPath,
              args: [
                "-e",
                "console.log(JSON.stringify({status:'advance', reason:'node passed', metadata:{nodeId:'reproduce'}}));",
              ],
              resultMode: "stdoutJson",
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        payload: {},
        events,
      });

      expect(result.status).toBe("advanced");
      if (result.status !== "advanced") {
        throw new Error("expected advanced workflow hook result");
      }
      expect(result.advance.reason).toBe("node passed");
      expect(result.advance.metadata).toMatchObject({
        nodeId: "reproduce",
        actionResult: { exitCode: 0 },
      });
      expect(events.all().map((event) => event.type)).toContain(
        "workflow_hook.completed",
      );
      expect(events.all().map((event) => event.type)).not.toContain(
        "workflow_hook.blocked",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects configured advance while a workflow is active", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-hook-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: workspace,
        workflowActive: true,
        hooks: [
          {
            name: "configured-advance",
            hook: "Stop",
            onError: "block",
            action: {
              type: "command",
              command: process.execPath,
              args: [
                "-e",
                "console.log(JSON.stringify({status:'advance', reason:'configured advance'}));",
              ],
              resultMode: "stdoutJson",
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        payload: {},
        events,
      });

      expect(result.status).toBe("blocked");
      if (result.status !== "blocked") {
        throw new Error("expected blocked workflow hook result");
      }
      expect(result.block.reason).toContain(
        "configured hooks cannot advance workflow-controlled runs",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("pins configured advance support to ModelOutput and Stop", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-hook-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: workspace,
        hooks: [
          {
            name: "model-output-advance",
            hook: "ModelOutput",
            action: {
              type: "command",
              command: process.execPath,
              args: [
                "-e",
                "console.log(JSON.stringify({status:'advance', reason:'model output accepted'}));",
              ],
              resultMode: "stdoutJson",
            },
          },
          {
            name: "pre-tool-advance",
            hook: "PreToolUse",
            onError: "block",
            action: {
              type: "command",
              command: process.execPath,
              args: [
                "-e",
                "console.log(JSON.stringify({status:'advance', reason:'should reject'}));",
              ],
              resultMode: "stdoutJson",
            },
          },
        ],
      });

      const advanced = await runWorkflowHooks({
        hooks,
        hook: "ModelOutput",
        run,
        payload: {},
        events,
      });
      expect(advanced.status).toBe("advanced");

      const blocked = await runWorkflowHooks({
        hooks,
        hook: "PreToolUse",
        run,
        payload: { toolName: "read", arguments: {} },
        events,
      });
      expect(blocked.status).toBe("blocked");
      if (blocked.status !== "blocked") {
        throw new Error("expected blocked workflow hook result");
      }
      expect(blocked.block.reason).toContain(
        "advance is only supported for ModelOutput and Stop",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("can use HTTP response JSON as a WorkflowHookResult", async () => {
    const seenBodies: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        seenBodies.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            status: "block",
            reason: "http says no",
            metadata: { source: "http" },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address() as AddressInfo;
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: process.cwd(),
        http: {
          enabled: true,
          allow: [{ origin: `http://127.0.0.1:${address.port}` }],
          allowPrivateNetwork: true,
        },
        hooks: [
          {
            name: "http-check",
            hook: "Stop",
            action: {
              type: "http",
              url: `http://127.0.0.1:${address.port}/hook`,
              resultMode: "responseJson",
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        payload: { message: "ship?" },
        events,
      });

      expect(result.status).toBe("blocked");
      if (result.status !== "blocked") {
        throw new Error("expected blocked workflow hook result");
      }
      expect(result.block.reason).toBe("http says no");
      expect(result.block.metadata).toMatchObject({
        source: "http",
        actionResult: {
          hookName: "http-check",
          hook: "Stop",
          status: 200,
          ok: true,
        },
      });
      expect(seenBodies[0]).toMatchObject({
        hook: "Stop",
        run: { id: run.id, state: "running" },
      });
      expect(
        (seenBodies[0] as Record<string, unknown>).payload,
      ).toBeUndefined();
      expect(
        (seenBodies[0] as { run?: Record<string, unknown> }).run?.goal,
      ).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("requires explicit HTTP hook enablement before fetching", async () => {
    const run = runRecord();
    const events = new EventLog(run.id);
    const hooks = createConfiguredWorkflowHooks({
      workspaceRoot: process.cwd(),
      hooks: [
        {
          name: "http-disabled",
          hook: "Stop",
          onError: "block",
          action: {
            type: "http",
            url: "https://example.com/hook",
          },
        },
      ],
    });

    const result = await runWorkflowHooks({
      hooks,
      hook: "Stop",
      run,
      payload: {},
      events,
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") {
      throw new Error("expected blocked workflow hook result");
    }
    expect(result.block.reason).toContain("HTTP hook actions are disabled");
  });

  it("blocks link-local HTTP hook targets even when private network is allowed", async () => {
    const run = runRecord();
    const events = new EventLog(run.id);
    const hooks = createConfiguredWorkflowHooks({
      workspaceRoot: process.cwd(),
      http: {
        enabled: true,
        allow: [{ origin: "http://169.254.169.254" }],
        allowPrivateNetwork: true,
      },
      hooks: [
        {
          name: "metadata-http",
          hook: "Stop",
          onError: "block",
          action: {
            type: "http",
            url: "http://169.254.169.254/latest/meta-data",
          },
        },
      ],
    });

    const result = await runWorkflowHooks({
      hooks,
      hook: "Stop",
      run,
      payload: {},
      events,
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") {
      throw new Error("expected blocked workflow hook result");
    }
    expect(result.block.reason).toContain("blocked link-local address");
  });

  it("does not follow HTTP hook redirects to other hosts", async () => {
    const server = createServer((_req, res) => {
      // A followed redirect would pivot to a blocked link-local address.
      res.writeHead(302, {
        location: "http://169.254.169.254/latest/meta-data",
      });
      res.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address() as AddressInfo;
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: process.cwd(),
        http: {
          enabled: true,
          allow: [{ origin: `http://127.0.0.1:${address.port}` }],
          allowPrivateNetwork: true,
        },
        hooks: [
          {
            name: "http-redirect",
            hook: "Stop",
            action: {
              type: "http",
              url: `http://127.0.0.1:${address.port}/hook`,
              blockOnFailure: true,
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        payload: {},
        events,
      });

      // The 302 itself is surfaced as a failed (non-2xx) response. If the
      // redirect had been followed we'd see a connect error to 169.254, not a
      // clean status 302.
      expect(result.status).toBe("blocked");
      if (result.status !== "blocked") {
        throw new Error("expected blocked workflow hook result");
      }
      expect(result.block.reason).toContain("status 302");
      expect(result.block.metadata).toMatchObject({ status: 302, ok: false });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("can use agent workflowResult output as a WorkflowHookResult", async () => {
    const run = runRecord();
    const events = new EventLog(run.id);
    const controller = new AbortController();
    const parentRun = {
      record: run,
      events,
      abortSignal: controller.signal,
    } as never;
    const agentTool = defineTool<Record<string, unknown>, unknown>({
      name: "delegate_agent",
      description: "Delegate to a configured agent",
      inputSchema: { type: "object" },
      policy: { risk: "safe" },
      execute: (args, ctx) => {
        expect(args).toMatchObject({
          agentId: "reviewer",
          goal: "review final answer",
        });
        expect(ctx.run.id).toBe(run.id);
        return {
          status: "block",
          reason: "agent says no",
          metadata: { source: "agent" },
        };
      },
    });
    const hooks = createConfiguredWorkflowHooks({
      workspaceRoot: process.cwd(),
      getRun: () => parentRun,
      agentTool,
      hooks: [
        {
          name: "agent-check",
          hook: "Stop",
          action: {
            type: "agent",
            agentId: "reviewer",
            goal: "review final answer",
            resultMode: "workflowResult",
          },
        },
      ],
    });

    const result = await runWorkflowHooks({
      hooks,
      hook: "Stop",
      run,
      payload: {},
      events,
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") {
      throw new Error("expected blocked workflow hook result");
    }
    expect(result.block.reason).toBe("agent says no");
    expect(result.block.metadata).toMatchObject({
      source: "agent",
      actionResult: {
        hookName: "agent-check",
        hook: "Stop",
        agentId: "reviewer",
        goal: "review final answer",
      },
    });
  });

  it("can use command stdout JSON to rewrite PreToolUse arguments", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-hook-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: workspace,
        hooks: [
          {
            name: "json-rewrite",
            hook: "PreToolUse",
            action: {
              type: "command",
              command: process.execPath,
              args: [
                "-e",
                "console.log(JSON.stringify({status:'rewrite', patch:{arguments:{command:'npm test'}}}))",
              ],
              resultMode: "stdoutJson",
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "PreToolUse",
        run,
        payload: { toolName: "shell", arguments: { command: "npm t" } },
        events,
      });

      expect(result.status).toBe("continued");
      expect(result.rewrites).toEqual([
        expect.objectContaining({ arguments: { command: "npm test" } }),
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("applies configured PreToolUse rewrites before governance while a workflow is active", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-hook-"));
    try {
      let executed = false;
      let modelCalls = 0;
      const configured = createConfiguredWorkflowHooks({
        workspaceRoot: workspace,
        workflowActive: true,
        hooks: [
          {
            name: "configured-rewrite",
            hook: "PreToolUse",
            onError: "block",
            action: {
              type: "command",
              command: process.execPath,
              args: [
                "-e",
                "console.log(JSON.stringify({status:'rewrite', patch:{arguments:{path:'generated/a.ts'}}}))",
              ],
              resultMode: "stdoutJson",
            },
          },
          {
            name: "generated-block",
            hook: "PreToolUse",
            matcher: { toolName: "write_file", pathGlob: "generated/**" },
            action: { type: "block", reason: "generated files are locked" },
          },
        ],
      });
      const run = createRun({
        goal: "rewrite then govern",
        workflowHooks: configured,
        tools: [
          defineTool({
            name: "write_file",
            description: "Write.",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
            execute() {
              executed = true;
              return { ok: true };
            },
          }),
        ],
        model: {
          async complete(input) {
            modelCalls += 1;
            if (modelCalls === 1) {
              return {
                toolCalls: [
                  { toolName: "write_file", arguments: { path: "draft.ts" } },
                ],
              };
            }
            expect(input.context[0]?.content).toContain(
              "TOOL_BLOCKED_BY_WORKFLOW_HOOK",
            );
            return { message: "blocked after rewrite" };
          },
        },
      });

      const result = await run.start();

      expect(result.state).toBe("completed");
      expect(modelCalls).toBe(2);
      expect(executed).toBe(false);
      expect(
        run.events.all().find((event) => event.type === "workflow_hook.blocked")
          ?.payload,
      ).toMatchObject({
        hookName: "generated-block",
        reason: "generated files are locked",
      });
      expect(
        run.events.all().some((event) => {
          if (event.type !== "workflow_hook.failed") return false;
          return JSON.stringify(event.payload).includes(
            "configured PreToolUse hooks cannot rewrite workflow-controlled tool calls",
          );
        }),
      ).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects workflow hook effects that the lifecycle cannot consume", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-hook-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: workspace,
        hooks: [
          {
            name: "bad-stop-rewrite",
            hook: "Stop",
            onError: "block",
            action: {
              type: "command",
              command: process.execPath,
              args: [
                "-e",
                "console.log(JSON.stringify({status:'rewrite', patch:{arguments:{command:'npm test'}}}))",
              ],
              resultMode: "stdoutJson",
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        payload: {},
        events,
      });

      expect(result.status).toBe("blocked");
      if (result.status !== "blocked") {
        throw new Error("expected blocked workflow hook result");
      }
      expect(result.block.reason).toContain("rewrite is only supported");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses onError for malformed command stdout JSON", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-hook-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: workspace,
        hooks: [
          {
            name: "bad-json",
            hook: "Stop",
            onError: "block",
            action: {
              type: "command",
              command: process.execPath,
              args: ["-e", "console.log('not json')"],
              resultMode: "stdoutJson",
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        payload: {},
        events,
      });

      expect(result.status).toBe("blocked");
      if (result.status !== "blocked") {
        throw new Error("expected blocked workflow hook result");
      }
      expect(result.block.reason).toContain("invalid JSON");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("drops malformed stderr progress without corrupting stdoutJson hook control", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-hook-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: workspace,
        hooks: [
          {
            name: "bad-progress-good-json",
            hook: "Stop",
            onError: "block",
            action: {
              type: "command",
              command: process.execPath,
              args: [
                "-e",
                [
                  "process.stderr.write(process.env.SPARKWRIGHT_EVENT_TOKEN + ': not json\\n');",
                  "process.stdout.write(JSON.stringify({status:'block', reason:'stdout still controls'}));",
                ].join("\n"),
              ],
              resultMode: "stdoutJson",
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        payload: {},
        events,
      });

      expect(result.status).toBe("blocked");
      if (result.status !== "blocked") {
        throw new Error("expected blocked workflow hook result");
      }
      expect(result.block.reason).toBe("stdout still controls");
      expect(events.all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "extension.process.completed",
            payload: expect.objectContaining({
              progressDropped: 1,
              output: expect.not.objectContaining({
                stderrPreview: expect.stringContaining("not json"),
              }),
            }),
          }),
        ]),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("deduplicates repeated Stop agent blocks for the same run", async () => {
    const run = runRecord();
    const events = new EventLog(run.id);
    const controller = new AbortController();
    const parentRun = {
      record: run,
      events,
      abortSignal: controller.signal,
    } as never;
    let calls = 0;
    const agentTool = defineTool<Record<string, unknown>, unknown>({
      name: "delegate_agent",
      description: "Delegate to a configured agent",
      inputSchema: { type: "object" },
      policy: { risk: "safe" },
      execute: () => {
        calls += 1;
        return { status: "block", reason: "still blocked" };
      },
    });
    const hooks = createConfiguredWorkflowHooks({
      workspaceRoot: process.cwd(),
      getRun: () => parentRun,
      agentTool,
      hooks: [
        {
          name: "agent-stop",
          hook: "Stop",
          action: {
            type: "agent",
            agentId: "reviewer",
            goal: "review final answer",
            resultMode: "workflowResult",
          },
        },
      ],
    });

    const first = await runWorkflowHooks({
      hooks,
      hook: "Stop",
      run,
      payload: {},
      events,
    });
    const second = await runWorkflowHooks({
      hooks,
      hook: "Stop",
      run,
      payload: {},
      events,
    });

    expect(first.status).toBe("blocked");
    expect(second.status).toBe("continued");
    expect(calls).toBe(1);
    expect(events.all().at(-1)?.payload).toMatchObject({
      result: {
        status: "skipped",
        metadata: { repeatedBlockSignature: true },
      },
    });
  });

  it("reports malformed agent workflowResult strings as invalid JSON", async () => {
    const run = runRecord();
    const events = new EventLog(run.id);
    const controller = new AbortController();
    const parentRun = {
      record: run,
      events,
      abortSignal: controller.signal,
    } as never;
    const agentTool = defineTool<Record<string, unknown>, unknown>({
      name: "delegate_agent",
      description: "Delegate to a configured agent",
      inputSchema: { type: "object" },
      policy: { risk: "safe" },
      execute: () => "not json",
    });
    const hooks = createConfiguredWorkflowHooks({
      workspaceRoot: process.cwd(),
      getRun: () => parentRun,
      agentTool,
      hooks: [
        {
          name: "agent-bad-json",
          hook: "Stop",
          onError: "block",
          action: {
            type: "agent",
            agentId: "reviewer",
            goal: "review final answer",
            resultMode: "workflowResult",
          },
        },
      ],
    });

    const result = await runWorkflowHooks({
      hooks,
      hook: "Stop",
      run,
      payload: {},
      events,
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") {
      throw new Error("expected blocked workflow hook result");
    }
    expect(result.block.reason).toContain("invalid JSON");
  });

  it("can skip configured hooks after they run once in a turn", async () => {
    const run = runRecord();
    const events = new EventLog(run.id);
    const hooks = createConfiguredWorkflowHooks({
      workspaceRoot: process.cwd(),
      hooks: [
        {
          name: "once",
          hook: "PostToolUse",
          frequency: "oncePerTurn",
          action: {
            type: "context",
            content: "ran",
          },
        },
      ],
    });

    const first = await runWorkflowHooks({
      hooks,
      hook: "PostToolUse",
      run,
      step: 1,
      payload: {},
      events,
    });
    const second = await runWorkflowHooks({
      hooks,
      hook: "PostToolUse",
      run,
      step: 1,
      payload: {},
      events,
    });

    expect(first.status).toBe("continued");
    expect(first.context).toHaveLength(1);
    expect(second.status).toBe("continued");
    expect(second.context).toHaveLength(0);
    expect(events.all().at(-1)?.payload).toMatchObject({
      result: {
        status: "skipped",
        reason: "configured hook already ran for this turn",
      },
    });
  });

  it("can suppress command output context on successful commands", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-hook-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: workspace,
        hooks: [
          {
            name: "quiet-check",
            hook: "Stop",
            action: {
              type: "command",
              command: process.execPath,
              args: ["-e", "console.log('ok')"],
              injectOutput: "onFailure",
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        payload: {},
        events,
      });

      expect(result.status).toBe("continued");
      expect(result.context).toEqual([]);
      expect(events.all().at(-1)?.payload).toMatchObject({
        result: {
          status: "continue",
          metadata: {
            hookName: "quiet-check",
            exitCode: 0,
            stdout: "ok\n",
            output: {
              stdoutPreview: "ok\n",
              stdoutBytes: 3,
              stdoutTruncated: false,
            },
          },
        },
      });
      expect(events.all().map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "extension.process.started",
          "extension.process.completed",
        ]),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("can pass workflow hook input to command actions on stdin", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-hook-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: workspace,
        hooks: [
          {
            name: "stdin-check",
            hook: "Stop",
            action: {
              type: "command",
              command: process.execPath,
              args: [
                "-e",
                [
                  "let data = '';",
                  "process.stdin.on('data', (chunk) => data += chunk);",
                  "process.stdin.on('end', () => {",
                  "  const input = JSON.parse(data);",
                  "  if (input.hook !== 'Stop') process.exit(2);",
                  "  if (input.payload.message !== 'reject me') process.exit(3);",
                  "  console.error(input.metadata.step);",
                  "  process.exit(4);",
                  "});",
                ].join("\n"),
              ],
              stdin: "json",
              blockOnFailure: true,
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        step: 7,
        payload: { message: "reject me" },
        metadata: { step: 7 },
        events,
      });

      expect(result.status).toBe("blocked");
      if (result.status !== "blocked") {
        throw new Error("expected blocked workflow hook result");
      }
      expect(result.block.reason).toContain("exit code 4");
      expect(result.block.metadata).toMatchObject({
        stderr: "7\n",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("blocks command hooks when enforce-mode sandbox is unavailable", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-hook-"));
    const runtime = unavailableRuntime();
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: workspace,
        sandbox: { mode: "enforce" },
        sandboxRuntime: runtime,
        hooks: [
          {
            name: "sandboxed-check",
            hook: "Stop",
            action: {
              type: "command",
              command: process.execPath,
              args: ["-e", "console.log('should not run')"],
              blockOnFailure: true,
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        payload: {},
        events,
      });

      expect(result.status).toBe("blocked");
      if (result.status !== "blocked") {
        throw new Error("expected blocked workflow hook result");
      }
      expect(result.block.metadata).toMatchObject({
        exitCode: null,
        sandbox: {
          sandboxed: false,
          mode: "enforce",
          runtime: "test-unavailable",
          available: false,
          fallbackReason: expect.stringContaining("test-unavailable"),
          enforced: true,
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("falls back in warn mode and records sandbox metadata", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-hook-"));
    const runtime = unavailableRuntime();
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: workspace,
        sandbox: { mode: "warn" },
        sandboxRuntime: runtime,
        hooks: [
          {
            name: "warn-check",
            hook: "Stop",
            action: {
              type: "command",
              command: process.execPath,
              args: ["-e", "console.log('fallback')"],
              injectOutput: "never",
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        payload: {},
        events,
      });

      expect(result.status).toBe("continued");
      expect(events.all().at(-1)?.payload).toMatchObject({
        result: {
          metadata: {
            exitCode: 0,
            stdout: "fallback\n",
            sandbox: {
              sandboxed: false,
              mode: "warn",
              runtime: "test-unavailable",
              available: false,
              fallbackReason: expect.stringContaining("test-unavailable"),
              enforced: false,
            },
          },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps command hooks from writing forced deny paths when runtime is available", async () => {
    const runtime = createPlatformShellSandboxRuntime();
    if (!(await runtime.isAvailable())) return;
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-hook-"));
    const configPath = join(workspace, ".sparkwright", "config.json");
    try {
      await mkdir(join(workspace, ".sparkwright"), { recursive: true });
      await writeFile(configPath, "original\n", "utf8");
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: workspace,
        sandbox: { mode: "enforce" },
        sandboxRuntime: runtime,
        configPaths: [configPath],
        hooks: [
          {
            name: "deny-config-write",
            hook: "Stop",
            action: {
              type: "command",
              command: "/bin/bash",
              args: ["-c", "echo bad > .sparkwright/config.json"],
              blockOnFailure: true,
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        payload: {},
        events,
      });

      expect(result.status).toBe("blocked");
      await expect(readFile(configPath, "utf8")).resolves.toBe("original\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("createVerificationWorkflowHooks", () => {
  it("defaults to suggestion mode when mode is omitted", async () => {
    const run = runRecord();
    const events = new EventLog(run.id);
    const hooks = createVerificationWorkflowHooks({
      workspaceRoot: process.cwd(),
      verification: {
        defaultProfile: "fast",
        profiles: {
          fast: [{ id: "lint", command: "npm", args: ["run", "lint"] }],
        },
      },
    });

    const result = await runWorkflowHooks({
      hooks,
      hook: "TurnStart",
      run,
      payload: {},
      events,
    });

    expect(result.status).toBe("continued");
    expect(result.context[0]?.content).toContain("npm run lint");
    expect(hooks.some((hook) => hook.hook === "Stop")).toBe(false);
  });

  it("allows final answers when verification passed after the latest write", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-verify-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const facts = new FactLedger();
      events.subscribe((event) => facts.observeEvent(event));
      const hooks = createVerificationWorkflowHooks({
        workspaceRoot: workspace,
        verification: {
          mode: "require",
          defaultProfile: "fast",
          profiles: {
            fast: [
              {
                id: "ok",
                command: process.execPath,
                args: ["-e", "process.exit(0)"],
              },
            ],
          },
        },
      });

      events.emit("workspace.write.completed", { path: "src/a.ts" });
      const stop = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        step: 2,
        payload: { events: events.all() },
        events,
        facts,
      });

      expect(stop.status).toBe("continued");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("records profile verifier results without verification hook names", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-verify-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const facts = new FactLedger();
      events.subscribe((event) => facts.observeEvent(event));
      const hooks = createVerificationWorkflowHooks({
        workspaceRoot: workspace,
        verification: {
          mode: "require",
          defaultProfile: "fast",
          profiles: {
            fast: [
              {
                id: "lint",
                command: process.execPath,
                args: ["-e", "process.exit(0)"],
              },
            ],
          },
        },
      });

      events.emit("workspace.write.completed", { path: "src/a.ts" });
      const stop = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        step: 2,
        payload: { events: events.all() },
        events,
        facts,
      });

      expect(stop.status).toBe("continued");
      expect(facts.snapshot().verificationResults[0]).toMatchObject({
        profile: "fast",
        verificationSource: "profile",
        verifierId: "lint",
        satisfied: true,
      });
      expect(
        facts
          .snapshot()
          .verificationResults[0]?.hookName?.startsWith(
            "workflow:verification_fast",
          ),
      ).toBe(true);
      const runEnd = await runWorkflowHooks({
        hooks,
        hook: "RunEnd",
        run,
        payload: { state: "completed" },
        events,
        facts,
      });
      expect(runEnd.status).toBe("continued");
      expect(
        events.all().some((event) => {
          if (event.type !== "workflow.completed") return false;
          const payload = event.payload as
            | { projectionKind?: unknown; verificationSource?: unknown }
            | undefined;
          return (
            payload?.projectionKind === "invariant" &&
            payload.verificationSource === "profile"
          );
        }),
      ).toBe(true);
      expect(
        events.all().some((event) => {
          const hookName =
            event.type === "workflow_hook.completed"
              ? (event.payload as { hookName?: unknown } | undefined)?.hookName
              : undefined;
          if (typeof hookName !== "string") return false;
          return hookName?.startsWith("verification:") === true;
        }),
      ).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("advances with profile verifier evidence when fresh verification fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-verify-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const facts = new FactLedger();
      events.subscribe((event) => facts.observeEvent(event));
      const hooks = createVerificationWorkflowHooks({
        workspaceRoot: workspace,
        verification: {
          mode: "require",
          defaultProfile: "fast",
          profiles: {
            fast: [
              {
                id: "lint",
                command: process.execPath,
                args: ["-e", "process.exit(1)"],
              },
            ],
          },
        },
      });

      events.emit("workspace.write.completed", { path: "src/a.ts" });
      const stop = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        step: 2,
        payload: { events: events.all() },
        events,
        facts,
      });

      expect(stop.status).toBe("advanced");
      expect(stop.context[0]?.content).toContain('"verifierId":"lint"');
      const verification = facts.snapshot().verificationResults[0];
      expect(verification).toMatchObject({
        profile: "fast",
        verificationSource: "profile",
        verifierId: "lint",
        expect: "zero",
        satisfied: false,
        stale: false,
        writeEpoch: 1,
        exitCode: 1,
      });
      expect(
        events.all().some((event) => event.type === "workflow.failed"),
      ).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

function unavailableRuntime(): ShellSandboxRuntime {
  return {
    id: "test-unavailable",
    platform: "unsupported",
    isAvailable: async () => false,
    execute: async () => {
      throw new Error("should not execute");
    },
  };
}
