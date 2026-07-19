import { describe, expect, it } from "vitest";
import type { WorkflowRunSnapshot } from "@sparkwright/protocol";
import {
  formatWorkflowListNotice,
  formatWorkflowSummary,
  latestWorkflowVerdict,
  shortWorkflowId,
} from "../src/lib/workflow-display.js";

describe("workflow display helpers", () => {
  it("formats empty workflow lists for scrollback", () => {
    expect(formatWorkflowListNotice([])).toBe(
      "workflow list: no workflow jobs found",
    );
  });

  it("summarizes waiting workflow snapshots", () => {
    expect(formatWorkflowSummary(waitingWorkflow())).toContain(
      "waiting release-check node=review wait=input:Need approval",
    );
  });

  it("formats latest verdict from the snapshot payload", () => {
    expect(latestWorkflowVerdict(waitingWorkflow())).toBe("review: passed");
  });

  it("shortens durable workflow ids to their useful suffix", () => {
    expect(shortWorkflowId("workflow_run_abcdefghijklmnopqrstuvwxyz")).toBe(
      "abcdefghijkl",
    );
  });
});

function waitingWorkflow(): WorkflowRunSnapshot {
  return {
    id: "workflow_run_abcdefghijklmnopqrstuvwxyz",
    generation: 1,
    recordRevision: 1,
    sessionId: "sess",
    status: "waiting",
    assetName: "release-check",
    layer: "project",
    packageHash: "sha256:release-check",
    packageHashPolicyVersion: 2,
    activeRunId: "run_123",
    runIds: ["run_123"],
    currentNodeId: "review",
    attempts: { review: 1 },
    latestVerdict: {
      nodeId: "review",
      attempt: 1,
      verdict: { status: "passed" },
    },
    wait: { kind: "input", reason: "Need approval" },
    resume: { verifyOnResume: true },
    createdAt: "2026-07-09T00:00:00.000Z",
    metadata: {},
  };
}
