import { useEffect, useMemo, useState } from "react";
import type { WorkflowRunSnapshot } from "@sparkwright/protocol";
import type { RunController } from "./run-controller.js";
import type { EventStore } from "./event-store.js";
import type { LayerStack } from "./layer-stack.js";
import type { ToastStore } from "./toast-store.js";
import { formatWorkflowListNotice } from "../lib/workflow-display.js";

export interface WorkflowActions {
  workflows: WorkflowRunSnapshot[];
  loadingWorkflows: boolean;
  waitingWorkflowCount: number;
  selectedWorkflowId: string | undefined;
  refreshWorkflows: () => Promise<WorkflowRunSnapshot[]>;
  listWorkflows: () => Promise<void>;
  attachWorkflow: (id: string) => Promise<void>;
  selectWorkflow: (id: string) => void;
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

  return {
    workflows,
    loadingWorkflows,
    waitingWorkflowCount,
    selectedWorkflowId,
    refreshWorkflows,
    listWorkflows,
    attachWorkflow,
    selectWorkflow,
  };
}
