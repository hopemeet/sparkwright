import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunId, EventLog, runWorkflowHooks } from "@sparkwright/core";
import {
  createPlatformShellSandboxRuntime,
  type ShellSandboxRuntime,
} from "@sparkwright/shell-sandbox";
import {
  createConfiguredWorkflowHooks,
  createVerificationWorkflowHooks,
} from "../src/index.js";

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
      hook: "SessionStart",
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
      await runWorkflowHooks({
        hooks,
        hook: "PostToolUse",
        run,
        step: 1,
        payload: {
          toolName: "apply_patch",
          status: "completed",
          path: "src/a.ts",
        },
        events,
      });

      const stop = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        step: 2,
        payload: { events: events.all() },
        events,
      });

      expect(stop.status).toBe("continued");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("blocks final answers when the latest write is not verified", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-verify-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
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
      await runWorkflowHooks({
        hooks,
        hook: "PostToolUse",
        run,
        step: 1,
        payload: {
          toolName: "apply_patch",
          status: "completed",
          path: "src/a.ts",
        },
        events,
      });
      events.emit("workspace.write.completed", { path: "src/b.ts" });

      const stop = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        step: 2,
        payload: { events: events.all() },
        events,
      });

      expect(stop.status).toBe("blocked");
      if (stop.status !== "blocked") {
        throw new Error("expected blocked workflow hook result");
      }
      expect(stop.block.reason).toContain("latest workspace write");
      expect(stop.block.metadata).toMatchObject({
        profile: "fast",
        missing: ["lint"],
      });
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
