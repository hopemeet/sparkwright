import {
  assertSafePathSegment,
  createId,
  formatWorkspaceDisplayPath,
} from "@sparkwright/core";
import {
  computeSkillPackageHash,
  inspectSkill,
  parseSkill,
  type SkillGuardFinding,
  type SkillManifest,
  type SkillRoot,
} from "@sparkwright/skills";
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createFileCapabilityPackageWriter,
  type CapabilityPackageMutationReporter,
  type CapabilityPackageMutationWriter,
} from "./capability-package-mutation.js";
import { projectSkillRoot } from "./skill-roots.js";
import { runSkillDoctor, type SkillDoctorReport } from "./skill-doctor.js";
import {
  loadLayeredSkillReport,
  type SkillReportEntry,
} from "./skill-report.js";
import { recordSkillPatch } from "./skill-usage.js";

export type SkillProposalState =
  | "draft"
  | "applied"
  | "rejected"
  | "stale"
  | "superseded"
  | "failed";

export type SkillProposalKind = "create" | "update";
export type SkillProposalContentMode = "authored" | "intent_stub" | "template";
export type SkillHistoryKind = SkillProposalKind | "restore";

const PRUNABLE_PROPOSAL_STATES: readonly SkillProposalState[] = [
  "rejected",
  "stale",
  "superseded",
  "failed",
];

/**
 * Where a proposal came from. Auto-captured when a proposal is drafted by a
 * model tool during a run, so a reviewer can pull the trace that motivated the
 * change. All fields are optional: CLI-authored proposals have no run.
 */
export interface SkillProposalProvenance {
  runId?: string;
  sessionId?: string;
  /** Short reason/intent the author gave for the change. */
  rationale?: string;
}

export interface SkillProposalMetadata {
  id: string;
  kind: SkillProposalKind;
  state: SkillProposalState;
  skillName: string;
  targetLayer: "project";
  targetPath: string;
  createdAt: string;
  updatedAt: string;
  basePackageHash: string | null;
  afterPackageHash: string;
  /** Monotonic revision of a mutable draft. Applied/closed proposals freeze it. */
  revision?: number;
  /** Hash replaced by the latest draft revision, for reviewer-visible audit. */
  previousAfterPackageHash?: string;
  summary: string;
  contentMode?: SkillProposalContentMode;
  sourceLayer?: SkillRoot["layer"];
  sourcePath?: string;
  closedAt?: string;
  statusReason?: string;
  supersededBy?: string;
  /**
   * Static guard findings on the proposed (after) content, recorded at draft so
   * a human reviewer sees them before applying. Evolution content is inspected
   * as `agent-created` regardless of any trust the skill body self-declares.
   */
  guardFindings?: SkillGuardFinding[];
  /** Run/session that produced the proposal, when drafted during a run. */
  provenance?: SkillProposalProvenance;
}

export interface SkillProposalSummary extends SkillProposalMetadata {
  path: string;
}

export interface SkillProposalDetail extends SkillProposalSummary {
  proposalMarkdown: string;
  patchDiff: string;
}

export interface ReviseSkillProposalDraftResult {
  proposal: SkillProposalDetail;
  changed: boolean;
}

export interface SkillHistoryMetadata {
  id: string;
  skillName: string;
  proposalId: string;
  kind: SkillHistoryKind;
  createdAt: string;
  beforePackageHash: string | null;
  afterPackageHash: string;
  targetPath: string;
  /** @reserved Restore provenance linking back to the source history version, persisted for readers/diagnostics, not by an in-process TS reader. */
  sourceHistoryId?: string;
}

export interface SkillHistoryEntry extends SkillHistoryMetadata {
  path: string;
}

export interface SkillHistoryDetail extends SkillHistoryEntry {
  beforePath: string;
  afterPath: string;
  patchDiff: string;
}

export interface ApplySkillProposalResult {
  proposal: SkillProposalDetail;
  history: SkillHistoryEntry;
  doctor: SkillDoctorReport;
  guardFindings: SkillGuardFinding[];
  changed: true;
}

export interface CloseSkillProposalInput {
  workspaceRoot: string;
  proposalId: string;
  reason?: string;
  closedAt?: Date | string;
}

export interface SupersedeSkillProposalInput extends CloseSkillProposalInput {
  supersededBy: string;
}

export interface PruneSkillProposalsInput {
  workspaceRoot: string;
  states?: readonly SkillProposalState[];
  olderThanMs?: number;
  now?: Date | string;
  apply?: boolean;
}

export interface PruneSkillProposalsResult {
  applied: boolean;
  states: SkillProposalState[];
  cutoff?: string;
  candidates: SkillProposalSummary[];
  deleted: SkillProposalSummary[];
}

export interface RestoreSkillFromHistoryInput {
  workspaceRoot: string;
  skillName: string;
  historyId: string;
  apply?: boolean;
  /**
   * Which side of the history entry to restore. `after` (default) re-applies the
   * package that version produced. `before` restores the package as it was prior
   * to that version — the revert/undo edge for an applied evolution.
   */
  side?: "before" | "after";
  restoredAt?: Date | string;
}

export interface RestoreSkillFromHistoryResult {
  applied: boolean;
  skillName: string;
  targetPath: string;
  side: "before" | "after";
  sourceHistory: SkillHistoryDetail;
  currentPackageHash: string | null;
  restorePackageHash: string;
  restoreHistory?: SkillHistoryEntry;
  doctor?: SkillDoctorReport;
}

export interface CreateSkillCreateProposalInput {
  workspaceRoot: string;
  name: string;
  description: string;
  createdAt?: Date | string;
  /**
   * Full SKILL.md content for the new Skill. When omitted, a minimal template
   * derived from `description` is used. Callers that capture real content
   * (e.g. the TUI learning helper) provide it here so the proposed Skill holds
   * actual guidance rather than a placeholder.
   */
  content?: string;
  provenance?: SkillProposalProvenance;
  mutationReporter?: CapabilityPackageMutationReporter;
}

export interface CreateSkillUpdateProposalInput {
  workspaceRoot: string;
  skillRoots: readonly SkillRoot[];
  name: string;
  description: string;
  createdAt?: Date | string;
  /**
   * Transform applied to the current SKILL.md to produce the proposed content.
   * When omitted, `description` is appended as a "Proposed Evolution" section.
   */
  applyEdit?: (beforeContent: string) => string;
  provenance?: SkillProposalProvenance;
  mutationReporter?: CapabilityPackageMutationReporter;
}

export async function createSkillCreateProposal(
  input: CreateSkillCreateProposalInput,
): Promise<SkillProposalDetail> {
  const mutations = createFileCapabilityPackageWriter(
    input.workspaceRoot,
    input.mutationReporter,
  );
  validateSkillName(input.name);
  if (input.description.trim().length === 0) {
    throw new Error("Skill proposal create requires description.");
  }

  const targetPath = join(projectSkillRoot(input.workspaceRoot), input.name);
  if (existsSync(join(targetPath, "SKILL.md"))) {
    throw new Error(`Project Skill already exists: ${targetPath}`);
  }

  const proposalId = createId("skillprop") as string;
  const proposalPath = proposalDir(input.workspaceRoot, proposalId);
  const afterSkillDir = join(proposalPath, "after", input.name);
  const now =
    input.createdAt instanceof Date
      ? input.createdAt.toISOString()
      : (input.createdAt ?? new Date().toISOString());
  const skillContent =
    input.content ?? renderSkillTemplate(input.name, input.description);
  assertSkillMarkdownName(
    skillContent,
    input.name,
    join(afterSkillDir, "SKILL.md"),
  );

  try {
    await mutations.ensureDirectory(afterSkillDir, {
      reason: `Create proposal package ${proposalId}`,
    });
    await mutations.writeText(join(afterSkillDir, "SKILL.md"), skillContent, {
      reason: `Write proposed Skill ${input.name}`,
    });
    const guardFindings = inspectProposedSkillContent(input.name, skillContent);

    const afterHash = await computeSkillPackageHash(afterSkillDir);
    const metadata: SkillProposalMetadata = {
      id: proposalId,
      kind: "create",
      state: "draft",
      skillName: input.name,
      targetLayer: "project",
      targetPath,
      createdAt: now,
      updatedAt: now,
      basePackageHash: null,
      afterPackageHash: afterHash.packageHash,
      revision: 1,
      summary: `Create project Skill ${input.name}`,
      contentMode: input.content ? "authored" : "template",
      ...(guardFindings.length > 0 ? { guardFindings } : {}),
      ...(normalizeProvenance(input.provenance)
        ? { provenance: normalizeProvenance(input.provenance) }
        : {}),
    };
    const proposalMarkdown = renderCreateProposalMarkdown(
      metadata,
      input.description,
      input.workspaceRoot,
    );
    const patchDiff = renderCreatePatch(input.name, skillContent);

    await mutations.ensureDirectory(join(proposalPath, "before"), {
      reason: `Create empty proposal base ${proposalId}`,
    });
    await mutations.writeJson(join(proposalPath, "metadata.json"), metadata, {
      reason: `Write proposal metadata ${proposalId}`,
    });
    await mutations.writeText(
      join(proposalPath, "proposal.md"),
      proposalMarkdown,
      {
        reason: `Write proposal markdown ${proposalId}`,
      },
    );
    await mutations.writeText(join(proposalPath, "patch.diff"), patchDiff, {
      reason: `Write proposal patch ${proposalId}`,
    });

    return {
      ...metadata,
      path: proposalPath,
      proposalMarkdown,
      patchDiff,
    };
  } catch (error) {
    await rollbackPartialProposal(mutations, proposalPath, proposalId);
    throw error;
  }
}

export async function createSkillUpdateProposal(
  input: CreateSkillUpdateProposalInput,
): Promise<SkillProposalDetail> {
  const mutations = createFileCapabilityPackageWriter(
    input.workspaceRoot,
    input.mutationReporter,
  );
  validateSkillName(input.name);
  if (input.description.trim().length === 0) {
    throw new Error("Skill proposal update requires description.");
  }

  const report = await loadLayeredSkillReport(input.skillRoots, {
    includeMissingRoots: false,
  });
  const skill = report.skills.find((entry) => entry.name === input.name);
  if (!skill?.source) {
    throw new Error(`Skill not found: ${input.name}`);
  }

  const sourceDir = skillPackageDir(skill);
  const baseHash = await computeSkillPackageHash(sourceDir);
  const targetPath = join(projectSkillRoot(input.workspaceRoot), input.name);
  const proposalId = createId("skillprop") as string;
  const proposalPath = proposalDir(input.workspaceRoot, proposalId);
  const beforeSkillDir = join(proposalPath, "before", input.name);
  const afterSkillDir = join(proposalPath, "after", input.name);
  const now =
    input.createdAt instanceof Date
      ? input.createdAt.toISOString()
      : (input.createdAt ?? new Date().toISOString());

  try {
    await mutations.snapshotSkillPackage(sourceDir, beforeSkillDir, {
      reason: `Snapshot proposal base ${proposalId}`,
    });
    await mutations.snapshotSkillPackage(sourceDir, afterSkillDir, {
      reason: `Snapshot proposal after package ${proposalId}`,
    });
    const skillPath = join(afterSkillDir, "SKILL.md");
    const beforeContent = await readFile(skillPath, "utf8");
    const afterContent = input.applyEdit
      ? input.applyEdit(beforeContent)
      : renderUpdatedSkillContent(beforeContent, input.description);
    assertSkillMarkdownName(afterContent, input.name, skillPath);
    await mutations.writeText(skillPath, afterContent, {
      reason: `Write proposed Skill update ${input.name}`,
    });
    const guardFindings = inspectProposedSkillContent(input.name, afterContent);

    const afterHash = await computeSkillPackageHash(afterSkillDir);
    const metadata: SkillProposalMetadata = {
      id: proposalId,
      kind: "update",
      state: "draft",
      skillName: input.name,
      targetLayer: "project",
      targetPath,
      createdAt: now,
      updatedAt: now,
      basePackageHash: baseHash.packageHash,
      afterPackageHash: afterHash.packageHash,
      revision: 1,
      summary:
        skill.layer === "project"
          ? `Update project Skill ${input.name}`
          : `Fork ${skill.layer ?? "unknown"} Skill ${input.name} into project layer`,
      contentMode: input.applyEdit ? "authored" : "intent_stub",
      sourceLayer: skill.layer,
      sourcePath: skill.source,
      ...(guardFindings.length > 0 ? { guardFindings } : {}),
      ...(normalizeProvenance(input.provenance)
        ? { provenance: normalizeProvenance(input.provenance) }
        : {}),
    };
    const proposalMarkdown = renderUpdateProposalMarkdown(
      metadata,
      input.description,
      input.workspaceRoot,
    );
    const patchDiff = renderUpdatePatch(
      input.name,
      beforeContent,
      afterContent,
    );

    await mutations.writeJson(join(proposalPath, "metadata.json"), metadata, {
      reason: `Write proposal metadata ${proposalId}`,
    });
    await mutations.writeText(
      join(proposalPath, "proposal.md"),
      proposalMarkdown,
      {
        reason: `Write proposal markdown ${proposalId}`,
      },
    );
    await mutations.writeText(join(proposalPath, "patch.diff"), patchDiff, {
      reason: `Write proposal patch ${proposalId}`,
    });

    return {
      ...metadata,
      path: proposalPath,
      proposalMarkdown,
      patchDiff,
    };
  } catch (error) {
    await rollbackPartialProposal(mutations, proposalPath, proposalId);
    throw error;
  }
}

/**
 * Revise an existing draft in place. The proposal id remains stable, while
 * revision/hash metadata makes a changed model-authored body visible to the
 * human review gate. Closed proposals are immutable.
 */
export async function reviseSkillProposalDraft(input: {
  workspaceRoot: string;
  proposalId: string;
  description: string;
  content?: string;
  revisedAt?: Date | string;
  provenance?: SkillProposalProvenance;
  mutationReporter?: CapabilityPackageMutationReporter;
}): Promise<ReviseSkillProposalDraftResult> {
  const proposal = await readSkillProposal(
    input.workspaceRoot,
    input.proposalId,
  );
  if (proposal.state !== "draft") {
    throw new Error(`Skill proposal is not draft: ${proposal.id}`);
  }
  const mutations = createFileCapabilityPackageWriter(
    input.workspaceRoot,
    input.mutationReporter,
  );
  const afterSkillPath = join(
    proposal.path,
    "after",
    proposal.skillName,
    "SKILL.md",
  );
  const previousContent = await readFile(afterSkillPath, "utf8");
  const beforeContent =
    proposal.kind === "update"
      ? await readFile(
          join(proposal.path, "before", proposal.skillName, "SKILL.md"),
          "utf8",
        )
      : undefined;
  const nextContent =
    input.content ??
    (beforeContent
      ? renderUpdatedSkillContent(beforeContent, input.description)
      : renderSkillTemplate(proposal.skillName, input.description));
  assertSkillMarkdownName(nextContent, proposal.skillName, afterSkillPath);
  if (nextContent === previousContent) {
    return { proposal, changed: false };
  }

  const previousMetadata =
    JSON.stringify(proposalMetadataFromDetail(proposal), null, 2) + "\n";
  const previousProposalMarkdown = proposal.proposalMarkdown;
  const previousPatchDiff = proposal.patchDiff;
  try {
    await mutations.writeText(afterSkillPath, nextContent, {
      reason: `Revise proposed Skill ${proposal.skillName}`,
    });
    const afterHash = await computeSkillPackageHash(
      join(proposal.path, "after", proposal.skillName),
    );
    const guardFindings = inspectProposedSkillContent(
      proposal.skillName,
      nextContent,
    );
    const updatedAt = normalizeDateInput(input.revisedAt);
    const metadata: SkillProposalMetadata = {
      ...proposalMetadataFromDetail(proposal),
      updatedAt,
      afterPackageHash: afterHash.packageHash,
      revision: (proposal.revision ?? 1) + 1,
      previousAfterPackageHash: proposal.afterPackageHash,
      contentMode: input.content ? "authored" : proposal.contentMode,
      guardFindings: guardFindings.length > 0 ? guardFindings : undefined,
      provenance: normalizeProvenance(input.provenance) ?? proposal.provenance,
    };
    const proposalMarkdown =
      proposal.kind === "create"
        ? renderCreateProposalMarkdown(
            metadata,
            input.description,
            input.workspaceRoot,
          )
        : renderUpdateProposalMarkdown(
            metadata,
            input.description,
            input.workspaceRoot,
          );
    const patchDiff =
      proposal.kind === "create"
        ? renderCreatePatch(proposal.skillName, nextContent)
        : renderUpdatePatch(
            proposal.skillName,
            beforeContent ?? "",
            nextContent,
          );
    await mutations.writeJson(join(proposal.path, "metadata.json"), metadata, {
      reason: `Write revised proposal metadata ${proposal.id}`,
    });
    await mutations.writeText(
      join(proposal.path, "proposal.md"),
      proposalMarkdown,
      { reason: `Write revised proposal markdown ${proposal.id}` },
    );
    await mutations.writeText(join(proposal.path, "patch.diff"), patchDiff, {
      reason: `Write revised proposal patch ${proposal.id}`,
    });
    return {
      proposal: {
        ...metadata,
        path: proposal.path,
        proposalMarkdown,
        patchDiff,
      },
      changed: true,
    };
  } catch (error) {
    await Promise.allSettled([
      mutations.writeText(afterSkillPath, previousContent, {
        reason: `Roll back proposed Skill revision ${proposal.id}`,
      }),
      mutations.writeText(
        join(proposal.path, "metadata.json"),
        previousMetadata,
        {
          reason: `Roll back proposal metadata ${proposal.id}`,
        },
      ),
      mutations.writeText(
        join(proposal.path, "proposal.md"),
        previousProposalMarkdown,
        { reason: `Roll back proposal markdown ${proposal.id}` },
      ),
      mutations.writeText(
        join(proposal.path, "patch.diff"),
        previousPatchDiff,
        { reason: `Roll back proposal patch ${proposal.id}` },
      ),
    ]);
    throw error;
  }
}

export async function listSkillProposals(
  workspaceRoot: string,
): Promise<SkillProposalSummary[]> {
  const root = proposalsRoot(workspaceRoot);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const proposals = (
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(root, entry);
        const info = await stat(path).catch(() => undefined);
        if (!info?.isDirectory()) return undefined;
        return readSkillProposal(workspaceRoot, entry).catch(() => undefined);
      }),
    )
  ).filter(
    (proposal): proposal is SkillProposalDetail => proposal !== undefined,
  );

  return proposals
    .map(
      ({ proposalMarkdown: _proposalMarkdown, patchDiff: _patchDiff, ...p }) =>
        p,
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function pruneSkillProposals(
  input: PruneSkillProposalsInput,
): Promise<PruneSkillProposalsResult> {
  const states = normalizePruneStates(input.states);
  const now = normalizeDateInput(input.now);
  const cutoff =
    input.olderThanMs === undefined
      ? undefined
      : new Date(Date.parse(now) - input.olderThanMs).toISOString();
  const proposals = await listSkillProposals(input.workspaceRoot);
  const candidates = proposals.filter((proposal) => {
    if (!states.includes(proposal.state)) return false;
    if (!cutoff) return true;
    return proposal.updatedAt < cutoff;
  });

  const deleted: SkillProposalSummary[] = [];
  if (input.apply) {
    const mutations = createFileCapabilityPackageWriter(input.workspaceRoot);
    for (const proposal of candidates) {
      await mutations.removeTree(proposal.path, {
        reason: `Prune Skill proposal ${proposal.id}`,
      });
      deleted.push(proposal);
    }
  }

  return {
    applied: input.apply === true,
    states,
    ...(cutoff ? { cutoff } : {}),
    candidates,
    deleted,
  };
}

export async function readSkillProposal(
  workspaceRoot: string,
  proposalId: string,
): Promise<SkillProposalDetail> {
  assertSafePathSegment(proposalId, "proposal id");
  const proposal = await readSkillProposalFromPath(
    proposalDir(workspaceRoot, proposalId),
  );
  if (proposal.id !== proposalId) {
    throw new Error(`Skill proposal id mismatch: ${proposalId}`);
  }
  validateProposalTarget(workspaceRoot, proposal);
  return proposal;
}

async function readSkillProposalFromPath(
  path: string,
): Promise<SkillProposalDetail> {
  const metadata = JSON.parse(
    await readFile(join(path, "metadata.json"), "utf8"),
  ) as SkillProposalMetadata;
  return {
    ...metadata,
    path,
    proposalMarkdown: await readFile(join(path, "proposal.md"), "utf8"),
    patchDiff: await readFile(join(path, "patch.diff"), "utf8"),
  };
}

export async function applySkillProposal(
  workspaceRoot: string,
  proposalId: string,
  options: { appliedAt?: Date | string; force?: boolean } = {},
): Promise<ApplySkillProposalResult> {
  const mutations = createFileCapabilityPackageWriter(workspaceRoot);
  const proposal = await readSkillProposal(workspaceRoot, proposalId);
  if (proposal.state !== "draft") {
    throw new Error(`Skill proposal is not draft: ${proposal.id}`);
  }
  validateProposalTarget(workspaceRoot, proposal);

  const afterSkillDir = join(proposal.path, "after", proposal.skillName);
  await verifyProposalAfterSkillName(proposal, afterSkillDir, mutations);
  const currentAfterHash = await computeSkillPackageHash(afterSkillDir);
  if (currentAfterHash.packageHash !== proposal.afterPackageHash) {
    await updateProposalState(proposal, "stale", mutations);
    throw new Error(
      `Skill proposal after package hash changed: ${proposal.id}`,
    );
  }

  // Re-inspect the proposed content at the human apply gate. Dangerous findings
  // require an explicit force so an agent-authored evolution cannot quietly
  // introduce secret-exfil-shaped instructions.
  const afterContent = await readFile(join(afterSkillDir, "SKILL.md"), "utf8");
  const guardFindings = inspectProposedSkillContent(
    proposal.skillName,
    afterContent,
  );
  if (hasDangerousGuardFinding(guardFindings) && !options.force) {
    throw new Error(
      `Skill proposal ${proposal.id} has dangerous guard findings; ` +
        `review with 'skills proposals show' and re-apply with force to proceed.`,
    );
  }

  await verifyProposalBase(proposal, mutations);

  await mutations.ensureDirectory(projectSkillRoot(workspaceRoot), {
    reason: "Ensure project Skill root before applying proposal",
  });
  const restoreProjectBefore = proposalCreatesFromProject(proposal);
  if (proposal.kind === "update") {
    await mutations.removeTree(proposal.targetPath, {
      reason: `Remove current Skill ${proposal.skillName} before applying proposal`,
    });
  }
  await mutations.replaceWithSkillPackage(afterSkillDir, proposal.targetPath, {
    reason: `Apply Skill proposal ${proposal.id}`,
  });

  const roots = [
    { root: projectSkillRoot(workspaceRoot), layer: "project" as const },
  ];
  const doctor = await runSkillDoctor({ skillRoots: roots });
  if (doctor.status === "blocked") {
    await rollbackAppliedProposal(proposal, restoreProjectBefore, mutations);
    await updateProposalState(proposal, "failed", mutations);
    throw new Error(
      `Applied Skill proposal failed doctor checks: ${proposal.id}`,
    );
  }

  const now =
    options.appliedAt instanceof Date
      ? options.appliedAt.toISOString()
      : (options.appliedAt ?? new Date().toISOString());
  let history: SkillHistoryEntry | undefined;
  try {
    history = await writeHistoryEntry(workspaceRoot, proposal, now, mutations);
    const applied = await updateProposalState(
      proposal,
      "applied",
      mutations,
      now,
      {},
    );
    recordSkillPatch(workspaceRoot, proposal.skillName, now);

    return {
      proposal: applied,
      history,
      doctor,
      guardFindings,
      changed: true,
    };
  } catch (error) {
    if (history) {
      await mutations.removeTree(history.path, {
        reason: `Rollback Skill history ${history.id}`,
      });
    }
    await rollbackAppliedProposal(proposal, restoreProjectBefore, mutations);
    throw error;
  }
}

export async function rejectSkillProposal(
  input: CloseSkillProposalInput,
): Promise<SkillProposalDetail> {
  const mutations = createFileCapabilityPackageWriter(input.workspaceRoot);
  const proposal = await readSkillProposal(
    input.workspaceRoot,
    input.proposalId,
  );
  ensureClosableProposal(proposal, "reject");
  const closedAt = normalizeDateInput(input.closedAt);
  return updateProposalState(proposal, "rejected", mutations, closedAt, {
    closedAt,
    statusReason: cleanOptionalText(input.reason),
  });
}

export async function supersedeSkillProposal(
  input: SupersedeSkillProposalInput,
): Promise<SkillProposalDetail> {
  const mutations = createFileCapabilityPackageWriter(input.workspaceRoot);
  const proposal = await readSkillProposal(
    input.workspaceRoot,
    input.proposalId,
  );
  ensureClosableProposal(proposal, "supersede");
  assertSafePathSegment(input.supersededBy, "superseding proposal id");
  if (proposal.id === input.supersededBy) {
    throw new Error(`Skill proposal cannot supersede itself: ${proposal.id}`);
  }

  const replacement = await readSkillProposal(
    input.workspaceRoot,
    input.supersededBy,
  );
  if (replacement.state !== "draft") {
    throw new Error(
      `Superseding Skill proposal is not draft: ${replacement.id}`,
    );
  }
  if (
    replacement.skillName !== proposal.skillName ||
    replacement.targetPath !== proposal.targetPath
  ) {
    throw new Error(
      `Superseding Skill proposal targets a different Skill: ${replacement.id}`,
    );
  }

  const closedAt = normalizeDateInput(input.closedAt);
  return updateProposalState(proposal, "superseded", mutations, closedAt, {
    closedAt,
    statusReason: cleanOptionalText(input.reason),
    supersededBy: replacement.id,
  });
}

export async function listSkillHistory(
  workspaceRoot: string,
  skillName: string,
): Promise<SkillHistoryEntry[]> {
  validateSkillName(skillName);
  const root = historySkillRoot(workspaceRoot, skillName);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const history = (
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(root, entry);
        const info = await stat(path).catch(() => undefined);
        if (!info?.isDirectory()) return undefined;
        return readHistoryEntry(path).catch(() => undefined);
      }),
    )
  ).filter((entry): entry is SkillHistoryEntry => entry !== undefined);
  return history.sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

export async function readSkillHistoryDetail(
  workspaceRoot: string,
  skillName: string,
  historyId: string,
): Promise<SkillHistoryDetail> {
  validateSkillName(skillName);
  assertSafePathSegment(historyId, "history id");
  const path = join(historySkillRoot(workspaceRoot, skillName), historyId);
  const entry = await readHistoryEntry(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Skill history version not found: ${skillName}:${historyId}`,
      );
    }
    throw error;
  });
  if (entry.skillName !== skillName) {
    throw new Error(
      `Skill history entry belongs to a different Skill: ${entry.skillName}`,
    );
  }
  return {
    ...entry,
    beforePath: join(path, "before"),
    afterPath: join(path, "after", entry.skillName),
    patchDiff: await readFile(join(path, "patch.diff"), "utf8"),
  };
}

export async function restoreSkillFromHistory(
  input: RestoreSkillFromHistoryInput,
): Promise<RestoreSkillFromHistoryResult> {
  const mutations = createFileCapabilityPackageWriter(input.workspaceRoot);
  validateSkillName(input.skillName);
  const sourceHistory = await readSkillHistoryDetail(
    input.workspaceRoot,
    input.skillName,
    input.historyId,
  );
  const side = input.side ?? "after";
  if (side === "before" && !sourceHistory.beforePackageHash) {
    throw new Error(
      `Skill history version ${input.skillName}:${input.historyId} has no prior ` +
        `(before) package to restore; this version created the Skill from nothing.`,
    );
  }
  const restoreSourceDir =
    side === "before"
      ? join(sourceHistory.beforePath, input.skillName)
      : sourceHistory.afterPath;
  const targetPath = join(
    projectSkillRoot(input.workspaceRoot),
    input.skillName,
  );
  const currentPackageHash = await computeSkillPackageHash(targetPath)
    .then((hash) => hash.packageHash)
    .catch(() => null);
  const restorePackageHash = await computeSkillPackageHash(
    restoreSourceDir,
  ).then((hash) => hash.packageHash);

  if (!input.apply) {
    return {
      applied: false,
      skillName: input.skillName,
      targetPath,
      side,
      sourceHistory,
      currentPackageHash,
      restorePackageHash,
    };
  }

  const restoreBeforeRoot = join(
    skillEvolutionRoot(input.workspaceRoot),
    "restore-tmp",
    createId("skillrestore") as string,
  );
  const restoreBeforeSkill = join(restoreBeforeRoot, input.skillName);
  let hadCurrentSkill = false;
  let restoreHistory: SkillHistoryEntry | undefined;
  try {
    hadCurrentSkill = existsSync(join(targetPath, "SKILL.md"));
    if (hadCurrentSkill) {
      await mutations.snapshotSkillPackage(targetPath, restoreBeforeSkill, {
        reason: `Snapshot current Skill ${input.skillName} before restore`,
      });
    } else {
      await mutations.ensureDirectory(restoreBeforeSkill, {
        reason: `Create empty restore base for ${input.skillName}`,
      });
    }

    await mutations.ensureDirectory(projectSkillRoot(input.workspaceRoot), {
      reason: "Ensure project Skill root before restoring Skill",
    });
    await mutations.removeTree(targetPath, {
      reason: `Remove current Skill ${input.skillName} before restore`,
    });
    await mutations.replaceWithSkillPackage(restoreSourceDir, targetPath, {
      reason: `Restore Skill ${input.skillName} from history ${input.historyId} (${side})`,
    });

    const roots = [
      {
        root: projectSkillRoot(input.workspaceRoot),
        layer: "project" as const,
      },
    ];
    const doctor = await runSkillDoctor({ skillRoots: roots });
    if (doctor.status === "blocked") {
      await rollbackRestoredSkill(
        targetPath,
        restoreBeforeSkill,
        hadCurrentSkill,
        mutations,
      );
      throw new Error(
        `Restored Skill failed doctor checks: ${input.skillName}`,
      );
    }

    const restoredAt = normalizeDateInput(input.restoredAt);
    restoreHistory = await writeRestoreHistoryEntry({
      workspaceRoot: input.workspaceRoot,
      skillName: input.skillName,
      targetPath,
      beforeSkillDir: hadCurrentSkill ? restoreBeforeSkill : undefined,
      sourceHistory,
      beforePackageHash: currentPackageHash,
      afterPackageHash: restorePackageHash,
      createdAt: restoredAt,
      mutations,
    });
    recordSkillPatch(input.workspaceRoot, input.skillName, restoredAt);

    return {
      applied: true,
      skillName: input.skillName,
      targetPath,
      side,
      sourceHistory,
      currentPackageHash,
      restorePackageHash,
      restoreHistory,
      doctor,
    };
  } catch (error) {
    if (restoreHistory) {
      await mutations.removeTree(restoreHistory.path, {
        reason: `Rollback restore history ${restoreHistory.id}`,
      });
    }
    if (existsSync(restoreBeforeRoot)) {
      await rollbackRestoredSkill(
        targetPath,
        restoreBeforeSkill,
        hadCurrentSkill,
        mutations,
      );
    }
    throw error;
  } finally {
    await mutations.removeTree(restoreBeforeRoot, {
      reason: `Remove restore temp for ${input.skillName}`,
    });
  }
}

export function skillEvolutionRoot(workspaceRoot: string): string {
  return join(workspaceRoot, ".sparkwright", "skill-evolution");
}

/**
 * Run the static skill guard over proposed content. Evolution content is
 * agent-authored, so it is inspected as `agent-created` regardless of any trust
 * the skill body self-declares (preventing a skill from weakening its own
 * scrutiny). Returns findings only; callers decide whether to record or gate.
 */
export function inspectProposedSkillContent(
  skillName: string,
  content: string,
): SkillGuardFinding[] {
  const parsed = parseSkill(content, `${skillName}/SKILL.md`);
  const manifest: SkillManifest = {
    name: parsed.name,
    description: parsed.description,
    instructions: parsed.body,
    allowedTools: parsed.allowedTools,
    metadata: parsed.metadata,
  };
  return inspectSkill(manifest, { trust: "agent-created" }).findings;
}

function hasDangerousGuardFinding(
  findings: readonly SkillGuardFinding[],
): boolean {
  return findings.some((finding) => finding.severity === "dangerous");
}

/**
 * Best-effort removal of a partially-written proposal directory when proposal
 * creation throws after the package dirs were created (e.g. unparseable body,
 * name mismatch). Keeps the original error as the thrown one.
 */
async function rollbackPartialProposal(
  mutations: CapabilityPackageMutationWriter,
  proposalPath: string,
  proposalId: string,
): Promise<void> {
  if (!existsSync(proposalPath)) return;
  try {
    await mutations.removeTree(proposalPath, {
      reason: `Roll back partial proposal ${proposalId}`,
    });
  } catch {
    // Swallow cleanup failures so the caller sees the original error.
  }
}

/** Drop empty/whitespace fields; return undefined when nothing meaningful set. */
function normalizeProvenance(
  provenance: SkillProposalProvenance | undefined,
): SkillProposalProvenance | undefined {
  if (!provenance) return undefined;
  const clean: SkillProposalProvenance = {};
  if (provenance.runId?.trim()) clean.runId = provenance.runId.trim();
  if (provenance.sessionId?.trim())
    clean.sessionId = provenance.sessionId.trim();
  if (provenance.rationale?.trim())
    clean.rationale = provenance.rationale.trim();
  return Object.keys(clean).length > 0 ? clean : undefined;
}

function proposalsRoot(workspaceRoot: string): string {
  return join(skillEvolutionRoot(workspaceRoot), "proposals");
}

function proposalMetadataFromDetail(
  proposal: SkillProposalDetail,
): SkillProposalMetadata {
  const {
    path: _path,
    proposalMarkdown: _proposalMarkdown,
    patchDiff: _patchDiff,
    ...metadata
  } = proposal;
  return metadata;
}

function proposalDir(workspaceRoot: string, proposalId: string): string {
  return join(proposalsRoot(workspaceRoot), proposalId);
}

function historyRoot(workspaceRoot: string): string {
  return join(skillEvolutionRoot(workspaceRoot), "history");
}

function historySkillRoot(workspaceRoot: string, skillName: string): string {
  return join(historyRoot(workspaceRoot), skillName);
}

async function updateProposalState(
  proposal: SkillProposalDetail,
  state: SkillProposalState,
  mutations: CapabilityPackageMutationWriter,
  updatedAt = new Date().toISOString(),
  extra: Partial<
    Pick<SkillProposalMetadata, "closedAt" | "statusReason" | "supersededBy">
  > = {},
): Promise<SkillProposalDetail> {
  const metadata: SkillProposalMetadata = {
    id: proposal.id,
    kind: proposal.kind,
    state,
    skillName: proposal.skillName,
    targetLayer: proposal.targetLayer,
    targetPath: proposal.targetPath,
    createdAt: proposal.createdAt,
    updatedAt,
    basePackageHash: proposal.basePackageHash,
    afterPackageHash: proposal.afterPackageHash,
    revision: proposal.revision,
    previousAfterPackageHash: proposal.previousAfterPackageHash,
    summary: proposal.summary,
    sourceLayer: proposal.sourceLayer,
    sourcePath: proposal.sourcePath,
    closedAt: extra.closedAt ?? proposal.closedAt,
    statusReason: extra.statusReason ?? proposal.statusReason,
    supersededBy: extra.supersededBy ?? proposal.supersededBy,
    contentMode: proposal.contentMode,
    guardFindings: proposal.guardFindings,
    provenance: proposal.provenance,
  };
  await mutations.writeJson(join(proposal.path, "metadata.json"), metadata, {
    reason: `Update proposal state ${proposal.id} to ${state}`,
  });
  return readSkillProposalFromPath(proposal.path);
}

function ensureClosableProposal(
  proposal: SkillProposalDetail,
  action: "reject" | "supersede",
): void {
  if (
    proposal.state === "applied" ||
    proposal.state === "rejected" ||
    proposal.state === "superseded"
  ) {
    throw new Error(
      `Cannot ${action} Skill proposal in state ${proposal.state}: ${proposal.id}`,
    );
  }
}

function normalizeDateInput(value?: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : (value ?? new Date().toISOString());
}

function cleanOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizePruneStates(
  states: readonly SkillProposalState[] | undefined,
): SkillProposalState[] {
  const selected = states ?? PRUNABLE_PROPOSAL_STATES;
  const out: SkillProposalState[] = [];
  for (const state of selected) {
    if (!PRUNABLE_PROPOSAL_STATES.includes(state)) {
      throw new Error(
        `Skill proposal state cannot be pruned: ${state}. Supported states: ${PRUNABLE_PROPOSAL_STATES.join(", ")}`,
      );
    }
    if (!out.includes(state)) out.push(state);
  }
  if (out.length === 0) {
    throw new Error("Skill proposal prune requires at least one state.");
  }
  return out;
}

async function writeHistoryEntry(
  workspaceRoot: string,
  proposal: SkillProposalDetail,
  createdAt: string,
  mutations: CapabilityPackageMutationWriter,
): Promise<SkillHistoryEntry> {
  const id = createId("skillver") as string;
  const path = join(historySkillRoot(workspaceRoot, proposal.skillName), id);
  const afterSkillDir = join(proposal.path, "after", proposal.skillName);
  const beforeSkillDir = join(proposal.path, "before", proposal.skillName);
  if (proposal.basePackageHash) {
    await mutations.snapshotSkillPackage(
      beforeSkillDir,
      join(path, "before", proposal.skillName),
      {
        reason: `Write history before package ${id}`,
      },
    );
  } else {
    await mutations.ensureDirectory(join(path, "before"), {
      reason: `Create empty history base ${id}`,
    });
  }
  await mutations.snapshotSkillPackage(
    afterSkillDir,
    join(path, "after", proposal.skillName),
    {
      reason: `Write history after package ${id}`,
    },
  );
  await mutations.writeText(join(path, "patch.diff"), proposal.patchDiff, {
    reason: `Write history patch ${id}`,
  });
  const metadata: SkillHistoryMetadata = {
    id,
    skillName: proposal.skillName,
    proposalId: proposal.id,
    kind: proposal.kind,
    createdAt,
    beforePackageHash: proposal.basePackageHash,
    afterPackageHash: proposal.afterPackageHash,
    targetPath: proposal.targetPath,
  };
  await mutations.writeJson(join(path, "metadata.json"), metadata, {
    reason: `Write history metadata ${id}`,
  });
  return { ...metadata, path };
}

async function writeRestoreHistoryEntry(input: {
  workspaceRoot: string;
  skillName: string;
  targetPath: string;
  beforeSkillDir?: string;
  sourceHistory: SkillHistoryDetail;
  beforePackageHash: string | null;
  afterPackageHash: string;
  createdAt: string;
  mutations: CapabilityPackageMutationWriter;
}): Promise<SkillHistoryEntry> {
  const id = createId("skillver") as string;
  const path = join(historySkillRoot(input.workspaceRoot, input.skillName), id);
  if (input.beforeSkillDir) {
    await input.mutations.snapshotSkillPackage(
      input.beforeSkillDir,
      join(path, "before", input.skillName),
      {
        reason: `Write restore history before package ${id}`,
      },
    );
  } else {
    await input.mutations.ensureDirectory(join(path, "before"), {
      reason: `Create empty restore history base ${id}`,
    });
  }
  await input.mutations.snapshotSkillPackage(
    input.sourceHistory.afterPath,
    join(path, "after", input.skillName),
    {
      reason: `Write restore history after package ${id}`,
    },
  );
  const patchDiff = renderRestorePatch(input.skillName, input.sourceHistory);
  await input.mutations.writeText(join(path, "patch.diff"), patchDiff, {
    reason: `Write restore history patch ${id}`,
  });
  const metadata: SkillHistoryMetadata = {
    id,
    skillName: input.skillName,
    proposalId: input.sourceHistory.proposalId,
    kind: "restore",
    createdAt: input.createdAt,
    beforePackageHash: input.beforePackageHash,
    afterPackageHash: input.afterPackageHash,
    targetPath: input.targetPath,
    sourceHistoryId: input.sourceHistory.id,
  };
  await input.mutations.writeJson(join(path, "metadata.json"), metadata, {
    reason: `Write restore history metadata ${id}`,
  });
  return { ...metadata, path };
}

async function readHistoryEntry(path: string): Promise<SkillHistoryEntry> {
  const metadata = JSON.parse(
    await readFile(join(path, "metadata.json"), "utf8"),
  ) as SkillHistoryMetadata;
  return { ...metadata, path };
}

async function verifyProposalBase(
  proposal: SkillProposalDetail,
  mutations: CapabilityPackageMutationWriter,
): Promise<void> {
  if (proposal.kind === "create") {
    if (existsSync(join(proposal.targetPath, "SKILL.md"))) {
      await updateProposalState(proposal, "stale", mutations);
      throw new Error(`Project Skill already exists: ${proposal.targetPath}`);
    }
    return;
  }

  if (proposal.kind !== "update") {
    throw new Error(`Unsupported Skill proposal kind: ${proposal.kind}`);
  }
  if (!proposal.basePackageHash) {
    await updateProposalState(proposal, "stale", mutations);
    throw new Error(`Skill proposal missing base package hash: ${proposal.id}`);
  }

  if (proposalCreatesFromProject(proposal)) {
    const current = await computeSkillPackageHash(proposal.targetPath).catch(
      async (error) => {
        await updateProposalState(proposal, "stale", mutations);
        throw new Error(
          `Project Skill changed since proposal: ${proposal.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    );
    if (current.packageHash !== proposal.basePackageHash) {
      await updateProposalState(proposal, "stale", mutations);
      throw new Error(`Project Skill changed since proposal: ${proposal.id}`);
    }
    return;
  }

  if (existsSync(join(proposal.targetPath, "SKILL.md"))) {
    await updateProposalState(proposal, "stale", mutations);
    throw new Error(`Project Skill already exists: ${proposal.targetPath}`);
  }
  if (!proposal.sourcePath) {
    await updateProposalState(proposal, "stale", mutations);
    throw new Error(`Skill proposal missing source path: ${proposal.id}`);
  }
  const sourceHash = await computeSkillPackageHash(
    dirname(proposal.sourcePath),
  ).catch(async (error) => {
    await updateProposalState(proposal, "stale", mutations);
    throw new Error(
      `Source Skill changed since proposal: ${proposal.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  if (sourceHash.packageHash !== proposal.basePackageHash) {
    await updateProposalState(proposal, "stale", mutations);
    throw new Error(`Source Skill changed since proposal: ${proposal.id}`);
  }
}

function validateProposalTarget(
  workspaceRoot: string,
  proposal: SkillProposalDetail,
): void {
  validateSkillName(proposal.skillName);
  if (proposal.targetLayer !== "project") {
    throw new Error(
      `Skill proposal target layer must be project: ${proposal.id}`,
    );
  }
  const expected = join(projectSkillRoot(workspaceRoot), proposal.skillName);
  if (proposal.targetPath !== expected) {
    throw new Error(`Skill proposal target path mismatch: ${proposal.id}`);
  }
}

async function verifyProposalAfterSkillName(
  proposal: SkillProposalDetail,
  afterSkillDir: string,
  mutations: CapabilityPackageMutationWriter,
): Promise<void> {
  const skillPath = join(afterSkillDir, "SKILL.md");
  const content = await readFile(skillPath, "utf8");
  try {
    assertSkillMarkdownName(content, proposal.skillName, skillPath);
  } catch (error) {
    await updateProposalState(proposal, "stale", mutations);
    throw error;
  }
}

function assertSkillMarkdownName(
  content: string,
  expectedName: string,
  sourcePath: string,
): void {
  const parsed = parseSkill(content, sourcePath);
  if (parsed.name !== expectedName) {
    throw new Error(
      `Skill proposal content name mismatch: expected ${expectedName}, found ${parsed.name}`,
    );
  }
}

function proposalCreatesFromProject(proposal: SkillProposalDetail): boolean {
  return proposal.kind === "update" && proposal.sourceLayer === "project";
}

async function rollbackAppliedProposal(
  proposal: SkillProposalDetail,
  restoreProjectBefore: boolean,
  mutations: CapabilityPackageMutationWriter,
): Promise<void> {
  await mutations.removeTree(proposal.targetPath, {
    reason: `Rollback applied Skill ${proposal.skillName}`,
  });
  if (!restoreProjectBefore) return;
  await mutations.replaceWithSkillPackage(
    join(proposal.path, "before", proposal.skillName),
    proposal.targetPath,
    {
      reason: `Restore project Skill ${proposal.skillName} after failed apply`,
    },
  );
}

async function rollbackRestoredSkill(
  targetPath: string,
  restoreBeforeSkill: string,
  hadCurrentSkill: boolean,
  mutations: CapabilityPackageMutationWriter,
): Promise<void> {
  await mutations.removeTree(targetPath, {
    reason: "Rollback restored Skill",
  });
  if (hadCurrentSkill) {
    await mutations.replaceWithSkillPackage(restoreBeforeSkill, targetPath, {
      reason: "Restore Skill before failed restore",
    });
  }
}

function skillPackageDir(skill: SkillReportEntry): string {
  if (!skill.source) {
    throw new Error(`Skill has no source path: ${skill.name}`);
  }
  return dirname(skill.source);
}

function validateSkillName(value: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw new Error(
      "Skill proposal create requires a valid lowercase skill name.",
    );
  }
}

function renderSkillTemplate(name: string, description: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${description.trim()}`,
    'version: "1.0.0"',
    "metadata:",
    '  version: "1.0.0"',
    "---",
    "",
    `Use this skill when the user asks for ${description.trim()}`,
    "",
  ].join("\n");
}

function renderCreateProposalMarkdown(
  metadata: SkillProposalMetadata,
  description: string,
  workspaceRoot: string,
): string {
  return [
    `# Skill Proposal: ${metadata.id}`,
    "",
    `State: ${metadata.state}`,
    `Kind: ${metadata.kind}`,
    `Skill: ${metadata.skillName}`,
    `Target: ${formatWorkspaceDisplayPath(metadata.targetPath, { workspaceRoot })}`,
    "",
    "## Summary",
    "",
    metadata.summary,
    "",
    "## Description",
    "",
    description.trim(),
    "",
  ].join("\n");
}

function renderUpdateProposalMarkdown(
  metadata: SkillProposalMetadata,
  description: string,
  workspaceRoot: string,
): string {
  const sourcePath = metadata.sourcePath
    ? formatWorkspaceDisplayPath(metadata.sourcePath, { workspaceRoot })
    : "unknown";
  return [
    `# Skill Proposal: ${metadata.id}`,
    "",
    `State: ${metadata.state}`,
    `Kind: ${metadata.kind}`,
    `Skill: ${metadata.skillName}`,
    `Source: ${metadata.sourceLayer ?? "unknown"}:${sourcePath}`,
    `Target: ${formatWorkspaceDisplayPath(metadata.targetPath, { workspaceRoot })}`,
    `Base: ${metadata.basePackageHash ?? "none"}`,
    `After: ${metadata.afterPackageHash}`,
    "",
    "## Summary",
    "",
    metadata.summary,
    "",
    "## Description",
    "",
    description.trim(),
    "",
  ].join("\n");
}

function renderUpdatedSkillContent(
  content: string,
  description: string,
): string {
  const trimmed = content.trimEnd();
  return [
    trimmed,
    "",
    "## Proposed Evolution",
    "",
    description.trim(),
    "",
  ].join("\n");
}

// Split SKILL.md content into unified-diff body lines. A single trailing
// newline is dropped so the line count matches the hunk header; the Skill
// package writers always terminate content with a newline.
function diffBodyLines(content: string): string[] {
  const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
  return normalized.length === 0 ? [] : normalized.split("\n");
}

function renderCreatePatch(name: string, content: string): string {
  const path = `.sparkwright/skills/${name}/SKILL.md`;
  const lines = diffBodyLines(content);
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function renderUpdatePatch(
  name: string,
  beforeContent: string,
  afterContent: string,
): string {
  const path = `.sparkwright/skills/${name}/SKILL.md`;
  const before = diffBodyLines(beforeContent);
  const after = diffBodyLines(afterContent);
  // Whole-file replacement: not minimal, but a valid unified diff with correct
  // hunk counts and a/b paths, so `git apply` accepts it against the base.
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${before.length} +1,${after.length} @@`,
    ...before.map((line) => `-${line}`),
    ...after.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function renderRestorePatch(
  name: string,
  sourceHistory: SkillHistoryDetail,
): string {
  return [
    `# restore ${name} from history ${sourceHistory.id}`,
    `# source proposal ${sourceHistory.proposalId}`,
    "#",
    "# original change being restored:",
    sourceHistory.patchDiff.trimEnd(),
    "",
  ].join("\n");
}
