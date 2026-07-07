import { describe, expect, it } from "vitest";
import {
  PERMISSION_MODES,
  PROTOCOL_VERSION,
  TRACE_LEVELS,
  getRunFailure,
  isEvent,
  isPermissionMode,
  isProtocolErrorCode,
  isRequest,
  isResponse,
  isTraceLevel,
  protocolErrorToRunFailure,
  runFailureMessage,
  type HostMessage,
} from "../src/index.js";

describe("@sparkwright/protocol", () => {
  it("exports the current host protocol version", () => {
    expect(PROTOCOL_VERSION).toBe("1.4");
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
    expect(isTraceLevel("minimal")).toBe(false);
    expect(isTraceLevel("verbose")).toBe(false);
  });

  it("exports stable protocol error guards", () => {
    expect(isProtocolErrorCode("internal_error")).toBe(true);
    expect(isProtocolErrorCode("model_error")).toBe(false);
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

  it("extracts canonical terminal run failures", () => {
    const payload = {
      runId: "run_1",
      state: "failed",
      failure: {
        category: "model",
        code: "MODEL_COMPLETION_FAILED",
        message: "provider rejected request",
        retryable: false,
        metadata: { status: 401 },
      },
      error: {
        code: "internal_error",
        message: "legacy projection",
      },
    };

    expect(getRunFailure(payload)).toEqual(payload.failure);
    expect(runFailureMessage(payload)).toBe("provider rejected request");
  });

  it("projects legacy protocol errors into run failures", () => {
    const error = {
      code: "internal_error" as const,
      message: "host crashed",
      details: { phase: "startup" },
    };

    expect(protocolErrorToRunFailure(error)).toEqual({
      code: "internal_error",
      message: "host crashed",
      metadata: { phase: "startup" },
    });
    expect(getRunFailure({ runId: "run_1", error })).toEqual({
      code: "internal_error",
      message: "host crashed",
      metadata: { phase: "startup" },
    });
  });

  it("falls back to root run failure messages for legacy failed payloads", () => {
    expect(
      runFailureMessage({
        runId: "run_1",
        code: "MODEL_COMPLETION_FAILED",
        message: "invalid API key",
      }),
    ).toBe("invalid API key");
  });

  it("synthesizes failed completed payloads without treating answers as failures", () => {
    expect(
      getRunFailure({
        runId: "run_1",
        state: "failed",
        stopReason: "model_auth_failed",
        message: "invalid API key",
      }),
    ).toEqual({
      code: "model_auth_failed",
      message: "invalid API key",
    });

    expect(
      getRunFailure({
        runId: "run_2",
        state: "completed",
        stopReason: "final_answer",
        message: "done",
      }),
    ).toBeUndefined();
  });
});
