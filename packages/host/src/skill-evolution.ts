import { createId, assertSafePathSegment } from "@sparkwright/core";
import {
  computeSkillPackageHash,
  snapshotSkillPackage,
  type SkillRoot,
} from "@sparkwright/skills";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectSkillRoot } from "./skill-roots.js";
import { runSkillDoctor, type SkillDoctorReport } from "./skill-doctor.js";
import {
  loadLayeredSkillReport,
  type SkillReportEntry,
} from "./skill-report.js";

export type SkillProposalState =
  | "draft"
  | "applied"
  | "rejected"
  | "stale"
  | "superseded"
  | "failed";

export type SkillProposalKind = "create" | "update";
export type SkillHistoryKind = SkillProposalKind | "restore";

const PRUNABLE_PROPOSAL_STATES: readonly SkillProposalState[] = [
  "rejected",
  "stale",
  "superseded",
  "failed",
];

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
  summary: string;
  sourceLayer?: SkillRoot["layer"];
  sourcePath?: string;
  closedAt?: string;
  statusReason?: string;
  supersededBy?: string;
}

export interface SkillProposalSummary extends SkillProposalMetadata {
  path: string;
}

export interface SkillProposalDetail extends SkillProposalSummary {
  proposalMarkdown: string;
  patchDiff: string;
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
  restoredAt?: Date | string;
}

export interface RestoreSkillFromHistoryResult {
  applied: boolean;
  skillName: string;
  targetPath: string;
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
}

export interface CreateSkillUpdateProposalInput {
  workspaceRoot: string;
  skillRoots: readonly SkillRoot[];
  name: string;
  description: string;
  createdAt?: Date | string;
}

export async function createSkillCreateProposal(
  input: CreateSkillCreateProposalInput,
): Promise<SkillProposalDetail> {
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
  const skillContent = renderSkillTemplate(input.name, input.description);

  await mkdir(afterSkillDir, { recursive: true });
  await writeFile(join(afterSkillDir, "SKILL.md"), skillContent, "utf8");

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
    summary: `Create project Skill ${input.name}`,
  };
  const proposalMarkdown = renderCreateProposalMarkdown(
    metadata,
    input.description,
  );
  const patchDiff = renderCreatePatch(input.name, skillContent);

  await mkdir(join(proposalPath, "before"), { recursive: true });
  await writeFile(
    join(proposalPath, "metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(proposalPath, "proposal.md"), proposalMarkdown, "utf8");
  await writeFile(join(proposalPath, "patch.diff"), patchDiff, "utf8");

  return {
    ...metadata,
    path: proposalPath,
    proposalMarkdown,
    patchDiff,
  };
}

export async function createSkillUpdateProposal(
  input: CreateSkillUpdateProposalInput,
): Promise<SkillProposalDetail> {
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

  await snapshotSkillPackage(sourceDir, beforeSkillDir);
  await snapshotSkillPackage(sourceDir, afterSkillDir);
  const skillPath = join(afterSkillDir, "SKILL.md");
  const beforeContent = await readFile(skillPath, "utf8");
  const afterContent = renderUpdatedSkillContent(
    beforeContent,
    input.description,
  );
  await writeFile(skillPath, afterContent, "utf8");

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
    summary:
      skill.layer === "project"
        ? `Update project Skill ${input.name}`
        : `Fork ${skill.layer ?? "unknown"} Skill ${input.name} into project layer`,
    sourceLayer: skill.layer,
    sourcePath: skill.source,
  };
  const proposalMarkdown = renderUpdateProposalMarkdown(
    metadata,
    input.description,
  );
  const patchDiff = renderUpdatePatch(input.name, beforeContent, afterContent);

  await writeFile(
    join(proposalPath, "metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(proposalPath, "proposal.md"), proposalMarkdown, "utf8");
  await writeFile(join(proposalPath, "patch.diff"), patchDiff, "utf8");

  return {
    ...metadata,
    path: proposalPath,
    proposalMarkdown,
    patchDiff,
  };
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
    for (const proposal of candidates) {
      await rm(proposal.path, { recursive: true, force: true });
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
  return readSkillProposalFromPath(proposalDir(workspaceRoot, proposalId));
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
  options: { appliedAt?: Date | string } = {},
): Promise<ApplySkillProposalResult> {
  const proposal = await readSkillProposal(workspaceRoot, proposalId);
  if (proposal.state !== "draft") {
    throw new Error(`Skill proposal is not draft: ${proposal.id}`);
  }

  const afterSkillDir = join(proposal.path, "after", proposal.skillName);
  const currentAfterHash = await computeSkillPackageHash(afterSkillDir);
  if (currentAfterHash.packageHash !== proposal.afterPackageHash) {
    await updateProposalState(proposal, "stale");
    throw new Error(
      `Skill proposal after package hash changed: ${proposal.id}`,
    );
  }

  await verifyProposalBase(proposal);

  await mkdir(projectSkillRoot(workspaceRoot), { recursive: true });
  const restoreProjectBefore = proposalCreatesFromProject(proposal);
  if (proposal.kind === "update") {
    await rm(proposal.targetPath, { recursive: true, force: true });
  }
  await cp(afterSkillDir, proposal.targetPath, { recursive: true });

  const roots = [
    { root: projectSkillRoot(workspaceRoot), layer: "project" as const },
  ];
  const doctor = await runSkillDoctor({ skillRoots: roots });
  if (doctor.status === "blocked") {
    await rollbackAppliedProposal(proposal, restoreProjectBefore);
    await updateProposalState(proposal, "failed");
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
    history = await writeHistoryEntry(workspaceRoot, proposal, now);
    const applied = await updateProposalState(proposal, "applied", now);

    return {
      proposal: applied,
      history,
      doctor,
      changed: true,
    };
  } catch (error) {
    if (history) await rm(history.path, { recursive: true, force: true });
    await rollbackAppliedProposal(proposal, restoreProjectBefore);
    throw error;
  }
}

export async function rejectSkillProposal(
  input: CloseSkillProposalInput,
): Promise<SkillProposalDetail> {
  const proposal = await readSkillProposal(
    input.workspaceRoot,
    input.proposalId,
  );
  ensureClosableProposal(proposal, "reject");
  const closedAt = normalizeDateInput(input.closedAt);
  return updateProposalState(proposal, "rejected", closedAt, {
    closedAt,
    statusReason: cleanOptionalText(input.reason),
  });
}

export async function supersedeSkillProposal(
  input: SupersedeSkillProposalInput,
): Promise<SkillProposalDetail> {
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
  return updateProposalState(proposal, "superseded", closedAt, {
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
  validateSkillName(input.skillName);
  const sourceHistory = await readSkillHistoryDetail(
    input.workspaceRoot,
    input.skillName,
    input.historyId,
  );
  const targetPath = join(
    projectSkillRoot(input.workspaceRoot),
    input.skillName,
  );
  const currentPackageHash = await computeSkillPackageHash(targetPath)
    .then((hash) => hash.packageHash)
    .catch(() => null);
  const restorePackageHash = await computeSkillPackageHash(
    sourceHistory.afterPath,
  ).then((hash) => hash.packageHash);

  if (!input.apply) {
    return {
      applied: false,
      skillName: input.skillName,
      targetPath,
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
      await snapshotSkillPackage(targetPath, restoreBeforeSkill);
    } else {
      await mkdir(restoreBeforeSkill, { recursive: true });
    }

    await mkdir(projectSkillRoot(input.workspaceRoot), { recursive: true });
    await rm(targetPath, { recursive: true, force: true });
    await cp(sourceHistory.afterPath, targetPath, { recursive: true });

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
    });

    return {
      applied: true,
      skillName: input.skillName,
      targetPath,
      sourceHistory,
      currentPackageHash,
      restorePackageHash,
      restoreHistory,
      doctor,
    };
  } catch (error) {
    if (restoreHistory) {
      await rm(restoreHistory.path, { recursive: true, force: true });
    }
    if (existsSync(restoreBeforeRoot)) {
      await rollbackRestoredSkill(
        targetPath,
        restoreBeforeSkill,
        hadCurrentSkill,
      );
    }
    throw error;
  } finally {
    await rm(restoreBeforeRoot, { recursive: true, force: true });
  }
}

export function skillEvolutionRoot(workspaceRoot: string): string {
  return join(workspaceRoot, ".sparkwright", "skill-evolution");
}

function proposalsRoot(workspaceRoot: string): string {
  return join(skillEvolutionRoot(workspaceRoot), "proposals");
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
    summary: proposal.summary,
    sourceLayer: proposal.sourceLayer,
    sourcePath: proposal.sourcePath,
    closedAt: extra.closedAt ?? proposal.closedAt,
    statusReason: extra.statusReason ?? proposal.statusReason,
    supersededBy: extra.supersededBy ?? proposal.supersededBy,
  };
  await writeFile(
    join(proposal.path, "metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
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
): Promise<SkillHistoryEntry> {
  const id = createId("skillver") as string;
  const path = join(historySkillRoot(workspaceRoot, proposal.skillName), id);
  const afterSkillDir = join(proposal.path, "after", proposal.skillName);
  const beforeSkillDir = join(proposal.path, "before", proposal.skillName);
  if (proposal.basePackageHash) {
    await cp(beforeSkillDir, join(path, "before", proposal.skillName), {
      recursive: true,
    });
  } else {
    await mkdir(join(path, "before"), { recursive: true });
  }
  await cp(afterSkillDir, join(path, "after", proposal.skillName), {
    recursive: true,
  });
  await writeFile(join(path, "patch.diff"), proposal.patchDiff, "utf8");
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
  await writeFile(
    join(path, "metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
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
}): Promise<SkillHistoryEntry> {
  const id = createId("skillver") as string;
  const path = join(historySkillRoot(input.workspaceRoot, input.skillName), id);
  if (input.beforeSkillDir) {
    await cp(input.beforeSkillDir, join(path, "before", input.skillName), {
      recursive: true,
    });
  } else {
    await mkdir(join(path, "before"), { recursive: true });
  }
  await cp(
    input.sourceHistory.afterPath,
    join(path, "after", input.skillName),
    {
      recursive: true,
    },
  );
  const patchDiff = renderRestorePatch(input.skillName, input.sourceHistory);
  await writeFile(join(path, "patch.diff"), patchDiff, "utf8");
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
  await writeFile(
    join(path, "metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
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
): Promise<void> {
  if (proposal.kind === "create") {
    if (existsSync(join(proposal.targetPath, "SKILL.md"))) {
      await updateProposalState(proposal, "stale");
      throw new Error(`Project Skill already exists: ${proposal.targetPath}`);
    }
    return;
  }

  if (proposal.kind !== "update") {
    throw new Error(`Unsupported Skill proposal kind: ${proposal.kind}`);
  }
  if (!proposal.basePackageHash) {
    await updateProposalState(proposal, "stale");
    throw new Error(`Skill proposal missing base package hash: ${proposal.id}`);
  }

  if (proposalCreatesFromProject(proposal)) {
    const current = await computeSkillPackageHash(proposal.targetPath).catch(
      async (error) => {
        await updateProposalState(proposal, "stale");
        throw new Error(
          `Project Skill changed since proposal: ${proposal.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    );
    if (current.packageHash !== proposal.basePackageHash) {
      await updateProposalState(proposal, "stale");
      throw new Error(`Project Skill changed since proposal: ${proposal.id}`);
    }
    return;
  }

  if (existsSync(join(proposal.targetPath, "SKILL.md"))) {
    await updateProposalState(proposal, "stale");
    throw new Error(`Project Skill already exists: ${proposal.targetPath}`);
  }
  if (!proposal.sourcePath) {
    await updateProposalState(proposal, "stale");
    throw new Error(`Skill proposal missing source path: ${proposal.id}`);
  }
  const sourceHash = await computeSkillPackageHash(
    dirname(proposal.sourcePath),
  ).catch(async (error) => {
    await updateProposalState(proposal, "stale");
    throw new Error(
      `Source Skill changed since proposal: ${proposal.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  if (sourceHash.packageHash !== proposal.basePackageHash) {
    await updateProposalState(proposal, "stale");
    throw new Error(`Source Skill changed since proposal: ${proposal.id}`);
  }
}

function proposalCreatesFromProject(proposal: SkillProposalDetail): boolean {
  return proposal.kind === "update" && proposal.sourceLayer === "project";
}

async function rollbackAppliedProposal(
  proposal: SkillProposalDetail,
  restoreProjectBefore: boolean,
): Promise<void> {
  await rm(proposal.targetPath, { recursive: true, force: true });
  if (!restoreProjectBefore) return;
  await cp(
    join(proposal.path, "before", proposal.skillName),
    proposal.targetPath,
    { recursive: true },
  );
}

async function rollbackRestoredSkill(
  targetPath: string,
  restoreBeforeSkill: string,
  hadCurrentSkill: boolean,
): Promise<void> {
  await rm(targetPath, { recursive: true, force: true });
  if (hadCurrentSkill) {
    await cp(restoreBeforeSkill, targetPath, { recursive: true });
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
): string {
  return [
    `# Skill Proposal: ${metadata.id}`,
    "",
    `State: ${metadata.state}`,
    `Kind: ${metadata.kind}`,
    `Skill: ${metadata.skillName}`,
    `Target: ${metadata.targetPath}`,
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
): string {
  return [
    `# Skill Proposal: ${metadata.id}`,
    "",
    `State: ${metadata.state}`,
    `Kind: ${metadata.kind}`,
    `Skill: ${metadata.skillName}`,
    `Source: ${metadata.sourceLayer ?? "unknown"}:${metadata.sourcePath ?? "unknown"}`,
    `Target: ${metadata.targetPath}`,
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

function renderCreatePatch(name: string, content: string): string {
  const lines = content
    .split("\n")
    .map((line) => `+${line}`)
    .join("\n");
  return [
    `diff --git a/.sparkwright/skills/${name}/SKILL.md b/.sparkwright/skills/${name}/SKILL.md`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/.sparkwright/skills/${name}/SKILL.md`,
    "@@",
    lines,
    "",
  ].join("\n");
}

function renderUpdatePatch(
  name: string,
  beforeContent: string,
  afterContent: string,
): string {
  return [
    `diff --git a/.sparkwright/skills/${name}/SKILL.md b/.sparkwright/skills/${name}/SKILL.md`,
    "--- before/SKILL.md",
    "+++ after/SKILL.md",
    "@@",
    ...beforeContent
      .trimEnd()
      .split("\n")
      .map((line) => `-${line}`),
    ...afterContent
      .trimEnd()
      .split("\n")
      .map((line) => `+${line}`),
    "",
  ].join("\n");
}

function renderRestorePatch(
  name: string,
  sourceHistory: SkillHistoryDetail,
): string {
  return [
    `diff --git a/.sparkwright/skills/${name}/ b/.sparkwright/skills/${name}/`,
    `restore from history ${sourceHistory.id}`,
    `source proposal ${sourceHistory.proposalId}`,
    "",
    sourceHistory.patchDiff.trimEnd(),
    "",
  ].join("\n");
}
