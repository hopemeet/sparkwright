import { describe, expect, it } from "vitest";
import {
  aggregateAssetObservations,
  agentObservationFromMetadata,
  classifyAssetIdentityChange,
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
      state: "completed",
      identity: { artifactKind: "workflow", packageHash: "sha256:workflow-v2" },
    });
  });
});
