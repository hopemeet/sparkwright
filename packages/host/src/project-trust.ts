import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, relative, sep } from "node:path";
import { atomicWriteText } from "@sparkwright/agent-runtime";
import { PROJECT_TRUST_SCOPES as PROTOCOL_PROJECT_TRUST_SCOPES } from "@sparkwright/protocol";
import type {
  ProjectTrustEffect,
  ProjectTrustScope,
  ProjectTrustScopeSnapshot,
  ProjectTrustSnapshot,
} from "@sparkwright/protocol";
import { parse as parseYaml } from "yaml";
import { CONFIG_FILE_BASENAMES } from "./config/contracts.js";

const PROJECT_TRUST_STATE_VERSION = 1;
const PROJECT_TRUST_MANIFEST_VERSION = 1;
const MAX_SCOPE_FILES = 2_048;
const MAX_SCOPE_BYTES = 16 * 1024 * 1024;

export const PROJECT_TRUST_SCOPES = PROTOCOL_PROJECT_TRUST_SCOPES;

const DIRECTORY_SCOPE_PATHS: Readonly<
  Record<Exclude<ProjectTrustScope, "config">, string>
> = {
  commands: "command",
  skills: "skills",
  agents: "agents",
  workflows: "workflows",
};

const SCOPE_EFFECTS: Readonly<
  Record<ProjectTrustScope, readonly ProjectTrustEffect[]>
> = {
  config: ["runtime_configuration", "process", "network"],
  commands: ["process"],
  skills: ["process"],
  agents: ["process", "network"],
  workflows: ["process", "network"],
};

interface ProjectTrustGrantRecord {
  manifestHash: string;
  grantedAt: string;
}

interface ProjectTrustWorkspaceRecord {
  canonicalWorkspaceRoot: string;
  scopes: Partial<Record<ProjectTrustScope, ProjectTrustGrantRecord>>;
  updatedAt: string;
}

interface ProjectTrustStateFile {
  version: typeof PROJECT_TRUST_STATE_VERSION;
  workspaces: Record<string, ProjectTrustWorkspaceRecord>;
}

interface ScopeManifest {
  scope: ProjectTrustScope;
  manifestHash?: string;
  fileCount: number;
  byteCount: number;
  invalidReason?: "symlink_not_allowed" | "limit_exceeded" | "read_failed";
}

export interface ProjectTrustManagerOptions {
  env?: Record<string, string | undefined>;
  statePath?: string;
  now?: () => Date;
}

export type ProjectTrustMutationResult =
  | { ok: true; snapshot: ProjectTrustSnapshot }
  | {
      ok: false;
      code: "conflict" | "invalid_payload";
      message: string;
      snapshot?: ProjectTrustSnapshot;
    };

/**
 * Host-owned trust store for repository-authored executable capabilities.
 *
 * Trust lives outside the workspace and is pinned to both its canonical path
 * and a bounded, symlink-free content manifest. It only admits project assets
 * into the existing runtime governance chain; it never relaxes approvals,
 * access mode, sandboxing, confidential paths, or write policy.
 */
export class ProjectTrustManager {
  private readonly env: Record<string, string | undefined>;
  private readonly statePath: string;
  private readonly now: () => Date;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: ProjectTrustManagerOptions = {}) {
    this.env = options.env ?? process.env;
    this.statePath = options.statePath ?? projectTrustStatePath(this.env);
    this.now = options.now ?? (() => new Date());
  }

  async inspect(workspaceRoot: string): Promise<ProjectTrustSnapshot> {
    const canonicalWorkspaceRoot = await realpath(workspaceRoot);
    const [manifests, state] = await Promise.all([
      buildProjectTrustManifest(canonicalWorkspaceRoot),
      this.readState(),
    ]);
    return projectTrustSnapshot(
      canonicalWorkspaceRoot,
      manifests,
      state.workspaces[workspaceTrustKey(canonicalWorkspaceRoot)],
    );
  }

  async grant(input: {
    workspaceRoot: string;
    expectedManifestHash: string;
    scopes?: readonly ProjectTrustScope[];
  }): Promise<ProjectTrustMutationResult> {
    let result: ProjectTrustMutationResult | undefined;
    await this.enqueueMutation(async () => {
      const canonicalWorkspaceRoot = await realpath(input.workspaceRoot);
      const manifests = await buildProjectTrustManifest(canonicalWorkspaceRoot);
      const state = await this.readState();
      const key = workspaceTrustKey(canonicalWorkspaceRoot);
      const before = projectTrustSnapshot(
        canonicalWorkspaceRoot,
        manifests,
        state.workspaces[key],
      );
      if (before.manifestHash !== input.expectedManifestHash) {
        result = {
          ok: false,
          code: "conflict",
          message:
            "Project capability manifest changed after inspection; inspect it again before granting trust.",
          snapshot: before,
        };
        return;
      }
      const requested = normalizeRequestedScopes(input.scopes, before);
      if (requested.length === 0) {
        result = {
          ok: false,
          code: "invalid_payload",
          message: "No present project capability scopes were selected.",
          snapshot: before,
        };
        return;
      }
      const invalid = requested.find(
        (scope) => scopeStatus(before, scope)?.status === "invalid",
      );
      if (invalid) {
        result = {
          ok: false,
          code: "invalid_payload",
          message: `Project capability scope "${invalid}" has an invalid manifest and cannot be trusted.`,
          snapshot: before,
        };
        return;
      }
      const now = this.now().toISOString();
      const previous = state.workspaces[key];
      const scopes = { ...(previous?.scopes ?? {}) };
      for (const scope of requested) {
        const manifestHash = scopeStatus(before, scope)?.manifestHash;
        if (!manifestHash) continue;
        scopes[scope] = { manifestHash, grantedAt: now };
      }
      state.workspaces[key] = {
        canonicalWorkspaceRoot,
        scopes,
        updatedAt: now,
      };
      await this.writeState(state);
      result = {
        ok: true,
        snapshot: projectTrustSnapshot(
          canonicalWorkspaceRoot,
          manifests,
          state.workspaces[key],
        ),
      };
    });
    return result!;
  }

  async revoke(input: {
    workspaceRoot: string;
    scopes?: readonly ProjectTrustScope[];
  }): Promise<ProjectTrustMutationResult> {
    let result: ProjectTrustMutationResult | undefined;
    await this.enqueueMutation(async () => {
      const canonicalWorkspaceRoot = await realpath(input.workspaceRoot);
      const manifests = await buildProjectTrustManifest(canonicalWorkspaceRoot);
      const state = await this.readState();
      const key = workspaceTrustKey(canonicalWorkspaceRoot);
      const previous = state.workspaces[key];
      if (previous) {
        if (!input.scopes || input.scopes.length === 0) {
          delete state.workspaces[key];
        } else {
          const scopes = { ...previous.scopes };
          for (const scope of new Set(input.scopes)) delete scopes[scope];
          if (Object.keys(scopes).length === 0) delete state.workspaces[key];
          else {
            state.workspaces[key] = {
              ...previous,
              scopes,
              updatedAt: this.now().toISOString(),
            };
          }
        }
        await this.writeState(state);
      }
      result = {
        ok: true,
        snapshot: projectTrustSnapshot(
          canonicalWorkspaceRoot,
          manifests,
          state.workspaces[key],
        ),
      };
    });
    return result!;
  }

  private enqueueMutation(run: () => Promise<void>): Promise<void> {
    const next = this.mutationQueue.then(run, run);
    this.mutationQueue = next.catch(() => undefined);
    return next;
  }

  private async writeState(state: ProjectTrustStateFile): Promise<void> {
    await atomicWriteText(
      this.statePath,
      `${JSON.stringify(state, null, 2)}\n`,
      {
        mode: 0o600,
        durable: true,
      },
    );
  }

  private async readState(): Promise<ProjectTrustStateFile> {
    let raw: string;
    try {
      raw = await readFile(this.statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: PROJECT_TRUST_STATE_VERSION, workspaces: {} };
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Invalid project trust state at ${this.statePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isProjectTrustStateFile(parsed)) {
      throw new Error(`Invalid project trust state at ${this.statePath}.`);
    }
    return parsed;
  }
}

export function projectTrustStatePath(
  env: Record<string, string | undefined> = process.env,
): string {
  const stateBase =
    env.XDG_STATE_HOME && env.XDG_STATE_HOME.length > 0
      ? env.XDG_STATE_HOME
      : join(homedir(), ".local", "state");
  return join(stateBase, "sparkwright", "project-trust.json");
}

export function isProjectScopeTrusted(
  snapshot: ProjectTrustSnapshot,
  scope: ProjectTrustScope,
): boolean {
  const entry = scopeStatus(snapshot, scope);
  return entry?.status === "trusted" || entry?.status === "not_present";
}

export function summarizeProjectTrust(
  snapshot: ProjectTrustSnapshot,
): Omit<ProjectTrustSnapshot, "canonicalWorkspaceRoot"> {
  const { canonicalWorkspaceRoot: _workspaceRoot, ...summary } = snapshot;
  return summary;
}

async function buildProjectTrustManifest(
  canonicalWorkspaceRoot: string,
): Promise<ScopeManifest[]> {
  const manifests: ScopeManifest[] = [];
  manifests.push(await buildConfigScopeManifest(canonicalWorkspaceRoot));
  for (const scope of PROJECT_TRUST_SCOPES) {
    if (scope === "config") continue;
    manifests.push(
      await buildDirectoryScopeManifest(
        canonicalWorkspaceRoot,
        scope,
        DIRECTORY_SCOPE_PATHS[scope],
      ),
    );
  }
  return manifests;
}

async function buildConfigScopeManifest(
  workspaceRoot: string,
): Promise<ScopeManifest> {
  const entries: Array<{ path: string; content: Buffer }> = [];
  for (const name of CONFIG_FILE_BASENAMES) {
    const path = join(workspaceRoot, ".sparkwright", name);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return invalidManifest("config", "read_failed");
    }
    if (info.isSymbolicLink()) {
      return invalidManifest("config", "symlink_not_allowed");
    }
    if (!info.isFile()) continue;
    let content: Buffer;
    try {
      content = await readFile(path);
    } catch {
      return invalidManifest("config", "read_failed");
    }
    if (!projectConfigRequiresTrust(name, content)) continue;
    entries.push({ path: `.sparkwright/${name}`, content });
  }
  return hashScopeEntries("config", entries);
}

async function buildDirectoryScopeManifest(
  workspaceRoot: string,
  scope: Exclude<ProjectTrustScope, "config">,
  directoryName: string,
): Promise<ScopeManifest> {
  const root = join(workspaceRoot, ".sparkwright", directoryName);
  const entries: Array<{ path: string; content: Buffer }> = [];
  let invalidReason: ScopeManifest["invalidReason"];
  let totalBytes = 0;

  const walk = async (dir: string): Promise<void> => {
    if (invalidReason) return;
    let children;
    try {
      children = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && dir === root) {
        return;
      }
      invalidReason = "read_failed";
      return;
    }
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const path = join(dir, child.name);
      if (child.isSymbolicLink()) {
        invalidReason = "symlink_not_allowed";
        return;
      }
      if (child.isDirectory()) {
        await walk(path);
        if (invalidReason) return;
        continue;
      }
      if (!child.isFile()) continue;
      let content: Buffer;
      try {
        content = await readFile(path);
      } catch {
        invalidReason = "read_failed";
        return;
      }
      entries.push({
        path: relative(workspaceRoot, path).split(sep).join("/"),
        content,
      });
      totalBytes += content.length;
      if (entries.length > MAX_SCOPE_FILES || totalBytes > MAX_SCOPE_BYTES) {
        invalidReason = "limit_exceeded";
        return;
      }
    }
  };

  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return hashScopeEntries(scope, []);
    }
    return invalidManifest(scope, "read_failed");
  }
  if (rootInfo.isSymbolicLink()) {
    return invalidManifest(scope, "symlink_not_allowed");
  }
  if (!rootInfo.isDirectory()) return hashScopeEntries(scope, []);
  await walk(root);
  return invalidReason
    ? invalidManifest(scope, invalidReason, entries)
    : hashScopeEntries(scope, entries);
}

function hashScopeEntries(
  scope: ProjectTrustScope,
  entries: Array<{ path: string; content: Buffer }>,
): ScopeManifest {
  const byteCount = entries.reduce(
    (total, entry) => total + entry.content.length,
    0,
  );
  if (entries.length === 0) return { scope, fileCount: 0, byteCount: 0 };
  const digest = createHash("sha256");
  digest.update(
    `sparkwright-project-trust-v${PROJECT_TRUST_MANIFEST_VERSION}\0`,
  );
  digest.update(`${scope}\0`);
  for (const entry of entries.sort((a, b) => a.path.localeCompare(b.path))) {
    digest.update(entry.path);
    digest.update("\0");
    digest.update(String(entry.content.length));
    digest.update("\0");
    digest.update(entry.content);
    digest.update("\0");
  }
  return {
    scope,
    manifestHash: `sha256:${digest.digest("hex")}`,
    fileCount: entries.length,
    byteCount,
  };
}

function invalidManifest(
  scope: ProjectTrustScope,
  invalidReason: NonNullable<ScopeManifest["invalidReason"]>,
  entries: Array<{ path: string; content: Buffer }> = [],
): ScopeManifest {
  return {
    scope,
    fileCount: entries.length,
    byteCount: entries.reduce(
      (total, entry) => total + entry.content.length,
      0,
    ),
    invalidReason,
  };
}

function projectConfigRequiresTrust(name: string, content: Buffer): boolean {
  let parsed: unknown;
  try {
    const raw = content.toString("utf8");
    parsed = [".yaml", ".yml"].includes(extname(name).toLowerCase())
      ? parseYaml(raw)
      : JSON.parse(raw);
  } catch {
    // Invalid project config remains in the manifest and is rejected by the
    // normal config validator. It must not become a way to evade change pins.
    return true;
  }
  if (!isRecord(parsed)) return true;
  if (
    parsed.workspace !== undefined ||
    parsed.shell !== undefined ||
    parsed.tasks !== undefined ||
    parsed.identity !== undefined
  ) {
    return true;
  }
  if (projectToolsRequireTrust(parsed.tools)) return true;
  if (projectPolicyRequiresTrust(parsed.policy)) return true;
  if (projectCapabilitiesRequireTrust(parsed.capabilities)) return true;
  if (isRecord(parsed.run)) {
    const safeRunKeys = new Set(["accessMode", "backgroundTasks"]);
    if (Object.keys(parsed.run).some((key) => !safeRunKeys.has(key)))
      return true;
  }
  return false;
}

function projectToolsRequireTrust(value: unknown): boolean {
  return isRecord(value) && value.defer !== undefined;
}

function projectPolicyRequiresTrust(value: unknown): boolean {
  if (!isRecord(value)) return value !== undefined;
  if (value.confidentialDefaults === false) return true;
  const sandbox = value.sandbox;
  if (!isRecord(sandbox)) return sandbox !== undefined;
  if (sandbox.mode !== undefined && sandbox.mode !== "enforce") return true;
  if (
    sandbox.failIfUnavailable !== undefined &&
    sandbox.failIfUnavailable !== true
  ) {
    return true;
  }
  if (isRecord(sandbox.filesystem)) {
    if (
      sandbox.filesystem.allowRead !== undefined ||
      sandbox.filesystem.allowWrite !== undefined ||
      sandbox.filesystem.tmp === true
    ) {
      return true;
    }
  } else if (sandbox.filesystem !== undefined) {
    return true;
  }
  if (isRecord(sandbox.network)) {
    if (sandbox.network.mode !== undefined && sandbox.network.mode !== "deny") {
      return true;
    }
  } else if (sandbox.network !== undefined) {
    return true;
  }
  return false;
}

function projectCapabilitiesRequireTrust(value: unknown): boolean {
  if (value === undefined) return false;
  if (!isRecord(value)) return true;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  if (keys.length !== 1 || keys[0] !== "web") return true;
  return !isRecord(value.web);
}

function projectTrustSnapshot(
  canonicalWorkspaceRoot: string,
  manifests: readonly ScopeManifest[],
  record: ProjectTrustWorkspaceRecord | undefined,
): ProjectTrustSnapshot {
  const scopes = manifests.map((manifest): ProjectTrustScopeSnapshot => {
    const grant = record?.scopes[manifest.scope];
    const status: ProjectTrustScopeSnapshot["status"] = manifest.invalidReason
      ? "invalid"
      : !manifest.manifestHash
        ? "not_present"
        : grant?.manifestHash === manifest.manifestHash
          ? "trusted"
          : grant
            ? "changed"
            : "untrusted";
    return {
      scope: manifest.scope,
      status,
      effects: [...SCOPE_EFFECTS[manifest.scope]],
      fileCount: manifest.fileCount,
      byteCount: manifest.byteCount,
      ...(manifest.manifestHash ? { manifestHash: manifest.manifestHash } : {}),
      ...(grant?.manifestHash
        ? { trustedManifestHash: grant.manifestHash }
        : {}),
      ...(grant?.grantedAt ? { grantedAt: grant.grantedAt } : {}),
      ...(manifest.invalidReason ? { reason: manifest.invalidReason } : {}),
    };
  });
  const present = scopes.filter((scope) => scope.status !== "not_present");
  const manifestDigest = createHash("sha256");
  manifestDigest.update(
    `sparkwright-project-trust-set-v${PROJECT_TRUST_MANIFEST_VERSION}\0`,
  );
  for (const scope of scopes) {
    manifestDigest.update(scope.scope);
    manifestDigest.update("\0");
    manifestDigest.update(
      scope.manifestHash ?? `invalid:${scope.reason ?? "none"}`,
    );
    manifestDigest.update("\0");
  }
  const status: ProjectTrustSnapshot["status"] =
    present.length === 0
      ? "not_required"
      : present.some((scope) => scope.status === "invalid")
        ? "invalid"
        : present.some((scope) => scope.status === "changed")
          ? "changed"
          : present.every((scope) => scope.status === "trusted")
            ? "trusted"
            : "untrusted";
  return {
    canonicalWorkspaceRoot,
    workspaceId: `workspace_${workspaceTrustKey(canonicalWorkspaceRoot).slice(0, 20)}`,
    status,
    manifestHash: `sha256:${manifestDigest.digest("hex")}`,
    scopes,
  };
}

function normalizeRequestedScopes(
  requested: readonly ProjectTrustScope[] | undefined,
  snapshot: ProjectTrustSnapshot,
): ProjectTrustScope[] {
  const present = new Set(
    snapshot.scopes
      .filter((scope) => scope.status !== "not_present")
      .map((scope) => scope.scope),
  );
  const candidates = requested?.length ? requested : PROJECT_TRUST_SCOPES;
  return [...new Set(candidates)].filter((scope) => present.has(scope));
}

function scopeStatus(
  snapshot: ProjectTrustSnapshot,
  scope: ProjectTrustScope,
): ProjectTrustScopeSnapshot | undefined {
  return snapshot.scopes.find((entry) => entry.scope === scope);
}

function workspaceTrustKey(canonicalWorkspaceRoot: string): string {
  return createHash("sha256").update(canonicalWorkspaceRoot).digest("hex");
}

function isProjectTrustStateFile(
  value: unknown,
): value is ProjectTrustStateFile {
  if (!isRecord(value) || value.version !== PROJECT_TRUST_STATE_VERSION) {
    return false;
  }
  if (!isRecord(value.workspaces)) return false;
  return Object.values(value.workspaces).every((workspace) => {
    if (
      !isRecord(workspace) ||
      typeof workspace.canonicalWorkspaceRoot !== "string" ||
      typeof workspace.updatedAt !== "string" ||
      !isRecord(workspace.scopes)
    ) {
      return false;
    }
    return Object.entries(workspace.scopes).every(([scope, grant]) => {
      return (
        (PROJECT_TRUST_SCOPES as readonly string[]).includes(scope) &&
        isRecord(grant) &&
        typeof grant.manifestHash === "string" &&
        typeof grant.grantedAt === "string"
      );
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
