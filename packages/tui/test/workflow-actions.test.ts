import { describe, expect, it } from "vitest";
import type { WorkflowRunSnapshot } from "@sparkwright/protocol";
import {
  findOwnedLiveJob,
  findWorkflowByIdOrRun,
  type OwnedWorkflowJob,
} from "../src/state/use-workflow-actions.js";

function workflow(input: {
  id: string;
  activeRunId?: string;
  runIds?: string[];
  status?: WorkflowRunSnapshot["status"];
}): WorkflowRunSnapshot {
  return {
    id: input.id,
    assetName: "wf",
    status: input.status ?? "running",
    contentHash: "hash",
    ...(input.activeRunId ? { activeRunId: input.activeRunId } : {}),
    runIds: input.runIds ?? [],
    attempts: {},
    resume: { verifyOnResume: true },
    createdAt: "2026-07-09T00:00:00.000Z",
  };
}

function ownedJob(input: {
  runId: string;
  workflowRunId?: string;
  status?: OwnedWorkflowJob["status"];
}): OwnedWorkflowJob {
  const workflowRunId = input.workflowRunId ?? "workflow_pending";
  const execution = {
    kind: "workflow" as const,
    sessionId: "session_workflow_test",
    permissionMode: "default" as const,
    runId: input.runId,
    workflowRunId,
  };
  return {
    runId: input.runId,
    ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
    workflowName: "wf",
    goal: "goal",
    status: input.status ?? "running",
    handle: {
      ...execution,
      execution,
      client: {} as OwnedWorkflowJob["handle"]["client"],
      close: () => {},
    },
    startedAt: 1,
  };
}

describe("workflow action helpers", () => {
  it("matches workflows by durable id, active run id, and historical run ids", () => {
    const workflows = [
      workflow({
        id: "workflow_one",
        activeRunId: "run_active_one",
        runIds: ["run_old_one"],
      }),
    ];

    expect(findWorkflowByIdOrRun(workflows, "workflow_one")?.id).toBe(
      "workflow_one",
    );
    expect(findWorkflowByIdOrRun(workflows, "active_one")?.id).toBe(
      "workflow_one",
    );
    expect(findWorkflowByIdOrRun(workflows, "run_old_one")?.id).toBe(
      "workflow_one",
    );
  });

  it("finds a connecting owned job by run id before a workflow record is adopted", () => {
    const job = ownedJob({ runId: "run_connecting", status: "connecting" });

    expect(
      findOwnedLiveJob({
        ownedJobs: { [job.runId]: job },
        id: "run_connecting",
      })?.runId,
    ).toBe("run_connecting");
  });
});
