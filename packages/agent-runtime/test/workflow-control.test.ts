import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileWorkflowControlInbox,
  FileWorkflowStore,
  WorkflowControlCommandProcessor,
  WORKFLOW_CONTROL_SCHEMA_VERSION,
  type WorkflowControlCommandEnvelope,
  type WorkflowRunId,
} from "../src/index.js";

const workflowRunId = "workflow_control" as WorkflowRunId;

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sparkwright-workflow-control-"));
}

function workflowPin() {
  const packageSnapshotRef = `/snapshots/${workflowRunId}`;
  const packageHash = "sha256:workflow-control";
  return {
    assetName: "control",
    layer: "project" as const,
    packageHash,
    packageHashPolicyVersion: 2 as const,
    packageSnapshotRef,
    definitionSnapshot: {
      assetName: "control",
      sourceDir: packageSnapshotRef,
      layer: "project" as const,
      packageHash,
      packageHashPolicyVersion: 2 as const,
      packageSnapshotRef,
      nodes: [{ id: "main", body: "Control." }],
    },
  };
}

function envelope(
  overrides: Partial<WorkflowControlCommandEnvelope> = {},
): WorkflowControlCommandEnvelope {
  return {
    schemaVersion: WORKFLOW_CONTROL_SCHEMA_VERSION,
    workflowRunId,
    commandId: "workflow_command_one",
    idempotencyKey: "key-one",
    source: {
      kind: "cli",
      principalId: "user-one",
      authenticatedBy: "host-test",
    },
    authorization: {
      workspaceId: "workspace-one",
      workflowRunId,
      allowedCommandKinds: ["cancel"],
    },
    expected: { generation: 1, status: "running" },
    command: { kind: "cancel", reason: "test" },
    createdAt: "2026-07-11T00:00:00.000Z",
    expiresAt: "2099-07-11T23:00:00.000Z",
    ...overrides,
  };
}

describe("FileWorkflowControlInbox", () => {
  it("accepts once and deduplicates the same scoped payload", async () => {
    const root = await tempDir();
    const inbox = new FileWorkflowControlInbox({ rootDir: root });
    const first = await inbox.accept(envelope());
    const duplicate = await inbox.accept(
      envelope({ commandId: "workflow_command_retry" }),
    );

    expect(first).toMatchObject({ status: "accepted" });
    expect(duplicate).toMatchObject({
      status: "duplicate",
      envelope: { commandId: "workflow_command_one" },
    });
    expect(inbox.pending(workflowRunId)).toHaveLength(1);
  });

  it("rejects a different payload under the same idempotency scope", async () => {
    const root = await tempDir();
    const inbox = new FileWorkflowControlInbox({ rootDir: root });
    await inbox.accept(envelope());
    const conflict = await inbox.accept(
      envelope({
        commandId: "workflow_command_conflict",
        command: { kind: "cancel", reason: "different" },
      }),
    );
    expect(conflict).toEqual({
      status: "conflict",
      commandId: "workflow_command_one",
      code: "idempotency_conflict",
    });
  });

  it("allows one winner for concurrent duplicate acceptance", async () => {
    const root = await tempDir();
    const inboxA = new FileWorkflowControlInbox({ rootDir: root });
    const inboxB = new FileWorkflowControlInbox({ rootDir: root });
    const results = await Promise.all([
      inboxA.accept(envelope()),
      inboxB.accept(envelope({ commandId: "workflow_command_two" })),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "accepted",
      "duplicate",
    ]);
    expect(inboxA.pending(workflowRunId)).toHaveLength(1);
  });

  it("rejects external system identity and unauthorized command kinds", async () => {
    const root = await tempDir();
    const inbox = new FileWorkflowControlInbox({ rootDir: root });
    await expect(
      inbox.accept(
        envelope({
          source: {
            kind: "system",
            principalId: "fake",
            authenticatedBy: "external",
          },
        }),
      ),
    ).rejects.toThrow(/cannot claim system identity/);
    await expect(
      inbox.accept(
        envelope({
          commandId: "workflow_command_input",
          command: { kind: "provide_input", waitId: "wait-one", value: "yes" },
        }),
      ),
    ).rejects.toThrow(/not authorized/);
  });

  it("persists immutable outcomes and rebuilds pending state after restart", async () => {
    const root = await tempDir();
    const inbox = new FileWorkflowControlInbox({ rootDir: root });
    await inbox.accept(envelope());
    const outcome = {
      schemaVersion: "sparkwright-workflow-control-outcome.v1" as const,
      workflowRunId,
      commandId: "workflow_command_one",
      status: "rejected" as const,
      code: "expired",
      completedAt: "2026-07-11T02:00:00.000Z",
    };
    await inbox.recordOutcome(outcome);
    await inbox.recordOutcome(outcome);
    await writeFile(
      join(root, `${workflowRunId}.control`, "cursor.json"),
      "{torn",
      "utf8",
    );

    const reopened = new FileWorkflowControlInbox({
      rootDir: root,
      createRoot: false,
    });
    expect(reopened.pending(workflowRunId)).toEqual([]);
    expect(await reopened.outcome(workflowRunId, outcome.commandId)).toEqual(
      outcome,
    );
  });

  it("isolates a corrupt command without wedging later pending commands", async () => {
    const root = await tempDir();
    const inbox = new FileWorkflowControlInbox({ rootDir: root });
    await inbox.accept(envelope());
    await writeFile(
      join(
        root,
        `${workflowRunId}.control`,
        "commands",
        "workflow_command_bad.json",
      ),
      "{torn",
      "utf8",
    );
    const snapshot = inbox.snapshot(workflowRunId);
    expect(snapshot.commands).toHaveLength(1);
    expect(snapshot.invalidEntries).toEqual([
      expect.objectContaining({ code: "invalid_json" }),
    ]);
    expect(inbox.pending(workflowRunId)).toHaveLength(1);
  });
});

describe("WorkflowControlCommandProcessor", () => {
  it("applies cancel through the fenced workflow writer", async () => {
    const root = await tempDir();
    const store = new FileWorkflowStore({ rootDir: root });
    const creator = await store.acquireWriter(workflowRunId, {
      owner: "creator",
    });
    const record = await creator!.create({
      id: workflowRunId,
      ...workflowPin(),
    });
    await creator!.release();
    const inbox = new FileWorkflowControlInbox({ rootDir: root });
    await inbox.accept(
      envelope({ expected: { generation: record.generation! } }),
    );
    const processor = new WorkflowControlCommandProcessor({
      inbox,
      store,
      workspaceId: "workspace-one",
    });

    const result = await processor.processNext(workflowRunId);

    expect(result).toMatchObject({
      status: "terminal",
      outcome: { status: "applied" },
    });
    expect(store.get(workflowRunId)).toMatchObject({
      status: "cancelled",
      metadata: { controlCommandId: "workflow_command_one" },
    });
    expect(inbox.pending(workflowRunId)).toEqual([]);
  });

  it("durably stages input without letting the producer choose context role", async () => {
    const root = await tempDir();
    const store = new FileWorkflowStore({ rootDir: root });
    const creator = await store.acquireWriter(workflowRunId, {
      owner: "creator",
    });
    const created = await creator!.create({
      id: workflowRunId,
      ...workflowPin(),
    });
    const waiting = await creator!.mutate({
      expectedRevision: created.recordRevision!,
      patch: {
        status: "waiting",
        wait: { kind: "input", reason: "Need input" },
      },
      event: {
        at: "2026-07-11T00:00:00.000Z",
        type: "waiting",
        workflowRunId,
        status: "waiting",
      },
    });
    await creator!.release();
    const inbox = new FileWorkflowControlInbox({ rootDir: root });
    await inbox.accept(
      envelope({
        commandId: "workflow_command_input",
        idempotencyKey: "input-one",
        authorization: {
          workspaceId: "workspace-one",
          workflowRunId,
          allowedCommandKinds: ["provide_input"],
        },
        expected: {
          generation: waiting.generation!,
          status: "waiting",
          waitId: waiting.wait!.id,
        },
        command: {
          kind: "provide_input",
          waitId: waiting.wait!.id!,
          value: "approved input",
        },
      }),
    );
    const processor = new WorkflowControlCommandProcessor({
      inbox,
      store,
      workspaceId: "workspace-one",
    });

    await processor.processNext(workflowRunId);

    expect(store.get(workflowRunId)).toMatchObject({
      status: "waiting",
      wait: { id: waiting.wait!.id, kind: "input" },
      metadata: {
        pendingWorkflowControlInput: {
          commandId: "workflow_command_input",
          value: "approved input",
        },
      },
    });
  });

  it("rejects expired and stale-generation commands with immutable outcomes", async () => {
    const root = await tempDir();
    const store = new FileWorkflowStore({ rootDir: root });
    const creator = await store.acquireWriter(workflowRunId, {
      owner: "creator",
    });
    await creator!.create({
      id: workflowRunId,
      ...workflowPin(),
    });
    await creator!.release();
    const inbox = new FileWorkflowControlInbox({ rootDir: root });
    await inbox.accept(envelope());
    const processor = new WorkflowControlCommandProcessor({
      inbox,
      store,
      workspaceId: "workspace-one",
      now: () => new Date("2100-07-12T00:00:00.000Z"),
    });
    const result = await processor.processNext(workflowRunId);
    expect(result).toMatchObject({
      status: "terminal",
      outcome: { status: "rejected", code: "expired" },
    });
  });

  it("recovers an applied outcome from canonical workflow event metadata", async () => {
    const root = await tempDir();
    const store = new FileWorkflowStore({ rootDir: root });
    const writer = await store.acquireWriter(workflowRunId, {
      owner: "crashed-consumer",
    });
    const created = await writer!.create({
      id: workflowRunId,
      ...workflowPin(),
    });
    const inbox = new FileWorkflowControlInbox({ rootDir: root });
    await inbox.accept(
      envelope({ expected: { generation: created.generation! } }),
    );
    await writer!.mutate({
      expectedRevision: created.recordRevision!,
      patch: {
        status: "cancelled",
        metadata: { controlCommandId: "workflow_command_one" },
      },
      event: {
        at: "2026-07-11T00:01:00.000Z",
        type: "cancelled",
        workflowRunId,
        status: "cancelled",
        metadata: { controlCommandId: "workflow_command_one" },
      },
    });
    await writer!.release();
    const processor = new WorkflowControlCommandProcessor({
      inbox,
      store,
      workspaceId: "workspace-one",
    });

    const recovered = await processor.processNext(workflowRunId);

    expect(recovered).toMatchObject({
      status: "terminal",
      outcome: { status: "applied", code: "recovered_applied" },
    });
    expect(store.get(workflowRunId)?.recordRevision).toBe(2);
  });

  it("applies a durably linked approval response", async () => {
    const root = await tempDir();
    const store = new FileWorkflowStore({ rootDir: root });
    const creator = await store.acquireWriter(workflowRunId, {
      owner: "creator",
    });
    const created = await creator!.create({
      id: workflowRunId,
      ...workflowPin(),
      authorizationSnapshot: {
        confidentialPaths: [],
        confidentialDefaults: true,
        accessMode: "read-only",
        backgroundTasks: "foreground-only",
      },
    });
    const waiting = await creator!.mutate({
      expectedRevision: created.recordRevision!,
      patch: {
        status: "waiting",
        wait: { kind: "approval", approvalId: "approval-one" },
      },
      event: {
        at: "2026-07-11T00:00:00.000Z",
        type: "waiting",
        workflowRunId,
        status: "waiting",
      },
    });
    await creator!.release();
    const inbox = new FileWorkflowControlInbox({ rootDir: root });
    await inbox.accept(
      envelope({
        commandId: "workflow_command_approval",
        idempotencyKey: "approval-one",
        authorization: {
          workspaceId: "workspace-one",
          workflowRunId,
          allowedCommandKinds: ["approval_response"],
        },
        expected: {
          generation: waiting.generation!,
          status: "waiting",
          waitId: waiting.wait!.id,
        },
        command: {
          kind: "approval_response",
          approvalId: "approval-one",
          decision: "approved",
        },
      }),
    );
    const processor = new WorkflowControlCommandProcessor({
      inbox,
      store,
      workspaceId: "workspace-one",
    });

    const result = await processor.processNext(workflowRunId);

    expect(result).toMatchObject({
      status: "terminal",
      outcome: { status: "applied" },
    });
    expect(store.get(workflowRunId)).toMatchObject({
      status: "running",
      wait: undefined,
      metadata: {
        workflowApprovalDecision: { approvalId: "approval-one" },
      },
    });
  });

  it("rejects approval responses without a durable authorization snapshot", async () => {
    const root = await tempDir();
    const store = new FileWorkflowStore({ rootDir: root });
    const creator = await store.acquireWriter(workflowRunId, {
      owner: "creator",
    });
    const created = await creator!.create({
      id: workflowRunId,
      ...workflowPin(),
    });
    const waiting = await creator!.mutate({
      expectedRevision: created.recordRevision!,
      patch: {
        status: "waiting",
        wait: { kind: "approval", approvalId: "approval-one" },
      },
      event: {
        at: "2026-07-11T00:00:00.000Z",
        type: "waiting",
        workflowRunId,
        status: "waiting",
      },
    });
    await creator!.release();
    const inbox = new FileWorkflowControlInbox({ rootDir: root });
    await inbox.accept(
      envelope({
        commandId: "workflow_command_approval",
        idempotencyKey: "approval-one",
        authorization: {
          workspaceId: "workspace-one",
          workflowRunId,
          allowedCommandKinds: ["approval_response"],
        },
        expected: {
          generation: waiting.generation!,
          status: "waiting",
          waitId: waiting.wait!.id,
        },
        command: {
          kind: "approval_response",
          approvalId: "approval-one",
          decision: "approved",
        },
      }),
    );

    const result = await new WorkflowControlCommandProcessor({
      inbox,
      store,
      workspaceId: "workspace-one",
    }).processNext(workflowRunId);

    expect(result).toMatchObject({
      status: "terminal",
      outcome: {
        status: "rejected",
        code: "approval_authorization_missing",
      },
    });
    expect(store.get(workflowRunId)).toMatchObject({
      status: "waiting",
      wait: { approvalId: "approval-one" },
    });
  });

  it("lets only one of two consumers mutate the workflow", async () => {
    const root = await tempDir();
    const storeA = new FileWorkflowStore({ rootDir: root });
    const creator = await storeA.acquireWriter(workflowRunId, {
      owner: "creator",
    });
    const record = await creator!.create({
      id: workflowRunId,
      ...workflowPin(),
    });
    await creator!.release();
    const inboxA = new FileWorkflowControlInbox({ rootDir: root });
    await inboxA.accept(
      envelope({ expected: { generation: record.generation! } }),
    );
    const inboxB = new FileWorkflowControlInbox({ rootDir: root });
    const processorA = new WorkflowControlCommandProcessor({
      inbox: inboxA,
      store: storeA,
      workspaceId: "workspace-one",
      owner: "consumer-a",
    });
    const processorB = new WorkflowControlCommandProcessor({
      inbox: inboxB,
      store: new FileWorkflowStore({ rootDir: root }),
      workspaceId: "workspace-one",
      owner: "consumer-b",
    });

    const results = await Promise.all([
      processorA.processNext(workflowRunId),
      processorB.processNext(workflowRunId),
    ]);

    expect(
      results.filter(
        (result) =>
          result.status === "terminal" && result.outcome.status === "applied",
      ),
    ).toHaveLength(1);
    const reopened = new FileWorkflowStore({
      rootDir: root,
      createRoot: false,
    });
    expect(reopened.get(workflowRunId)).toMatchObject({
      status: "cancelled",
      recordRevision: 2,
    });
    expect(
      reopened
        .eventLog(workflowRunId)
        .events.filter(
          (event) =>
            event.metadata?.controlCommandId === "workflow_command_one",
        ),
    ).toHaveLength(1);
  });
});
