import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunId, EventLog, runWorkflowHooks } from "@sparkwright/core";
import { createConfiguredWorkflowHooks } from "../src/index.js";

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

describe("createConfiguredWorkflowHooks", () => {
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
          hook: "SessionStart",
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
      hook: "SessionStart",
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
          },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
