import { describe, expect, it } from "vitest";
import { Client, type ClientTransport } from "@sparkwright/sdk-core";

/**
 * Round-trip test against an in-process fake transport. Confirms that the
 * browser SDK's Client (re-exported from sdk-core) handles handshake +
 * request/response correlation correctly without any Node deps.
 *
 * The actual WebSocket transport is exercised by integration testing
 * against a running host; this test guards the protocol logic.
 */
function fakeHostTransport(): {
  client: ClientTransport;
  inject: (message: unknown) => void;
  sent: unknown[];
  close: () => void;
} {
  const sent: unknown[] = [];
  let onMessage: ((m: unknown) => void) | null = null;
  let onClose: ((reason?: string) => void) | null = null;
  return {
    sent,
    client: {
      send(m) {
        sent.push(m);
      },
      onMessage(handler) {
        onMessage = handler as (m: unknown) => void;
      },
      onClose(handler) {
        onClose = handler;
      },
      close() {
        onClose?.("client close");
      },
    },
    inject: (m) => onMessage?.(m),
    close: () => onClose?.("test close"),
  };
}

describe("sdk-browser Client", () => {
  it("handshake → response round-trip", async () => {
    const fake = fakeHostTransport();
    const client = new Client({
      transport: fake.client,
      client: { name: "test", version: "0.0.0" },
      requestTimeoutMs: 2000,
    });

    const promise = client.handshake();
    // Wait one tick so the request reaches `sent`.
    await new Promise((r) => setTimeout(r, 0));
    const sent = fake.sent[0] as {
      envelope: string;
      id: string;
      kind: string;
    };
    expect(sent.envelope).toBe("request");
    expect(sent.kind).toBe("handshake");

    fake.inject({
      envelope: "response",
      id: sent.id,
      ok: true,
      timestamp: new Date().toISOString(),
      result: {},
    });

    await promise;
    client.close();
  });

  it("emits typed events from inbound event messages", async () => {
    const fake = fakeHostTransport();
    const client = new Client({
      transport: fake.client,
      client: { name: "test", version: "0.0.0" },
    });

    const seen: unknown[] = [];
    client.on("run.event", (msg) => seen.push(msg));

    fake.inject({
      envelope: "event",
      id: "evt_1",
      kind: "run.event",
      timestamp: new Date().toISOString(),
      payload: { runId: "r1", event: { type: "tool.requested", sequence: 1 } },
    });

    expect(seen).toHaveLength(1);
    expect((seen[0] as { payload: { runId: string } }).payload.runId).toBe(
      "r1",
    );
    client.close();
  });
});
