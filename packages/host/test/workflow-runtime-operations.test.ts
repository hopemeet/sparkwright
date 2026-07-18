import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileWorkflowControlInbox,
  FileWorkflowNotificationOutbox,
  type WorkflowControlSourceIdentity,
  type WorkflowDefinition,
  type WorkflowRunId,
} from "@sparkwright/agent-runtime";
import { InFlightCommandDispatcher } from "@sparkwright/server-runtime";
import {
  WorkflowRuntimeOperations,
  type WorkflowControlExecutionPort,
} from "../src/runtime/workflow-runtime-operations.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("WorkflowRuntimeOperations", () => {
  it("owns canonical roots, list projection, and the shared actor inbox", async () => {
    const { operations, notifications } = await createOperations();
    const id = "workflow_operations_completed" as WorkflowRunId;
    const store = operations.createStore();
    const writer = await store.acquireWriter(id, { owner: "owner-test" });
    if (!writer) throw new Error("Could not acquire workflow writer.");
    let record = await writer.create({
      id,
      sessionId: "session_operations",
      ...workflowPin(id),
      currentNodeId: "main",
      attempts: { main: 1 },
      now: () => "2026-07-18T00:00:00.000Z",
    });
    record = await operations.mutate(writer, record, {
      status: "completed",
      completedAt: "2026-07-18T00:01:00.000Z",
      now: () => "2026-07-18T00:01:00.000Z",
    });
    await writer.release();

    operations.deliverNotification(record);
    const listed = await operations.list({ sessionId: "session_operations" });
    expect(listed).toMatchObject({
      ok: true,
      workflows: [
        {
          id,
          sessionId: "session_operations",
          status: "completed",
          packageHashPolicyVersion: 2,
        },
      ],
    });
    expect(operations.actorInbox()).toBe(notifications);
    expect(
      operations.actorInbox().drain((entry) => entry.source.id === id),
    ).toMatchObject([
      {
        type: "completed",
        correlationId: `${id}:completed`,
        payload: { workflowId: id },
      },
    ]);
    expect(operations.rootDir).toMatch(/\.sparkwright\/workflow-runs$/);
    expect(operations.notificationRootDir).toMatch(
      /\.sparkwright\/workflow-actors$/,
    );
  });

  it("accepts, dispatches, and deduplicates durable control without owning execution", async () => {
    const { operations } = await createOperations();
    const id = "workflow_operations_control" as WorkflowRunId;
    const store = operations.createStore();
    const writer = await store.acquireWriter(id, { owner: "owner-test" });
    if (!writer) throw new Error("Could not acquire workflow writer.");
    await writer.create({
      id,
      sessionId: "session_control",
      ...workflowPin(id),
      currentNodeId: "main",
      attempts: { main: 1 },
    });
    await writer.release();

    let resumeCalls = 0;
    const execution: WorkflowControlExecutionPort = {
      hasExecution: () => false,
      processActiveControls: async () => {},
      resume: async () => {
        resumeCalls += 1;
        throw new Error("cancel control must not enter live resume");
      },
    };
    const source: WorkflowControlSourceIdentity = {
      kind: "api",
      principalId: "owner-test",
      authenticatedBy: "test",
    };
    const first = await operations.control(
      {
        workflowRunId: id,
        sessionId: "session_control",
        idempotencyKey: "cancel-once",
        source,
        command: { kind: "cancel", reason: "owner-level-test" },
      },
      execution,
    );
    const duplicate = await operations.control(
      {
        workflowRunId: id,
        sessionId: "session_control",
        idempotencyKey: "cancel-once",
        source,
        command: { kind: "cancel", reason: "owner-level-test" },
      },
      execution,
    );
    const conflict = await operations.control(
      {
        workflowRunId: id,
        sessionId: "session_control",
        idempotencyKey: "cancel-once",
        source,
        command: { kind: "cancel", reason: "different-payload" },
      },
      execution,
    );

    expect(first).toMatchObject({
      ok: true,
      status: "applied",
      code: "applied",
    });
    expect(duplicate).toEqual(first);
    expect(conflict).toMatchObject({
      ok: false,
      error: { code: "invalid_payload" },
    });
    expect(store.get(id)).toMatchObject({
      status: "cancelled",
      failure: { message: "owner-level-test" },
    });
    expect(resumeCalls).toBe(0);
  });
});

async function createOperations(): Promise<{
  operations: WorkflowRuntimeOperations;
  notifications: FileWorkflowNotificationOutbox;
}> {
  const workspace = await mkdtemp(
    join(tmpdir(), "sparkwright-workflow-operations-"),
  );
  tempDirs.push(workspace);
  const notifications = new FileWorkflowNotificationOutbox({
    rootDir: join(workspace, ".sparkwright", "workflow-actors"),
  });
  const controls = new FileWorkflowControlInbox({
    rootDir: join(workspace, ".sparkwright", "workflow-runs"),
  });
  return {
    notifications,
    operations: new WorkflowRuntimeOperations({
      workspaceRoot: workspace,
      notifications,
      controls,
      dispatcher: new InFlightCommandDispatcher(),
    }),
  };
}

function workflowPin(
  id: WorkflowRunId,
  definition: WorkflowDefinition = {
    assetName: "owner-test",
    contentHash: "live-only",
    nodes: [{ id: "main", body: "Run." }],
  },
) {
  const { contentHash: _contentHash, ...executableDefinition } = definition;
  const packageSnapshotRef = `/snapshots/${id}`;
  const packageHash = `sha256:${id}`;
  return {
    assetName: definition.assetName,
    layer: "project" as const,
    packageHash,
    packageHashPolicyVersion: 2 as const,
    packageSnapshotRef,
    definitionSnapshot: {
      ...executableDefinition,
      sourceDir: packageSnapshotRef,
      layer: "project" as const,
      packageHash,
      packageHashPolicyVersion: 2 as const,
      packageSnapshotRef,
    },
  };
}
