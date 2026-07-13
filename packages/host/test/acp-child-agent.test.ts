import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
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

    await expect(
      tool.execute({ goal: "review" }, { run: parent.record } as never),
    ).rejects.toThrow("ACP connection closed");
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
