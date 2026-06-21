import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRun } from "@sparkwright/core";
import type { AgentProfile } from "@sparkwright/agent-runtime";
import {
  createPlatformShellSandboxRuntime,
  type ShellSandboxRuntime,
} from "@sparkwright/shell-sandbox";
import {
  createExternalCommandDelegateTool,
  externalCommandConfigFromAgentProfile,
  isSecretEnvKey,
  redactSecretEnv,
} from "../src/external-command-agent.js";

describe("external command delegate tool", () => {
  it("parses external command config from agent profile metadata", () => {
    const profile: AgentProfile = {
      id: "external_reviewer",
      metadata: {
        externalCommand: {
          command: "agent-cli",
          args: ["run", "{{goal}}"],
          input: "none",
          timeoutMs: 120000,
          maxOutputBytes: 4096,
          maxStdoutBytes: 2048,
          maxStderrBytes: 1024,
          envMode: "explicit",
          workspaceAccess: "read_write",
        },
      },
    };

    expect(externalCommandConfigFromAgentProfile(profile)).toEqual({
      command: "agent-cli",
      args: ["run", "{{goal}}"],
      input: "none",
      timeoutMs: 120000,
      maxOutputBytes: 4096,
      maxStdoutBytes: 2048,
      maxStderrBytes: 1024,
      envMode: "explicit",
      workspaceAccess: "read_write",
    });
  });

  it("runs an argument-based command and mirrors subagent lifecycle events", async () => {
    const fixture = await createFixtureCommand();
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent" };
        },
      },
      maxSteps: 1,
    });
    const profile: AgentProfile = {
      id: "external_reviewer",
      name: "External Reviewer",
      metadata: {
        externalCommand: {
          command: process.execPath,
          args: [fixture.commandPath, "--goal", "{{goal}}"],
          input: "none",
        },
      },
    };
    const tool = createExternalCommandDelegateTool({
      getParent: () => parent,
      profile,
      toolName: "delegate_external_reviewer",
      description: "Delegate to fixture command.",
      workspaceRoot: fixture.cwd,
    });

    const result = (await tool.execute({ goal: "review the patch" }, {
      run: parent.record,
    } as never)) as {
      protocol: string;
      stdout: string;
      exitCode: number;
      agentProfileId: string;
      output: { stdoutBytes: number; stdoutPreview?: string };
    };

    expect(result).toMatchObject({
      protocol: "external_command",
      agentProfileId: "external_reviewer",
      exitCode: 0,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      argv: ["--goal", "review the patch"],
      stdin: "",
    });
    expect(result.output).toMatchObject({
      stdoutBytes: result.stdout.length,
      stdoutPreview: result.stdout,
    });
    expect(parent.events.all().map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "subagent.requested",
        "subagent.started",
        "subagent.completed",
      ]),
    );
    expect(
      parent.events.all().some((event) => event.type.startsWith("extension.")),
    ).toBe(false);
    expect(parent.events.all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "subagent.completed",
          payload: expect.objectContaining({
            result: expect.objectContaining({
              protocol: "external_command",
              exitCode: 0,
              stdoutTruncated: false,
              stderrTruncated: false,
              output: expect.objectContaining({
                stdoutBytes: result.stdout.length,
              }),
            }),
          }),
        }),
      ]),
    );
  });

  it("summarizes trace inbox progress on the external delegate result", async () => {
    const fixture = await createProgressFixtureCommand();
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent" };
        },
      },
      maxSteps: 1,
    });
    const profile: AgentProfile = {
      id: "external_progress",
      name: "External Progress",
      metadata: {
        externalCommand: {
          command: process.execPath,
          args: [fixture.commandPath],
          input: "none",
        },
      },
    };
    const tool = createExternalCommandDelegateTool({
      getParent: () => parent,
      profile,
      toolName: "delegate_external_progress",
      description: "Delegate to fixture command.",
      workspaceRoot: fixture.cwd,
    });

    const result = (await tool.execute({ goal: "review the patch" }, {
      run: parent.record,
    } as never)) as {
      stdout: string;
      progressCount: number;
      progressDropped: number;
      progressHead: Array<Record<string, unknown>>;
      progressTail: Array<Record<string, unknown>>;
    };

    expect(JSON.parse(result.stdout)).toEqual({ traceInbox: true });
    expect(result).toMatchObject({
      progressCount: 7,
      progressDropped: 0,
      progressHead: [
        { channel: "event", message: "phase 1", data: { index: 1 } },
        { channel: "event", message: "phase 2", data: { index: 2 } },
        { channel: "event", message: "phase 3", data: { index: 3 } },
        { channel: "event", message: "phase 4", data: { index: 4 } },
        { channel: "event", message: "phase 5", data: { index: 5 } },
      ],
      progressTail: [
        { channel: "event", message: "phase 6", data: { index: 6 } },
        { channel: "event", message: "phase 7", data: { index: 7 } },
      ],
    });
    expect(
      parent.events.all().some((event) => event.type.startsWith("extension.")),
    ).toBe(false);
    expect(parent.events.all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "subagent.completed",
          payload: expect.objectContaining({
            result: expect.objectContaining({
              progressCount: 7,
              progressDropped: 0,
              progressHead: result.progressHead,
              progressTail: result.progressTail,
            }),
          }),
        }),
      ]),
    );
  });

  it("does not expose the workspace path unless explicitly authorized", async () => {
    const fixture = await createFixtureCommand();
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent" };
        },
      },
      maxSteps: 1,
    });
    const profile: AgentProfile = {
      id: "external_reviewer",
      metadata: {
        externalCommand: {
          command: process.execPath,
          args: [fixture.commandPath, "--workspace", "{{workspaceRoot}}"],
          input: "none",
        },
      },
    };
    const tool = createExternalCommandDelegateTool({
      getParent: () => parent,
      profile,
      toolName: "delegate_external_reviewer",
      description: "Delegate to fixture command.",
      workspaceRoot: fixture.cwd,
    });

    await expect(
      tool.execute({ goal: "review the patch" }, {
        run: parent.record,
      } as never),
    ).rejects.toThrow('requires workspaceAccess "read_write"');
    expect(parent.events.all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "subagent.failed",
          payload: expect.objectContaining({
            errorCode: "DELEGATE_WORKSPACE_ACCESS_DENIED",
          }),
        }),
      ]),
    );
  });

  it("requires parent write access before exposing the workspace path", async () => {
    const fixture = await createFixtureCommand();
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent" };
        },
      },
      maxSteps: 1,
    });
    const profile: AgentProfile = {
      id: "external_reviewer",
      metadata: {
        externalCommand: {
          command: process.execPath,
          args: [fixture.commandPath, "--workspace", "{{workspaceRoot}}"],
          input: "none",
          workspaceAccess: "read_write",
        },
      },
    };
    const tool = createExternalCommandDelegateTool({
      getParent: () => parent,
      profile,
      toolName: "delegate_external_reviewer",
      description: "Delegate to fixture command.",
      workspaceRoot: fixture.cwd,
    });

    await expect(
      tool.execute({ goal: "review the patch" }, {
        run: parent.record,
      } as never),
    ).rejects.toThrow("parent run has not enabled workspace writes");
    expect(parent.events.all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "subagent.failed",
          payload: expect.objectContaining({
            errorCode: "DELEGATE_WORKSPACE_ACCESS_DENIED",
          }),
        }),
      ]),
    );
  });

  it("can expose the workspace path with explicit read-write access", async () => {
    const fixture = await createFixtureCommand();
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent" };
        },
      },
      maxSteps: 1,
    });
    const profile: AgentProfile = {
      id: "external_reviewer",
      metadata: {
        externalCommand: {
          command: process.execPath,
          args: [fixture.commandPath, "--workspace", "{{workspaceRoot}}"],
          input: "none",
          workspaceAccess: "read_write",
        },
      },
    };
    const tool = createExternalCommandDelegateTool({
      getParent: () => parent,
      profile,
      toolName: "delegate_external_reviewer",
      description: "Delegate to fixture command.",
      workspaceRoot: fixture.cwd,
      allowReadWriteWorkspaceAccess: true,
    });

    const result = (await tool.execute({ goal: "review the patch" }, {
      run: parent.record,
    } as never)) as { stdout: string };

    expect(JSON.parse(result.stdout)).toMatchObject({
      argv: ["--workspace", fixture.cwd],
    });
  });

  it("can send the delegated goal through stdin", async () => {
    const fixture = await createFixtureCommand();
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent" };
        },
      },
      maxSteps: 1,
    });
    const profile: AgentProfile = {
      id: "external_stdin",
      metadata: {
        externalCommand: {
          command: process.execPath,
          args: [fixture.commandPath],
          input: "stdin",
        },
      },
    };
    const tool = createExternalCommandDelegateTool({
      getParent: () => parent,
      profile,
      toolName: "delegate_external_stdin",
      description: "Delegate to fixture command.",
      workspaceRoot: fixture.cwd,
    });

    const result = (await tool.execute(
      { goal: "inspect docs", metadata: { trace: true } },
      { run: parent.record } as never,
    )) as { stdout: string };

    expect(JSON.parse(result.stdout)).toMatchObject({
      argv: [],
      stdin: 'inspect docs\n\nMetadata:\n{\n  "trace": true\n}',
    });
  });

  it("fails the delegate when the command exits with a non-success code", async () => {
    const fixture = await createFixtureCommand("process.exitCode = 7;");
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent" };
        },
      },
      maxSteps: 1,
    });
    const profile: AgentProfile = {
      id: "external_failing",
      metadata: {
        externalCommand: {
          command: process.execPath,
          args: [fixture.commandPath],
          input: "none",
        },
      },
    };
    const tool = createExternalCommandDelegateTool({
      getParent: () => parent,
      profile,
      toolName: "delegate_external_failing",
      description: "Delegate to fixture command.",
      workspaceRoot: fixture.cwd,
    });

    await expect(
      tool.execute({ goal: "inspect docs" }, { run: parent.record } as never),
    ).rejects.toThrow("exited with exit code 7");
    expect(parent.events.all().map((event) => event.type)).toEqual(
      expect.arrayContaining(["subagent.failed"]),
    );
  });

  it("can run with an explicit environment", async () => {
    const fixture = await createFixtureCommand(
      'process.stdout.write("\\n" + JSON.stringify({ hasCustomEnv: process.env.CUSTOM_ENV === "yes", hasPath: process.env.PATH !== undefined }));',
    );
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent" };
        },
      },
      maxSteps: 1,
    });
    const profile: AgentProfile = {
      id: "external_env",
      metadata: {
        externalCommand: {
          command: process.execPath,
          args: [fixture.commandPath],
          input: "none",
          env: { CUSTOM_ENV: "yes" },
          envMode: "explicit",
        },
      },
    };
    const tool = createExternalCommandDelegateTool({
      getParent: () => parent,
      profile,
      toolName: "delegate_external_env",
      description: "Delegate to fixture command.",
      workspaceRoot: fixture.cwd,
    });

    const result = (await tool.execute({ goal: "inspect docs" }, {
      run: parent.record,
    } as never)) as { stdout: string };
    const lines = result.stdout.trimEnd().split("\n");

    // explicit env mode drops the inherited PATH on POSIX; Windows always
    // keeps a PATH-like var in the child, so only assert hasPath strictly off
    // POSIX.
    expect(JSON.parse(lines[1] ?? "{}")).toEqual({
      hasCustomEnv: true,
      hasPath: process.platform === "win32" ? expect.any(Boolean) : false,
    });
  });

  it("redacts credential-looking env vars from a sandboxed (workspaceAccess none) child", async () => {
    const fixture = await createFixtureCommand(
      'process.stdout.write("\\n" + JSON.stringify({ secret: process.env.QA_TEST_SECRET ?? null, hasPath: process.env.PATH !== undefined }));',
    );
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent" };
        },
      },
      maxSteps: 1,
    });
    const profile: AgentProfile = {
      id: "external_sandbox",
      metadata: {
        externalCommand: {
          command: process.execPath,
          args: [fixture.commandPath],
          input: "none",
          // inherit (default), workspaceAccess none (default) -> sanitized.
        },
      },
    };
    const tool = createExternalCommandDelegateTool({
      getParent: () => parent,
      profile,
      toolName: "delegate_external_sandbox",
      description: "Delegate to fixture command.",
      workspaceRoot: fixture.cwd,
    });

    process.env.QA_TEST_SECRET = "leak-me";
    try {
      const result = (await tool.execute({ goal: "inspect docs" }, {
        run: parent.record,
      } as never)) as { stdout: string };
      const lines = result.stdout.trimEnd().split("\n");
      // Secret dropped, but PATH (needed to spawn) retained.
      expect(JSON.parse(lines[1] ?? "{}")).toEqual({
        secret: null,
        hasPath: true,
      });
    } finally {
      delete process.env.QA_TEST_SECRET;
    }
  });

  it("preserves inherited env for a read_write (explicitly trusted) child", async () => {
    const fixture = await createFixtureCommand(
      'process.stdout.write("\\n" + JSON.stringify({ secret: process.env.QA_TEST_SECRET ?? null }));',
    );
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent" };
        },
      },
      maxSteps: 1,
    });
    const profile: AgentProfile = {
      id: "external_trusted",
      metadata: {
        externalCommand: {
          command: process.execPath,
          args: [fixture.commandPath],
          input: "none",
          workspaceAccess: "read_write",
        },
      },
    };
    const tool = createExternalCommandDelegateTool({
      getParent: () => parent,
      profile,
      toolName: "delegate_external_trusted",
      description: "Delegate to fixture command.",
      workspaceRoot: fixture.cwd,
      allowReadWriteWorkspaceAccess: true,
    });

    process.env.QA_TEST_SECRET = "trusted-keep";
    try {
      const result = (await tool.execute({ goal: "inspect docs" }, {
        run: parent.record,
      } as never)) as { stdout: string };
      const lines = result.stdout.trimEnd().split("\n");
      expect(JSON.parse(lines[1] ?? "{}")).toEqual({ secret: "trusted-keep" });
    } finally {
      delete process.env.QA_TEST_SECRET;
    }
  });

  it("classifies and strips secret env keys while keeping benign ones", () => {
    for (const key of [
      "QA_FAKE_SECRET",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "GITHUB_TOKEN",
      "DB_PASSWORD",
      "SSH_PRIVATE_KEY",
      "MY_KEY",
    ]) {
      expect(isSecretEnvKey(key)).toBe(true);
    }
    for (const key of [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "MONKEY",
      "KEYBOARD",
    ]) {
      expect(isSecretEnvKey(key)).toBe(false);
    }
    const redacted = redactSecretEnv({
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-x",
      HOME: "/home/u",
    });
    expect(redacted).toEqual({ PATH: "/usr/bin", HOME: "/home/u" });
  });

  it("reports stdout and stderr truncation separately", async () => {
    const fixture = await createFixtureCommand(
      'process.stdout.write("abcd"); process.stderr.write("wxyz");',
    );
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent" };
        },
      },
      maxSteps: 1,
    });
    const profile: AgentProfile = {
      id: "external_truncated",
      metadata: {
        externalCommand: {
          command: process.execPath,
          args: [fixture.commandPath],
          input: "none",
          maxStdoutBytes: 2,
          maxStderrBytes: 3,
        },
      },
    };
    const tool = createExternalCommandDelegateTool({
      getParent: () => parent,
      profile,
      toolName: "delegate_external_truncated",
      description: "Delegate to fixture command.",
      workspaceRoot: fixture.cwd,
    });

    const result = (await tool.execute({ goal: "inspect docs" }, {
      run: parent.record,
    } as never)) as {
      stdout: string;
      stderr: string;
      stdoutTruncated: boolean;
      stderrTruncated: boolean;
      outputTruncated: boolean;
      output: { artifactIds?: string[] };
    };

    expect(result).toMatchObject({
      stdout: '{"',
      stderr: "wxy",
      stdoutTruncated: true,
      stderrTruncated: true,
      outputTruncated: true,
    });
    expect(result.output.artifactIds).toEqual(
      expect.arrayContaining([expect.stringMatching(/^artifact_/)]),
    );
    expect(parent.events.all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "artifact.created",
          payload: expect.objectContaining({ type: "log" }),
        }),
      ]),
    );
  });

  it("fails closed when enforce-mode sandbox is unavailable", async () => {
    const fixture = await createFixtureCommand();
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent" };
        },
      },
      maxSteps: 1,
    });
    const profile: AgentProfile = {
      id: "external_enforce",
      metadata: {
        externalCommand: {
          command: process.execPath,
          args: [fixture.commandPath],
          input: "none",
        },
      },
    };
    const tool = createExternalCommandDelegateTool({
      getParent: () => parent,
      profile,
      toolName: "delegate_external_enforce",
      description: "Delegate to fixture command.",
      workspaceRoot: fixture.cwd,
      sandbox: { mode: "enforce" },
      sandboxRuntime: unavailableRuntime(),
    });

    await expect(
      tool.execute({ goal: "inspect docs" }, { run: parent.record } as never),
    ).rejects.toThrow("test-unavailable");
  });

  it("falls back in warn mode and returns sandbox metadata", async () => {
    const fixture = await createFixtureCommand();
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent" };
        },
      },
      maxSteps: 1,
    });
    const profile: AgentProfile = {
      id: "external_warn",
      metadata: {
        externalCommand: {
          command: process.execPath,
          args: [fixture.commandPath],
          input: "none",
        },
      },
    };
    const tool = createExternalCommandDelegateTool({
      getParent: () => parent,
      profile,
      toolName: "delegate_external_warn",
      description: "Delegate to fixture command.",
      workspaceRoot: fixture.cwd,
      sandbox: { mode: "warn" },
      sandboxRuntime: unavailableRuntime(),
    });

    const result = (await tool.execute({ goal: "inspect docs" }, {
      run: parent.record,
    } as never)) as { stdout: string; sandbox?: Record<string, unknown> };

    expect(JSON.parse(result.stdout)).toMatchObject({ argv: [] });
    expect(result.sandbox).toEqual({
      sandboxed: false,
      mode: "warn",
      runtime: "test-unavailable",
      networkMode: "deny",
      unavailable: expect.stringContaining("test-unavailable"),
      available: false,
      fallbackReason: expect.stringContaining("test-unavailable"),
      enforced: false,
    });
  });

  it("prevents read_write delegates from changing forced deny paths when runtime is available", async () => {
    const runtime = createPlatformShellSandboxRuntime();
    if (!(await runtime.isAvailable())) return;
    const fixture = await createFixtureCommand(
      "require('node:fs').writeFileSync('.sparkwright/config.json', 'bad\\n');",
    );
    const configPath = join(fixture.cwd, ".sparkwright", "config.json");
    await mkdir(join(fixture.cwd, ".sparkwright"), { recursive: true });
    await writeFile(configPath, "original\n", "utf8");
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent" };
        },
      },
      maxSteps: 1,
    });
    const profile: AgentProfile = {
      id: "external_deny_config",
      metadata: {
        externalCommand: {
          command: process.execPath,
          args: [fixture.commandPath],
          input: "none",
          workspaceAccess: "read_write",
        },
      },
    };
    const tool = createExternalCommandDelegateTool({
      getParent: () => parent,
      profile,
      toolName: "delegate_external_deny_config",
      description: "Delegate to fixture command.",
      workspaceRoot: fixture.cwd,
      allowReadWriteWorkspaceAccess: true,
      sandbox: { mode: "enforce" },
      sandboxRuntime: runtime,
      configPaths: [configPath],
    });

    await expect(
      tool.execute({ goal: "inspect docs" }, { run: parent.record } as never),
    ).rejects.toThrow("exited with exit code");
    await expect(readFile(configPath, "utf8")).resolves.toBe("original\n");
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

async function createFixtureCommand(): Promise<{
  cwd: string;
  commandPath: string;
}>;
async function createFixtureCommand(extraCode: string): Promise<{
  cwd: string;
  commandPath: string;
}>;
async function createFixtureCommand(extraCode = ""): Promise<{
  cwd: string;
  commandPath: string;
}> {
  const cwd = await mkdtemp(join(tmpdir(), "sparkwright-external-command-"));
  const commandPath = join(cwd, "command.mjs");
  await writeFile(
    commandPath,
    `
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    argv: process.argv.slice(2),
    stdin: Buffer.concat(chunks).toString("utf8")
  }));
  ${extraCode}
});
process.stdin.resume();
`,
    "utf8",
  );
  return { cwd, commandPath };
}

async function createProgressFixtureCommand(): Promise<{
  cwd: string;
  commandPath: string;
}> {
  const cwd = await mkdtemp(join(tmpdir(), "sparkwright-external-progress-"));
  const commandPath = join(cwd, "progress.mjs");
  await writeFile(
    commandPath,
    `
import { appendFileSync } from "node:fs";

const inbox = process.env.SPARKWRIGHT_TRACE_EVENTS;
if (inbox) {
  for (let index = 1; index <= 7; index += 1) {
    appendFileSync(
      inbox,
      JSON.stringify({
        type: "progress",
        channel: "event",
        message: \`phase \${index}\`,
        data: { index },
      }) + "\\n",
      "utf8",
    );
  }
}

process.stdout.write(JSON.stringify({ traceInbox: Boolean(inbox) }));
`,
    "utf8",
  );
  return { cwd, commandPath };
}
