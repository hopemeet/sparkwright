import type { WorkflowRunSnapshot } from "@sparkwright/protocol";
import { describe, expect, it } from "vitest";
import { workflowSnapshotsEqual } from "../src/state/use-workflow-actions.js";

function snapshot(
  id: string,
  status: "running" | "waiting",
): WorkflowRunSnapshot {
  return {
    id,
    status,
  } as WorkflowRunSnapshot;
}

describe("workflow background refresh", () => {
  it("recognizes an unchanged semantic snapshot", () => {
    expect(
      workflowSnapshotsEqual(
        [snapshot("workflow_a", "waiting")],
        [snapshot("workflow_a", "waiting")],
      ),
    ).toBe(true);
  });

  it("detects visible workflow changes and ordering changes", () => {
    expect(
      workflowSnapshotsEqual(
        [snapshot("workflow_a", "waiting")],
        [snapshot("workflow_a", "running")],
      ),
    ).toBe(false);
    expect(
      workflowSnapshotsEqual(
        [snapshot("workflow_a", "waiting"), snapshot("workflow_b", "running")],
        [snapshot("workflow_b", "running"), snapshot("workflow_a", "waiting")],
      ),
    ).toBe(false);
  });
});
