import { describe, expect, it } from "vitest";
import type { HostEvent } from "@sparkwright/protocol";
import { hostEventToSessionUpdates } from "../src/event.js";

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
});
