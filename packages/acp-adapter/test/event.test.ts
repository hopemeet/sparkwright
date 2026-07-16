import { describe, expect, it } from "vitest";
import type { HostEvent } from "@sparkwright/protocol";
import {
  hostEventToSessionUpdates,
  routeHostEventToAcp,
} from "../src/event.js";

describe("ACP event mapping", () => {
  it("maps final model output to an ACP agent message chunk", () => {
    const event: HostEvent = {
      envelope: "event",
      id: "evt_1",
      kind: "run.event",
      timestamp: "2026-01-01T00:00:00.000Z",
      payload: {
        runId: "run_1",
        event: {
          id: "core_1",
          type: "model.completed",
          payload: { message: "done" },
        },
      },
    };

    expect(hostEventToSessionUpdates(event)).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "core_1",
        content: { type: "text", text: "done" },
      },
    ]);
  });

  it("uses model.completed as a non-streaming fallback only once per routed run", async () => {
    const updates: unknown[] = [];
    const session = fakeSession([]);
    const connection = {
      async requestPermission() {
        throw new Error("not used");
      },
      async sessionUpdate(params: unknown) {
        updates.push(params);
      },
    };

    await routeHostEventToAcp({
      session,
      connection,
      event: runEvent({
        id: "stream_1",
        runId: "run_1",
        type: "model.stream.chunk",
        payload: { text: "done" },
      }),
    });
    await routeHostEventToAcp({
      session,
      connection,
      event: runEvent({
        id: "completed_1",
        runId: "run_1",
        type: "model.completed",
        payload: { message: "done" },
      }),
    });

    expect(updates).toEqual([
      {
        sessionId: "session_1",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "run_1",
          content: { type: "text", text: "done" },
        },
      },
    ]);
  });

  it("does not drop a later non-streamed message from the same run", async () => {
    const updates: unknown[] = [];
    const session = fakeSession([]);
    const connection = {
      async requestPermission() {
        throw new Error("not used");
      },
      async sessionUpdate(params: unknown) {
        updates.push(params);
      },
    };

    await routeHostEventToAcp({
      session,
      connection,
      event: runEvent({
        id: "stream_1",
        runId: "run_1",
        type: "model.stream.chunk",
        payload: { messageId: "msg_1", text: "first" },
      }),
    });
    await routeHostEventToAcp({
      session,
      connection,
      event: runEvent({
        id: "completed_2",
        runId: "run_1",
        type: "model.completed",
        payload: { messageId: "msg_2", message: "second" },
      }),
    });

    expect(updates).toEqual([
      {
        sessionId: "session_1",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "msg_1",
          content: { type: "text", text: "first" },
        },
      },
      {
        sessionId: "session_1",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "msg_2",
          content: { type: "text", text: "second" },
        },
      },
    ]);
  });

  it("omits control events from ACP agent text", () => {
    expect(
      hostEventToSessionUpdates({
        envelope: "event",
        id: "evt_done",
        kind: "run.completed",
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: {
          runId: "run_1",
          state: "completed",
          stopReason: "completed",
        },
      }),
    ).toEqual([]);
    expect(
      hostEventToSessionUpdates(
        runEvent({
          id: "write_1",
          runId: "run_1",
          type: "workspace.write.completed",
          payload: { path: "README.md" },
        }),
      ),
    ).toEqual([]);
    expect(
      hostEventToSessionUpdates(
        runEvent({
          id: "artifact_1",
          runId: "run_1",
          type: "artifact.created",
          payload: { id: "artifact_1", type: "log" },
        }),
      ),
    ).toEqual([]);
  });

  it("maps tool lifecycle events to ACP tool updates", () => {
    const event: HostEvent = {
      envelope: "event",
      id: "evt_1",
      kind: "run.event",
      timestamp: "2026-01-01T00:00:00.000Z",
      payload: {
        runId: "run_1",
        event: {
          id: "core_1",
          type: "tool.completed",
          payload: {
            toolCallId: "tool_1",
            toolName: "read",
            output: "contents",
          },
        },
      },
    };

    expect(hostEventToSessionUpdates(event)).toEqual([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool_1",
        title: "read",
        status: "completed",
        kind: "read",
        rawOutput: "contents",
        content: [
          {
            type: "content",
            content: { type: "text", text: "contents" },
          },
        ],
      },
    ]);
  });

  it("maps ACP allow_once permission responses to approved runtime approvals", async () => {
    const decisions: Array<{ approvalId: string; decision: string }> = [];
    const requested: unknown[] = [];

    await routeHostEventToAcp({
      session: fakeSession(decisions),
      connection: {
        async requestPermission(params: unknown) {
          requested.push(params);
          return {
            outcome: { outcome: "selected", optionId: "allow_once" },
          };
        },
        async sessionUpdate() {},
      },
      event: approvalEvent(),
    });

    await waitFor(() => decisions.length > 0);
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({
      sessionId: "session_1",
      toolCall: {
        toolCallId: "approval_1",
        title: "Write README.md",
        status: "pending",
        kind: "edit",
        rawInput: { path: "README.md" },
      },
      options: [
        { optionId: "allow_once", kind: "allow_once" },
        { optionId: "reject", kind: "reject_once" },
      ],
    });
    expect(decisions).toEqual([
      { approvalId: "approval_1", decision: "approved" },
    ]);
  });

  it("maps rejected or failed ACP permission responses to denied runtime approvals", async () => {
    const rejected: Array<{ approvalId: string; decision: string }> = [];
    await routeHostEventToAcp({
      session: fakeSession(rejected),
      connection: {
        async requestPermission() {
          return { outcome: { outcome: "selected", optionId: "reject" } };
        },
        async sessionUpdate() {},
      },
      event: approvalEvent(),
    });
    await waitFor(() => rejected.length > 0);
    expect(rejected).toEqual([
      { approvalId: "approval_1", decision: "denied" },
    ]);

    const failed: Array<{ approvalId: string; decision: string }> = [];
    await routeHostEventToAcp({
      session: fakeSession(failed),
      connection: {
        async requestPermission() {
          throw new Error("permission UI unavailable");
        },
        async sessionUpdate() {},
      },
      event: approvalEvent(),
    });
    await waitFor(() => failed.length > 0);
    expect(failed).toEqual([{ approvalId: "approval_1", decision: "denied" }]);
  });
});

function runEvent(event: Record<string, unknown>): HostEvent {
  return {
    envelope: "event",
    id: "evt_1",
    kind: "run.event",
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: {
      runId: String(event.runId ?? "run_1"),
      event,
    },
  };
}

function approvalEvent(): Extract<HostEvent, { kind: "approval.requested" }> {
  return {
    envelope: "event",
    id: "evt_approval",
    kind: "approval.requested",
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: {
      runId: "run_1",
      approvalId: "approval_1",
      action: "workspace.write",
      summary: "Write README.md",
      details: { path: "README.md" },
    },
  };
}

function fakeSession(
  decisions: Array<{ approvalId: string; decision: string }>,
) {
  return {
    sessionId: "session_1",
    cwd: "/tmp/project",
    runtime: {
      resolveApproval(approvalId: string, decision: string) {
        decisions.push({ approvalId, decision });
        return { ok: true };
      },
    },
  } as never;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) {
      throw new Error("Timed out waiting for async ACP approval routing.");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
