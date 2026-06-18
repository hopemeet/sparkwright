import { describe, expect, it } from "vitest";
import {
  PERMISSION_MODES,
  PROTOCOL_VERSION,
  TRACE_LEVELS,
  isEvent,
  isPermissionMode,
  isRequest,
  isResponse,
  isTraceLevel,
  type HostMessage,
} from "../src/index.js";

describe("@sparkwright/protocol", () => {
  it("exports the current host protocol version", () => {
    expect(PROTOCOL_VERSION).toBe("1.3");
  });

  it("exports stable permission mode and trace level guards", () => {
    expect([...PERMISSION_MODES]).toEqual([
      "plan",
      "default",
      "accept_edits",
      "dont_ask",
      "bypass_permissions",
    ]);
    expect([...TRACE_LEVELS]).toEqual(["standard", "debug"]);
    expect(isPermissionMode("accept_edits")).toBe(true);
    expect(isPermissionMode("unknown")).toBe(false);
    expect(isTraceLevel("debug")).toBe(true);
    expect(isTraceLevel("verbose")).toBe(false);
  });

  it("narrows host message envelopes", () => {
    const messages: HostMessage[] = [
      {
        envelope: "request",
        id: "req_1",
        kind: "handshake",
        timestamp: "2026-05-24T00:00:00.000Z",
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      },
      {
        envelope: "response",
        id: "req_1",
        timestamp: "2026-05-24T00:00:01.000Z",
        ok: true,
        result: {},
      },
      {
        envelope: "event",
        id: "evt_1",
        kind: "host.ready",
        timestamp: "2026-05-24T00:00:02.000Z",
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          host: { name: "sparkwright-host", version: "0.1.0" },
        },
      },
    ];

    expect(messages.map(isRequest)).toEqual([true, false, false]);
    expect(messages.map(isResponse)).toEqual([false, true, false]);
    expect(messages.map(isEvent)).toEqual([false, false, true]);
  });
});
