import type { SkillRoot } from "@sparkwright/skills";
import {
  listSkillProposals,
  type SkillProposalContentMode,
  type SkillProposalKind,
  type SkillProposalState,
  type SkillProposalSummary,
} from "./skill-evolution.js";
import {
  collectSkillStats,
  type SkillStatsFinding,
  type SkillStatsFindingCode,
  type SkillStatsFindingRelation,
  type SkillStatsFindingSeverity,
  type SkillStatsFreshness,
  type SkillStatsOptions,
} from "./skill-stats.js";

export type SkillReviewDigestItemKind = "proposal" | "stats_finding";
export type SkillReviewDigestSeverity = SkillStatsFindingSeverity;

export interface SkillReviewDigestOptions {
  workspaceRoot: string;
  sessionRootDir: string;
  skillRoots: readonly SkillRoot[];
  limit?: number;
  skillName?: string;
  skillKey?: string;
  packageHash?: string;
  useProjectionCache?: boolean;
  projectionCacheDir?: string;
}

export interface SkillReviewDigestItem {
  id: string;
  kind: SkillReviewDigestItemKind;
  severity: SkillReviewDigestSeverity;
  relation?: SkillStatsFindingRelation;
  skillName: string;
  title: string;
  message: string;
  action: string;
  proposalId?: string;
  proposalKind?: SkillProposalKind;
  /** @reserved Public review-digest field consumed by CLI/TUI and downstream reviewers. */
  proposalState?: SkillProposalState;
  contentMode?: SkillProposalContentMode;
  findingCode?: SkillStatsFindingCode;
  evidence?: SkillStatsFinding["evidence"];
  createdAt?: string;
  updatedAt?: string;
}

export interface SkillReviewDigest {
  workspaceRoot: string;
  sessionRootDir: string;
  sessionLimit: number;
  generatedAt: string;
  freshness: SkillStatsFreshness;
  stats: {
    sessionsScanned: number;
    tracesScanned: number;
    findingsScanned: number;
  };
  proposals: {
    scanned: number;
    drafts: number;
    intentStubs: number;
    templates: number;
  };
  items: SkillReviewDigestItem[];
}

interface PrioritizedSkillReviewDigestItem extends SkillReviewDigestItem {
  priority: number;
}

const REVIEWABLE_STATS_FINDINGS: ReadonlySet<SkillStatsFindingCode> = new Set([
  "SKILL_LOAD_FAILURES",
  "ASSOCIATED_TOOL_FAILURES",
]);

export async function collectSkillReviewDigest(
  options: SkillReviewDigestOptions,
): Promise<SkillReviewDigest> {
  const statsOptions: SkillStatsOptions = {
    workspaceRoot: options.workspaceRoot,
    sessionRootDir: options.sessionRootDir,
    skillRoots: options.skillRoots,
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.skillName ? { skillName: options.skillName } : {}),
    ...(options.skillKey ? { skillKey: options.skillKey } : {}),
    ...(options.packageHash ? { packageHash: options.packageHash } : {}),
    ...(options.useProjectionCache !== undefined
      ? { useProjectionCache: options.useProjectionCache }
      : {}),
    ...(options.projectionCacheDir
      ? { projectionCacheDir: options.projectionCacheDir }
      : {}),
  };
  const stats = await collectSkillStats(statsOptions);
  const proposals = await listSkillProposals(options.workspaceRoot);
  const draftProposals = proposals.filter((proposal) => {
    if (proposal.state !== "draft") return false;
    if (options.skillName && proposal.skillName !== options.skillName) {
      return false;
    }
    return true;
  });
  const items = [
    ...draftProposals.map(proposalToReviewItem),
    ...stats.findings
      .filter((finding) => REVIEWABLE_STATS_FINDINGS.has(finding.code))
      .map(findingToReviewItem),
  ].sort(compareReviewItems);

  return {
    workspaceRoot: options.workspaceRoot,
    sessionRootDir: options.sessionRootDir,
    sessionLimit: stats.sessionLimit,
    generatedAt: stats.freshness.computedAt,
    freshness: stats.freshness,
    stats: {
      sessionsScanned: stats.sessionsScanned,
      tracesScanned: stats.tracesScanned,
      findingsScanned: stats.findings.length,
    },
    proposals: {
      scanned: proposals.length,
      drafts: draftProposals.length,
      intentStubs: draftProposals.filter(
        (proposal) => proposal.contentMode === "intent_stub",
      ).length,
      templates: draftProposals.filter(
        (proposal) => proposal.contentMode === "template",
      ).length,
    },
    items: items.map(({ priority: _priority, ...item }) => item),
  };
}

function proposalToReviewItem(
  proposal: SkillProposalSummary,
): PrioritizedSkillReviewDigestItem {
  const contentMode = proposal.contentMode;
  const isIntentStub = contentMode === "intent_stub";
  const isTemplate = contentMode === "template";
  const needsAuthoredBody = isIntentStub || isTemplate;
  return {
    id: `proposal:${proposal.id}`,
    kind: "proposal",
    severity: needsAuthoredBody ? "warning" : "info",
    skillName: proposal.skillName,
    title: `Draft ${proposal.kind} proposal for ${proposal.skillName}`,
    message: needsAuthoredBody
      ? proposalContentModeMessage(proposal)
      : "Draft proposal is ready for human review.",
    action: needsAuthoredBody
      ? `Open ${proposal.id} and replace the generated proposal body with authored SKILL.md content before applying.`
      : `Review ${proposal.id}; apply or close it once the proposed content is checked.`,
    proposalId: proposal.id,
    proposalKind: proposal.kind,
    proposalState: proposal.state,
    ...(contentMode ? { contentMode } : {}),
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    priority: needsAuthoredBody ? 0 : 20,
  };
}

function proposalContentModeMessage(proposal: SkillProposalSummary): string {
  if (proposal.contentMode === "intent_stub") {
    return "Draft update only captures intent; it does not contain reviewer-ready evolved skill content.";
  }
  return "Draft create proposal uses the generated template body; it needs authored skill content before review can finish.";
}

function findingToReviewItem(
  finding: SkillStatsFinding,
): PrioritizedSkillReviewDigestItem {
  const isLoadFailure = finding.code === "SKILL_LOAD_FAILURES";
  return {
    id: `finding:${finding.code}:${finding.skillKey}`,
    kind: "stats_finding",
    severity: finding.severity,
    relation: finding.relation,
    skillName: finding.skillName,
    title: `${finding.code} for ${finding.skillName}`,
    message: finding.message,
    action: isLoadFailure
      ? "Inspect the failed runs and draft or update the skill if the failure is reproducible."
      : "Inspect the associated failed tool calls; treat this as correlation, not causation.",
    findingCode: finding.code,
    evidence: finding.evidence,
    priority: isLoadFailure ? 40 : 60,
  };
}

function compareReviewItems(
  left: PrioritizedSkillReviewDigestItem,
  right: PrioritizedSkillReviewDigestItem,
): number {
  const severityOrder: Record<SkillReviewDigestSeverity, number> = {
    warning: 0,
    info: 1,
  };
  return (
    severityOrder[left.severity] - severityOrder[right.severity] ||
    left.priority - right.priority ||
    left.skillName.localeCompare(right.skillName) ||
    left.id.localeCompare(right.id)
  );
}
