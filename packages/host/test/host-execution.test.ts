import { describe, expect, it, vi } from "vitest";
import { createRun, MemoryTrace } from "@sparkwright/core";
import { HostExecution } from "../src/host-execution.js";

describe("HostExecution", () => {
  it("keeps root/current/final aliases across multiple Core episodes", async () => {
    const execution = new HostExecution();
    const first = createRun({ goal: "first episode" });
    const second = createRun({ goal: "second episode" });
    execution.attachRun({
      runId: first.record.id,
      run: first,
      trace: new MemoryTrace(),
      sessionId: "session_execution",
    });
    execution.attachRun({
      runId: second.record.id,
      run: second,
      trace: new MemoryTrace(),
      sessionId: "session_execution",
    });

    expect(execution.rootRunId).toBe(first.record.id);
    expect(execution.currentRunId()).toBe(second.record.id);
    expect(execution.ownsRun(first.record.id)).toBe(true);
    expect(
      execution.tryInject(first.record.id, { content: "handoff message" }),
    ).toBe("accepted");
    expect(
      second.events
        .all()
        .filter((event) => event.type === "run.command.enqueued"),
    ).toHaveLength(1);

    execution.finish("completed");
    await expect(execution.completion).resolves.toMatchObject({
      executionId: execution.executionId,
      sessionId: "session_execution",
      rootRunId: first.record.id,
      finalRunId: second.record.id,
      state: "completed",
    });
  });

  it("resolves approvals once and disposes execution resources once", async () => {
    const execution = new HostExecution();
    const resolve = vi.fn();
    const cleanup = vi.fn(async () => {});
    execution.addApproval({
      approvalId: "approval_execution",
      runId: "run_execution",
      resolve,
    });
    execution.addCleanup(cleanup);

    expect(
      execution.resolveApproval("approval_execution", {
        decision: "approved",
      }),
    ).toBe(true);
    expect(
      execution.resolveApproval("approval_execution", { decision: "denied" }),
    ).toBe(false);
    await Promise.all([
      execution.disposeResources(),
      execution.disposeResources(),
    ]);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ decision: "approved" });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("uses one abort for cancellation and refuses continuation admission", async () => {
    const execution = new HostExecution();
    const run = createRun({ goal: "cancel execution" });
    execution.attachRun({
      runId: run.record.id,
      run,
      trace: new MemoryTrace(),
      sessionId: "session_cancel",
    });

    expect(execution.cancel("test cancel")).toBe(true);
    expect(execution.abortController.signal.aborted).toBe(true);
    expect(run.record.state).toBe("cancelled");
    expect(
      execution.tryInject(run.record.id, { content: "after cancel" }),
    ).toBe("closed");
    execution.finish("cancelled");
    expect(execution.cancel("duplicate")).toBe(false);
  });
});
