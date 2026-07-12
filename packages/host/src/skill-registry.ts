import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { atomicWriteText } from "@sparkwright/agent-runtime";
import {
  computeAssetPackageHash,
  PACKAGE_HASH_POLICY_VERSION,
  snapshotAssetPackage,
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
  revision: number;
  artifacts: SkillArtifactRecord[];
}

export interface SkillOrigin {
  schemaVersion: 1;
  artifactId: string;
  kind: "local-path";
  /** @reserved Redacted source locator consumed by future origin inspection UIs. */
  locator: { redacted: string };
  /** @reserved Import timestamp consumed by future origin/history inspection UIs. */
  importedAt: string;
  /** @reserved Imported identity consumed by future upstream-change comparison. */
  importedPackageHash: string;
  packageHashPolicyVersion: 2;
  updatePolicy: "frozen" | "notify";
}

interface SkillOriginInput {
  kind: "local-path";
  locator: { redacted: string };
  updatePolicy: "frozen" | "notify";
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

export async function readSkillOrigin(
  workspaceRoot: string,
  artifactId: string,
): Promise<SkillOrigin | undefined> {
  const path = join(
    skillRegistryRoot(workspaceRoot),
    "origins",
    `${artifactId}.json`,
  );
  const raw = await readFile(path, "utf8").catch(() => undefined);
  return raw ? (JSON.parse(raw) as SkillOrigin) : undefined;
}

export async function importSkill(input: {
  workspaceRoot: string;
  skillName: string;
  sourcePath: string;
  updatePolicy?: "frozen" | "notify";
}): Promise<{ receipt: SkillReconciliationReceipt; origin: SkillOrigin }> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.skillName)) {
    throw new Error("Skill import requires a valid project Skill name.");
  }
  const sourcePath = resolve(input.sourcePath);
  const targetPath = join(
    projectSkillRoot(input.workspaceRoot),
    input.skillName,
  );
  const existing = await computeAssetPackageHash({
    rootPath: targetPath,
    entryPath: "SKILL.md",
  }).catch(() => undefined);
  if (existing)
    throw new Error(`Imported Skill target already exists: ${input.skillName}`);
  const pending = join(
    input.workspaceRoot,
    ".sparkwright",
    "skill-registry",
    "v1",
    "imports",
    `.pending-${randomUUID()}`,
  );
  await snapshotAssetPackage(
    { rootPath: sourcePath, entryPath: "SKILL.md" },
    pending,
  );
  await mkdir(dirname(targetPath), { recursive: true });
  let published = false;
  try {
    await rename(pending, targetPath);
    published = true;
    const receipt = await reconcileSkill({
      workspaceRoot: input.workspaceRoot,
      kind: "adopt",
      skillName: input.skillName,
      origin: {
        kind: "local-path",
        locator: {
          redacted: sourcePath.split(/[\\/]/).at(-1) ?? "local-path",
        },
        updatePolicy: input.updatePolicy ?? "frozen",
      },
    });
    const origin = await readSkillOrigin(
      input.workspaceRoot,
      receipt.artifactId,
    );
    if (!origin) throw new Error("Imported Skill origin was not persisted.");
    return { receipt, origin };
  } catch (error) {
    const pendingTransaction = await readPendingReconciliation(
      input.workspaceRoot,
    );
    if (pendingTransaction?.origin && pendingTransaction.receipt) {
      await recoverPendingReconciliation(input.workspaceRoot);
      return {
        receipt: pendingTransaction.receipt,
        origin: pendingTransaction.origin,
      };
    }
    if (published) {
      const registered = (
        await readSkillRegistry(input.workspaceRoot)
      ).artifacts.some(
        (artifact) =>
          artifact.status === "active" &&
          artifact.activePath === input.skillName,
      );
      if (!registered) await rm(targetPath, { recursive: true, force: true });
    }
    throw error;
  } finally {
    await rm(pending, { recursive: true, force: true });
  }
}

export async function readSkillRegistry(
  workspaceRoot: string,
): Promise<SkillRegistry> {
  const pending = await readFile(
    skillRegistryTransactionPath(workspaceRoot),
    "utf8",
  ).catch(() => undefined);
  if (pending) {
    const parsed = JSON.parse(pending) as { registry?: SkillRegistry };
    if (!parsed.registry || !isRegistry(parsed.registry)) {
      throw new Error("Invalid pending Skill reconciliation transaction.");
    }
    assertRegistryInvariants(parsed.registry);
    return {
      ...parsed.registry,
      revision: parsed.registry.revision ?? 0,
      artifacts: parsed.registry.artifacts.map((artifact) => ({ ...artifact })),
    };
  }
  return readSkillRegistryFile(workspaceRoot);
}

async function readSkillRegistryFile(
  workspaceRoot: string,
): Promise<SkillRegistry> {
  const path = skillRegistryPath(workspaceRoot);
  const raw = await readFile(path, "utf8").catch(() => undefined);
  if (!raw)
    return {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      revision: 0,
      artifacts: [],
    };
  const parsed: unknown = JSON.parse(raw);
  if (!isRegistry(parsed)) throw new Error(`Invalid Skill registry: ${path}`);
  assertRegistryInvariants(parsed);
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    revision: parsed.revision ?? 0,
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
  origin?: SkillOriginInput;
}): Promise<SkillReconciliationReceipt> {
  return withRegistryLock(input.workspaceRoot, async () => {
    await recoverPendingReconciliation(input.workspaceRoot, true);
    return reconcileSkillLocked(input);
  });
}

async function reconcileSkillLocked(input: {
  workspaceRoot: string;
  kind: SkillReconciliationKind;
  skillName?: string;
  artifactId?: string;
  sourceArtifactId?: string;
  origin?: SkillOriginInput;
}): Promise<SkillReconciliationReceipt> {
  const registry = await readSkillRegistryFile(input.workspaceRoot);
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
  const claimed = registry.artifacts.find(
    (artifact) =>
      artifact.status === "active" &&
      artifact.activePath === input.skillName &&
      artifact.artifactId !== existing?.artifactId,
  );
  if (claimed) {
    throw new Error(
      `Skill path is already owned by active artifact ${claimed.artifactId}: ${input.skillName}`,
    );
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
  return persistReconciliation(
    input.workspaceRoot,
    registry,
    {
      kind: input.kind,
      artifactId,
      observedPackageHash: identity.packageHash,
      packageHashPolicyVersion: identity.packageHashPolicyVersion,
      ...(previousPath ? { previousPath } : {}),
      currentPath: input.skillName,
      ...(record.derivedFrom ? { derivedFrom: record.derivedFrom } : {}),
      reconciledAt: now,
    },
    input.origin,
  );
}

async function persistReconciliation(
  workspaceRoot: string,
  registry: SkillRegistry,
  receipt: Omit<SkillReconciliationReceipt, "schemaVersion" | "receiptId">,
  originInput?: SkillOriginInput,
): Promise<SkillReconciliationReceipt> {
  const fullReceipt: SkillReconciliationReceipt = {
    schemaVersion: 1,
    receiptId: `skillrecon_${randomUUID()}`,
    ...receipt,
  };
  const nextRegistry: SkillRegistry = {
    ...registry,
    revision: registry.revision + 1,
  };
  const origin: SkillOrigin | undefined = originInput
    ? {
        schemaVersion: 1,
        artifactId: fullReceipt.artifactId,
        kind: originInput.kind,
        locator: originInput.locator,
        importedAt: fullReceipt.reconciledAt,
        importedPackageHash: fullReceipt.observedPackageHash!,
        packageHashPolicyVersion: 2,
        updatePolicy: originInput.updatePolicy,
      }
    : undefined;
  assertRegistryInvariants(nextRegistry);
  const transactionPath = skillRegistryTransactionPath(workspaceRoot);
  await atomicWriteText(
    transactionPath,
    `${JSON.stringify({ registry: nextRegistry, receipt: fullReceipt, ...(origin ? { origin } : {}) }, null, 2)}\n`,
    { durable: true },
  );
  await atomicWriteText(
    skillRegistryPath(workspaceRoot),
    `${JSON.stringify(nextRegistry, null, 2)}\n`,
    { durable: true },
  );
  if (origin) {
    await atomicWriteText(
      join(
        skillRegistryRoot(workspaceRoot),
        "origins",
        `${origin.artifactId}.json`,
      ),
      `${JSON.stringify(origin, null, 2)}\n`,
      { durable: true },
    );
  }
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
  await rm(transactionPath, { force: true });
  return fullReceipt;
}

function skillRegistryRoot(workspaceRoot: string): string {
  return join(workspaceRoot, ".sparkwright", "skill-registry", "v1");
}

function skillRegistryTransactionPath(workspaceRoot: string): string {
  return join(skillRegistryRoot(workspaceRoot), "reconciliation.pending.json");
}

async function recoverPendingReconciliation(
  workspaceRoot: string,
  lockHeld = false,
): Promise<void> {
  const recover = async () => {
    const path = skillRegistryTransactionPath(workspaceRoot);
    const raw = await readFile(path, "utf8").catch(() => undefined);
    if (!raw) return;
    const parsed = JSON.parse(raw) as PendingSkillReconciliation;
    if (!parsed.registry || !isRegistry(parsed.registry) || !parsed.receipt) {
      throw new Error(
        `Invalid pending Skill reconciliation transaction: ${path}`,
      );
    }
    assertRegistryInvariants(parsed.registry);
    await atomicWriteText(
      skillRegistryPath(workspaceRoot),
      `${JSON.stringify(parsed.registry, null, 2)}\n`,
      { durable: true },
    );
    if (parsed.origin) {
      await atomicWriteText(
        join(
          skillRegistryRoot(workspaceRoot),
          "origins",
          `${parsed.origin.artifactId}.json`,
        ),
        `${JSON.stringify(parsed.origin, null, 2)}\n`,
        { durable: true },
      );
    }
    await atomicWriteText(
      join(
        skillRegistryRoot(workspaceRoot),
        "reconciliation",
        `${parsed.receipt.receiptId}.json`,
      ),
      `${JSON.stringify(parsed.receipt, null, 2)}\n`,
      { durable: true },
    );
    await rm(path, { force: true });
  };
  if (lockHeld) return recover();
  return withRegistryLock(workspaceRoot, recover);
}

interface PendingSkillReconciliation {
  registry?: SkillRegistry;
  receipt?: SkillReconciliationReceipt;
  origin?: SkillOrigin;
}

async function readPendingReconciliation(
  workspaceRoot: string,
): Promise<PendingSkillReconciliation | undefined> {
  const raw = await readFile(
    skillRegistryTransactionPath(workspaceRoot),
    "utf8",
  ).catch(() => undefined);
  return raw ? (JSON.parse(raw) as PendingSkillReconciliation) : undefined;
}

async function withRegistryLock<T>(
  workspaceRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const root = skillRegistryRoot(workspaceRoot);
  const lock = join(root, ".lock");
  await mkdir(root, { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 200)
        throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

function assertRegistryInvariants(registry: SkillRegistry): void {
  const ids = new Set<string>();
  const activePaths = new Set<string>();
  for (const artifact of registry.artifacts) {
    if (ids.has(artifact.artifactId)) {
      throw new Error(`Duplicate Skill artifact id: ${artifact.artifactId}`);
    }
    ids.add(artifact.artifactId);
    if (artifact.status === "active") {
      if (!artifact.activePath) {
        throw new Error(
          `Active Skill artifact has no path: ${artifact.artifactId}`,
        );
      }
      if (activePaths.has(artifact.activePath)) {
        throw new Error(
          `Multiple active Skill artifacts own path: ${artifact.activePath}`,
        );
      }
      activePaths.add(artifact.activePath);
    }
  }
}

function isRegistry(value: unknown): value is SkillRegistry {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { schemaVersion?: unknown }).schemaVersion ===
      REGISTRY_SCHEMA_VERSION &&
    ((value as { revision?: unknown }).revision === undefined ||
      (Number.isInteger((value as { revision?: unknown }).revision) &&
        Number((value as { revision?: unknown }).revision) >= 0)) &&
    Array.isArray((value as { artifacts?: unknown }).artifacts)
  );
}
