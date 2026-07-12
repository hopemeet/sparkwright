import { useState } from "react";
import type { CapabilitySnapshot } from "@sparkwright/protocol";
import {
  createCapability,
  type CreateCapabilityDraft,
} from "../lib/create-capability.js";
import {
  createKindFromRest,
  type CapabilityView,
} from "../lib/layer-payload.js";
import { formatWorkspaceDisplayPath } from "../lib/path-display.js";
import type { RunController } from "./run-controller.js";
import type { LayerStack } from "./layer-stack.js";
import type { ToastStore } from "./toast-store.js";

/**
 * The capability browser + creation flow: the panel snapshot state and the
 * handlers that open it, open the create dialog, and commit a new capability.
 * Lifted out of App so the component carries wiring, not the inspect/create
 * plumbing.
 */
export interface CapabilityActions {
  capabilitySnapshot: CapabilitySnapshot | null;
  loadingCapabilities: boolean;
  openCapabilities: (view?: CapabilityView) => Promise<void>;
  openCreateCapability: (rest?: string) => void;
  handleCreateCapability: (draft: CreateCapabilityDraft) => void;
}

export function useCapabilityActions(deps: {
  workspaceRoot: string;
  controller: RunController;
  toasts: ToastStore;
  layers: LayerStack;
  onSkillProposalPrepared?: () => void;
}): CapabilityActions {
  const { workspaceRoot, controller, toasts, layers } = deps;
  const [capabilitySnapshot, setCapabilitySnapshot] =
    useState<CapabilitySnapshot | null>(null);
  const [loadingCapabilities, setLoadingCapabilities] = useState(false);

  async function openCapabilities(view: CapabilityView = "all"): Promise<void> {
    setLoadingCapabilities(true);
    layers.push("capabilities", { view });
    const snapshot = await controller.inspectCapabilities();
    setLoadingCapabilities(false);
    if (snapshot) setCapabilitySnapshot(snapshot);
  }

  function openCreateCapability(rest = ""): void {
    const kind = createKindFromRest(rest);
    if (rest.trim() && !kind) {
      toasts.push({
        variant: "error",
        title: "create",
        message: "use /create skill|agent|cron|command|mcp",
      });
      return;
    }
    layers.push("create", { kind });
  }

  function handleCreateCapability(draft: CreateCapabilityDraft): void {
    void (async () => {
      try {
        const result = await createCapability(draft, workspaceRoot);
        layers.pop("create");
        toasts.push({
          variant: "success",
          title: result.kind === "skill" ? "prepared" : "created",
          message: result.path
            ? `${result.message} · ${formatWorkspaceDisplayPath(result.path, {
                workspaceRoot,
                maxCols: 72,
              })}`
            : result.message,
        });
        if (result.kind === "skill") deps.onSkillProposalPrepared?.();
        const snapshot = await controller.inspectCapabilities();
        if (snapshot) setCapabilitySnapshot(snapshot);
      } catch (error) {
        toasts.push({
          variant: "error",
          title: "create failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }

  return {
    capabilitySnapshot,
    loadingCapabilities,
    openCapabilities,
    openCreateCapability,
    handleCreateCapability,
  };
}
