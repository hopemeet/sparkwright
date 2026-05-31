import { describe, expect, it } from "vitest";
import { Client } from "../src/client.js";
import type { ClientTransport } from "../src/transport.js";
import { PROTOCOL_VERSION, type HostMessage } from "@sparkwright/protocol";

class FakeTransport implements ClientTransport {
  sent: HostMessage[] = [];
  private messageHandler?: (message: HostMessage) => void;
  private closeHandler?: (reason?: string) => void;

  send(message: HostMessage): void {
    this.sent.push(message);
  }

  onMessage(handler: (message: HostMessage) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (reason?: string) => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.closeHandler?.("closed by test");
  }

  receive(message: HostMessage): void {
    this.messageHandler?.(message);
  }
}

describe("@sparkwright/sdk-core Client", () => {
  it("sends a handshake request and resolves its response", async () => {
    const transport = new FakeTransport();
    const client = new Client({
      transport,
      client: { name: "test-client", version: "0.0.0" },
    });

    const handshake = client.handshake();
    const request = transport.sent[0];

    expect(request).toMatchObject({
      envelope: "request",
      kind: "handshake",
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        client: { name: "test-client", version: "0.0.0" },
      },
    });

    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-05-24T00:00:00.000Z",
      ok: true,
      result: {},
    });

    await expect(handshake).resolves.toBeUndefined();
  });

  it("emits host events from the transport", () => {
    const transport = new FakeTransport();
    const client = new Client({
      transport,
      client: { name: "test-client", version: "0.0.0" },
    });
    const readyEvents: HostMessage[] = [];

    client.on("host.ready", (event) => readyEvents.push(event));
    transport.receive({
      envelope: "event",
      id: "evt_1",
      kind: "host.ready",
      timestamp: "2026-05-24T00:00:00.000Z",
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        host: { name: "sparkwright-host", version: "0.1.0" },
      },
    });

    expect(readyEvents).toHaveLength(1);
    expect(readyEvents[0]).toMatchObject({
      envelope: "event",
      kind: "host.ready",
    });
  });

  it("sends run.inject_message requests", async () => {
    const transport = new FakeTransport();
    const client = new Client({
      transport,
      client: { name: "test-client", version: "0.0.0" },
    });

    const injected = client.injectRunMessage({
      runId: "run_1",
      content: "please include tests",
      metadata: { source: "telegram" },
    });
    const request = transport.sent[0];

    expect(request).toMatchObject({
      envelope: "request",
      kind: "run.inject_message",
      payload: {
        runId: "run_1",
        content: "please include tests",
        metadata: { source: "telegram" },
      },
    });

    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-05-24T00:00:00.000Z",
      ok: true,
      result: {},
    });

    await expect(injected).resolves.toEqual({});
  });

  it("sends session.inspect requests", async () => {
    const transport = new FakeTransport();
    const client = new Client({
      transport,
      client: { name: "test-client", version: "0.0.0" },
    });

    const inspected = client.inspectSession({ sessionId: "session_1" });
    const request = transport.sent[0];

    expect(request).toMatchObject({
      envelope: "request",
      kind: "session.inspect",
      payload: { sessionId: "session_1" },
    });

    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-05-24T00:00:00.000Z",
      ok: true,
      result: {
        sessionId: "session_1",
        summary: { eventCount: 1 },
        consistency: { ok: true },
        timeline: { phases: [] },
      },
    });

    await expect(inspected).resolves.toMatchObject({
      sessionId: "session_1",
      summary: { eventCount: 1 },
    });
  });
});
