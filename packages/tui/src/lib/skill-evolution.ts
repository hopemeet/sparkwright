import {
  createSkillUpdateProposal,
  existingSkillRoots,
  SkillCommandService,
  listSkillProposals,
  loadHostConfig,
  readSkillProposal,
  rejectSkillProposal,
  resolveSkillRootsForRuntime,
  type SkillProposalDetail,
  type SkillProposalState,
  type SkillProposalSummary,
} from "@sparkwright/host";

export interface TuiSkillProposalInput {
  name: string;
  description: string;
}

export interface TuiSkillProposalResult {
  id: string;
  kind: string;
  skillName: string;
  state: string;
  path: string;
}

export interface TuiSkillReviewSummary {
  total: number;
  shown: SkillProposalSummary[];
  stateFilter?: SkillProposalState;
}

export type TuiSkillReviewItem = SkillProposalDetail;

export interface TuiSkillReviewDetail {
  total: number;
  items: TuiSkillReviewItem[];
  stateFilter?: SkillProposalState;
  proposalId?: string;
}

export interface TuiSkillReviewActionResult {
  id: string;
  state: string;
  skillName: string;
  historyId?: string;
}

export interface TuiSkillInboxAction {
  kind: "skill_proposal_review";
  proposalId: string;
  reviewCommand: string;
  eligibility: "review_required";
  validationStatus: "passed";
  contentMode?: string;
  guardSeverity: "none" | "caution" | "dangerous";
  recommendedAction: "review";
}

const REVIEW_STATES: readonly SkillProposalState[] = [
  "draft",
  "applied",
  "rejected",
  "stale",
  "superseded",
  "failed",
];

export function parseTuiSkillProposalInput(
  rest: string,
): TuiSkillProposalInput {
  const parts = rest.trim().split(/\s+/u).filter(Boolean);
  const name = parts.shift();
  if (!name || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error("usage: /skill-create <name> --description <text>");
  }

  const descriptionFlag = parts.indexOf("--description");
  const description =
    descriptionFlag >= 0
      ? parts.slice(descriptionFlag + 1).join(" ")
      : parts.join(" ");
  if (description.trim().length === 0) {
    throw new Error("description is required");
  }
  return { name, description: description.trim() };
}

export async function createTuiSkillProposal(
  workspaceRoot: string,
  rest: string,
): Promise<TuiSkillProposalResult> {
  const input = parseTuiSkillProposalInput(rest);
  return createTuiSkillProposalFromInput(workspaceRoot, input);
}

export async function createTuiSkillProposalFromInput(
  workspaceRoot: string,
  input: TuiSkillProposalInput,
): Promise<TuiSkillProposalResult> {
  const { proposal } = await new SkillCommandService(
    workspaceRoot,
  ).prepareCreate({
    name: input.name,
    description: input.description,
  });
  return {
    id: proposal.id,
    kind: proposal.kind,
    skillName: proposal.skillName,
    state: proposal.state,
    path: proposal.path,
  };
}

export async function updateTuiSkillProposal(
  workspaceRoot: string,
  rest: string,
): Promise<TuiSkillProposalResult> {
  const input = parseTuiSkillProposalInput(rest);
  return updateTuiSkillProposalFromInput(workspaceRoot, input);
}

export async function updateTuiSkillProposalFromInput(
  workspaceRoot: string,
  input: TuiSkillProposalInput,
): Promise<TuiSkillProposalResult> {
  const loaded = await loadHostConfig(workspaceRoot, process.env);
  const roots = await existingSkillRoots(
    resolveSkillRootsForRuntime(
      workspaceRoot,
      loaded.config.capabilities?.skills?.roots,
      process.env,
    ),
  );
  const proposal = await createSkillUpdateProposal({
    workspaceRoot,
    skillRoots: roots,
    name: input.name,
    description: input.description,
  });
  return {
    id: proposal.id,
    kind: proposal.kind,
    skillName: proposal.skillName,
    state: proposal.state,
    path: proposal.path,
  };
}

export async function reviewTuiSkillProposals(
  workspaceRoot: string,
  rest: string,
  limit = 5,
): Promise<TuiSkillReviewSummary> {
  const target = parseTuiSkillReviewTarget(rest);
  if (target.kind === "proposal") {
    const proposal = await readSkillProposal(workspaceRoot, target.proposalId);
    return { total: 1, shown: [proposal] };
  }
  const stateFilter = target.kind === "state" ? target.state : undefined;
  const proposals = await listSkillProposals(workspaceRoot);
  const filtered = stateFilter
    ? proposals.filter((proposal) => proposal.state === stateFilter)
    : proposals;
  return {
    total: filtered.length,
    shown: filtered.slice(0, limit),
    ...(stateFilter ? { stateFilter } : {}),
  };
}

export async function loadTuiSkillReview(
  workspaceRoot: string,
  rest: string,
  limit = 20,
): Promise<TuiSkillReviewDetail> {
  const target = parseTuiSkillReviewTarget(rest);
  if (target.kind === "proposal") {
    const proposal = await readSkillProposal(workspaceRoot, target.proposalId);
    return {
      total: 1,
      items: [proposal],
      proposalId: target.proposalId,
    };
  }
  const stateFilter = target.kind === "state" ? target.state : undefined;
  const proposals = await listSkillProposals(workspaceRoot);
  const filtered = stateFilter
    ? proposals.filter((proposal) => proposal.state === stateFilter)
    : proposals;
  const shown = filtered.slice(0, limit);
  const items = await Promise.all(
    shown.map((proposal) => readSkillProposal(workspaceRoot, proposal.id)),
  );
  return {
    total: filtered.length,
    items,
    ...(stateFilter ? { stateFilter } : {}),
  };
}

/**
 * Proposal files are the persistent inbox. Restore the newest open draft as a
 * small completion-card affordance; the full inbox remains `/skill-review`.
 */
export async function loadTuiSkillInboxAction(
  workspaceRoot: string,
): Promise<TuiSkillInboxAction | null> {
  const proposals = await listSkillProposals(workspaceRoot);
  const latest = proposals
    .filter((proposal) => proposal.state === "draft")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!latest) return null;
  const proposal = await readSkillProposal(workspaceRoot, latest.id);
  const guardSeverity = proposal.guardFindings?.some(
    (finding) => finding.severity === "dangerous",
  )
    ? "dangerous"
    : (proposal.guardFindings?.length ?? 0) > 0
      ? "caution"
      : "none";
  return {
    kind: "skill_proposal_review",
    proposalId: proposal.id,
    reviewCommand: `/skill-review ${proposal.id}`,
    eligibility: "review_required",
    validationStatus: "passed",
    contentMode: proposal.contentMode,
    guardSeverity,
    recommendedAction: "review",
  };
}

export function formatTuiSkillProposalResult(
  result: TuiSkillProposalResult,
): string {
  return `${result.kind} ${result.skillName} -> ${result.id}`;
}

export function formatTuiSkillReviewSummary(
  summary: TuiSkillReviewSummary,
): string {
  const header = summary.stateFilter
    ? `${summary.total} ${summary.stateFilter} proposal(s)`
    : `${summary.total} proposal(s)`;
  if (summary.shown.length === 0) return header;
  return [
    header,
    ...summary.shown.map(
      (proposal) =>
        `${proposal.id}: ${proposal.state} ${proposal.kind} ${proposal.skillName}${formatProposalContentSuffix(proposal)}`,
    ),
  ].join("\n");
}

function formatProposalContentSuffix(
  proposal: Pick<SkillProposalSummary, "contentMode">,
): string {
  switch (proposal.contentMode) {
    case "intent_stub":
      return " [intent-only]";
    case "template":
      return " [template]";
    default:
      return "";
  }
}

export async function applyTuiSkillReviewProposal(
  workspaceRoot: string,
  proposalId: string,
): Promise<TuiSkillReviewActionResult> {
  const { applied } = await new SkillCommandService(
    workspaceRoot,
  ).approveAndApply(proposalId);
  return {
    id: applied.proposal.id,
    state: applied.proposal.state,
    skillName: applied.proposal.skillName,
    historyId: applied.history.id,
  };
}

export async function rejectTuiSkillReviewProposal(
  workspaceRoot: string,
  proposalId: string,
): Promise<TuiSkillReviewActionResult> {
  const rejected = await rejectSkillProposal({
    workspaceRoot,
    proposalId,
    reason: "Rejected from TUI skill review.",
  });
  return {
    id: rejected.id,
    state: rejected.state,
    skillName: rejected.skillName,
  };
}

export type TuiSkillReviewTarget =
  | { kind: "all" }
  | { kind: "state"; state: SkillProposalState }
  | { kind: "proposal"; proposalId: string };

export function parseTuiSkillReviewTarget(rest: string): TuiSkillReviewTarget {
  const value = rest.trim();
  if (!value) return { kind: "all" };
  if (/^skillprop_[a-z0-9]+$/u.test(value)) {
    return { kind: "proposal", proposalId: value };
  }
  const normalized = value.startsWith("--state ")
    ? value.slice("--state ".length).trim()
    : value;
  if (!REVIEW_STATES.includes(normalized as SkillProposalState)) {
    throw new Error(
      `usage: /skill-review [proposal-id|${REVIEW_STATES.join("|")}]`,
    );
  }
  return { kind: "state", state: normalized as SkillProposalState };
}
