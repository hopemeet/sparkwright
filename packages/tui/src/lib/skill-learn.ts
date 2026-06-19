import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  applySkillProposal,
  createSkillCreateProposal,
  createSkillUpdateProposal,
  existingSkillRoots,
  loadHostConfig,
  projectConfigPath,
  resolveSkillRootsForRuntime,
  type CapabilitySkillEvolutionMode,
} from "@sparkwright/host";

export type SkillLearnMode = CapabilitySkillEvolutionMode;

export interface SkillLearnStatus {
  mode: SkillLearnMode;
  source: "config" | "default";
}

export interface SkillLearnSetResult extends SkillLearnStatus {
  path: string;
}

export interface SkillLearnNotice {
  reason: string;
  /**
   * The user's own instruction that triggered the notice, captured verbatim
   * (condensed). This is the actual content a learned draft records — only the
   * user's prompt is ever used as evidence, never tool/log/web/command output.
   */
  evidence: string;
}

export interface SkillLearnDraftProposal {
  id: string;
  kind: "create" | "update";
  skillName: string;
  state: string;
  path: string;
}

export interface CreateSkillLearnDraftProposalOptions {
  targetSkillName?: string;
  /** Session the learning was captured in, recorded as proposal provenance. */
  sessionId?: string;
}

export interface SkillLearnAutoApplyResult {
  proposalId: string;
  historyId: string;
  /** @reserved Auto-apply doctor verdict surfaced to callers/diagnostics, not by an in-process TS reader. */
  doctorStatus: string;
}

export const SKILL_LEARN_DRAFT_SKILL_NAME = "session-learnings";

export const SKILL_LEARN_MODES: readonly SkillLearnMode[] = [
  "off",
  "notice",
  "draft",
  "apply",
];

export async function readSkillLearnStatus(
  workspaceRoot: string,
): Promise<SkillLearnStatus> {
  const loaded = await loadHostConfig(workspaceRoot, process.env);
  const mode = loaded.config.capabilities?.skills?.evolution?.mode;
  if (mode) return { mode, source: "config" };
  return { mode: "notice", source: "default" };
}

export async function setProjectSkillLearnMode(
  workspaceRoot: string,
  mode: SkillLearnMode,
): Promise<SkillLearnSetResult> {
  const configPath = projectConfigPath(workspaceRoot);
  const config = await readJsonObject(configPath);
  const capabilities = ensureObject(config, "capabilities");
  const skills = ensureObject(capabilities, "skills");
  const evolution = ensureObject(skills, "evolution");
  evolution.mode = mode;
  await writeJsonObject(configPath, config);
  return { mode, source: "config", path: configPath };
}

export function parseSkillLearnMode(rest: string): SkillLearnMode | undefined {
  const value = rest.trim();
  if (!value) return undefined;
  if (!SKILL_LEARN_MODES.includes(value as SkillLearnMode)) {
    throw new Error(`usage: /skill-learn [${SKILL_LEARN_MODES.join("|")}]`);
  }
  return value as SkillLearnMode;
}

export function formatSkillLearnStatus(status: SkillLearnStatus): string {
  return status.source === "default"
    ? `${status.mode} (default)`
    : `${status.mode} (config)`;
}

const REUSE_PATTERNS: readonly RegExp[] = [
  /\bremember (this|that|to)\b/u,
  /\bnext time\b/u,
  /\bfrom now on\b/u,
  /\balways\b.+\b(use|do|run|check|prefer)\b/u,
  /以后.*(这样|记住|都|总是)/u,
  /下次.*(这样|记住|都|先|不要)/u,
  /记住(这个|这点|这样)/u,
];

const CORRECTION_PATTERNS: readonly RegExp[] = [
  /\b(don't|do not|never)\b.+\b(next time|again)\b/u,
  /以后不要/u,
];

export function detectSkillLearnNotice(
  goals: readonly string[],
): SkillLearnNotice | null {
  const goal = latestGoal(goals);
  if (!goal) return null;
  const normalized = goal.toLowerCase();
  const reuse = REUSE_PATTERNS.some((pattern) => pattern.test(normalized));
  const correction = CORRECTION_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
  if (!reuse && !correction) return null;
  const reason = reuse ? "explicit reuse instruction" : "workflow correction";
  return {
    reason,
    evidence: captureEvidence(
      [goal],
      [...REUSE_PATTERNS, ...CORRECTION_PATTERNS],
    ),
  };
}

/**
 * Picks the user instruction that justifies the notice: the most recent goal
 * that individually matches a trigger pattern, else the most recent non-empty
 * goal. Returned verbatim (condensed), so the learned draft records what the
 * user actually said rather than a placeholder.
 */
function captureEvidence(
  goals: readonly string[],
  patterns: readonly RegExp[],
): string {
  for (let i = goals.length - 1; i >= 0; i -= 1) {
    const goal = goals[i]?.trim();
    if (goal && patterns.some((pattern) => pattern.test(goal.toLowerCase()))) {
      return condenseEvidence(goal);
    }
  }
  const last = [...goals].reverse().find((goal) => goal.trim().length > 0);
  return condenseEvidence(last?.trim() ?? "");
}

function condenseEvidence(text: string): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length > 280 ? `${collapsed.slice(0, 277)}...` : collapsed;
}

export function detectSkillLearnTarget(
  goals: readonly string[],
): string | undefined {
  const goal = latestGoal(goals);
  if (!goal) return undefined;
  const combined = goal.toLowerCase();
  const patterns = [
    /\bskill\s+([a-z0-9][a-z0-9-]{0,63})\b/u,
    /\b([a-z0-9][a-z0-9-]{0,63})\s+skill\b/u,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(combined);
    const name = match?.[1];
    if (name && !isReservedSkillTarget(name)) return name;
  }
  return undefined;
}

function latestGoal(goals: readonly string[]): string | undefined {
  for (let i = goals.length - 1; i >= 0; i -= 1) {
    const goal = goals[i]?.trim();
    if (goal) return goal;
  }
  return undefined;
}

export async function createSkillLearnDraftProposal(
  workspaceRoot: string,
  notice: SkillLearnNotice,
  options: CreateSkillLearnDraftProposalOptions = {},
): Promise<SkillLearnDraftProposal> {
  const loaded = await loadHostConfig(workspaceRoot, process.env);
  const evidence =
    notice.evidence.trim().length > 0
      ? condenseEvidence(notice.evidence)
      : "Reusable workflow guidance noticed in a TUI session.";
  const description = learnSummaryDescription(evidence);
  const provenance = { sessionId: options.sessionId, rationale: description };
  const applyEdit = (beforeContent: string): string =>
    appendLearning(beforeContent, evidence);
  const roots = await existingSkillRoots(
    resolveSkillRootsForRuntime(
      workspaceRoot,
      loaded.config.capabilities?.skills?.roots,
      process.env,
    ),
  );

  // A detected target name is only a hint. Honor it solely when it resolves to
  // an existing Skill (appending the captured learning to it). A name that
  // matches no Skill is almost certainly a false-positive extraction from the
  // user's prose (e.g. "use the skill here" -> "here"), so we must NOT create a
  // brand-new Skill named after it; fall back to the session-learnings draft.
  if (options.targetSkillName) {
    try {
      return toDraftProposal(
        await createSkillUpdateProposal({
          workspaceRoot,
          skillRoots: roots,
          name: options.targetSkillName,
          description,
          applyEdit,
          provenance,
        }),
      );
    } catch (error) {
      if (!isSkillNotFoundError(error)) throw error;
    }
  }

  // Default target: session-learnings. Append the learning to the existing
  // draft Skill if it exists, otherwise create it with the captured content.
  try {
    return toDraftProposal(
      await createSkillUpdateProposal({
        workspaceRoot,
        skillRoots: roots,
        name: SKILL_LEARN_DRAFT_SKILL_NAME,
        description,
        applyEdit,
        provenance,
      }),
    );
  } catch (error) {
    if (!isSkillNotFoundError(error)) throw error;
  }

  return toDraftProposal(
    await createSkillCreateProposal({
      workspaceRoot,
      name: SKILL_LEARN_DRAFT_SKILL_NAME,
      description,
      content: renderSessionLearningsSkill(evidence),
      provenance,
    }),
  );
}

function toDraftProposal(proposal: {
  id: string;
  kind: "create" | "update";
  skillName: string;
  state: string;
  path: string;
}): SkillLearnDraftProposal {
  return {
    id: proposal.id,
    kind: proposal.kind,
    skillName: proposal.skillName,
    state: proposal.state,
    path: proposal.path,
  };
}

export async function applySkillLearnDraftProposal(
  workspaceRoot: string,
  proposal: SkillLearnDraftProposal,
): Promise<SkillLearnAutoApplyResult> {
  if (proposal.skillName !== SKILL_LEARN_DRAFT_SKILL_NAME) {
    throw new Error(
      `Skill learn auto apply cannot apply ${proposal.skillName}`,
    );
  }
  if (proposal.state !== "draft") {
    throw new Error(`Skill learn auto apply requires a draft proposal`);
  }
  const applied = await applySkillProposal(workspaceRoot, proposal.id);
  return {
    proposalId: applied.proposal.id,
    historyId: applied.history.id,
    doctorStatus: applied.doctor.status,
  };
}

const SESSION_LEARNINGS_DESCRIPTION =
  "Reusable, project-specific workflow guidance captured from explicit user instructions in past sessions. Consult before recurring tasks to follow established conventions.";

const SESSION_LEARNINGS_PREAMBLE =
  "Captured verbatim from the user's own explicit reuse instructions during TUI sessions. Evidence is limited to the user's prompts; tool output, logs, web pages, and command output are never used as learning evidence. Review the session transcript before relying on an entry.";

function learnSummaryDescription(evidence: string): string {
  return condenseEvidence(`Capture session learning: ${evidence}`);
}

/** Full SKILL.md for a fresh session-learnings Skill seeded with one learning. */
function renderSessionLearningsSkill(evidence: string): string {
  return [
    "---",
    `name: ${SKILL_LEARN_DRAFT_SKILL_NAME}`,
    `description: ${SESSION_LEARNINGS_DESCRIPTION}`,
    'version: "1.0.0"',
    "metadata:",
    '  version: "1.0.0"',
    "---",
    "",
    "# Session Learnings",
    "",
    SESSION_LEARNINGS_PREAMBLE,
    "",
    "## Learnings",
    "",
    `- ${evidence}`,
    "",
  ].join("\n");
}

/**
 * Appends the captured learning as a bullet under a "## Learnings" section,
 * creating the section if absent. De-duplicates: an identical bullet leaves the
 * content unchanged so repeated sessions do not pile up duplicates.
 */
function appendLearning(beforeContent: string, evidence: string): string {
  const bullet = `- ${evidence}`;
  const trimmed = beforeContent.replace(/\s+$/u, "");
  const alreadyPresent = trimmed
    .split("\n")
    .some((line) => line.trim() === bullet);
  if (alreadyPresent) return `${trimmed}\n`;
  if (/^##\s+Learnings\s*$/mu.test(trimmed)) {
    return `${trimmed}\n${bullet}\n`;
  }
  return [trimmed, "", "## Learnings", "", bullet, ""].join("\n");
}

function isReservedSkillTarget(name: string): boolean {
  return new Set([
    "a",
    "an",
    "the",
    "this",
    "that",
    "with",
    "for",
    "from",
    "next",
    "current",
  ]).has(name);
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) throw new Error("config must be a JSON object");
    return parsed;
  } catch (error) {
    if (isMissingFileError(error)) return {};
    throw error;
  }
}

async function writeJsonObject(
  path: string,
  value: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureObject(
  target: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = target[key];
  if (value === undefined) {
    const next: Record<string, unknown> = {};
    target[key] = next;
    return next;
  }
  if (!isRecord(value)) throw new Error(`${key} must be a JSON object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isSkillNotFoundError(error: unknown): boolean {
  return error instanceof Error && /^Skill not found:/u.test(error.message);
}
