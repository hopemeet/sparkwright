import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { createRun } from "@sparkwright/core";
import type { AgentProfile } from "@sparkwright/agent-runtime";
import {
  createPlatformShellSandboxRuntime,
  type ShellSandboxRuntime,
} from "@sparkwright/shell-sandbox";
import {
  acpConfigFromAgentProfile,
  createAcpDelegateTool,
} from "../src/acp-child-agent.js";
import {
  lifecycleTypes,
  projectAgentLifecycle,
  terminalLifecycleCount,
} from "./helpers/agent-lifecycle.js";
import { WorkspaceLeaseCoordinator } from "../src/workspace-agent-arbiter.js";

describe("ACP child agent delegate tool", () => {
  it("parses ACP config from agent profile metadata", () => {
    const profile: AgentProfile = {
      id: "external_reviewer",
      metadata: {
        acp: {
          transport: "stdio",
          command: "codex",
          args: ["acp"],
          timeoutMs: 120000,
        },
      },
    };

    expect(acpConfigFromAgentProfile(profile)).toEqual({
      transport: "stdio",
      command: "codex",
      args: ["acp"],
      timeoutMs: 120000,
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
          acp: {
            transport: "stdio",
            command: "unused",
            workspaceAccess: "read_write",
          },
        },
      };
      const tool = createAcpDelegateTool({
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

  it("runs an external ACP worker and mirrors subagent lifecycle events", async () => {
    const fixture = await createFixtureAgent();
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
        acp: {
          transport: "stdio",
          command: process.execPath,
          args: [fixture.agentPath],
        },
      },
    };
    const tool = createAcpDelegateTool({
      getParent: () => parent,
      profile,
      toolName: "delegate_external_reviewer",
      description: "Delegate to fixture ACP worker.",
      workspaceRoot: fixture.cwd,
    });

    const result = (await tool.execute({ goal: "review the patch" }, {
      run: parent.record,
    } as never)) as {
      childRunId: string;
      protocol: string;
      message: string;
      stopReason: string;
      agentProfileId: string;
    };

    expect(result).toMatchObject({
      protocol: "acp",
      agentProfileId: "external_reviewer",
      stopReason: "end_turn",
    });
    expect(result.message).toContain("fixture reviewed: review the patch");
    expect(
      projectAgentLifecycle(parent.events.all(), result.childRunId),
    ).toEqual([
      expect.objectContaining({
        type: "subagent.requested",
        childRunId: result.childRunId,
        parentRunId: parent.record.id,
        childAgentId: "external_reviewer",
        agentProfileId: "external_reviewer",
        entrypoint: "acp",
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
    expect(parent.events.all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "subagent.completed",
          metadata: expect.objectContaining({
            agentId: "main",
            childAgentId: "external_reviewer",
            agentProfileId: "external_reviewer",
            protocol: "acp",
            workspaceAccess: "none",
          }),
          payload: expect.objectContaining({
            result: expect.objectContaining({
              protocol: "acp",
              stopReason: "end_turn",
              toolCalls: 0,
            }),
          }),
        }),
      ]),
    );
  });

  it("requires parent write access before exposing the workspace to ACP delegates", async () => {
    const fixture = await createFixtureAgent();
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
        acp: {
          transport: "stdio",
          command: process.execPath,
          args: [fixture.agentPath],
          workspaceAccess: "read_write",
        },
      },
    };
    const tool = createAcpDelegateTool({
      getParent: () => parent,
      profile,
      toolName: "delegate_external_reviewer",
      description: "Delegate to fixture ACP worker.",
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

  it("marks approved read-write ACP workspace access as untracked", async () => {
    const fixture = await createFixtureAgent();
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
        acp: {
          transport: "stdio",
          command: process.execPath,
          args: [fixture.agentPath],
          workspaceAccess: "read_write",
        },
      },
    };
    const tool = createAcpDelegateTool({
      getParent: () => parent,
      profile,
      toolName: "delegate_external_reviewer",
      description: "Delegate to fixture ACP worker.",
      workspaceRoot: fixture.cwd,
      allowReadWriteWorkspaceAccess: true,
      sandbox: { mode: "off" },
    });

    await tool.execute({ goal: "review" }, { run: parent.record } as never);

    expect(parent.events.all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "workspace.write.untracked_access_granted",
          payload: expect.objectContaining({
            protocol: "acp",
            marker: "untracked-write-capable",
          }),
        }),
      ]),
    );
  });

  it("terminates an ACP writer when its workspace lease is revoked", async () => {
    const fixture = await createFixtureAgent(
      'globalThis.__promptDelayMs = 10_000; process.on("SIGTERM", () => {});',
    );
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
        acp: {
          transport: "stdio",
          command: process.execPath,
          args: [fixture.agentPath],
          workspaceAccess: "read_write",
        },
      },
    };
    const tool = createAcpDelegateTool({
      getParent: () => parent,
      profile,
      toolName: "delegate_external_writer",
      description: "Delegate to a revocable ACP writer.",
      workspaceRoot: fixture.cwd,
      allowReadWriteWorkspaceAccess: true,
      sandbox: { mode: "off" },
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

    await expect(pending).rejects.toThrow("External ACP worker aborted");
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

  it("fails closed for workspaceAccess none when ACP sandbox is unavailable", async () => {
    const fixture = await createFixtureAgent();
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
        acp: {
          transport: "stdio",
          command: process.execPath,
          args: [fixture.agentPath],
        },
      },
    };
    const tool = createAcpDelegateTool({
      getParent: () => parent,
      profile,
      toolName: "delegate_external_reviewer",
      description: "Delegate to fixture ACP worker.",
      workspaceRoot: fixture.cwd,
      sandbox: { mode: "warn" },
      sandboxRuntime: unavailableRuntime(),
    });

    await expect(
      tool.execute({ goal: "review" }, { run: parent.record } as never),
    ).rejects.toMatchObject({ code: "DELEGATE_EXECUTION_FAILED" });
    expect(lifecycleTypes(parent.events.all())).toEqual([
      "subagent.requested",
      "subagent.failed",
    ]);
    expect(parent.events.all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "subagent.failed",
          payload: expect.objectContaining({
            errorCode: "DELEGATE_EXECUTION_FAILED",
          }),
        }),
      ]),
    );
  });

  it("blocks workspace writes from workspaceAccess none ACP workers", async () => {
    const runtime = createPlatformShellSandboxRuntime();
    if (!(await runtime.isAvailable())) return;
    const fixture = await createFixtureAgent(
      'writeFileSync(new URL("workspace-write.txt", import.meta.url), "bad\\n");',
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
      id: "external_workspace_writer",
      metadata: {
        acp: {
          transport: "stdio",
          command: process.execPath,
          args: [fixture.agentPath],
        },
      },
    };
    const tool = createAcpDelegateTool({
      getParent: () => parent,
      profile,
      toolName: "delegate_external_workspace_writer",
      description: "Attempt a workspace write without access.",
      workspaceRoot: fixture.cwd,
      sandbox: { mode: "enforce" },
      sandboxRuntime: runtime,
    });

    // The sandbox denial may surface as a stream close or child-process exit,
    // depending on which terminal event reaches the ACP worker first.
    await expect(
      tool.execute({ goal: "review" }, { run: parent.record } as never),
    ).rejects.toThrow();
    await expect(
      readFile(join(fixture.cwd, "workspace-write.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not inherit host environment by default", async () => {
    const fixture = await createEnvProbeAgent();
    const previous = process.env.SPARKWRIGHT_QA_SECRET;
    process.env.SPARKWRIGHT_QA_SECRET = "host-secret";
    try {
      const result = await runEnvProbeDelegate(fixture, {});
      expect(result.message).toBe("worker-env=missing");
    } finally {
      if (previous === undefined) delete process.env.SPARKWRIGHT_QA_SECRET;
      else process.env.SPARKWRIGHT_QA_SECRET = previous;
    }
  });

  it("inherits host environment only when ACP envMode is inherit", async () => {
    const fixture = await createEnvProbeAgent();
    const previous = process.env.SPARKWRIGHT_QA_SECRET;
    process.env.SPARKWRIGHT_QA_SECRET = "host-secret";
    try {
      const result = await runEnvProbeDelegate(fixture, {
        envMode: "inherit",
      });
      expect(result.message).toBe("worker-env=host-secret");
    } finally {
      if (previous === undefined) delete process.env.SPARKWRIGHT_QA_SECRET;
      else process.env.SPARKWRIGHT_QA_SECRET = previous;
    }
  });
});

function unavailableRuntime(): ShellSandboxRuntime {
  return {
    id: "missing-test-sandbox",
    platform: process.platform,
    isAvailable: async () => false,
    execute: async () => {
      throw new Error("unavailable runtime must not execute");
    },
  };
}

async function runEnvProbeDelegate(
  fixture: { cwd: string; agentPath: string },
  acpOptions: Record<string, unknown>,
): Promise<{ message?: string }> {
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
    id: "env_probe",
    name: "Env Probe",
    metadata: {
      acp: {
        transport: "stdio",
        command: process.execPath,
        args: [fixture.agentPath],
        ...acpOptions,
      },
    },
  };
  const tool = createAcpDelegateTool({
    getParent: () => parent,
    profile,
    toolName: "delegate_env_probe",
    description: "Delegate to env probe.",
    workspaceRoot: fixture.cwd,
  });
  return (await tool.execute({ goal: "probe env" }, {
    run: parent.record,
  } as never)) as { message?: string };
}

async function createFixtureAgent(startupCode = ""): Promise<{
  cwd: string;
  agentPath: string;
}> {
  const cwd = await mkdtemp(join(tmpdir(), "sparkwright-host-acp-worker-"));
  const agentPath = join(cwd, "agent.mjs");
  const require = createRequire(import.meta.url);
  const sdkUrl = pathToFileURL(
    require.resolve("@agentclientprotocol/sdk"),
  ).href;
  await writeFile(
    agentPath,
    `
import { AgentSideConnection, ndJsonStream } from ${JSON.stringify(sdkUrl)};
import { writeFileSync } from "node:fs";

${startupCode}

class FixtureAgent {
  async initialize() {
    return { protocolVersion: 1, agentInfo: { name: "Fixture", version: "1.0.0" }, authMethods: [] };
  }
  async authenticate() { return {}; }
  async newSession() { return { sessionId: "session_fixture" }; }
  async closeSession() { return {}; }
  async cancel() {}
  async prompt(params) {
    await new Promise((resolve) => setTimeout(resolve, globalThis.__promptDelayMs ?? 0));
    const text = params.prompt.find((block) => block.type === "text")?.text ?? "";
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fixture reviewed: " + text } }
    });
    return { stopReason: "end_turn" };
  }
}

new AgentSideConnection((connection) => {
  const agent = new FixtureAgent();
  agent.connection = connection;
  return agent;
}, ndJsonStream(
  new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        process.stdout.write(chunk, (error) => error ? reject(error) : resolve());
      });
    }
  }),
  new ReadableStream({
    start(controller) {
      process.stdin.on("data", (chunk) => controller.enqueue(chunk));
      process.stdin.on("end", () => controller.close());
      process.stdin.on("error", (error) => controller.error(error));
    }
  })
));
process.stdin.resume();
`,
    "utf8",
  );
  return { cwd, agentPath };
}

async function createEnvProbeAgent(): Promise<{
  cwd: string;
  agentPath: string;
}> {
  const cwd = await mkdtemp(join(tmpdir(), "sparkwright-host-acp-env-"));
  const agentPath = join(cwd, "env-agent.mjs");
  const require = createRequire(import.meta.url);
  const sdkUrl = pathToFileURL(
    require.resolve("@agentclientprotocol/sdk"),
  ).href;
  await writeFile(
    agentPath,
    `
import { AgentSideConnection, ndJsonStream } from ${JSON.stringify(sdkUrl)};

class EnvProbeAgent {
  async initialize() {
    return { protocolVersion: 1, agentInfo: { name: "EnvProbe", version: "1.0.0" }, authMethods: [] };
  }
  async authenticate() { return {}; }
  async newSession() { return { sessionId: "session_env_probe" }; }
  async closeSession() { return {}; }
  async cancel() {}
  async prompt(params) {
    const value = process.env.SPARKWRIGHT_QA_SECRET ?? "missing";
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "worker-env=" + value } }
    });
    return { stopReason: "end_turn" };
  }
}

new AgentSideConnection((connection) => {
  const agent = new EnvProbeAgent();
  agent.connection = connection;
  return agent;
}, ndJsonStream(
  new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        process.stdout.write(chunk, (error) => error ? reject(error) : resolve());
      });
    }
  }),
  new ReadableStream({
    start(controller) {
      process.stdin.on("data", (chunk) => controller.enqueue(chunk));
      process.stdin.on("end", () => controller.close());
      process.stdin.on("error", (error) => controller.error(error));
    }
  })
));
process.stdin.resume();
`,
    "utf8",
  );
  return { cwd, agentPath };
}
