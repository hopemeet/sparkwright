import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRunId,
  type ShellExecutionResult,
  type ShellStreamingResult,
} from "@sparkwright/core";
import { EventLog } from "@sparkwright/core/internal";
import {
  resolveShellSandboxConfig,
  type ResolvedShellSandboxConfig,
  type SandboxedShellRequest,
  type ShellSandboxRuntime,
} from "@sparkwright/shell-sandbox";
import { resolveHostProjectCommand } from "../src/project-command-resolution.js";

describe("resolveHostProjectCommand", () => {
  it("rediscovers the command and traces shell interpolation in a no-write sandbox", async () => {
    const root = await commandWorkspace(
      "demo",
      "args=[$ARGUMENTS] shell=[!`echo governed`]",
    );
    let captured:
      | { request: SandboxedShellRequest; sandbox: ResolvedShellSandboxConfig }
      | undefined;
    const runtime = shellRuntime((request, sandbox) => {
      captured = { request, sandbox };
      return streamingResult("governed\n");
    });
    const events = new EventLog(createRunId());

    try {
      const resolved = await resolveHostProjectCommand({
        command: { name: "demo", rest: "a b" },
        workspaceRoot: root,
        emitter: events,
        sandbox: writableSandbox(root),
        sandboxRuntime: runtime,
        env: { XDG_CONFIG_HOME: join(root, "config") },
      });

      expect(resolved).toEqual({
        goal: "args=[a b] shell=[governed]",
        metadata: {
          name: "demo",
          source: "project",
          shellInterpolation: true,
        },
      });
      expect(captured?.request.command).toContain("echo governed");
      expect(captured?.sandbox.mode).toBe("enforce");
      expect(captured?.sandbox.failIfUnavailable).toBe(true);
      expect(captured?.sandbox.filesystem.allowWrite).toEqual([]);
      expect(
        events
          .all()
          .filter((event) => event.type.startsWith("extension.process."))
          .map((event) => event.type),
      ).toEqual(["extension.process.started", "extension.process.completed"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies unsafe interpolation before starting a process", async () => {
    const root = await commandWorkspace("danger", "!`rm -rf /`");
    let executions = 0;
    const runtime = shellRuntime(() => {
      executions += 1;
      return streamingResult("");
    });

    try {
      await expect(
        resolveHostProjectCommand({
          command: { name: "danger" },
          workspaceRoot: root,
          emitter: new EventLog(createRunId()),
          sandbox: writableSandbox(root),
          sandboxRuntime: runtime,
          env: { XDG_CONFIG_HOME: join(root, "config") },
        }),
      ).rejects.toThrow(/denied/i);
      expect(executions).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an untrusted project command before interpolating shell", async () => {
    const root = await commandWorkspace("untrusted", "!`echo must-not-run`");
    let executions = 0;
    try {
      await expect(
        resolveHostProjectCommand({
          command: { name: "untrusted" },
          workspaceRoot: root,
          emitter: new EventLog(createRunId()),
          sandbox: writableSandbox(root),
          sandboxRuntime: shellRuntime(() => {
            executions += 1;
            return streamingResult("unexpected");
          }),
          env: { XDG_CONFIG_HOME: join(root, "config") },
          includeProject: false,
        }),
      ).rejects.toThrow(/requires trust/i);
      expect(executions).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the named command is absent", async () => {
    const root = await commandWorkspace("known", "hello");
    try {
      await expect(
        resolveHostProjectCommand({
          command: { name: "missing" },
          workspaceRoot: root,
          emitter: new EventLog(createRunId()),
          sandbox: writableSandbox(root),
          sandboxRuntime: shellRuntime(() => streamingResult("")),
          env: { XDG_CONFIG_HOME: join(root, "config") },
        }),
      ).rejects.toThrow('Project command "/missing" was not found');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function commandWorkspace(name: string, body: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sparkwright-project-command-"));
  const commandDir = join(root, ".sparkwright", "command");
  await mkdir(commandDir, { recursive: true });
  await writeFile(join(commandDir, `${name}.md`), body, "utf8");
  return root;
}

function writableSandbox(root: string): ResolvedShellSandboxConfig {
  return resolveShellSandboxConfig({
    workspaceRoot: root,
    config: {
      mode: "enforce",
      filesystem: { allowWrite: [root] },
    },
  });
}

function shellRuntime(
  execute: (
    request: SandboxedShellRequest,
    config: ResolvedShellSandboxConfig,
  ) => ShellStreamingResult | Promise<ShellStreamingResult>,
): ShellSandboxRuntime {
  return {
    id: "project-command-test",
    platform: "linux",
    isAvailable: async () => true,
    execute: async (request, config) => execute(request, config),
  };
}

function streamingResult(stdout: string): ShellStreamingResult {
  const completed = shellResult(stdout);
  return {
    handle: {
      stdout: () => chunks(stdout ? [stdout] : []),
      stderr: () => chunks([]),
      abort: () => undefined,
      metadata: {},
    },
    completed: Promise.resolve(completed),
  };
}

async function* chunks(values: readonly string[]): AsyncIterable<string> {
  for (const value of values) yield value;
}

function shellResult(stdout: string): ShellExecutionResult {
  const now = new Date().toISOString();
  return {
    status: "completed",
    exitCode: 0,
    stdout,
    stderr: "",
    startedAt: now,
    completedAt: now,
    metadata: {
      sandboxed: true,
      sandboxMode: "enforce",
      sandboxRuntime: "project-command-test",
      sandboxAvailable: true,
      sandboxEnforced: true,
    },
  };
}
