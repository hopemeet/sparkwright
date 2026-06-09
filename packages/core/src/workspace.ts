// AI maintenance note: Workspace owns the path boundary and write-through-
// approval flow. Tools must never touch the filesystem directly; route
// through `RuntimeContext.workspace`. Writes go through ControlledWorkspace,
// which emits diff artifacts and gates via approval/policy.

import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, basename, relative, resolve, sep } from "node:path";
import { createArtifactId, createWorkspaceWriteId } from "./ids.js";
import type { EventLog } from "./events.js";
import type { ApprovalResolver } from "./approval.js";
import { createApprovalRequest, resolveApproval } from "./approval.js";
import {
  AnchoredEditError,
  applyAnchoredEdits,
  createAnchoredText,
  type AnchoredEditOperation,
  type AnchoredText,
  type ApplyAnchoredEditsResult,
} from "./anchored-edit.js";
import { createDefaultPolicy, type Policy } from "./policy.js";
import type { WorkspaceCheckpointStore } from "./workspace-checkpoint.js";
import type {
  Artifact,
  RunRecord,
  RunState,
  WorkspaceRuntime,
  WorkspaceWriteProposal,
  WorkspaceWriteResult,
} from "./types.js";
import {
  runValidationHooks,
  validationFailureMessage,
  type ValidationHook,
} from "./validation.js";

/** @internal Reference local filesystem workspace with realpath containment. */
export class LocalWorkspace {
  readonly root: string;
  private resolvedRoot?: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async readText(path: string): Promise<string> {
    const fullPath = await this.resolveInsideRoot(path);
    return readFile(fullPath, "utf8");
  }

  async readAnchoredText(path: string): Promise<AnchoredText> {
    return createAnchoredText(path, await this.readText(path));
  }

  async editAnchoredText(
    path: string,
    edits: AnchoredEditOperation[],
  ): Promise<ApplyAnchoredEditsResult> {
    const result = applyAnchoredEdits({
      path,
      content: await this.readText(path),
      edits,
    });
    await this.writeText(path, result.content);
    return result;
  }

  async writeText(path: string, content: string): Promise<void> {
    const fullPath = await this.resolveInsideRoot(path);
    await this.assertWritePathHasNoSymlinkSegments(fullPath, path);
    // Create missing parent dirs so a write to a not-yet-existing nested path
    // succeeds before the file is written. Containment is already enforced
    // above by resolveInsideRoot + the symlink-segment check, so the recursive
    // mkdir cannot escape the root.
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
    await this.assertResolvedPathStillInsideRoot(fullPath, path);
  }

  async diffText(path: string, nextContent: string): Promise<string> {
    const current = await this.readText(path).catch(() => "");
    return createSimpleTextDiff(path, current, nextContent);
  }

  /**
   * Remove a file inside the root. Used by checkpoint rollback to undo the
   * creation of files that did not exist when a checkpoint opened. Missing
   * targets are a no-op. Subject to the same containment + symlink checks as
   * writes.
   */
  async removeFile(path: string): Promise<void> {
    const fullPath = await this.resolveInsideRoot(path);
    await this.assertWritePathHasNoSymlinkSegments(fullPath, path);
    await rm(fullPath, { force: true });
  }

  async resolveInsideRoot(path: string): Promise<string> {
    const fullPath = resolve(this.root, path);
    await this.assertResolvedPathStillInsideRoot(fullPath, path);

    return fullPath;
  }

  async canonicalPath(path: string): Promise<string> {
    const fullPath = await this.resolveInsideRoot(path);
    const realRoot = await this.getResolvedRoot();
    const realFullPath = await resolveRealPathAllowMissing(fullPath);
    return relative(realRoot, realFullPath).split(sep).join("/");
  }

  private async getResolvedRoot(): Promise<string> {
    if (this.resolvedRoot !== undefined) return this.resolvedRoot;
    try {
      this.resolvedRoot = await realpath(this.root);
    } catch {
      this.resolvedRoot = this.root;
    }
    return this.resolvedRoot;
  }

  private async assertResolvedPathStillInsideRoot(
    fullPath: string,
    path: string,
  ): Promise<void> {
    const realRoot = await this.getResolvedRoot();
    const realFullPath = await resolveRealPathAllowMissing(fullPath);
    const rel = relative(realRoot, realFullPath);

    if (rel.startsWith("..") || rel === ".." || realFullPath === realRoot) {
      throw new WorkspaceRuntimeError(
        "WORKSPACE_PATH_ESCAPED",
        `Path escapes workspace root: ${path}`,
        { path },
      );
    }
  }

  private async assertWritePathHasNoSymlinkSegments(
    fullPath: string,
    path: string,
  ): Promise<void> {
    const realRoot = await this.getResolvedRoot();
    let current = await resolveRealPathAllowMissing(fullPath);
    const pathsToCheck: string[] = [];

    while (current !== realRoot && current !== dirname(current)) {
      pathsToCheck.push(current);
      current = dirname(current);
    }

    for (const candidate of pathsToCheck.reverse()) {
      const stat = await lstat(candidate).catch(() => undefined);
      if (!stat?.isSymbolicLink()) continue;

      throw new WorkspaceRuntimeError(
        "WORKSPACE_SYMLINK_WRITE_DENIED",
        `Workspace writes cannot target symlink paths: ${path}`,
        { path },
      );
    }
  }
}

async function resolveRealPathAllowMissing(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    // Target may not exist (e.g., writing a new file). Resolve the deepest
    // existing ancestor, then rejoin the remaining segments. This still catches
    // symlinks placed anywhere along the chain.
    const parent = dirname(target);
    if (parent === target) return target;
    const realParent = await resolveRealPathAllowMissing(parent);
    return resolve(realParent, basename(target));
  }
}

export interface ControlledWorkspaceOptions {
  run: RunRecord;
  workspace: WorkspaceRuntime;
  events: EventLog;
  policy?: Policy;
  approvalResolver?: ApprovalResolver;
  validationHooks?: ValidationHook[];
  /**
   * Optional setState callback used to mutate run state through the run's
   * legal-transition guard. When omitted, falls back to a minimal in-place
   * mutation (kept for backward compatibility in standalone usage).
   */
  setState?: (state: RunState) => void;
  /**
   * Optional transparent checkpoint store. When provided, the prior content of
   * each file is captured before it is written (after approval/policy pass),
   * so a turn's writes can be rolled back. The model never sees it.
   */
  checkpointStore?: WorkspaceCheckpointStore;
}

/** @internal Reference `WorkspaceRuntime` with policy + approval + validation. */
export class ControlledWorkspace implements WorkspaceRuntime {
  private readonly policy: Policy;

  constructor(private readonly options: ControlledWorkspaceOptions) {
    this.policy = options.policy ?? createDefaultPolicy();
  }

  async readText(path: string): Promise<string> {
    const workspacePath = await this.canonicalizePath(path);
    const content = await this.options.workspace.readText(workspacePath);
    this.options.events.emit("workspace.read", { path: workspacePath });
    return content;
  }

  async readAnchoredText(path: string): Promise<AnchoredText> {
    const workspacePath = await this.canonicalizePath(path);
    const anchored = createAnchoredText(
      workspacePath,
      await this.options.workspace.readText(workspacePath),
    );
    this.options.events.emit("workspace.anchored_read", {
      path: workspacePath,
      anchorSetId: anchored.anchorSetId,
      lineCount: anchored.lineCount,
      metadata: anchored.metadata,
    });
    return anchored;
  }

  async editAnchoredText(
    path: string,
    edits: AnchoredEditOperation[],
    options: { reason?: string } = {},
  ): Promise<ApplyAnchoredEditsResult & { write?: WorkspaceWriteResult }> {
    const workspacePath = await this.canonicalizePath(path);
    this.options.events.emit("workspace.anchored_edit.requested", {
      path: workspacePath,
      edits,
      reason: options.reason,
    });

    let result: ApplyAnchoredEditsResult;
    try {
      result = applyAnchoredEdits({
        path: workspacePath,
        content: await this.options.workspace.readText(workspacePath),
        edits,
      });
    } catch (cause) {
      const error = normalizeAnchoredEditError(cause, workspacePath);
      this.options.events.emit("workspace.anchored_edit.rejected", {
        path: workspacePath,
        edits,
        reason: error.message,
        error: {
          code: error.code,
          message: error.message,
          metadata: error.metadata,
        },
      });
      throw new WorkspaceRuntimeError(error.code, error.message, {
        path,
        edits,
        ...error.metadata,
      });
    }

    this.options.events.emit("workspace.anchored_edit.verified", {
      path: workspacePath,
      anchors: result.anchors,
      editCount: edits.length,
    });
    const write = await this.writeText(workspacePath, result.content, options);
    return { ...result, write };
  }

  async diffText(path: string, nextContent: string): Promise<string> {
    return this.options.workspace.diffText(path, nextContent);
  }

  async writeText(
    path: string,
    content: string,
    options: { reason?: string } = {},
  ): Promise<WorkspaceWriteResult> {
    const workspacePath = await this.canonicalizePath(path);
    const proposal = await this.proposeWrite(workspacePath, content, options);
    this.options.events.emit("workspace.write.requested", proposal);

    const validationFailure = await runValidationHooks({
      hooks: this.options.validationHooks ?? [],
      stage: "workspace_write",
      run: this.options.run,
      subject: proposal,
      metadata: {
        path: workspacePath,
        reason: options.reason,
        proposalId: proposal.id,
      },
      events: this.options.events,
    });

    if (validationFailure) {
      this.options.events.emit("workspace.write.denied", {
        proposalId: proposal.id,
        path: workspacePath,
        reason: validationFailureMessage(validationFailure),
        validation: validationFailure,
      });
      throw new WorkspaceRuntimeError(
        "VALIDATION_FAILED",
        `Workspace write validation failed: ${workspacePath}`,
        {
          path: workspacePath,
          proposalId: proposal.id,
          validation: validationFailure,
        },
      );
    }

    const decision = await this.policy.decide({
      action: "workspace.write",
      metadata: {
        path: workspacePath,
        resource: workspacePath,
        reason: options.reason,
        proposalId: proposal.id,
        diff: proposal.diff,
      },
    });

    if (decision.decision === "deny") {
      this.options.events.emit("workspace.write.denied", {
        proposalId: proposal.id,
        path: workspacePath,
        reason: decision.reason,
        policy: decision,
      });
      throw new WorkspaceRuntimeError(
        "POLICY_DENIED",
        `Workspace write denied: ${decision.reason}`,
        {
          path: workspacePath,
          reason: decision.reason,
          proposalId: proposal.id,
        },
      );
    }

    if (decision.decision === "requires_approval") {
      if (!this.options.approvalResolver) {
        this.options.events.emit("workspace.write.denied", {
          proposalId: proposal.id,
          path: workspacePath,
          reason: "Approval required but no approval resolver was configured.",
          policy: decision,
        });
        throw new WorkspaceRuntimeError(
          "APPROVAL_UNAVAILABLE",
          "Workspace write requires approval but no approval resolver was configured.",
          {
            path: workspacePath,
            proposalId: proposal.id,
          },
        );
      }

      const request = createApprovalRequest({
        runId: this.options.run.id,
        action: "workspace.write",
        summary: `Write ${workspacePath}`,
        details: {
          path: workspacePath,
          reason: options.reason,
          proposalId: proposal.id,
          diff: proposal.diff,
          policy: decision,
        },
      });

      this.transitionState("waiting_approval");
      this.options.events.emit("approval.requested", request);
      const response = await resolveApproval(
        request,
        this.options.approvalResolver,
      );
      this.options.events.emit("approval.resolved", response);
      this.transitionState("running");

      if (response.decision !== "approved") {
        this.options.events.emit("workspace.write.denied", {
          proposalId: proposal.id,
          path: workspacePath,
          reason: "Approval denied.",
          approvalId: request.id,
        });
        throw new WorkspaceRuntimeError(
          "APPROVAL_DENIED",
          `Workspace write approval denied: ${workspacePath}`,
          {
            path: workspacePath,
            approvalId: request.id,
            proposalId: proposal.id,
          },
        );
      }
    }

    await this.assertWriteBaselineCurrent(proposal);
    const artifact = this.createDiffArtifact(proposal);
    this.options.events.emit("artifact.created", artifact);
    if (this.options.checkpointStore) {
      // Capture the pre-write image once per file per open checkpoint, so the
      // write can be rolled back. Runs only after policy/approval succeed.
      const prior = await this.options.workspace
        .readText(workspacePath)
        .catch(() => undefined);
      this.options.checkpointStore.recordBeforeWrite({
        path: workspacePath,
        existedBefore: prior !== undefined,
        content: prior,
      });
    }
    await this.options.workspace.writeText(workspacePath, content, options);
    const summary = summarizeWrittenContent(content);
    this.options.events.emit("workspace.write.completed", {
      proposalId: proposal.id,
      path: workspacePath,
      diffArtifactId: artifact.id,
      summary,
    });
    return {
      proposalId: proposal.id,
      path: workspacePath,
      diffArtifactId: artifact.id,
      diffArtifact: artifact,
      summary,
    };
  }

  async proposeWrite(
    path: string,
    content: string,
    options: { reason?: string } = {},
  ): Promise<WorkspaceWriteProposal> {
    const current = await this.options.workspace.readText(path).catch(() => "");
    const diff = createSimpleTextDiff(path, current, content);

    return {
      id: createWorkspaceWriteId(),
      runId: this.options.run.id,
      path,
      content,
      diff,
      reason: options.reason,
      createdAt: new Date().toISOString(),
      metadata: {
        baselineHash: hashText(current),
      },
    };
  }

  private async assertWriteBaselineCurrent(
    proposal: WorkspaceWriteProposal,
  ): Promise<void> {
    const current = await this.options.workspace
      .readText(proposal.path)
      .catch(() => "");
    const currentHash = hashText(current);

    if (proposal.metadata.baselineHash === currentHash) return;

    this.options.events.emit("workspace.write.denied", {
      proposalId: proposal.id,
      path: proposal.path,
      reason: "Workspace file changed after the write was proposed.",
      baselineHash: proposal.metadata.baselineHash,
      currentHash,
    });
    throw new WorkspaceRuntimeError(
      "WORKSPACE_WRITE_CONFLICT",
      `Workspace write conflicted because the file changed: ${proposal.path}`,
      {
        path: proposal.path,
        proposalId: proposal.id,
        baselineHash: proposal.metadata.baselineHash,
        currentHash,
      },
    );
  }

  private transitionState(state: RunState): void {
    if (this.options.setState) {
      this.options.setState(state);
      return;
    }
    // Fallback: direct mutation kept for ad-hoc usage where the workspace is
    // constructed without a host run. Callers wiring the workspace into a
    // SparkwrightRun MUST provide setState so legal-transition checks apply.
    this.options.run.state = state;
    this.options.run.updatedAt = new Date().toISOString();
  }

  private createDiffArtifact(proposal: WorkspaceWriteProposal): Artifact {
    return {
      id: createArtifactId(),
      runId: this.options.run.id,
      type: "diff",
      name: `${proposal.path} diff`,
      content: proposal.diff,
      metadata: {
        targetPath: proposal.path,
        proposalId: proposal.id,
        reason: proposal.reason,
      },
    };
  }

  private async canonicalizePath(path: string): Promise<string> {
    const workspace = this.options.workspace as WorkspaceRuntime & {
      canonicalPath?: (path: string) => Promise<string> | string;
    };

    if (typeof workspace.canonicalPath === "function") {
      return workspace.canonicalPath(path);
    }

    return normalizeWorkspacePath(path);
  }
}

class WorkspaceRuntimeError extends Error {
  readonly code: string;
  readonly metadata: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    metadata: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WorkspaceRuntimeError";
    this.code = code;
    this.metadata = metadata;
  }
}

function normalizeAnchoredEditError(
  cause: unknown,
  path: string,
): AnchoredEditError {
  if (cause instanceof AnchoredEditError) return cause;

  return new AnchoredEditError(
    "ANCHOR_EDIT_FAILED",
    cause instanceof Error ? cause.message : "Anchored edit failed.",
    { path, cause },
  );
}

function hashText(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeWorkspacePath(path: string): string {
  const resolved = resolve("/", path);
  return relative("/", resolved).split(sep).join("/");
}

function summarizeWrittenContent(
  content: string,
): WorkspaceWriteResult["summary"] {
  const lines = splitDiffLines(content);
  return {
    lineCount: lines.length,
    lastLines: lines.slice(-5),
  };
}

export function createSimpleTextDiff(
  path: string,
  before: string,
  after: string,
): string {
  if (before === after) return "";

  const beforeLines = splitDiffLines(before);
  const afterLines = splitDiffLines(after);
  const hunk = createSingleDiffHunk(beforeLines, afterLines, 3);
  const diff = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
    ...hunk.lines,
  ];

  return diff.join("\n");
}

function splitDiffLines(content: string): string[] {
  if (content === "") return [];
  return content.endsWith("\n")
    ? content.slice(0, -1).split("\n")
    : content.split("\n");
}

function createSingleDiffHunk(
  before: string[],
  after: string[],
  contextLines: number,
): {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
} {
  let prefixLength = 0;
  while (
    prefixLength < before.length &&
    prefixLength < after.length &&
    before[prefixLength] === after[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < before.length - prefixLength &&
    suffixLength < after.length - prefixLength &&
    before[before.length - suffixLength - 1] ===
      after[after.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  const oldChangeStart = prefixLength;
  const oldChangeEnd = before.length - suffixLength;
  const newChangeStart = prefixLength;
  const newChangeEnd = after.length - suffixLength;
  const oldStartIndex = Math.max(0, oldChangeStart - contextLines);
  const newStartIndex = Math.max(0, newChangeStart - contextLines);
  const oldEndIndex = Math.min(before.length, oldChangeEnd + contextLines);
  const leadingContext = before.slice(oldStartIndex, oldChangeStart);
  const trailingContext = before.slice(oldChangeEnd, oldEndIndex);
  const removed = before.slice(oldChangeStart, oldChangeEnd);
  const added = after.slice(newChangeStart, newChangeEnd);

  return {
    oldStart: oldStartIndex + 1,
    oldCount: leadingContext.length + removed.length + trailingContext.length,
    newStart: newStartIndex + 1,
    newCount: leadingContext.length + added.length + trailingContext.length,
    lines: [
      ...leadingContext.map((line) => ` ${line}`),
      ...removed.map((line) => `-${line}`),
      ...added.map((line) => `+${line}`),
      ...trailingContext.map((line) => ` ${line}`),
    ],
  };
}
