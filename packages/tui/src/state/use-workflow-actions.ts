import { useEffect, useMemo, useState } from "react";
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
}

export function useWorkflowActions(deps: {
  controller: RunController;
  store: EventStore;
  toasts: ToastStore;
  layers: LayerStack;
  layerOpen: boolean;
}): WorkflowActions {
  const { controller, store, toasts, layers, layerOpen } = deps;
  const [workflows, setWorkflows] = useState<WorkflowRunSnapshot[]>([]);
  const [loadingWorkflows, setLoadingWorkflows] = useState(false);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<
    string | undefined
  >(undefined);
  const [ownedJobs, setOwnedJobs] = useState<Record<string, OwnedWorkflowJob>>(
    {},
  );

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
      (workflow) =>
        workflow.id === trimmed || workflow.id.endsWith(trimmed),
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
      (item) => item.id === trimmed || item.id.endsWith(trimmed),
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

  function selectWorkflow(id: string): void {
    setSelectedWorkflowId(id);
  }

  useEffect(() => {
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
  }, [layerOpen, selectedWorkflowId]);

  const waitingWorkflowCount = useMemo(
    () => workflows.filter((workflow) => workflow.status === "waiting").length,
    [workflows],
  );
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
  };
}

type OwnedWorkflowJobStatus =
  | "connecting"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "disconnected";

interface OwnedWorkflowJob {
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
      deps.store.appendNotice(`workflow ${deps.workflowName} disconnected: ${reason}`);
    }
  });
}
