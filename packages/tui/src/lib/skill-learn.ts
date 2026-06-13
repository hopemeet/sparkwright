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

export function detectSkillLearnNotice(
  goals: readonly string[],
): SkillLearnNotice | null {
  const combined = goals.join("\n").toLowerCase();
  if (!combined.trim()) return null;
  if (
    /\bremember (this|that|to)\b/u.test(combined) ||
    /\bnext time\b/u.test(combined) ||
    /\bfrom now on\b/u.test(combined) ||
    /\balways\b.+\b(use|do|run|check|prefer)\b/u.test(combined)
  ) {
    return { reason: "explicit reuse instruction" };
  }
  if (
    /以后.*(这样|记住|都|总是)/u.test(combined) ||
    /下次.*(这样|记住|都|先|不要)/u.test(combined) ||
    /记住(这个|这点|这样)/u.test(combined)
  ) {
    return { reason: "explicit reuse instruction" };
  }
  if (
    /\b(don't|do not|never)\b.+\b(next time|again)\b/u.test(combined) ||
    /以后不要/u.test(combined)
  ) {
    return { reason: "workflow correction" };
  }
  return null;
}

export function detectSkillLearnTarget(
  goals: readonly string[],
): string | undefined {
  const combined = goals.join("\n").toLowerCase();
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

export async function createSkillLearnDraftProposal(
  workspaceRoot: string,
  notice: SkillLearnNotice,
  options: CreateSkillLearnDraftProposalOptions = {},
): Promise<SkillLearnDraftProposal> {
  const loaded = await loadHostConfig(workspaceRoot, process.env);
  const description = skillLearnDraftDescription(notice);
  const roots = await existingSkillRoots(
    resolveSkillRootsForRuntime(
      workspaceRoot,
      loaded.config.capabilities?.skills?.roots,
      process.env,
    ),
  );

  // A detected target name is only a hint. Honor it solely when it resolves to
  // an existing Skill (producing an update/fork proposal). A name that matches
  // no Skill is almost certainly a false-positive extraction from the user's
  // prose (e.g. "use the skill here" -> "here"), so we must NOT create a
  // brand-new Skill named after it; fall back to the session-learnings draft.
  if (options.targetSkillName) {
    try {
      return toDraftProposal(
        await createSkillUpdateProposal({
          workspaceRoot,
          skillRoots: roots,
          name: options.targetSkillName,
          description,
        }),
      );
    } catch (error) {
      if (!isSkillNotFoundError(error)) throw error;
    }
  }

  // Default target: session-learnings. Update the existing draft Skill if it
  // already exists, otherwise create it.
  try {
    return toDraftProposal(
      await createSkillUpdateProposal({
        workspaceRoot,
        skillRoots: roots,
        name: SKILL_LEARN_DRAFT_SKILL_NAME,
        description,
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

function skillLearnDraftDescription(notice: SkillLearnNotice): string {
  return [
    "Captures explicit reusable workflow guidance noticed in a TUI session.",
    `Trigger: ${notice.reason}.`,
    "Evidence: deterministic TUI learning detected explicit reuse wording in the user's own prompt.",
    "Safety: tool output, logs, webpages, and command output were not used as learning evidence.",
    "Review the session transcript before applying.",
  ].join(" ");
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
