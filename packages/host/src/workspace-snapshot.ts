import { createHash } from "node:crypto";
import { lstat, readFile, readlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { LocalWorkspace } from "@sparkwright/core";

const SNAPSHOT_FILE_CAPTURE_LIMIT_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_TOTAL_CAPTURE_LIMIT_BYTES = 25 * 1024 * 1024;
const AUDIT_EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
]);
// SparkWright's own control-plane runtime state lives under .sparkwright/ but is
// written by the framework (session traces, the task store, TUI history/stash),
// not by the shell command under audit. Excluding it keeps the mutation audit
// from flagging framework writes as untracked shell mutations. Managed
// capability packages under .sparkwright/{skills,agents,command} are
// deliberately NOT excluded — the foreground audit still guards them.
const AUDIT_EXCLUDED_PATHS = new Set([
  ".sparkwright/sessions",
  ".sparkwright/tasks",
  ".sparkwright/workflow-runs",
]);
const AUDIT_EXCLUDED_FILES = new Set([
  ".sparkwright/tui-history.jsonl",
  ".sparkwright/tui-stash.json",
]);
const MANAGED_CAPABILITY_PREFIXES = [
  ".sparkwright/skills/",
  ".sparkwright/agents/",
  ".sparkwright/command/",
];

export interface WorkspaceSnapshotEntry {
  kind: "file" | "symlink";
  hash: string;
  content?: Buffer;
}

export type WorkspaceSnapshot = Map<string, WorkspaceSnapshotEntry>;

export interface WorkspaceMutationChange {
  path: string;
  kind: "created" | "modified" | "deleted";
}

export interface WorkspaceRollbackResult {
  /** @reserved Public rollback diagnostic field consumed from serialized error metadata. */
  restored: string[];
  /** @reserved Public rollback diagnostic field consumed from serialized error metadata. */
  removed: string[];
  /** @reserved Public rollback diagnostic field consumed from serialized error metadata. */
  failed: Array<{ path: string; error: string }>;
  /** @reserved Public rollback diagnostic field consumed from serialized error metadata. */
  incomplete: string[];
}

export async function snapshotWorkspace(
  root: string,
): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = new Map();
  let capturedBytes = 0;

  async function visit(relativeDir: string): Promise<void> {
    const absoluteDir = relativeDir ? join(root, relativeDir) : root;
    const entries = await readdir(absoluteDir, { withFileTypes: true }).catch(
      () => [],
    );

    for (const entry of entries) {
      const relativePath = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        if (shouldSkipAuditDirectory(relativePath, entry.name)) continue;
        await visit(relativePath);
        continue;
      }
      if (AUDIT_EXCLUDED_FILES.has(relativePath)) continue;

      const absolutePath = join(root, relativePath);
      const stat = await lstat(absolutePath).catch(() => undefined);
      if (stat?.isSymbolicLink()) {
        const target = await readlink(absolutePath).catch(() => undefined);
        if (target !== undefined) {
          snapshot.set(relativePath, {
            kind: "symlink",
            hash: hashBuffer(Buffer.from(`symlink\0${target}`)),
          });
        }
        continue;
      }
      if (!stat?.isFile()) continue;
      const content = await readFile(absolutePath).catch(() => undefined);
      if (content === undefined) continue;

      const canCapture =
        content.byteLength <= SNAPSHOT_FILE_CAPTURE_LIMIT_BYTES &&
        capturedBytes + content.byteLength <=
          SNAPSHOT_TOTAL_CAPTURE_LIMIT_BYTES;
      if (canCapture) capturedBytes += content.byteLength;
      snapshot.set(relativePath, {
        kind: "file",
        hash: hashBuffer(content),
        ...(canCapture ? { content } : {}),
      });
    }
  }

  await visit("");
  return snapshot;
}

export function isManagedCapabilityPath(path: string): boolean {
  return MANAGED_CAPABILITY_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function diffWorkspaceSnapshots(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): WorkspaceMutationChange[] {
  const changes: WorkspaceMutationChange[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const prior = before.get(path);
    const next = after.get(path);
    if (!prior && next) changes.push({ path, kind: "created" });
    else if (prior && !next) changes.push({ path, kind: "deleted" });
    else if (
      prior &&
      next &&
      (prior.kind !== next.kind || prior.hash !== next.hash)
    ) {
      changes.push({ path, kind: "modified" });
    }
  }
  return changes;
}

export async function rollbackWorkspaceSnapshot(
  root: string,
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): Promise<WorkspaceRollbackResult> {
  const workspace = new LocalWorkspace(root);
  const restored: string[] = [];
  const removed: string[] = [];
  const failed: WorkspaceRollbackResult["failed"] = [];
  const incomplete: string[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);

  for (const path of [...paths].sort()) {
    const prior = before.get(path);
    const next = after.get(path);
    if (!prior && next) {
      try {
        await workspace.removeFile(path);
        removed.push(path);
      } catch (error) {
        failed.push({ path, error: formatError(error) });
      }
      continue;
    }
    if (!prior) continue;
    if (next && next.kind === prior.kind && next.hash === prior.hash) {
      continue;
    }
    if (prior.kind !== "file" || !prior.content) {
      incomplete.push(path);
      continue;
    }
    try {
      if (next?.kind === "symlink") await workspace.removeFile(path);
      await workspace.writeBytes(path, prior.content);
      restored.push(path);
    } catch (error) {
      failed.push({ path, error: formatError(error) });
    }
  }

  return { restored, removed, failed, incomplete };
}

function shouldSkipAuditDirectory(relativePath: string, name: string): boolean {
  return (
    AUDIT_EXCLUDED_DIRS.has(name) || AUDIT_EXCLUDED_PATHS.has(relativePath)
  );
}

function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
