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
            toolName: "read_file",
            output: "contents",
          },
        },
      },
    };

    expect(hostEventToSessionUpdates(event)).toEqual([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool_1",
        title: "read_file",
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
