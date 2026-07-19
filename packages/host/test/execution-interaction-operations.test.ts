import { createApprovalRequest, createRun } from "@sparkwright/core";
import { MemoryTrace } from "@sparkwright/core/internal";
import type { HostEvent } from "@sparkwright/protocol";
import { describe, expect, it, vi } from "vitest";
import { HostExecution } from "../src/host-execution.js";
import {
  contentPartsFromRunInput,
  ExecutionInteractionOperations,
} from "../src/runtime/execution-interaction-operations.js";

describe("ExecutionInteractionOperations", () => {
  it("projects identity and routes injected messages and cancellation", () => {
    const execution = new HostExecution({ executionId: "execution_owner" });
    const run = createRun({ goal: "interaction owner" });
    execution.attachRun({
      runId: run.record.id,
      run,
      trace: new MemoryTrace(),
      sessionId: "session_owner",
    });
    const operations = createOperations(execution);

    expect(operations.executionIdentity()).toEqual({
      executionId: "execution_owner",
      sessionId: "session_owner",
      currentRunId: run.record.id,
      runIds: [run.record.id],
    });
    expect(operations.hasActiveRun()).toBe(true);

    const handle = operations.executionDriverHandle("execution_owner");
    expect(
      handle?.tryInject({ runId: run.record.id, content: "follow up" }),
    ).toBe("accepted");
    expect(
      run.events.all().filter((event) => event.type === "run.command.enqueued"),
    ).toHaveLength(1);
    expect(handle?.tryInject({ runId: run.record.id, content: "   " })).toBe(
      "closed",
    );

    handle?.cancel("owner test");
    expect(execution.abortController.signal.reason).toBe("owner test");
    expect(run.record.state).toBe("cancelled");
  });

  it("owns approval delivery, resolution metadata, and disconnect denial", async () => {
    const execution = new HostExecution();
    const run = createRun({ goal: "approval owner" });
    execution.attachRun({
      runId: run.record.id,
      run,
      trace: new MemoryTrace(),
      sessionId: "session_approval_owner",
    });
    const events: HostEvent[] = [];
    const operations = createOperations(execution, events);
    const channel = operations.createInteractionChannel({
      value: run.record.id,
    });
    const firstRequest = createApprovalRequest({
      runId: run.record.id,
      action: "workspace.write",
      summary: "Write README.md",
      details: { path: "README.md", secret: "bounded-detail" },
    });
    const firstResponse = Promise.resolve(channel.approve(firstRequest));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "approval.requested",
      payload: {
        runId: run.record.id,
        approvalId: firstRequest.id,
        action: "workspace.write",
        summary: "Write README.md",
        details: { path: "README.md", secret: "bounded-detail" },
      },
    });
    expect(
      operations.resolveApproval(
        firstRequest.id,
        "approved",
        "session policy",
        true,
      ),
    ).toEqual({ ok: true });
    await expect(firstResponse).resolves.toEqual({
      approvalId: firstRequest.id,
      decision: "approved",
      message: "session policy",
      autoApproved: true,
    });

    const secondRequest = createApprovalRequest({
      runId: run.record.id,
      action: "shell.execute",
      summary: "Run tests",
    });
    const secondResponse = Promise.resolve(channel.approve(secondRequest));
    operations.cleanup();
    await expect(secondResponse).resolves.toEqual({
      approvalId: secondRequest.id,
      decision: "denied",
    });
    expect(execution.abortController.signal.reason).toBe("client_disconnected");
  });

  it("keeps protocol input-part projection canonical", () => {
    expect(
      contentPartsFromRunInput([
        { type: "text", text: "hello", metadata: { source: "test" } },
        { type: "text", text: "" },
        { type: "image", mediaType: "image/png" },
        {
          type: "image",
          uri: "file:///tmp/example.png",
          mediaType: "image/png",
          name: "example.png",
        },
      ]),
    ).toEqual([
      { type: "text", text: "hello", metadata: { source: "test" } },
      {
        type: "image",
        uri: "file:///tmp/example.png",
        mediaType: "image/png",
        name: "example.png",
      },
    ]);
  });

  it("denies approvals after the configured finite timeout", async () => {
    vi.useFakeTimers();
    try {
      const execution = new HostExecution();
      const run = createRun({ goal: "approval timeout" });
      execution.attachRun({
        runId: run.record.id,
        run,
        trace: new MemoryTrace(),
        sessionId: "session_approval_timeout",
      });
      const operations = createOperations(execution, [], 25);
      const channel = operations.createInteractionChannel({
        value: run.record.id,
      });
      const request = createApprovalRequest({
        runId: run.record.id,
        action: "workspace.write",
        summary: "Wait for approval",
      });
      const response = Promise.resolve(channel.approve(request));

      await vi.advanceTimersByTimeAsync(25);

      await expect(response).resolves.toEqual({
        approvalId: request.id,
        decision: "denied",
        message: "Approval timed out.",
      });
      expect(operations.resolveApproval(request.id, "approved")).toMatchObject({
        ok: false,
        error: { code: "approval_not_found" },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

function createOperations(
  execution: HostExecution | null,
  events: HostEvent[] = [],
  approvalTimeoutMs = 5_000,
): ExecutionInteractionOperations {
  return new ExecutionInteractionOperations({
    execution: { current: () => execution },
    emit: (event) => events.push(event),
    approvalTimeoutMs,
  });
}
