import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { WorkflowRunSnapshot } from "@sparkwright/protocol";
import { runFailureMessage } from "@sparkwright/protocol";
import type { RunController } from "./run-controller.js";
import type { WorkflowJobHandle } from "./run-controller.js";
import type { EventStore } from "./event-store.js";
import type { LayerStack } from "./layer-stack.js";
import type { ToastStore } from "./toast-store.js";
import { formatWorkflowListNotice } from "../lib/workflow-display.js";

export interface WorkflowActions {
  workflows: WorkflowRunSnapshot[];
  loadingWorkflows: boolean;
  waitingWorkflowCount: number;
  selectedWorkflowId: string | undefined;
  ownedWorkflowRunIds: ReadonlySet<string>;
  ownedRunIds: ReadonlySet<string>;
  refreshWorkflows: () => Promise<WorkflowRunSnapshot[]>;
  listWorkflows: () => Promise<void>;
  attachWorkflow: (id: string) => Promise<void>;
  selectWorkflow: (id: string) => void;
  startWorkflow: (rest: string) => Promise<void>;
  resumeWorkflow: (id: string) => Promise<void>;
  stopWorkflow: (id: string) => Promise<void>;
}

export function useWorkflowActions(deps: {
  controller: RunController;
  store: EventStore;
  toasts: ToastStore;
  layers: LayerStack;
  layerOpen: boolean;
  enableBackgroundRefresh?: boolean;
}): WorkflowActions {
  const {
    controller,
    store,
    toasts,
    layers,
    layerOpen,
    enableBackgroundRefresh = true,
  } = deps;
  const [workflows, setWorkflows] = useState<WorkflowRunSnapshot[]>([]);
  const [loadingWorkflows, setLoadingWorkflows] = useState(false);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<
    string | undefined
  >(undefined);
  const [ownedJobs, setOwnedJobs] = useState<Record<string, OwnedWorkflowJob>>(
    {},
  );
  const ownedJobsRef = useRef(ownedJobs);

  async function refreshWorkflows(): Promise<WorkflowRunSnapshot[]> {
    setLoadingWorkflows(true);
    try {
      const next = await controller.listWorkflowRuns({ limit: 100 });
      setWorkflows(next);
      if (
        selectedWorkflowId &&
        !next.some((workflow) => workflow.id === selectedWorkflowId)
      ) {
        setSelectedWorkflowId(undefined);
      }
      return next;
    } finally {
      setLoadingWorkflows(false);
    }
  }

  async function listWorkflows(): Promise<void> {
    const next = await refreshWorkflows();
    store.appendNotice(formatWorkflowListNotice(next));
  }

  async function attachWorkflow(id: string): Promise<void> {
    const trimmed = id.trim();
    if (!trimmed) {
      toasts.push({
        variant: "info",
        message: "usage: /workflow attach <id>",
      });
      return;
    }
    const next = await refreshWorkflows();
    const match = next.find(
      (workflow) => workflow.id === trimmed || workflow.id.endsWith(trimmed),
    );
    if (!match) {
      toasts.push({
        variant: "warning",
        title: "workflow not found",
        message: trimmed,
      });
      return;
    }
    setSelectedWorkflowId(match.id);
    layers.push("workflow", { workflowId: match.id });
  }

  async function startWorkflow(rest: string): Promise<void> {
    const parsed = parseWorkflowStartArgs(rest);
    if (!parsed) {
      toasts.push({
        variant: "info",
        title: "workflow",
        message: "usage: /workflow start <name> <goal...> [--stay]",
      });
      return;
    }
    const handle = await controller.startWorkflowJob({
      workflowName: parsed.workflowName,
      goal: parsed.goal,
    });
    if (!handle) return;
    const now = Date.now();
    setOwnedJobs((current) => ({
      ...current,
      [handle.runId]: {
        runId: handle.runId,
        workflowName: parsed.workflowName,
        goal: parsed.goal,
        status: "connecting",
        handle,
        startedAt: now,
      },
    }));
    store.appendNotice(
      `workflow start: ${parsed.workflowName} · run ${handle.runId}`,
    );
    wireWorkflowJob(handle, {
      workflowName: parsed.workflowName,
      store,
      toasts,
      setOwnedJobs,
      refreshWorkflows,
      focus: parsed.focus,
      layers,
      setSelectedWorkflowId,
    });
  }

  async function resumeWorkflow(id: string): Promise<void> {
    const trimmed = id.trim();
    if (!trimmed) {
      toasts.push({
        variant: "info",
        message: "usage: /workflow resume <id>",
      });
      return;
    }
    const next = await refreshWorkflows();
    const workflow = next.find(
      (item) =>
        item.id === trimmed ||
        item.id.endsWith(trimmed) ||
        item.activeRunId === trimmed ||
        item.runIds.includes(trimmed),
    );
    if (!workflow) {
      toasts.push({
        variant: "warning",
        title: "workflow not found",
        message: trimmed,
      });
      return;
    }
    if (!workflow.authorizationSnapshot) {
      toasts.push({
        variant: "warning",
        title: "resume blocked",
        message: "record has no authorization snapshot",
      });
      return;
    }
    const handle = await controller.resumeWorkflowJob({ workflow });
    if (!handle) return;
    setOwnedJobs((current) => ({
      ...current,
      [handle.runId]: {
        runId: handle.runId,
        workflowRunId: workflow.id,
        workflowName: workflow.assetName,
        goal: `Resume workflow ${workflow.assetName}`,
        status: "running",
        handle,
        startedAt: Date.now(),
      },
    }));
    store.appendNotice(
      `workflow resume: ${workflow.assetName} · ${workflow.id}`,
    );
    wireWorkflowJob(handle, {
      workflowName: workflow.assetName,
      store,
      toasts,
      setOwnedJobs,
      refreshWorkflows,
      focus: true,
      layers,
      setSelectedWorkflowId,
    });
    setSelectedWorkflowId(workflow.id);
    layers.push("workflow", { workflowId: workflow.id });
  }

  async function stopWorkflow(id: string): Promise<void> {
    const onlyLiveOwned = Object.values(ownedJobs).filter(
      (job) => job.status === "connecting" || job.status === "running",
    );
    const trimmed =
      id.trim() ||
      selectedWorkflowId ||
      (onlyLiveOwned.length === 1
        ? (onlyLiveOwned[0]?.workflowRunId ?? onlyLiveOwned[0]?.runId ?? "")
        : "");
    if (!trimmed) {
      toasts.push({
        variant: "info",
        message: "usage: /workflow stop [id]",
      });
      return;
    }
    const next = await refreshWorkflows();
    const workflow = findWorkflowByIdOrRun(next, trimmed);
    const liveJob = findOwnedLiveJob({
      ownedJobs,
      workflow,
      id: trimmed,
    });
    if (!workflow && !liveJob) {
      toasts.push({
        variant: "warning",
        title: "workflow not found",
        message: trimmed,
      });
      return;
    }
    if (
      !liveJob ||
      workflow?.status === "waiting" ||
      liveJob.status === "waiting" ||
      liveJob.status === "completed" ||
      liveJob.status === "failed" ||
      liveJob.status === "cancelled"
    ) {
      store.appendNotice(
        `workflow stop not available for ${workflow?.id ?? trimmed}: not in the current live connection; resume it or stop it from the owner`,
      );
      return;
    }
    try {
      await liveJob.handle.client.cancelRun({
        runId: liveJob.runId,
        reason: "workflow stop",
      });
      store.appendNotice(
        `workflow stop requested: ${workflow?.id ?? liveJob.workflowRunId ?? liveJob.runId} (stopping is terminal and cannot be resumed)`,
      );
    } catch (error) {
      store.appendNotice(
        `workflow stop failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function selectWorkflow(id: string): void {
    setSelectedWorkflowId(id);
  }

  useEffect(() => {
    ownedJobsRef.current = ownedJobs;
  }, [ownedJobs]);

  useEffect(() => {
    return () => {
      for (const job of Object.values(ownedJobsRef.current)) {
        if (job.status === "connecting" || job.status === "running") {
          job.handle.close();
        }
      }
    };
  }, []);

  useEffect(() => {
    if (!enableBackgroundRefresh) return;
    let cancelled = false;
    const interval = setInterval(() => {
      if (!cancelled) void refreshWorkflows().then(() => undefined);
    }, 5000);
    void refreshWorkflows().then(() => undefined);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [enableBackgroundRefresh]);

  useEffect(() => {
    if (!enableBackgroundRefresh) return;
    if (!layerOpen) return;
    let cancelled = false;
    const tick = (): void => {
      void refreshWorkflows().then(() => undefined);
    };
    const interval = setInterval(() => {
      if (!cancelled) tick();
    }, 2000);
    tick();
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [enableBackgroundRefresh, layerOpen, selectedWorkflowId]);

  const waitingWorkflowCount = useMemo(() => {
    const waitingWorkflowIds = new Set(
      workflows
        .filter((workflow) => workflow.status === "waiting")
        .map((workflow) => workflow.id),
    );
    let count = waitingWorkflowIds.size;
    for (const job of Object.values(ownedJobs)) {
      if (job.status !== "waiting") continue;
      if (job.workflowRunId && waitingWorkflowIds.has(job.workflowRunId)) {
        continue;
      }
      count += 1;
    }
    return count;
  }, [ownedJobs, workflows]);
  const ownedWorkflowRunIds = useMemo(
    () =>
      new Set(
        Object.values(ownedJobs)
          .map((job) => job.workflowRunId)
          .filter((id): id is string => Boolean(id)),
      ),
    [ownedJobs],
  );
  const ownedRunIds = useMemo(
    () => new Set(Object.keys(ownedJobs)),
    [ownedJobs],
  );

  return {
    workflows,
    loadingWorkflows,
    waitingWorkflowCount,
    selectedWorkflowId,
    ownedWorkflowRunIds,
    ownedRunIds,
    refreshWorkflows,
    listWorkflows,
    attachWorkflow,
    selectWorkflow,
    startWorkflow,
    resumeWorkflow,
    stopWorkflow,
  };
}

export type OwnedWorkflowJobStatus =
  | "connecting"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "disconnected";

export interface OwnedWorkflowJob {
  runId: string;
  workflowRunId?: string;
  workflowName: string;
  goal: string;
  status: OwnedWorkflowJobStatus;
  handle: WorkflowJobHandle;
  startedAt: number;
}

function parseWorkflowStartArgs(
  rest: string,
): { workflowName: string; goal: string; focus: boolean } | null {
  const words = rest.trim().split(/\s+/).filter(Boolean);
  let focus = true;
  const flags = new Set(["--stay", "--no-focus"]);
  const filtered = words.filter((word) => {
    if (!flags.has(word)) return true;
    focus = false;
    return false;
  });
  if (filtered[0] === "start") filtered.shift();
  const workflowName = filtered.shift();
  const goal = filtered.join(" ").trim();
  if (!workflowName || !goal) return null;
  return { workflowName, goal, focus };
}

export function findWorkflowByIdOrRun(
  workflows: readonly WorkflowRunSnapshot[],
  id: string,
): WorkflowRunSnapshot | undefined {
  return workflows.find(
    (item) =>
      item.id === id ||
      item.id.endsWith(id) ||
      item.activeRunId === id ||
      Boolean(item.activeRunId?.endsWith(id)) ||
      item.runIds.includes(id) ||
      item.runIds.some((runId) => runId.endsWith(id)),
  );
}

export function findOwnedLiveJob(input: {
  ownedJobs: Record<string, OwnedWorkflowJob>;
  workflow?: WorkflowRunSnapshot;
  id: string;
}): OwnedWorkflowJob | undefined {
  return Object.values(input.ownedJobs).find((job) => {
    if (job.status !== "connecting" && job.status !== "running") return false;
    if (job.runId === input.id || job.runId.endsWith(input.id)) return true;
    if (
      job.workflowRunId &&
      (job.workflowRunId === input.id || job.workflowRunId.endsWith(input.id))
    ) {
      return true;
    }
    if (!input.workflow) return false;
    return (
      job.workflowRunId === input.workflow.id ||
      (input.workflow.activeRunId &&
        job.runId === input.workflow.activeRunId) ||
      input.workflow.runIds.includes(job.runId)
    );
  });
}

function wireWorkflowJob(
  handle: WorkflowJobHandle,
  deps: {
    workflowName: string;
    store: EventStore;
    toasts: ToastStore;
    setOwnedJobs: Dispatch<SetStateAction<Record<string, OwnedWorkflowJob>>>;
    refreshWorkflows: () => Promise<WorkflowRunSnapshot[]>;
    focus: boolean;
    layers: LayerStack;
    setSelectedWorkflowId: (id: string | undefined) => void;
  },
): void {
  let closing = false;
  const update = (patch: Partial<OwnedWorkflowJob>): void => {
    deps.setOwnedJobs((current) => {
      const existing = current[handle.runId];
      if (!existing) return current;
      return { ...current, [handle.runId]: { ...existing, ...patch } };
    });
  };
  const adoptWorkflowRunId = (workflowRunId: string): void => {
    update({ workflowRunId, status: "running" });
    if (deps.focus) {
      deps.setSelectedWorkflowId(workflowRunId);
      deps.layers.push("workflow", { workflowId: workflowRunId });
    }
    void deps.refreshWorkflows();
  };
  handle.client.on("run.event", (event) => {
    const runEvent = event.payload.event as {
      type?: string;
      payload?: Record<string, unknown>;
    };
    const payload = runEvent.payload ?? {};
    const workflowRunId =
      typeof payload.workflowRunId === "string"
        ? payload.workflowRunId
        : undefined;
    if (workflowRunId) adoptWorkflowRunId(workflowRunId);
    if (runEvent.type === "workflow.started") {
      deps.store.appendNotice(
        `workflow ${deps.workflowName} started${workflowRunId ? ` · ${workflowRunId}` : ""}`,
      );
    } else if (runEvent.type === "workflow.node.started") {
      const nodeId =
        typeof payload.nodeId === "string" ? payload.nodeId : undefined;
      deps.store.appendNotice(
        `workflow ${deps.workflowName} node ${nodeId ?? "started"}`,
      );
    } else if (runEvent.type === "workflow.waiting") {
      update({ status: "waiting" });
      const wait = payload.wait as { kind?: unknown; reason?: unknown };
      deps.store.appendNotice(
        `workflow ${deps.workflowName} waiting: ${String(wait?.kind ?? "input")}${typeof wait?.reason === "string" ? ` · ${wait.reason}` : ""}`,
      );
      void deps.refreshWorkflows();
    }
  });
  handle.client.on("run.completed", (event) => {
    void deps.refreshWorkflows().then((workflows) => {
      const record = workflows.find(
        (workflow) =>
          workflow.activeRunId === handle.runId ||
          workflow.runIds.includes(handle.runId),
      );
      const state = event.payload.state;
      const status =
        record?.status ??
        (state === "cancelled"
          ? "cancelled"
          : state === "failed"
            ? "failed"
            : "completed");
      update({ status });
      deps.store.appendNotice(
        record?.status === "waiting"
          ? `workflow ${deps.workflowName} waiting for resume`
          : `workflow ${deps.workflowName} ${status}${event.payload.stopReason ? `: ${event.payload.stopReason}` : ""}`,
      );
      closing = true;
      handle.close();
    });
  });
  handle.client.on("run.failed", (event) => {
    update({ status: "failed" });
    deps.store.appendNotice(
      `workflow ${deps.workflowName} failed: ${runFailureMessage(event.payload)}`,
    );
    closing = true;
    handle.close();
    void deps.refreshWorkflows();
  });
  handle.client.on("disconnect", (reason) => {
    if (closing) return;
    update({ status: "disconnected" });
    if (reason) {
      deps.store.appendNotice(
        `workflow ${deps.workflowName} disconnected: ${reason}`,
      );
    }
  });
}
