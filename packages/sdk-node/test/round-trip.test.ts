import { describe, expect, it } from "vitest";
import type { Connection } from "@sparkwright/host";
import { serveConnection } from "@sparkwright/host";
import type { HostMessage } from "@sparkwright/protocol";
import {
  Client,
  runFailureMessage,
  type ClientTransport,
} from "@sparkwright/sdk-core";

/**
 * Build an in-process pair: a host-side Connection and a client-side
 * ClientTransport that share a queue. Exercises the SDK + host together
 * without spawning a child process or opening a socket.
 */
function inProcessPair(): {
  hostSide: Connection;
  clientTransport: ClientTransport;
} {
  let hostInbound: ((m: HostMessage) => void) | null = null;
  let hostClosed: ((reason?: string) => void) | null = null;
  let clientInbound: ((m: HostMessage) => void) | null = null;
  let clientClosed: ((reason?: string) => void) | null = null;

  const hostSide: Connection = {
    id: "test_host",
    send(m) {
      clientInbound?.(m);
    },
    onMessage(handler) {
      hostInbound = handler;
    },
    onClose(handler) {
      hostClosed = handler;
    },
    close() {
      hostClosed?.("host close");
      clientClosed?.("host close");
    },
  };

  const clientTransport: ClientTransport = {
    send(m) {
      hostInbound?.(m);
    },
    onMessage(handler) {
      clientInbound = handler;
    },
    onClose(handler) {
      clientClosed = handler;
    },
    close() {
      clientClosed?.("client close");
      hostClosed?.("client close");
    },
  };
  return { hostSide, clientTransport };
}

describe("sdk-node round-trip against host", () => {
  it("handshake + deterministic run + terminal event", async () => {
    const { hostSide, clientTransport } = inProcessPair();
    serveConnection(hostSide, {
      workspaceRoot: process.cwd(),
      defaultModel: "deterministic",
    });

    const client = new Client({
      transport: clientTransport,
      client: { name: "test-sdk", version: "0.0.0" },
    });

    const terminal = new Promise<{
      state?: string;
      stopReason?: string;
    }>((resolve, reject) => {
      client.on("run.completed", (m) =>
        resolve({ state: m.payload.state, stopReason: m.payload.stopReason }),
      );
      client.on("run.failed", (m) =>
        reject(new Error(`failed: ${runFailureMessage(m.payload)}`)),
      );
    });

    await client.handshake();
    const { runId } = await client.startRun({ goal: "smoke" });
    expect(runId).toMatch(/^run_/);

    const t = await terminal;
    expect(t.stopReason).toBeDefined();

    client.close();
  });

  it("rejects approval with unknown id", async () => {
    const { hostSide, clientTransport } = inProcessPair();
    serveConnection(hostSide, {
      workspaceRoot: process.cwd(),
      defaultModel: "deterministic",
    });
    const client = new Client({
      transport: clientTransport,
      client: { name: "test-sdk", version: "0.0.0" },
    });
    await client.handshake();
    await expect(
      client.resolveApproval({
        approvalId: "approval_bogus",
        decision: "approved",
      }),
    ).rejects.toMatchObject({ code: "approval_not_found" });
    client.close();
  });
});
