import { useState } from "react";
import { formatWorkspaceDisplayPath } from "../lib/path-display.js";
import {
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
  applySkillLearnDraftProposal,
  createSkillLearnDraftProposal,
  detectSkillLearnNotice,
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
  openSkillUpdateProposal: (rest?: string) => void;
  handleUpdateSkillProposal: (draft: TuiSkillProposalInput) => void;
  reviewSkillProposalsFromSlash: (rest: string) => void;
  applySkillReviewProposal: (proposalId: string) => Promise<boolean>;
  rejectSkillReviewProposal: (proposalId: string) => void;
  handleSkillLearn: (rest?: string) => void;
}

export function useSkillActions(deps: {
  workspaceRoot: string;
  toasts: ToastStore;
  layers: LayerStack;
  reloadConfig: (verbose: boolean) => void;
  onProposalClosed?: (proposalId: string) => void;
  onProposalPrepared?: () => void;
}): SkillActions {
  const { workspaceRoot, toasts, layers, reloadConfig } = deps;
  const [skillReviewSnapshot, setSkillReviewSnapshot] =
    useState<TuiSkillReviewDetail | null>(null);
  const [loadingSkillReview, setLoadingSkillReview] = useState(false);
  const [skillReviewRest, setSkillReviewRest] = useState("");

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

  async function applySkillReviewProposal(
    proposalId: string,
  ): Promise<boolean> {
    try {
      const result = await applyTuiSkillReviewProposal(
        workspaceRoot,
        proposalId,
      );
      toasts.push({
        variant: "success",
        title: "skill proposal applied",
        message: `${result.id} -> ${result.historyId ?? "history"}`,
        durationMs: 7000,
      });
      deps.onProposalClosed?.(proposalId);
      refreshSkillReview();
      return true;
    } catch (error) {
      toasts.push({
        variant: "error",
        title: "skill proposal apply failed",
        message: error instanceof Error ? error.message : String(error),
        durationMs: 9000,
      });
      return false;
    }
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
        deps.onProposalClosed?.(proposalId);
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
    openSkillUpdateProposal,
    handleUpdateSkillProposal,
    reviewSkillProposalsFromSlash,
    applySkillReviewProposal,
    rejectSkillReviewProposal,
    handleSkillLearn,
  };
}

/**
 * On run completion, inspect the session's goals for a Skill-learning signal
 * and, depending on the project's skill-learn mode, surface a notice / draft a
 * proposal / apply it automatically. Extracted verbatim from App's
 * run-completion effect; the `sessionId` guard mirrors the original captured
 * value (the effect closure compared the captured id to itself), so a stale
 * async resolve is a no-op just as before.
 */
export function runSkillLearnAutoNotice(deps: {
  workspaceRoot: string;
  toasts: ToastStore;
  goals: string[];
  sessionId: string | null;
  noticeCount: number;
  setNoticeCount: (n: number) => void;
}): void {
  const {
    workspaceRoot,
    toasts,
    goals,
    sessionId,
    noticeCount,
    setNoticeCount,
  } = deps;
  const notice = detectSkillLearnNotice(goals);
  if (!notice || goals.length <= noticeCount) return;
  const goalCount = goals.length;
  void readSkillLearnStatus(workspaceRoot)
    .then((status) => {
      if (status.mode === "off") return;
      if (status.mode === "notice") {
        setNoticeCount(goalCount);
        toasts.push({
          variant: "info",
          title: "skill learn",
          message: `${notice.reason}. Run /create skill or /skill-update <skill-name>.`,
          durationMs: 9000,
        });
        return;
      }
      void createSkillLearnDraftProposal(workspaceRoot, notice, {
        ...(sessionId ? { sessionId } : {}),
      })
        .then((proposal) => {
          if (status.mode === "draft") {
            setNoticeCount(goalCount);
            toasts.push({
              variant: "success",
              title: "skill learn draft",
              message: `${proposal.kind} ${proposal.skillName} -> ${proposal.id}`,
              durationMs: 9000,
            });
            return;
          }
          void applySkillLearnDraftProposal(workspaceRoot, proposal)
            .then((applied) => {
              setNoticeCount(goalCount);
              // Apply mode writes automatically (the user opted in), so the
              // toast must be transparent: show what was learned, the version
              // written, and how to inspect/undo. (We point to `skills history`
              // rather than a `restore --version` one-liner: restoring to the
              // just-written version is a no-op, and the first apply has no
              // prior version.)
              const learned =
                notice.evidence.length > 80
                  ? `${notice.evidence.slice(0, 77)}...`
                  : notice.evidence;
              toasts.push({
                variant: "success",
                title: "skill learn applied",
                message: `learned "${learned}" → ${proposal.skillName} (v ${applied.historyId}). undo: skills history ${proposal.skillName}`,
                durationMs: 14000,
              });
            })
            .catch((error: unknown) => {
              setNoticeCount(goalCount);
              toasts.push({
                variant: "warning",
                title: "skill learn draft",
                message: `left draft ${proposal.id}: ${error instanceof Error ? error.message : String(error)}`,
                durationMs: 9000,
              });
            });
        })
        .catch((error: unknown) => {
          toasts.push({
            variant: "error",
            title: "skill learn draft failed",
            message: error instanceof Error ? error.message : String(error),
            durationMs: 9000,
          });
        });
    })
    .catch(() => {});
}
