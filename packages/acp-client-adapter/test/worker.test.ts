import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  ExternalAcpWorker,
  createExternalAcpWorkerTool,
} from "../src/index.js";
import type { RuntimeContext } from "@sparkwright/core";

describe("ExternalAcpWorker", () => {
  it("runs an external ACP agent process", async () => {
    const fixture = await createFixtureAgent();
    let cleaned = false;
    const worker = new ExternalAcpWorker({
      command: process.execPath,
      args: [fixture.agentPath],
      cwd: fixture.cwd,
      env: process.env,
      cleanup: async () => {
        cleaned = true;
      },
    });

    const result = await worker.run({
      cwd: fixture.cwd,
      goal: "delegate this",
      metadata: { worker: "fixture" },
    });

    expect(result.stopReason).toBe("end_turn");
    expect(result.sessionId).toBe("session_fixture");
    expect(result.text).toContain("fixture handled: delegate this");
    expect(result.toolCallCount).toBe(1);
    expect(cleaned).toBe(true);
  });

  it("wraps an external ACP agent as a governed SparkWright tool", async () => {
    const fixture = await createFixtureAgent();
    const tool = createExternalAcpWorkerTool({
      name: "delegate_fixture",
      cwd: fixture.cwd,
      worker: {
        command: process.execPath,
        args: [fixture.agentPath],
        cwd: fixture.cwd,
        env: process.env,
      },
    });

    const result = await tool.execute({ goal: "tool task" }, {
      run: {
        id: "run_test",
        goal: "parent",
        state: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {},
      },
    } as RuntimeContext);

    expect(result.text).toContain("fixture handled: tool task");
    expect(tool.policy).toEqual({ risk: "risky", requiresApproval: true });
    expect(tool.governance?.origin).toMatchObject({
      kind: "hosted",
      metadata: { protocol: "acp" },
    });
  });
});

async function createFixtureAgent(): Promise<{
  cwd: string;
  agentPath: string;
}> {
  const cwd = await mkdtemp(join(tmpdir(), "sparkwright-acp-worker-"));
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
      update: { sessionUpdate: "tool_call", toolCallId: "tool_fixture", title: "fixture", status: "pending", kind: "other" }
    });
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fixture handled: " + text } }
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
