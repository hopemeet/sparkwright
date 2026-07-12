import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileWorkflowStore,
  type WorkflowRunId,
} from "@sparkwright/agent-runtime";
import { describe, expect, it } from "vitest";
import {
  aggregateAssetObservations,
  agentObservationFromMetadata,
  classifyAssetIdentityChange,
  collectAssetStats,
  workflowObservationFromRunRecord,
} from "../src/asset-stats.js";

const agentIdentity = {
  artifactKind: "agent" as const,
  layer: "project",
  logicalName: "reviewer",
  packageHashPolicyVersion: 2 as const,
  packageHash: "sha256:agent-v2",
};

describe("asset stats", () => {
  it("uses event-time Agent metadata without reading a current file", () => {
    const observation = agentObservationFromMetadata({
      event: "agent.spawn",
      runId: "run_1",
      sessionId: "session_1",
      metadata: { agentAssetIdentity: agentIdentity },
    });
    expect(observation).toMatchObject({
      identity: agentIdentity,
      runId: "run_1",
    });
    expect(
      agentObservationFromMetadata({
        event: "agent.delegate",
        metadata: {
          agentAssetIdentity: { ...agentIdentity, packageHashPolicyVersion: 3 },
        },
      }),
    ).toBeUndefined();
  });

  it("keeps v1 and v2 identity-policy buckets separate", () => {
    const report = aggregateAssetObservations([
      {
        identity: { ...agentIdentity, packageHashPolicyVersion: 1 },
        event: "agent.spawn",
      },
      { identity: agentIdentity, event: "agent.delegate", state: "completed" },
    ]);
    expect(report.observationsScanned).toBe(2);
    expect(report.entries).toHaveLength(2);
    expect(
      classifyAssetIdentityChange(
        { ...agentIdentity, packageHashPolicyVersion: 1 },
        agentIdentity,
      ),
    ).toBe("policy_changed");
    expect(
      classifyAssetIdentityChange(agentIdentity, {
        ...agentIdentity,
        packageHash: "sha256:next",
      }),
    ).toBe("content_changed");
    expect(
      classifyAssetIdentityChange(
        { ...agentIdentity, packageHashPolicyVersion: 1 },
        { ...agentIdentity, packageHash: "sha256:next" },
      ),
    ).toBe("both_changed");
  });

  it("derives Workflow observations from the durable pinned record", () => {
    const observation = workflowObservationFromRunRecord(
      {
        id: "workflow_1",
        schemaVersion: "sparkwright-workflow-run.v1",
        assetName: "release",
        layer: "user",
        contentHash: "legacy",
        packageHash: "sha256:workflow-v2",
        packageHashPolicyVersion: 2,
        runIds: [],
        status: "completed",
        attempts: {},
        evidenceRefs: [],
        verdictLog: [],
        transitionLog: [],
        resume: { verifyOnResume: true },
        metadata: {},
        createdAt: "2026-07-12T00:00:00.000Z",
      } as never,
      "workflow.usage",
    );
    expect(observation).toMatchObject({
      event: "workflow.usage",
      identity: {
        artifactKind: "workflow",
        layer: "user",
        packageHash: "sha256:workflow-v2",
      },
    });
    expect(observation).not.toHaveProperty("state");
  });

  it("collects Workflow projections from the production durable store", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "asset-stats-workspace-"),
    );
    const sessionRootDir = join(workspaceRoot, ".sparkwright", "sessions");
    const store = new FileWorkflowStore({
      rootDir: join(workspaceRoot, ".sparkwright", "workflow-runs"),
    });
    const id = "workflow_stats" as WorkflowRunId;
    const writer = await store.acquireWriter(id, { owner: "test" });
    const created = await writer!.create({
      id,
      assetName: "release",
      layer: "user",
      contentHash: "legacy",
      packageHash: "sha256:workflow-v2",
      packageHashPolicyVersion: 2,
      packageSnapshotRef: join(workspaceRoot, "snapshot"),
      attempts: { build: 2 },
      metadata: { workflowUsage: { modelCalls: 1 } },
    });
    await writer!.mutate({
      expectedRevision: created.recordRevision!,
      patch: { status: "completed" },
      event: {
        at: new Date().toISOString(),
        type: "completed",
        workflowRunId: id,
        status: "completed",
      },
    });
    await writer!.release();
    const report = await collectAssetStats({
      workspaceRoot,
      sessionRootDir,
      artifactKind: "workflow",
    });
    expect(report).toMatchObject({
      workflowRecordsScanned: 1,
      observationsScanned: 4,
      errors: [],
    });
    expect(report.entries[0]?.identity).toMatchObject({
      artifactKind: "workflow",
      layer: "user",
      logicalName: "release",
    });
    expect(report.entries[0]).toMatchObject({ completed: 1, failed: 0 });
  });
});
