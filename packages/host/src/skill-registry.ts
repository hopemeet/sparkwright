import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteText } from "@sparkwright/agent-runtime";
import {
  computeAssetPackageHash,
  PACKAGE_HASH_POLICY_VERSION,
} from "@sparkwright/skills";
import { projectSkillRoot } from "./skill-roots.js";

const REGISTRY_SCHEMA_VERSION = 1 as const;

export interface SkillArtifactRecord {
  artifactId: string;
  activePath?: string;
  packageHash?: string;
  packageHashPolicyVersion?: 1 | 2;
  derivedFrom?: string;
  status: "active" | "orphaned" | "conflicted";
  createdAt: string;
  updatedAt: string;
}

export interface SkillRegistry {
  schemaVersion: typeof REGISTRY_SCHEMA_VERSION;
  artifacts: SkillArtifactRecord[];
}

export type SkillReconciliationKind =
  | "adopt"
  | "move"
  | "copy"
  | "reidentify"
  | "orphan";

/** Observation record, deliberately not a managed-change mutation receipt. */
export interface SkillReconciliationReceipt {
  schemaVersion: 1;
  receiptId: string;
  kind: SkillReconciliationKind;
  artifactId: string;
  /** @reserved Public observed identity recorded for reconciliation audit. */
  observedPackageHash?: string;
  packageHashPolicyVersion?: 1 | 2;
  /** @reserved Public prior path recorded for reconciliation audit. */
  previousPath?: string;
  /** @reserved Public current path recorded for reconciliation audit. */
  currentPath?: string;
  derivedFrom?: string;
  /** @reserved Public reconciliation timestamp consumed by history UIs. */
  reconciledAt: string;
}

export interface SkillReconciliationFinding {
  kind: "unregistered" | "drift" | "missing";
  skillName?: string;
  artifactId?: string;
  path?: string;
  /** @reserved Public observed identity consumed by reconciliation review UIs. */
  observedPackageHash?: string;
}

export function skillRegistryPath(workspaceRoot: string): string {
  return join(
    workspaceRoot,
    ".sparkwright",
    "skill-registry",
    "v1",
    "registry.json",
  );
}

export async function readSkillRegistry(
  workspaceRoot: string,
): Promise<SkillRegistry> {
  const path = skillRegistryPath(workspaceRoot);
  const raw = await readFile(path, "utf8").catch(() => undefined);
  if (!raw) return { schemaVersion: REGISTRY_SCHEMA_VERSION, artifacts: [] };
  const parsed: unknown = JSON.parse(raw);
  if (!isRegistry(parsed)) throw new Error(`Invalid Skill registry: ${path}`);
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    artifacts: parsed.artifacts.map((artifact) => ({ ...artifact })),
  };
}

export async function scanSkillReconciliation(
  workspaceRoot: string,
): Promise<SkillReconciliationFinding[]> {
  const registry = await readSkillRegistry(workspaceRoot);
  const root = projectSkillRoot(workspaceRoot);
  const names = await readdir(root, { withFileTypes: true }).catch(() => []);
  const observed = new Map<string, { path: string; packageHash: string }>();
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    const hash = await computeAssetPackageHash({
      rootPath: path,
      entryPath: "SKILL.md",
    });
    observed.set(entry.name, { path, packageHash: hash.packageHash });
  }
  const findings: SkillReconciliationFinding[] = [];
  const activeByPath = new Map(
    registry.artifacts
      .filter((artifact) => artifact.status === "active" && artifact.activePath)
      .map((artifact) => [artifact.activePath!, artifact]),
  );
  for (const [name, current] of observed) {
    const artifact = activeByPath.get(name);
    if (!artifact) {
      findings.push({
        kind: "unregistered",
        skillName: name,
        path: current.path,
        observedPackageHash: current.packageHash,
      });
    } else if (
      artifact.packageHash !== current.packageHash ||
      artifact.packageHashPolicyVersion !== PACKAGE_HASH_POLICY_VERSION
    ) {
      findings.push({
        kind: "drift",
        skillName: name,
        artifactId: artifact.artifactId,
        path: current.path,
        observedPackageHash: current.packageHash,
      });
    }
  }
  for (const artifact of registry.artifacts) {
    if (
      artifact.status === "active" &&
      artifact.activePath &&
      !observed.has(artifact.activePath)
    ) {
      findings.push({
        kind: "missing",
        artifactId: artifact.artifactId,
        skillName: artifact.activePath,
      });
    }
  }
  return findings.sort((left, right) =>
    `${left.kind}:${left.skillName ?? left.artifactId}`.localeCompare(
      `${right.kind}:${right.skillName ?? right.artifactId}`,
    ),
  );
}

export async function reconcileSkill(input: {
  workspaceRoot: string;
  kind: SkillReconciliationKind;
  skillName?: string;
  artifactId?: string;
  sourceArtifactId?: string;
}): Promise<SkillReconciliationReceipt> {
  const registry = await readSkillRegistry(input.workspaceRoot);
  const now = new Date().toISOString();
  const existing = input.artifactId
    ? registry.artifacts.find(
        (artifact) => artifact.artifactId === input.artifactId,
      )
    : undefined;
  if (input.kind === "orphan") {
    if (!existing) throw new Error("orphan requires an existing artifactId.");
    const previousPath = existing.activePath;
    existing.status = "orphaned";
    existing.activePath = undefined;
    existing.updatedAt = now;
    return persistReconciliation(input.workspaceRoot, registry, {
      kind: "orphan",
      artifactId: existing.artifactId,
      ...(previousPath ? { previousPath } : {}),
      reconciledAt: now,
    });
  }
  if (!input.skillName || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.skillName)) {
    throw new Error("reconciliation requires a valid project Skill name.");
  }
  const skillPath = join(
    projectSkillRoot(input.workspaceRoot),
    input.skillName,
  );
  const identity = await computeAssetPackageHash({
    rootPath: skillPath,
    entryPath: "SKILL.md",
  });
  if (input.kind === "copy" && !input.sourceArtifactId) {
    throw new Error("copy requires sourceArtifactId.");
  }
  const artifactId =
    input.kind === "reidentify" || input.kind === "copy"
      ? `skill_${randomUUID()}`
      : (existing?.artifactId ?? `skill_${randomUUID()}`);
  const previousPath = existing?.activePath;
  const source = input.sourceArtifactId
    ? registry.artifacts.find(
        (artifact) => artifact.artifactId === input.sourceArtifactId,
      )
    : undefined;
  if (input.sourceArtifactId && !source)
    throw new Error("Unknown sourceArtifactId.");
  const record: SkillArtifactRecord = {
    artifactId,
    activePath: input.skillName,
    packageHash: identity.packageHash,
    packageHashPolicyVersion: identity.packageHashPolicyVersion,
    ...(input.kind === "copy" && source
      ? { derivedFrom: source.artifactId }
      : {}),
    status: "active",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (input.kind === "reidentify" && existing) {
    existing.status = "orphaned";
    existing.activePath = undefined;
    existing.updatedAt = now;
  }
  if (existing && input.kind !== "reidentify") Object.assign(existing, record);
  else registry.artifacts.push(record);
  return persistReconciliation(input.workspaceRoot, registry, {
    kind: input.kind,
    artifactId,
    observedPackageHash: identity.packageHash,
    packageHashPolicyVersion: identity.packageHashPolicyVersion,
    ...(previousPath ? { previousPath } : {}),
    currentPath: input.skillName,
    ...(record.derivedFrom ? { derivedFrom: record.derivedFrom } : {}),
    reconciledAt: now,
  });
}

async function persistReconciliation(
  workspaceRoot: string,
  registry: SkillRegistry,
  receipt: Omit<SkillReconciliationReceipt, "schemaVersion" | "receiptId">,
): Promise<SkillReconciliationReceipt> {
  const fullReceipt: SkillReconciliationReceipt = {
    schemaVersion: 1,
    receiptId: `skillrecon_${randomUUID()}`,
    ...receipt,
  };
  await atomicWriteText(
    skillRegistryPath(workspaceRoot),
    `${JSON.stringify(registry, null, 2)}\n`,
    { durable: true },
  );
  await atomicWriteText(
    join(
      workspaceRoot,
      ".sparkwright",
      "skill-registry",
      "v1",
      "reconciliation",
      `${fullReceipt.receiptId}.json`,
    ),
    `${JSON.stringify(fullReceipt, null, 2)}\n`,
    { durable: true },
  );
  return fullReceipt;
}

function isRegistry(value: unknown): value is SkillRegistry {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { schemaVersion?: unknown }).schemaVersion ===
      REGISTRY_SCHEMA_VERSION &&
    Array.isArray((value as { artifacts?: unknown }).artifacts)
  );
}
