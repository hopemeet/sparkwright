import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireWorktree } from "../src/concurrency/index.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempRoots.length = 0;
});

function git(cwd: string, args: string[]): { code: number; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { code: r.status ?? -1, out: `${r.stdout}\n${r.stderr}` };
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

async function makeRepo(): Promise<{ repoRoot: string; sessionDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "sparkwright-wt-"));
  tempRoots.push(root);
  // Initialize a minimal repo with one commit on branch "main".
  expect(git(root, ["init", "-q", "-b", "main"]).code).toBe(0);
  expect(git(root, ["config", "user.email", "t@example.com"]).code).toBe(0);
  expect(git(root, ["config", "user.name", "Test"]).code).toBe(0);
  expect(git(root, ["config", "commit.gpgsign", "false"]).code).toBe(0);
  await writeFile(join(root, "README.md"), "hello\n");
  expect(git(root, ["add", "."]).code).toBe(0);
  expect(git(root, ["commit", "-q", "-m", "init"]).code).toBe(0);
  const sessionDir = join(root, ".sparkwright", "sessions", "sess1");
  return { repoRoot: root, sessionDir };
}

describe("acquireWorktree", () => {
  it("creates a worktree under sessionDir/worktrees/<taskId> on a new branch", async () => {
    const { repoRoot, sessionDir } = await makeRepo();
    const handle = await acquireWorktree({
      repoRoot,
      sessionDir,
      taskId: "task-1",
    });
    expect(handle.path).toBe(join(sessionDir, "worktrees", "task-1"));
    expect(handle.branch).toBe("sw/task-1");
    // Worktree directory exists.
    const s = await stat(handle.path);
    expect(s.isDirectory()).toBe(true);
    // README.md inherited.
    expect(
      normalizeNewlines(await readFile(join(handle.path, "README.md"), "utf8")),
    ).toBe("hello\n");
    // git worktree list mentions the branch. Windows may report the same
    // temp directory through a long path while Node returns a short path.
    const list = git(repoRoot, ["worktree", "list", "--porcelain"]).out;
    expect(list).toContain("branch refs/heads/sw/task-1");
    await handle.release();
  });

  it("mergeBack reports no-changes when the worktree made no commits", async () => {
    const { repoRoot, sessionDir } = await makeRepo();
    const handle = await acquireWorktree({
      repoRoot,
      sessionDir,
      taskId: "task-2",
    });
    const r = await handle.mergeBack();
    expect(r.status).toBe("no-changes");
    await handle.release();
  });

  it("mergeBack fast-forwards when the worktree adds commits on a disjoint path", async () => {
    const { repoRoot, sessionDir } = await makeRepo();
    const handle = await acquireWorktree({
      repoRoot,
      sessionDir,
      taskId: "task-3",
    });
    // Commit a new file in the worktree.
    await writeFile(join(handle.path, "feature.txt"), "feature\n");
    expect(git(handle.path, ["add", "feature.txt"]).code).toBe(0);
    expect(git(handle.path, ["commit", "-q", "-m", "feature"]).code).toBe(0);
    const r = await handle.mergeBack();
    expect(r.status).toBe("merged");
    // Parent repo now has feature.txt.
    const merged = await readFile(join(repoRoot, "feature.txt"), "utf8");
    expect(normalizeNewlines(merged)).toBe("feature\n");
    await handle.release();
  });

  it("release with keep:true preserves the worktree directory", async () => {
    const { repoRoot, sessionDir } = await makeRepo();
    const handle = await acquireWorktree({
      repoRoot,
      sessionDir,
      taskId: "task-4",
    });
    await writeFile(join(handle.path, "scratch.txt"), "x\n");
    await handle.release({ keep: true });
    // Directory still exists.
    const s = await stat(handle.path);
    expect(s.isDirectory()).toBe(true);
  });

  it("release without keep removes the worktree and branch", async () => {
    const { repoRoot, sessionDir } = await makeRepo();
    const handle = await acquireWorktree({
      repoRoot,
      sessionDir,
      taskId: "task-5",
    });
    await handle.release();
    // Worktree path is gone.
    await expect(stat(handle.path)).rejects.toThrow();
    // Branch is gone.
    const list = git(repoRoot, ["branch", "--list", handle.branch]).out;
    expect(list.trim()).toBe("");
  });

  it("mergeBack returns conflict + conflictedFiles when ff-only fails", async () => {
    const { repoRoot, sessionDir } = await makeRepo();
    // Diverge: main moves forward on README.md while a worktree also edits README.md.
    const handle = await acquireWorktree({
      repoRoot,
      sessionDir,
      taskId: "task-6",
    });
    await writeFile(join(handle.path, "README.md"), "child edit\n");
    expect(git(handle.path, ["add", "README.md"]).code).toBe(0);
    expect(git(handle.path, ["commit", "-q", "-m", "child"]).code).toBe(0);
    // Parent moves on its own README.md too.
    await writeFile(join(repoRoot, "README.md"), "parent edit\n");
    expect(git(repoRoot, ["add", "README.md"]).code).toBe(0);
    expect(git(repoRoot, ["commit", "-q", "-m", "parent"]).code).toBe(0);
    // Default (3-way) merge: real conflicting edits on README.md surface
    // the conflicted file by name.
    const r = await handle.mergeBack();
    expect(r.status).toBe("conflict");
    if (r.status === "conflict") {
      expect(r.conflictedFiles).toContain("README.md");
    }
    // ff-only fails earlier (no shared ancestry beyond the fork) and may
    // not materialize a conflict before bailing — only stderr is guaranteed.
    const r2 = await handle.mergeBack({ ffOnly: true });
    expect(r2.status).toBe("conflict");
    if (r2.status === "conflict") {
      expect(typeof r2.stderr).toBe("string");
    }
    await handle.release({ keep: true });
  });

  it("rejects unsafe taskIds", async () => {
    const { repoRoot, sessionDir } = await makeRepo();
    await expect(
      acquireWorktree({
        repoRoot,
        sessionDir,
        taskId: "../escape",
      }),
    ).rejects.toThrow(/filesystem-safe/);
  });
});
