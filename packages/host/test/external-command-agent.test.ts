import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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
import { DelegateExecutionError } from "../src/delegate-capability.js";
import {
  lifecycleTypes,
  projectAgentLifecycle,
  terminalLifecycleCount,
} from "./helpers/agent-lifecycle.js";
import { WorkspaceLeaseCoordinator } from "../src/workspace-lease-coordinator.js";

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

  it("mints unique child run ids for same-millisecond invocations", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    let randomValue = 0;
    const random = vi
      .spyOn(Math, "random")
      .mockImplementation(() => ((randomValue += 1) % 1000) / 1000);
    try {
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
            command: "unused",
            workspaceAccess: "read_write",
          },
        },
      };
      const tool = createExternalCommandDelegateTool({
        getParent: () => parent,
        profile,
        toolName: "delegate_external_reviewer",
        description: "Blocked before process launch.",
        workspaceRoot: process.cwd(),
        allowReadWriteWorkspaceAccess: false,
      });

      await expect(
        tool.execute({ goal: "first" }, { run: parent.record } as never),
      ).rejects.toBeDefined();
      await expect(
        tool.execute({ goal: "second" }, { run: parent.record } as never),
      ).rejects.toBeDefined();

      const childRunIds = parent.events
        .all()
        .filter((event) => event.type === "subagent.requested")
        .map((event) => (event.payload as { childRunId: string }).childRunId);
      expect(childRunIds).toHaveLength(2);
      expect(new Set(childRunIds).size).toBe(2);
    } finally {
      random.mockRestore();
      now.mockRestore();
    }
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
      childRunId: string;
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
    expect(result).not.toHaveProperty("agentId");
    expect(JSON.parse(result.stdout)).toMatchObject({
      argv: ["--goal", "review the patch"],
      stdin: "",
    });
    expect(result.output).toMatchObject({
      stdoutBytes: result.stdout.length,
      stdoutPreview: result.stdout,
    });
    expect(
      projectAgentLifecycle(parent.events.all(), result.childRunId),
    ).toEqual([
      expect.objectContaining({
        type: "subagent.requested",
        childRunId: result.childRunId,
        parentRunId: parent.record.id,
        childAgentId: "external_reviewer",
        agentProfileId: "external_reviewer",
        entrypoint: "external_command",
        identityConsistent: true,
      }),
      expect.objectContaining({
        type: "subagent.started",
        identityConsistent: true,
      }),
      expect.objectContaining({
        type: "subagent.completed",
        identityConsistent: true,
      }),
    ]);
    expect(
      projectAgentLifecycle(parent.events.all(), result.childRunId).at(-1),
    ).toMatchObject({ terminalState: "completed" });
    expect(terminalLifecycleCount(parent.events.all(), result.childRunId)).toBe(
      1,
    );
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
          metadata: expect.objectContaining({
            agentId: "main",
            childAgentId: "external_reviewer",
            agentProfileId: "external_reviewer",
            protocol: "external_command",
            workspaceAccess: "none",
          }),
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

  it("serializes read-write delegates across parents sharing one workspace", async () => {
    const fixture = await createFixtureCommand("setTimeout(() => {}, 250);");
    const arbiter = new WorkspaceLeaseCoordinator();
    const makeParent = () =>
      createRun({
        goal: "parent",
        model: {
          async complete() {
            return { message: "parent" };
          },
        },
        maxSteps: 1,
      });
    const profile: AgentProfile = {
      id: "external_writer",
      metadata: {
        externalCommand: {
          command: process.execPath,
          args: [fixture.commandPath],
          input: "none",
          workspaceAccess: "read_write",
        },
      },
    };
    const firstParent = makeParent();
    const secondParent = makeParent();
    const makeTool = (parent: ReturnType<typeof createRun>) =>
      createExternalCommandDelegateTool({
        getParent: () => parent,
        profile,
        toolName: "delegate_external_writer",
        description: "Delegate to a serialized writer.",
        workspaceRoot: fixture.cwd,
        allowReadWriteWorkspaceAccess: true,
        workspaceLeaseCoordinator: arbiter,
      });

    const first = makeTool(firstParent).execute({ goal: "first" }, {
      run: firstParent.record,
    } as never);
    await vi.waitFor(() =>
      expect(arbiter.inspect(fixture.cwd).writer).toBeDefined(),
    );
    const second = makeTool(secondParent).execute({ goal: "second" }, {
      run: secondParent.record,
    } as never);
    await vi.waitFor(() =>
      expect(arbiter.inspect(fixture.cwd).queued).toHaveLength(1),
    );

    expect(lifecycleTypes(secondParent.events.all())).toEqual([
      "subagent.requested",
    ]);
    await Promise.all([first, second]);
    expect(lifecycleTypes(secondParent.events.all())).toEqual([
      "subagent.requested",
      "subagent.started",
      "subagent.completed",
    ]);
    expect(arbiter.inspect(fixture.cwd)).toMatchObject({
      readers: [],
      queued: [],
    });
  });

  it("terminates a read-write delegate when its workspace lease is revoked", async () => {
    const fixture = await createFixtureCommand("setInterval(() => {}, 1000);");
    const coordinator = new WorkspaceLeaseCoordinator();
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
      id: "external_writer",
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
      toolName: "delegate_external_writer",
      description: "Delegate to a revocable writer.",
      workspaceRoot: fixture.cwd,
      allowReadWriteWorkspaceAccess: true,
      workspaceLeaseCoordinator: coordinator,
    });

    const pending = tool.execute({ goal: "write until revoked" }, {
      run: parent.record,
    } as never);
    await vi.waitFor(() =>
      expect(lifecycleTypes(parent.events.all())).toContain("subagent.started"),
    );
    const ownerId = coordinator.inspect(fixture.cwd).writer?.ownerId;
    expect(ownerId).toBeDefined();
    expect(coordinator.revoke(fixture.cwd, ownerId!)).toBe(true);

    await expect(pending).rejects.toMatchObject({
      code: "DELEGATE_NONZERO_EXIT",
    });
    const requested = parent.events
      .all()
      .find((event) => event.type === "subagent.requested");
    const childRunId = (requested?.payload as { childRunId: string })
      .childRunId;
    expect(
      projectAgentLifecycle(parent.events.all(), childRunId).at(-1),
    ).toMatchObject({ terminalState: "failed" });
    expect(terminalLifecycleCount(parent.events.all(), childRunId)).toBe(1);
    expect(coordinator.inspect(fixture.cwd).writer).toBeUndefined();
  });

  it("summarizes stderr token progress on the external delegate result", async () => {
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

    expect(JSON.parse(result.stdout)).toEqual({
      processProtocol: "stdio-v1",
      eventToken: "SPARKWRIGHT_EVENT",
    });
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
    expect(lifecycleTypes(parent.events.all())).toEqual([
      "subagent.requested",
      "subagent.failed",
    ]);
    expect(terminalLifecycleCount(parent.events.all())).toBe(1);
    expect(parent.events.all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "subagent.failed",
          payload: expect.objectContaining({
            errorCode: "DELEGATE_WORKSPACE_ACCESS_DENIED",
            terminalState: "failed",
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

    let rejection: unknown;
    try {
      await tool.execute({ goal: "inspect docs" }, {
        run: parent.record,
      } as never);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(DelegateExecutionError);
    expect(rejection).toMatchObject({
      message: expect.stringContaining("exited with exit code 7"),
      metadata: expect.objectContaining({
        agentProfileId: "external_failing",
      }),
    });
    expect((rejection as DelegateExecutionError).metadata).not.toHaveProperty(
      "agentId",
    );
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
      output: { artifactIds?: string[] };
    };

    expect(result).toMatchObject({
      stdout: '{"',
      stderr: "wxy",
      stdoutTruncated: true,
      stderrTruncated: true,
    });
    expect(result).not.toHaveProperty("outputTruncated");
    const completed = parent.events
      .all()
      .find((event) => event.type === "subagent.completed");
    const completedPayload = completed?.payload as
      | { result?: unknown }
      | undefined;
    expect(completedPayload?.result).not.toHaveProperty("outputTruncated");
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
    expect(lifecycleTypes(parent.events.all())).toEqual([
      "subagent.requested",
      "subagent.failed",
    ]);
  });

  it("fails closed for workspaceAccess none even when sandbox mode is warn", async () => {
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

    await expect(
      tool.execute({ goal: "inspect docs" }, { run: parent.record } as never),
    ).rejects.toMatchObject({ code: "DELEGATE_EXECUTION_FAILED" });
    expect(lifecycleTypes(parent.events.all())).toEqual([
      "subagent.requested",
      "subagent.failed",
    ]);
  });

  it("blocks workspace writes but keeps the private delegate cwd writable", async () => {
    const runtime = createPlatformShellSandboxRuntime();
    if (!(await runtime.isAvailable())) return;
    const fixture = await createFixtureCommand(
      'writeFileSync("scratch.txt", "scratch\\n");',
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
      id: "external_private_scratch",
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
      toolName: "delegate_external_private_scratch",
      description: "Exercise private delegate scratch writes.",
      workspaceRoot: fixture.cwd,
      sandbox: { mode: "enforce" },
      sandboxRuntime: runtime,
    });

    await expect(
      tool.execute({ goal: "inspect docs" }, { run: parent.record } as never),
    ).resolves.toMatchObject({ exitCode: 0 });

    const workspaceWriteFixture = await createFixtureCommand(
      'writeFileSync(new URL("workspace-write.txt", import.meta.url), "bad\\n");',
    );
    const blockedProfile: AgentProfile = {
      id: "external_workspace_write",
      metadata: {
        externalCommand: {
          command: process.execPath,
          args: [workspaceWriteFixture.commandPath],
          input: "none",
        },
      },
    };
    const blockedTool = createExternalCommandDelegateTool({
      getParent: () => parent,
      profile: blockedProfile,
      toolName: "delegate_external_workspace_write",
      description: "Attempt a workspace write without access.",
      workspaceRoot: workspaceWriteFixture.cwd,
      sandbox: { mode: "enforce" },
      sandboxRuntime: runtime,
    });

    await expect(
      blockedTool.execute({ goal: "inspect docs" }, {
        run: parent.record,
      } as never),
    ).rejects.toThrow("exited with exit code");
    await expect(
      readFile(join(workspaceWriteFixture.cwd, "workspace-write.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prevents read_write delegates from changing forced deny paths when runtime is available", async () => {
    const runtime = createPlatformShellSandboxRuntime();
    if (!(await runtime.isAvailable())) return;
    const fixture = await createFixtureCommand(
      'writeFileSync(".sparkwright/config.json", "bad\\n");',
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
import { writeFileSync } from "node:fs";

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
const token = process.env.SPARKWRIGHT_EVENT_TOKEN ?? "SPARKWRIGHT_EVENT";
for (let index = 1; index <= 7; index += 1) {
  process.stderr.write(
    token + ": " + JSON.stringify({
      type: "progress",
      message: \`phase \${index}\`,
      data: { index },
    }) + "\\n",
  );
}

process.stdout.write(JSON.stringify({
  processProtocol: process.env.SPARKWRIGHT_PROCESS_PROTOCOL,
  eventToken: process.env.SPARKWRIGHT_EVENT_TOKEN,
}));
`,
    "utf8",
  );
  return { cwd, commandPath };
}
