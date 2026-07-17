import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileWorkflowChannelStore,
  FileWorkflowControlInbox,
  FileWorkflowStore,
  WorkflowControlCommandProcessor,
  type WorkflowChannelBinding,
  type WorkflowRunId,
} from "../src/workflows/index.js";

const workflowRunId = "workflow_channel_test" as WorkflowRunId;
const now = new Date("2026-07-11T00:00:00.000Z");

function binding(
  overrides: Partial<Omit<WorkflowChannelBinding, "schemaVersion">> = {},
) {
  return {
    bindingId: "workflow_binding_test",
    workspaceId: "/workspace/a",
    workflowRunId,
    sessionId: "session_workflow_channel",
    source: {
      kind: "im" as const,
      principalId: "user:1",
      authenticatedBy: "telegram:webhook",
      channelId: "telegram:chat:1",
    },
    allowedCommandKinds: ["provide_input" as const],
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    ...overrides,
  };
}

describe("workflow durable channels", () => {
  it("publishes immutable scoped bindings and rejects conflicting reuse", async () => {
    const store = new FileWorkflowChannelStore({
      rootDir: await mkdtemp(join(tmpdir(), "sw-channels-")),
      now: () => now,
    });
    const first = await store.bind(binding());
    expect(await store.bind(binding())).toEqual(first);
    await expect(
      store.bind(binding({ workspaceId: "/workspace/b" })),
    ).rejects.toThrow("binding conflict");
    expect(store.activeBindings(workflowRunId)).toEqual([first]);
  });

  it("enforces source, workspace, session, command scope, expiry and revoke before D accept", async () => {
    let clock = now;
    const rootDir = await mkdtemp(join(tmpdir(), "sw-channels-"));
    const store = new FileWorkflowChannelStore({
      rootDir,
      now: () => clock,
    });
    const bound = await store.bind(binding());
    const inbox = new FileWorkflowControlInbox({ rootDir });
    const base = {
      inbox,
      bindingId: bound.bindingId,
      workflowRunId,
      workspaceId: bound.workspaceId,
      sessionId: bound.sessionId,
      source: bound.source,
      idempotencyKey: "response-1",
      expected: { generation: 1, status: "waiting" as const, waitId: "wait-1" },
      command: {
        kind: "provide_input" as const,
        waitId: "wait-1",
        value: "yes",
      },
      expiresAt: new Date(now.getTime() + 30_000).toISOString(),
    };
    expect(await store.acceptControl(base)).toMatchObject({
      status: "accepted",
    });
    await expect(
      store.acceptControl({
        ...base,
        idempotencyKey: "response-2",
        command: { kind: "cancel" },
      }),
    ).rejects.toThrow("command kind is not authorized");
    await expect(
      store.acceptControl({
        ...base,
        idempotencyKey: "response-3",
        source: { ...bound.source, principalId: "attacker" },
      }),
    ).rejects.toThrow("source identity mismatch");
    await store.revoke({ workflowRunId, bindingId: bound.bindingId });
    await expect(
      store.acceptControl({ ...base, idempotencyKey: "response-4" }),
    ).rejects.toThrow("binding is revoked");

    const expiring = await store.bind(
      binding({
        bindingId: "workflow_binding_expiring",
        expiresAt: new Date(now.getTime() + 1).toISOString(),
      }),
    );
    clock = new Date(now.getTime() + 2);
    await expect(
      store.acceptControl({
        ...base,
        bindingId: expiring.bindingId,
        source: expiring.source,
        idempotencyKey: "response-5",
      }),
    ).rejects.toThrow("binding is expired");
  });

  it("routes duplicate adapter responses into Package D scoped idempotency", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sw-channels-"));
    const store = new FileWorkflowChannelStore({ rootDir, now: () => now });
    const bound = await store.bind(binding());
    const inbox = new FileWorkflowControlInbox({ rootDir });
    const response = {
      inbox,
      bindingId: bound.bindingId,
      workflowRunId,
      workspaceId: bound.workspaceId,
      sessionId: bound.sessionId,
      source: bound.source,
      idempotencyKey: "webhook-message-1",
      expected: { generation: 1, status: "waiting" as const, waitId: "wait-1" },
      command: {
        kind: "provide_input" as const,
        waitId: "wait-1",
        value: "yes",
      },
      expiresAt: new Date(now.getTime() + 30_000).toISOString(),
    };
    const first = await store.acceptControl(response);
    const duplicate = await store.acceptControl(response);
    expect(first.status).toBe("accepted");
    expect(duplicate).toMatchObject({
      status: "duplicate",
      envelope: {
        commandId: first.status === "accepted" ? first.envelope.commandId : "",
      },
    });
    expect(inbox.pending(workflowRunId)).toHaveLength(1);
    await expect(
      store.acceptControl({
        ...response,
        command: { ...response.command, value: "changed" },
      }),
    ).resolves.toMatchObject({
      status: "conflict",
      code: "idempotency_conflict",
    });
  });

  it("gives two authorized channels one canonical approval winner", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sw-channels-"));
    const id = "workflow_channel_approval_race" as WorkflowRunId;
    const workflowStore = new FileWorkflowStore({ rootDir });
    const writer = await workflowStore.acquireWriter(id, { owner: "fixture" });
    if (!writer) throw new Error("missing workflow writer");
    const packageSnapshotRef = `/snapshots/${id}`;
    const packageHash = "sha256:approval-race";
    const created = await writer.create({
      id,
      sessionId: "session_workflow_approval_race",
      assetName: "approval-race",
      layer: "project",
      packageHash,
      packageHashPolicyVersion: 2,
      packageSnapshotRef,
      currentNodeId: "approval",
      authorizationSnapshot: {
        confidentialPaths: [],
        confidentialDefaults: true,
        accessMode: "ask",
        backgroundTasks: "enabled",
      },
      definitionSnapshot: {
        assetName: "approval-race",
        sourceDir: packageSnapshotRef,
        layer: "project",
        packageHash,
        packageHashPolicyVersion: 2,
        packageSnapshotRef,
        nodes: [{ id: "approval", body: "Approve." }],
      },
    });
    await writer.mutate({
      expectedRevision: created.recordRevision,
      patch: {
        status: "waiting",
        wait: {
          id: "wait-approval-1",
          kind: "approval",
          approvalId: "approval-1",
        },
      },
      event: {
        at: now.toISOString(),
        type: "waiting",
        workflowRunId: id,
        status: "waiting",
      },
    });
    await writer.release();
    const channels = new FileWorkflowChannelStore({ rootDir, now: () => now });
    const inbox = new FileWorkflowControlInbox({ rootDir });
    const accepted = [];
    for (const channel of ["a", "b"] as const) {
      const source = {
        kind: "im" as const,
        principalId: `user:${channel}`,
        authenticatedBy: "test-auth",
        channelId: `channel-${channel}`,
      };
      const bound = await channels.bind({
        bindingId: `workflow_binding_${channel}`,
        workspaceId: "/workspace/a",
        workflowRunId: id,
        sessionId: "session_workflow_approval_race",
        source,
        allowedCommandKinds: ["approval_response"],
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      });
      accepted.push(
        await channels.acceptControl({
          inbox,
          bindingId: bound.bindingId,
          workflowRunId: id,
          workspaceId: "/workspace/a",
          sessionId: "session_workflow_approval_race",
          source,
          idempotencyKey: `approval-response-${channel}`,
          expected: {
            generation: workflowStore.canonicalGeneration(id),
            status: "waiting",
            waitId: "wait-approval-1",
          },
          command: {
            kind: "approval_response",
            approvalId: "approval-1",
            decision: "approved",
          },
          expiresAt: new Date(now.getTime() + 30_000).toISOString(),
        }),
      );
    }
    const processor = new WorkflowControlCommandProcessor({
      inbox,
      store: workflowStore,
      workspaceId: "/workspace/a",
      now: () => now,
    });
    const commandIds = accepted.map((result) =>
      result.status === "conflict" ? "" : result.envelope.commandId,
    );
    expect(await processor.processNext(id, commandIds[0])).toMatchObject({
      status: "terminal",
      outcome: { status: "applied" },
    });
    expect(await processor.processNext(id, commandIds[1])).toMatchObject({
      status: "terminal",
      outcome: { status: "rejected", code: "stale_generation" },
    });
    expect(
      new FileWorkflowStore({ rootDir, createRoot: false }).get(id),
    ).toMatchObject({
      status: "running",
      wait: undefined,
    });
  });

  it("records immutable delivery receipts and rebuilds a corrupt cursor", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sw-channels-"));
    const store = new FileWorkflowChannelStore({ rootDir, now: () => now });
    const bound = await store.bind(binding());
    const receipt = {
      schemaVersion: "sparkwright-workflow-channel-delivery.v1" as const,
      bindingId: bound.bindingId,
      workflowRunId,
      notificationId: "notification_1",
      deliveryKey: `${bound.bindingId}:notification_1`,
      status: "delivered" as const,
      attemptedAt: now.toISOString(),
      transportMessageId: "telegram-message-1",
    };
    expect(await store.recordDelivery(receipt)).toEqual(receipt);
    expect(
      store.hasTerminalDelivery(
        workflowRunId,
        bound.bindingId,
        "notification_1",
      ),
    ).toBe(true);
    await writeFile(
      join(
        rootDir,
        `${workflowRunId}.channels`,
        "cursors",
        `${bound.bindingId}.json`,
      ),
      "{torn",
    );
    const second = {
      ...receipt,
      notificationId: "notification_2",
      deliveryKey: `${bound.bindingId}:notification_2`,
    };
    await store.recordDelivery(second);
    expect(store.snapshot(workflowRunId).deliveries).toHaveLength(2);
  });

  it("keeps failed delivery retryable while terminal receipts suppress redelivery", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sw-channels-"));
    const store = new FileWorkflowChannelStore({ rootDir, now: () => now });
    const bound = await store.bind(binding());
    await store.recordDelivery({
      schemaVersion: "sparkwright-workflow-channel-delivery.v1",
      bindingId: bound.bindingId,
      workflowRunId,
      notificationId: "notification_failed",
      deliveryKey: `${bound.bindingId}:notification_failed`,
      status: "failed",
      attemptedAt: now.toISOString(),
      error: "transport unavailable",
    });
    expect(
      store.hasTerminalDelivery(
        workflowRunId,
        bound.bindingId,
        "notification_failed",
      ),
    ).toBe(false);
    await store.recordDelivery({
      schemaVersion: "sparkwright-workflow-channel-delivery.v1",
      bindingId: bound.bindingId,
      workflowRunId,
      notificationId: "notification_failed",
      deliveryKey: `${bound.bindingId}:notification_failed`,
      status: "delivered",
      attemptedAt: new Date(now.getTime() + 1).toISOString(),
      transportMessageId: "retry-success",
    });
    expect(
      store.hasTerminalDelivery(
        workflowRunId,
        bound.bindingId,
        "notification_failed",
      ),
    ).toBe(true);
  });
});
