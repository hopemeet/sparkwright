import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentSideConnection,
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { createSparkwrightAcpAgentFactory } from "../src/index.js";

describe("ACP round trip", () => {
  it("runs a deterministic SparkWright turn over ACP", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sparkwright-acp-roundtrip-"));
    await writeFile(join(cwd, "README.md"), "# Demo\n", "utf8");
    const clientToAgent = new TransformStream<Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array>();
    const updates: SessionNotification[] = [];
    const client: Client = {
      async requestPermission(params) {
        return {
          outcome: {
            outcome: "selected",
            optionId: params.options.at(-1)?.optionId ?? "reject",
          },
        };
      },
      async sessionUpdate(params) {
        updates.push(params);
      },
    };

    const agentConnection = new AgentSideConnection(
      createSparkwrightAcpAgentFactory({
        defaultWorkspaceRoot: cwd,
        defaultModel: "deterministic",
        defaultTraceLevel: "debug",
      }),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );
    const clientConnection = new ClientSideConnection(
      () => client,
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );

    const initialized = await clientConnection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await clientConnection.newSession({
      cwd,
      mcpServers: [],
    });
    const capabilities = await clientConnection.extMethod(
      "sparkwright/capabilities",
      { sessionId: session.sessionId },
    );
    const response = await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "inspect this repo" }],
    });

    expect(initialized.agentInfo?.name).toBe("SparkWright");
    expect(response.stopReason).toBe("end_turn");
    expect(
      updates.some(
        (update) =>
          update.update.sessionUpdate === "agent_message_chunk" &&
          update.update.content.type === "text" &&
          update.update.content.text.includes("Done"),
      ),
    ).toBe(true);
    expect(
      updates.some((update) => update.update.sessionUpdate === "tool_call"),
    ).toBe(true);
    expect(Array.isArray(capabilities.tools)).toBe(true);
    const runsDir = join(
      cwd,
      ".sparkwright",
      "sessions",
      session.sessionId,
      "agents",
      "main",
      "runs",
    );
    const runIds = await readdir(runsDir);
    const runJson = JSON.parse(
      await readFile(join(runsDir, runIds[0]!, "run.json"), "utf8"),
    ) as { metadata?: Record<string, unknown> };
    expect(runJson.metadata).toMatchObject({
      source: "acp",
      traceLevel: "debug",
      permissionMode: "default",
      shouldWrite: false,
      workspaceRoot: cwd,
    });
    expect(runJson.metadata?.capabilitySnapshot).toMatchObject({
      tools: expect.any(Number),
    });

    agentConnection.signal.throwIfAborted?.();
    await clientConnection.closeSession({ sessionId: session.sessionId });
  });
});
