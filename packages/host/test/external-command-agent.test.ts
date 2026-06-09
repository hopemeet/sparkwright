import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRun } from "@sparkwright/core";
import type { AgentProfile } from "@sparkwright/agent-runtime";
import {
  createExternalCommandDelegateTool,
  externalCommandConfigFromAgentProfile,
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
    expect(parent.events.all().map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "subagent.requested",
        "subagent.started",
        "subagent.completed",
      ]),
    );
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
    };

    expect(result).toMatchObject({
      stdout: '{"',
      stderr: "wxy",
      stdoutTruncated: true,
      stderrTruncated: true,
      outputTruncated: true,
    });
  });
});

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
