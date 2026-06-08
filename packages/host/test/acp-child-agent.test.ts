import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createRun } from "@sparkwright/core";
import type { AgentProfile } from "@sparkwright/agent-runtime";
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
          cwd: ".",
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
  });
});

async function createFixtureAgent(): Promise<{
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
