// End-to-end demo: a Leader fans out to multiple sub-agents in parallel,
// using the four concurrency primitives shipped by @sparkwright/agent-runtime:
//
//   1. ConcurrencyCoordinator   — declarative writes partitioning (glob)
//   2. acquireWorktree          — per-sub-agent git isolation + 3-way merge
//   3. createTodoTools          — Leader single-writer todo file
//   4. parseSubAgentResult      — structured JSON result protocol + audit
//
// Sub-agent execution is simulated in-process (no model adapter, no tools).
// The shape of "what the sub-agent does" — write declared files, emit a
// final JSON message — is what matters for this demo. For real sub-agent
// dispatch see examples/promote-shell-to-task and the Sub-agents section of
// docs/EXTENSION_INTERFACES.md.

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  ConcurrencyCoordinator,
  acquireWorktree,
  createTodoTools,
  parseSubAgentResult,
  validateDeclaredWrites,
  type TodoItem,
  type TodoStatus,
  type WorktreeHandle,
} from "@sparkwright/agent-runtime";

// ---------------------------------------------------------------------------
// 1. Plan: each child declares the globs it intends to write and the work
//    function the orchestrator will execute inside its worktree.
// ---------------------------------------------------------------------------

interface ChildPlan {
  taskId: string;
  goal: string;
  /** Globs the child is permitted to write. Used by the coordinator AND audited. */
  writes: string[];
  /**
   * Simulates the sub-agent's tool calls. Returns the files it actually
   * wrote (relative to its worktree). A real sub-agent would touch the disk
   * via approved tools; here we touch it directly.
   */
  perform(workspace: string): Promise<{
    actualWrites: string[];
    /** Final JSON message the sub-agent would emit. */
    finalMessage: string;
  }>;
}

// ---------------------------------------------------------------------------
// 2. Leader: dispatch in parallel, audit, merge, update todo.
// ---------------------------------------------------------------------------

interface DispatchOutcome {
  plan: ChildPlan;
  finalStatus: TodoStatus;
  note?: string;
  mergeCommit?: string;
}

async function runLeader(
  repoRoot: string,
  sessionDir: string,
  plans: ChildPlan[],
): Promise<DispatchOutcome[]> {
  const coord = new ConcurrencyCoordinator();
  const { todoWrite } = createTodoTools({
    getTodoPath: () => join(sessionDir, "todo.md"),
  });

  // Initial todo: everything pending.
  await writeTodo(
    todoWrite,
    plans.map<TodoItem>((p) => ({
      title: p.goal,
      status: "pending",
      depth: 0,
    })),
  );

  // Acquire claims + worktrees up front. Conflicts would surface here.
  interface Slot {
    plan: ChildPlan;
    wt: WorktreeHandle;
  }
  const slots: Slot[] = [];
  for (const plan of plans) {
    const claim = coord.acquire(plan.taskId, plan.writes);
    if (claim.status === "conflict") {
      throw new Error(
        `[leader] unexpected conflict for ${plan.taskId}: ${claim.reason}`,
      );
    }
    const wt = await acquireWorktree({
      repoRoot,
      sessionDir,
      taskId: plan.taskId,
    });
    slots.push({ plan, wt });
  }

  // Mark all in_progress.
  await writeTodo(
    todoWrite,
    plans.map<TodoItem>((p) => ({
      title: p.goal,
      status: "in_progress",
      depth: 0,
    })),
  );

  // Run children IN PARALLEL. Each sub-agent's work happens in its own
  // worktree — disjoint working directories, so no contention.
  const childResults = await Promise.all(
    slots.map(async ({ plan, wt }) => {
      const { actualWrites, finalMessage } = await plan.perform(wt.path);
      // Commit whatever the child wrote so the worktree's branch has a tip
      // distinct from the parent's HEAD.
      if (actualWrites.length > 0) {
        runGit(wt.path, ["add", "."]);
        runGit(wt.path, ["commit", "-q", "-m", `child(${plan.taskId})`]);
      }
      return { plan, wt, actualWrites, finalMessage };
    }),
  );

  // Audit + merge + release SEQUENTIALLY. mergeBack uses a regular 3-way
  // merge — by construction (declarative partitioning) it is conflict-free.
  const outcomes: DispatchOutcome[] = [];
  for (const { plan, wt, finalMessage } of childResults) {
    const parsed = parseSubAgentResult(finalMessage);
    if (parsed.kind === "invalid") {
      coord.release(plan.taskId);
      await wt.release({ keep: true });
      outcomes.push({
        plan,
        finalStatus: "failed",
        note: `bad output: ${parsed.reason}`,
      });
      continue;
    }
    const audit = validateDeclaredWrites(plan.writes, parsed.value.writes);
    if (audit.violations.length > 0) {
      coord.release(plan.taskId);
      await wt.release({ keep: true });
      outcomes.push({
        plan,
        finalStatus: "failed",
        note: `wrote outside partition: ${audit.violations.join(", ")}`,
      });
      continue;
    }
    if (parsed.value.status === "fail") {
      coord.release(plan.taskId);
      await wt.release({ keep: parsed.value.retryable });
      outcomes.push({
        plan,
        finalStatus: "failed",
        note: parsed.value.notes,
      });
      continue;
    }
    // ok or partial → merge back.
    const merge = await wt.mergeBack();
    coord.release(plan.taskId);
    if (merge.status === "conflict") {
      await wt.release({ keep: true });
      outcomes.push({
        plan,
        finalStatus: "failed",
        note: `merge conflict on ${merge.conflictedFiles.join(", ")}`,
      });
      continue;
    }
    await wt.release();
    outcomes.push({
      plan,
      finalStatus: parsed.value.status === "ok" ? "completed" : "in_progress",
      note: parsed.value.notes,
      mergeCommit: merge.status === "merged" ? merge.commit : undefined,
    });
  }

  // Final todo write reflecting every outcome.
  await writeTodo(
    todoWrite,
    outcomes.map<TodoItem>((o) => ({
      title: o.plan.goal,
      status: o.finalStatus,
      depth: 0,
      ...(o.note ? { note: o.note } : {}),
    })),
  );
  return outcomes;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolLike = { execute: (args: any, ctx: any) => any };

async function writeTodo(
  todoWrite: ToolLike,
  items: TodoItem[],
): Promise<void> {
  await todoWrite.execute({ items }, {});
}

// ---------------------------------------------------------------------------
// 3. Drive the demo.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const repoRoot = await makeRepo();
  const sessionDir = join(repoRoot, ".sparkwright", "sessions", "demo");
  try {
    // -- Conflict detection (no work performed) ------------------------------
    const probe = new ConcurrencyCoordinator();
    probe.acquire("auth", ["src/auth/**"]);
    const conflict = probe.acquire("auth-2", ["src/auth/foo.ts"]);
    assert(
      conflict.status === "conflict",
      "overlapping claim should be rejected",
    );
    log("conflict detected (expected)", conflict);
    probe.release("auth");

    // -- Two-way parallel fan-out --------------------------------------------
    const plans: ChildPlan[] = [
      {
        taskId: "auth",
        goal: "add auth module",
        writes: ["src/auth/**"],
        perform: writeFilesPlan({
          files: { "src/auth/login.ts": "export const login = () => {};\n" },
          message: {
            status: "ok",
            writes: ["src/auth/login.ts"],
            notes: "auth scaffolded",
            retryable: false,
          },
        }),
      },
      {
        taskId: "billing",
        goal: "add billing module",
        writes: ["src/billing/**"],
        perform: writeFilesPlan({
          files: {
            "src/billing/invoice.ts": "export const invoice = () => {};\n",
          },
          message: {
            status: "ok",
            writes: ["src/billing/invoice.ts"],
            notes: "billing scaffolded",
            retryable: false,
          },
        }),
      },
      {
        taskId: "rogue",
        goal: "rogue agent writes outside its partition",
        writes: ["src/docs/**"],
        // Declares src/docs/** but writes src/auth/sneak.ts — must be caught.
        perform: writeFilesPlan({
          files: {
            "src/auth/sneak.ts": "export const sneak = () => {};\n",
          },
          message: {
            status: "ok",
            writes: ["src/auth/sneak.ts"],
            notes: "I wrote whatever I wanted",
            retryable: false,
          },
        }),
      },
    ];

    const outcomes = await runLeader(repoRoot, sessionDir, plans);
    for (const o of outcomes) log(`outcome[${o.plan.taskId}]`, o);

    // -- Assertions ----------------------------------------------------------
    const auth = outcomes.find((o) => o.plan.taskId === "auth")!;
    const billing = outcomes.find((o) => o.plan.taskId === "billing")!;
    const rogue = outcomes.find((o) => o.plan.taskId === "rogue")!;
    assert(auth.finalStatus === "completed", "auth must complete");
    assert(billing.finalStatus === "completed", "billing must complete");
    assert(rogue.finalStatus === "failed", "rogue must fail the writes audit");
    assert(
      (rogue.note ?? "").includes("outside partition"),
      "rogue note must explain the violation",
    );

    // Both legitimate children's files landed in the parent repo.
    const mergedAuth = await readFile(
      join(repoRoot, "src/auth/login.ts"),
      "utf8",
    );
    const mergedBilling = await readFile(
      join(repoRoot, "src/billing/invoice.ts"),
      "utf8",
    );
    assert(mergedAuth.includes("login"), "auth file merged into parent");
    assert(
      mergedBilling.includes("invoice"),
      "billing file merged into parent",
    );

    // The rogue's worktree was kept around for inspection.
    const rogueWorktree = join(sessionDir, "worktrees", "rogue");
    const rogueExists = await pathExists(rogueWorktree);
    assert(rogueExists, "rogue worktree must be preserved for inspection");

    // Final todo reflects the three outcomes.
    const finalTodo = await readFile(join(sessionDir, "todo.md"), "utf8");
    log("final todo.md", finalTodo);
    assert(finalTodo.includes("- [x] add auth module"), "todo: auth done");
    assert(
      finalTodo.includes("- [x] add billing module"),
      "todo: billing done",
    );
    assert(
      finalTodo.includes("- [ ] ❌ rogue agent writes outside its partition"),
      "todo: rogue marked failed",
    );

    console.log("\n✓ concurrent-sub-agents demo finished");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface WriteFilesPlanInput {
  files: Record<string, string>;
  message: {
    status: "ok" | "fail" | "partial";
    writes: string[];
    notes: string;
    retryable: boolean;
  };
}

function writeFilesPlan(input: WriteFilesPlanInput): ChildPlan["perform"] {
  return async (workspace: string) => {
    const actualWrites: string[] = [];
    for (const [relPath, content] of Object.entries(input.files)) {
      const abs = join(workspace, relPath);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, content);
      actualWrites.push(relative(workspace, abs));
    }
    return {
      actualWrites,
      finalMessage: [
        "Done. Here is my structured result:",
        "",
        "```json",
        JSON.stringify(input.message, null, 2),
        "```",
      ].join("\n"),
    };
  };
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sparkwright-fanout-"));
  runGit(root, ["init", "-q", "-b", "main"]);
  runGit(root, ["config", "user.email", "demo@sparkwright.dev"]);
  runGit(root, ["config", "user.name", "Demo"]);
  runGit(root, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(root, "README.md"), "# demo workspace\n");
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-q", "-m", "init"]);
  return root;
}

function runGit(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${r.stderr || r.stdout || "unknown"}`,
    );
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await readFile(p).catch(async () => {
      // Maybe a directory — readFile would throw EISDIR.
      const { stat } = await import("node:fs/promises");
      await stat(p);
    });
    return true;
  } catch {
    try {
      const { stat } = await import("node:fs/promises");
      await stat(p);
      return true;
    } catch {
      return false;
    }
  }
}

function log(label: string, value: unknown): void {
  console.log(
    `[${label}]`,
    typeof value === "string" ? value : JSON.stringify(value, null, 2),
  );
}

function assert(cond: boolean, message: string): void {
  if (!cond) {
    console.error(`✗ assertion failed: ${message}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("demo crashed:", err);
  process.exit(1);
});
