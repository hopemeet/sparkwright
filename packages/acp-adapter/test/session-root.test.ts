import { access, mkdtemp, readdir, writeFile } from "node:fs/promises";
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("ACP --session-root", () => {
  it("writes session artifacts under the configured session root, not the workspace", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sparkwright-acp-sr-ws-"));
    const sessionRootDir = await mkdtemp(
      join(tmpdir(), "sparkwright-acp-sr-out-"),
    );
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
        defaultSessionRootDir: sessionRootDir,
        defaultModel: "deterministic",
        defaultTraceLevel: "debug",
      }),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );
    const clientConnection = new ClientSideConnection(
      () => client,
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );

    await clientConnection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await clientConnection.newSession({ cwd, mcpServers: [] });
    const response = await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "inspect this repo" }],
    });
    expect(response.stopReason).toBe("end_turn");

    // Artifacts land under the configured session root...
    const runsDir = join(
      sessionRootDir,
      session.sessionId,
      "agents",
      "main",
      "runs",
    );
    const runIds = await readdir(runsDir);
    expect(runIds.length).toBeGreaterThan(0);

    // ...and the workspace is left untouched (no .sparkwright/sessions leak).
    expect(await exists(join(cwd, ".sparkwright", "sessions"))).toBe(false);

    await clientConnection.closeSession({ sessionId: session.sessionId });
    agentConnection.signal.throwIfAborted?.();
  });
});
