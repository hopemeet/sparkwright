// AI maintenance note: Worktree adapter wraps `git worktree` for the
// concurrency layer. It is invoked by Leader code that has already cleared a
// claim through ConcurrencyCoordinator, so by the contract of declarative
// partitioning `mergeBack()` is conflict-free in the happy path. The default
// merge is a regular `git merge` (fast-forward when possible, otherwise a
// 3-way merge) — declarative partitioning guarantees 3-way is clean for
// parallel sibling branches, where strict ff-only would fail after the first
// sibling merges. Pass `ffOnly: true` for chains where the branch is known
// to be strictly ancestral. Conflict outcomes are still surfaced for the
// rare cases where declarations drift from reality — the Leader records
// `[ ] ❌` on the todo and keeps the worktree for human inspection.
//
// Path layout: <sessionDir>/worktrees/<taskId> for the working tree,
// branch name "<branchPrefix>/<taskId>" by default. Both are predictable so
// stale state from previous runs can be detected and cleaned up.

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Options for {@link acquireWorktree}.
 *
 * @public
 * @stability experimental v0.1
 */
export interface AcquireWorktreeOptions {
  /** Absolute path to the parent git repository. */
  repoRoot: string;
  /**
   * Absolute path to the session directory (typically
   * `<workspace>/.sparkwright/sessions/<sessionId>`). The worktree is created
   * under `<sessionDir>/worktrees/<taskId>`.
   */
  sessionDir: string;
  /** Stable id used in the worktree path and default branch name. */
  taskId: string;
  /** Source ref the worktree is forked from. Default: "HEAD". */
  baseRef?: string;
  /** Branch-name prefix. Default: "sw". */
  branchPrefix?: string;
  /** Custom git executable. Default: "git". */
  gitExecutable?: string;
}

/**
 * Outcome of `mergeBack()`.
 *
 * @public
 * @stability experimental v0.1
 */
export type MergeBackResult =
  | { status: "merged"; commit: string }
  | { status: "no-changes" }
  | { status: "conflict"; conflictedFiles: string[]; stderr: string };

/**
 * Handle returned by {@link acquireWorktree}. Holds the worktree path and
 * branch name, plus operations to merge the branch back and tear the
 * worktree down.
 *
 * @public
 * @stability experimental v0.1
 */
export interface WorktreeHandle {
  /** Absolute path to the worktree's working directory. */
  path: string;
  /** Branch the worktree checked out. */
  branch: string;
  /**
   * Merge the worktree's branch back into `target` in the parent repo.
   * Default target is the parent's current branch (i.e. whichever ref was
   * checked out in `repoRoot` at acquire time).
   *
   * Default: a regular `git merge` (fast-forward when possible, otherwise
   * 3-way). Declarative partitioning makes the 3-way merge conflict-free
   * for sibling branches. Pass `ffOnly: true` only when the worktree
   * branch is known to be strictly ancestral to the target — e.g. a
   * chained workflow where no sibling has merged in between.
   *
   * @reserved Public worktree lifecycle helper consumed by orchestrators.
   */
  mergeBack(options?: {
    target?: string;
    ffOnly?: boolean;
  }): Promise<MergeBackResult>;
  /**
   * Remove the worktree and delete the branch. When `keep: true`, both
   * the directory and the git worktree registration are preserved so a
   * human can inspect what happened — useful after a merge conflict or
   * a partition audit failure. A future `git worktree remove --force
   * <path>` cleans up.
   */
  release(options?: { keep?: boolean }): Promise<void>;
}

/**
 * Allocate a fresh git worktree under `<sessionDir>/worktrees/<taskId>` on a
 * new branch derived from `baseRef`. The caller drives execution inside
 * `handle.path` (typically by passing it as the child sub-agent's workspace),
 * then calls `mergeBack()` followed by `release()` when done.
 *
 * @public
 * @stability experimental v0.1
 */
export async function acquireWorktree(
  options: AcquireWorktreeOptions,
): Promise<WorktreeHandle> {
  const repoRoot = resolve(options.repoRoot);
  const sessionDir = resolve(options.sessionDir);
  const taskId = options.taskId;
  if (!/^[A-Za-z0-9_.-]+$/.test(taskId)) {
    throw new Error(
      `acquireWorktree: taskId must be filesystem-safe (got: ${taskId})`,
    );
  }
  const baseRef = options.baseRef ?? "HEAD";
  const branchPrefix = options.branchPrefix ?? "sw";
  const git = options.gitExecutable ?? "git";

  const worktreePath = join(sessionDir, "worktrees", taskId);
  const branch = `${branchPrefix}/${taskId}`;

  await mkdir(dirname(worktreePath), { recursive: true });

  // `git worktree add -b <branch> <path> <baseRef>` creates the directory
  // and the branch atomically. If <path> already exists git refuses.
  const add = await runGit(
    git,
    ["worktree", "add", "-b", branch, worktreePath, baseRef],
    repoRoot,
  );
  if (add.code !== 0) {
    throw new Error(
      `git worktree add failed (exit ${add.code}): ${add.stderr.trim() || add.stdout.trim()}`,
    );
  }

  return makeHandle({
    repoRoot,
    worktreePath,
    branch,
    git,
  });
}

interface HandleContext {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  git: string;
}

function makeHandle(ctx: HandleContext): WorktreeHandle {
  let released = false;
  return {
    path: ctx.worktreePath,
    branch: ctx.branch,
    async mergeBack(opts = {}): Promise<MergeBackResult> {
      if (released) {
        throw new Error("WorktreeHandle: mergeBack called after release.");
      }
      // Detect whether the branch has any commits beyond its merge base. If
      // not, there's nothing to merge.
      const range = await runGit(
        ctx.git,
        ["rev-list", "--count", `HEAD..${ctx.branch}`],
        ctx.repoRoot,
      );
      if (range.code !== 0) {
        throw new Error(
          `git rev-list failed (exit ${range.code}): ${range.stderr.trim()}`,
        );
      }
      const commits = Number.parseInt(range.stdout.trim(), 10);
      if (!Number.isFinite(commits) || commits <= 0) {
        return { status: "no-changes" };
      }

      const args = ["merge", "--no-edit"];
      if (opts.ffOnly === true) args.push("--ff-only");
      const target = opts.target;
      if (target) {
        const checkout = await runGit(
          ctx.git,
          ["checkout", target],
          ctx.repoRoot,
        );
        if (checkout.code !== 0) {
          throw new Error(
            `git checkout ${target} failed (exit ${checkout.code}): ${checkout.stderr.trim()}`,
          );
        }
      }
      args.push(ctx.branch);
      const merge = await runGit(ctx.git, args, ctx.repoRoot);
      if (merge.code === 0) {
        const head = await runGit(ctx.git, ["rev-parse", "HEAD"], ctx.repoRoot);
        return { status: "merged", commit: head.stdout.trim() };
      }
      // Non-zero exit: try to extract conflicted files for the report. If
      // the merge left the index in conflict, `git diff --name-only
      // --diff-filter=U` lists them; abort the merge so the repo returns to
      // a clean state.
      const conflictedFiles = await listConflictedFiles(ctx);
      await runGit(ctx.git, ["merge", "--abort"], ctx.repoRoot).catch(
        () => undefined,
      );
      return {
        status: "conflict",
        conflictedFiles,
        stderr: merge.stderr.trim(),
      };
    },
    async release(opts = {}): Promise<void> {
      if (released) return;
      released = true;
      // keep:true → leave both the directory and the worktree registration
      // intact so a human can inspect. They run `git worktree remove --force
      // <path>` later to clean up.
      if (opts.keep === true) return;
      const remove = await runGit(
        ctx.git,
        ["worktree", "remove", "--force", ctx.worktreePath],
        ctx.repoRoot,
      );
      if (remove.code !== 0) {
        // Worktree directory may already be gone; prune stale metadata.
        await runGit(ctx.git, ["worktree", "prune"], ctx.repoRoot).catch(
          () => undefined,
        );
      }
      await runGit(ctx.git, ["branch", "-D", ctx.branch], ctx.repoRoot).catch(
        () => undefined,
      );
    },
  };
}

async function listConflictedFiles(ctx: HandleContext): Promise<string[]> {
  const r = await runGit(
    ctx.git,
    ["diff", "--name-only", "--diff-filter=U"],
    ctx.repoRoot,
  );
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

interface GitOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

function runGit(git: string, args: string[], cwd: string): Promise<GitOutcome> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(git, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Disable any pager so output is captured cleanly.
        GIT_PAGER: "cat",
        // Disable .gitconfig hooks like commit signing that could prompt.
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => rejectPromise(err));
    child.on("close", (code) => {
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}
