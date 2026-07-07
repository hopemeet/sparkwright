import { useState } from "react";
import { formatWorkspaceDisplayPath } from "../lib/path-display.js";
import {
  createTuiSkillProposal,
  createTuiSkillProposalFromInput,
  applyTuiSkillReviewProposal,
  formatTuiSkillProposalResult,
  loadTuiSkillReview,
  rejectTuiSkillReviewProposal,
  type TuiSkillReviewDetail,
  type TuiSkillProposalInput,
  updateTuiSkillProposal,
  updateTuiSkillProposalFromInput,
} from "../lib/skill-evolution.js";
import {
  formatSkillLearnStatus,
  parseSkillLearnMode,
  readSkillLearnStatus,
  setProjectSkillLearnMode,
} from "../lib/skill-learn.js";
import type { LayerStack } from "./layer-stack.js";
import type { ToastStore } from "./toast-store.js";

/**
 * Skill Evolution actions (create / update / review / learn) plus the
 * skill-review panel state they drive. Lifted out of App so the component body
 * carries wiring, not the ~230 lines of near-identical then/catch → toast
 * plumbing these handlers are made of.
 *
 * Handlers are plain per-render closures (same as when they lived in App): they
 * always read the latest `deps`, and the values captured by the command
 * registry memo stay valid because every dep here (workspaceRoot, toasts,
 * layers, setters) is stable across renders.
 */
export interface SkillActions {
  /** Live skill-review snapshot for the review dialog. */
  skillReviewSnapshot: TuiSkillReviewDetail | null;
  /** Whether the review snapshot is loading. */
  loadingSkillReview: boolean;
  openSkillCreateProposal: (rest?: string) => void;
  handleCreateSkillProposal: (draft: TuiSkillProposalInput) => void;
  openSkillUpdateProposal: (rest?: string) => void;
  handleUpdateSkillProposal: (draft: TuiSkillProposalInput) => void;
  reviewSkillProposalsFromSlash: (rest: string) => void;
  applySkillReviewProposal: (proposalId: string) => void;
  rejectSkillReviewProposal: (proposalId: string) => void;
  handleSkillLearn: (rest?: string) => void;
}

export function useSkillActions(deps: {
  workspaceRoot: string;
  toasts: ToastStore;
  layers: LayerStack;
  reloadConfig: (verbose: boolean) => void;
}): SkillActions {
  const { workspaceRoot, toasts, layers, reloadConfig } = deps;
  const [skillReviewSnapshot, setSkillReviewSnapshot] =
    useState<TuiSkillReviewDetail | null>(null);
  const [loadingSkillReview, setLoadingSkillReview] = useState(false);
  const [skillReviewRest, setSkillReviewRest] = useState("");

  function createSkillProposalFromSlash(rest: string): void {
    void createTuiSkillProposal(workspaceRoot, rest)
      .then((proposal) => {
        toasts.push({
          variant: "success",
          title: "skill proposal",
          message: formatTuiSkillProposalResult(proposal),
        });
      })
      .catch((error: unknown) => {
        toasts.push({
          variant: "error",
          title: "/skill-create failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  function openSkillCreateProposal(rest = ""): void {
    if (rest.trim().length > 0) {
      createSkillProposalFromSlash(rest);
      return;
    }
    layers.push("skill-create");
  }

  function handleCreateSkillProposal(draft: TuiSkillProposalInput): void {
    void createTuiSkillProposalFromInput(workspaceRoot, draft)
      .then((proposal) => {
        layers.pop("skill-create");
        toasts.push({
          variant: "success",
          title: "skill proposal",
          message: formatTuiSkillProposalResult(proposal),
        });
      })
      .catch((error: unknown) => {
        toasts.push({
          variant: "error",
          title: "/skill-create failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  function updateSkillProposalFromSlash(rest: string): void {
    void updateTuiSkillProposal(workspaceRoot, rest)
      .then((proposal) => {
        toasts.push({
          variant: "success",
          title: "skill proposal",
          message: formatTuiSkillProposalResult(proposal),
        });
      })
      .catch((error: unknown) => {
        toasts.push({
          variant: "error",
          title: "/skill-update failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  function openSkillUpdateProposal(rest = ""): void {
    const trimmed = rest.trim();
    if (!trimmed) {
      layers.push("skill-update");
      return;
    }
    if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(trimmed)) {
      layers.push("skill-update", { name: trimmed });
      return;
    }
    updateSkillProposalFromSlash(rest);
  }

  function handleUpdateSkillProposal(draft: TuiSkillProposalInput): void {
    void updateTuiSkillProposalFromInput(workspaceRoot, draft)
      .then((proposal) => {
        layers.pop("skill-update");
        toasts.push({
          variant: "success",
          title: "skill proposal",
          message: formatTuiSkillProposalResult(proposal),
        });
      })
      .catch((error: unknown) => {
        toasts.push({
          variant: "error",
          title: "/skill-update failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  function reviewSkillProposalsFromSlash(rest: string): void {
    setSkillReviewRest(rest);
    setLoadingSkillReview(true);
    setSkillReviewSnapshot(null);
    layers.push("skill-review");
    void loadTuiSkillReview(workspaceRoot, rest)
      .then((review) => {
        setSkillReviewSnapshot(review);
        setLoadingSkillReview(false);
      })
      .catch((error: unknown) => {
        setLoadingSkillReview(false);
        toasts.push({
          variant: "error",
          title: "/skill-review failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  function refreshSkillReview(): void {
    setLoadingSkillReview(true);
    void loadTuiSkillReview(workspaceRoot, skillReviewRest)
      .then((review) => {
        setSkillReviewSnapshot(review);
        setLoadingSkillReview(false);
      })
      .catch((error: unknown) => {
        setLoadingSkillReview(false);
        toasts.push({
          variant: "error",
          title: "/skill-review refresh failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  function applySkillReviewProposal(proposalId: string): void {
    void applyTuiSkillReviewProposal(workspaceRoot, proposalId)
      .then((result) => {
        toasts.push({
          variant: "success",
          title: "skill proposal applied",
          message: `${result.id} -> ${result.historyId ?? "history"}`,
          durationMs: 7000,
        });
        refreshSkillReview();
      })
      .catch((error: unknown) => {
        toasts.push({
          variant: "error",
          title: "skill proposal apply failed",
          message: error instanceof Error ? error.message : String(error),
          durationMs: 9000,
        });
      });
  }

  function rejectSkillReviewProposal(proposalId: string): void {
    void rejectTuiSkillReviewProposal(workspaceRoot, proposalId)
      .then((result) => {
        toasts.push({
          variant: "success",
          title: "skill proposal rejected",
          message: `${result.id} ${result.skillName}`,
          durationMs: 7000,
        });
        refreshSkillReview();
      })
      .catch((error: unknown) => {
        toasts.push({
          variant: "error",
          title: "skill proposal reject failed",
          message: error instanceof Error ? error.message : String(error),
          durationMs: 9000,
        });
      });
  }

  function handleSkillLearn(rest = ""): void {
    let mode: ReturnType<typeof parseSkillLearnMode>;
    try {
      mode = parseSkillLearnMode(rest);
    } catch (error) {
      toasts.push({
        variant: "error",
        title: "/skill-learn failed",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (!mode) {
      void readSkillLearnStatus(workspaceRoot)
        .then((status) => {
          toasts.push({
            variant: "info",
            title: "skill learn",
            message: formatSkillLearnStatus(status),
          });
        })
        .catch((error: unknown) => {
          toasts.push({
            variant: "error",
            title: "/skill-learn failed",
            message: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }

    void setProjectSkillLearnMode(workspaceRoot, mode)
      .then((result) => {
        toasts.push({
          variant: "success",
          title: "skill learn",
          message: `${result.mode} -> ${formatWorkspaceDisplayPath(
            result.path,
            {
              workspaceRoot,
              maxCols: 72,
            },
          )}`,
        });
        void reloadConfig(true);
      })
      .catch((error: unknown) => {
        toasts.push({
          variant: "error",
          title: "/skill-learn failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  return {
    skillReviewSnapshot,
    loadingSkillReview,
    openSkillCreateProposal,
    handleCreateSkillProposal,
    openSkillUpdateProposal,
    handleUpdateSkillProposal,
    reviewSkillProposalsFromSlash,
    applySkillReviewProposal,
    rejectSkillReviewProposal,
    handleSkillLearn,
  };
}
