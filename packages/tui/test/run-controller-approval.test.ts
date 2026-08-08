import { describe, expect, it, vi } from "vitest";
import type { Client } from "@sparkwright/sdk-node";
import type { HostEvent, RunAccessMode } from "@sparkwright/protocol";
import { EventStore } from "../src/state/event-store.js";
import { RunController } from "../src/state/run-controller.js";

function approvalEvent(id: string): HostEvent & { kind: "approval.requested" } {
  return {
    kind: "approval.requested",
    timestamp: "2026-07-10T00:00:00.000Z",
    payload: {
      approvalId: id,
      runId: "run_1",
      action: "tool.execute",
      summary: "Run shell command",
      details: {
        toolName: "bash",
        arguments: { command: "npm test", cwd: "/workspace/project" },
      },
    },
  } as unknown as HostEvent & { kind: "approval.requested" };
}

function deliver(
  controller: RunController,
  client: Client,
  sessionId: string,
  event: HostEvent & { kind: "approval.requested" },
  accessMode: RunAccessMode = "ask",
  workflowRunId?: string,
): void {
  const internal = controller as unknown as {
    handleApprovalRequested(
      execution: {
        client: Client;
        sessionId: string;
        accessMode: RunAccessMode;
        kind: "workflow";
        workflowRunId?: string;
        runId: string;
      },
      event: HostEvent & { kind: "approval.requested" },
    ): void;
  };
  internal.handleApprovalRequested(
    {
      client,
      sessionId,
      accessMode,
      kind: "workflow",
      ...(workflowRunId ? { workflowRunId } : {}),
      runId: event.payload.runId,
    },
    event,
  );
}

function cleanup(controller: RunController, client: Client): void {
  (
    controller as unknown as { cleanupExecution(client: Client): void }
  ).cleanupExecution(client);
}

describe("RunController session approvals", () => {
  it("surfaces approvals from a workflow job client", async () => {
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: "/workspace/project",
      initialSessionId: "session_a",
      store,
    });
    let listener:
      | ((event: ReturnType<typeof approvalEvent>) => void)
      | undefined;
    const resolveApproval = vi.fn().mockResolvedValue({});
    const client = {
      on: vi.fn(
        (
          kind: string,
          handler: (event: ReturnType<typeof approvalEvent>) => void,
        ) => {
          if (kind === "approval.requested") listener = handler;
        },
      ),
      resolveApproval,
    } as unknown as Client;

    controller.wireWorkflowClientApprovals(client, {
      client,
      sessionId: "session_workflow",
      accessMode: "ask",
      kind: "workflow",
      workflowRunId: "workflow_1",
    });
    expect(listener).toBeDefined();
    listener!(approvalEvent("approval_workflow"));
    expect(store.getSnapshot().pendingApproval?.id).toBe("approval_workflow");

    await controller.resolveApproval("allow-once");
    expect(resolveApproval).toHaveBeenCalledWith({
      approvalId: "approval_workflow",
      decision: "approved",
    });
  });

  it("remembers only after resolve succeeds and scopes rules by session", async () => {
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: "/workspace/project",
      initialSessionId: "session_a",
      store,
    });
    const resolveApproval = vi.fn().mockResolvedValue({});
    const client = { resolveApproval } as unknown as Client;

    deliver(controller, client, "session_a", approvalEvent("approval_1"));
    expect(store.getSnapshot().pendingApproval?.id).toBe("approval_1");
    await controller.resolveApproval("allow-session");
    expect(controller.listSessionApprovalRules()).toHaveLength(1);

    deliver(controller, client, "session_a", approvalEvent("approval_2"));
    await vi.waitFor(() => expect(resolveApproval).toHaveBeenCalledTimes(2));
    expect(resolveApproval.mock.calls[1]?.[0]).toMatchObject({
      approvalId: "approval_2",
      decision: "approved",
      autoApproved: true,
    });
    expect(store.getSnapshot().pendingApproval).toBeNull();

    deliver(controller, client, "session_b", approvalEvent("approval_3"));
    expect(store.getSnapshot().pendingApproval?.id).toBe("approval_3");
  });

  it("queues simultaneous approvals instead of replacing the visible prompt", async () => {
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: "/workspace/project",
      initialSessionId: "session_a",
      store,
    });
    const client = {
      resolveApproval: vi.fn().mockResolvedValue({}),
    } as unknown as Client;

    deliver(controller, client, "session_a", approvalEvent("approval_1"));
    deliver(controller, client, "session_a", approvalEvent("approval_2"));
    expect(store.getSnapshot().pendingApproval?.id).toBe("approval_1");

    await controller.resolveApproval("allow-once");
    expect(store.getSnapshot().pendingApproval?.id).toBe("approval_2");
  });

  it("auto-resolves an already queued request when the first decision creates its rule", async () => {
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: "/workspace/project",
      initialSessionId: "session_a",
      store,
    });
    const resolveApproval = vi.fn().mockResolvedValue({});
    const client = { resolveApproval } as unknown as Client;

    deliver(controller, client, "session_a", approvalEvent("approval_1"));
    deliver(controller, client, "session_a", approvalEvent("approval_2"));
    await controller.resolveApproval("allow-session");

    await vi.waitFor(() => expect(resolveApproval).toHaveBeenCalledTimes(2));
    expect(resolveApproval.mock.calls[1]?.[0]).toMatchObject({
      approvalId: "approval_2",
      autoApproved: true,
    });
    expect(store.getSnapshot().pendingApproval).toBeNull();
  });

  it("does not retain a rule when resolving fails", async () => {
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: "/workspace/project",
      initialSessionId: "session_a",
      store,
    });
    const client = {
      resolveApproval: vi.fn().mockRejectedValue(new Error("disconnected")),
    } as unknown as Client;

    deliver(controller, client, "session_a", approvalEvent("approval_1"));
    await controller.resolveApproval("allow-session");

    expect(controller.listSessionApprovalRules()).toHaveLength(0);
    expect(store.getSnapshot().pendingApproval?.id).toBe("approval_1");
  });

  it("keeps concurrent workflow permission modes isolated", async () => {
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: "/workspace/project",
      initialSessionId: "session_main",
      store,
    });
    const askClient = {
      resolveApproval: vi.fn().mockResolvedValue({}),
    } as unknown as Client;
    const bypassClient = {
      resolveApproval: vi.fn().mockResolvedValue({}),
    } as unknown as Client;

    deliver(
      controller,
      askClient,
      "session_workflow_ask",
      approvalEvent("approval_ask"),
      "ask",
      "workflow_ask",
    );
    deliver(
      controller,
      bypassClient,
      "session_workflow_bypass",
      approvalEvent("approval_bypass"),
      "bypass",
      "workflow_bypass",
    );

    expect(store.getSnapshot().pendingApproval?.id).toBe("approval_ask");
    await vi.waitFor(() =>
      expect(bypassClient.resolveApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalId: "approval_bypass",
          decision: "approved",
          autoApproved: true,
        }),
      ),
    );
    expect(askClient.resolveApproval).not.toHaveBeenCalled();
  });

  it("removes only approvals owned by a disconnected client and is idempotent", () => {
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: "/workspace/project",
      initialSessionId: "session_main",
      store,
    });
    const first = { resolveApproval: vi.fn() } as unknown as Client;
    const second = { resolveApproval: vi.fn() } as unknown as Client;
    const third = { resolveApproval: vi.fn() } as unknown as Client;

    deliver(controller, first, "session_1", approvalEvent("approval_1"));
    deliver(controller, second, "session_2", approvalEvent("approval_2"));
    deliver(controller, third, "session_3", approvalEvent("approval_3"));

    cleanup(controller, third);
    expect(store.getSnapshot().pendingApproval?.id).toBe("approval_1");
    cleanup(controller, first);
    expect(store.getSnapshot().pendingApproval?.id).toBe("approval_2");
    cleanup(controller, first);
    expect(store.getSnapshot().pendingApproval?.id).toBe("approval_2");
  });

  it("binds a pending approval to its immutable execution identity", () => {
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: "/workspace/project",
      initialSessionId: "session_main",
      store,
    });
    const client = { resolveApproval: vi.fn() } as unknown as Client;
    const event = approvalEvent("approval_identity");
    event.payload.runId = "run_episode_2";

    deliver(
      controller,
      client,
      "session_job",
      event,
      "accept-edits",
      "workflow_job",
    );

    const active = (
      controller as unknown as {
        activeApproval: {
          execution: Record<string, unknown>;
        };
      }
    ).activeApproval;
    expect(active.execution).toMatchObject({
      client,
      sessionId: "session_job",
      accessMode: "accept-edits",
      kind: "workflow",
      workflowRunId: "workflow_job",
      runId: "run_episode_2",
    });
    expect(Object.isFrozen(active.execution)).toBe(true);
  });
});
