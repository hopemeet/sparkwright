import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  auditTodoAfterTerminal,
  createAgentProfilePolicy,
  createTodoTools,
  createTodoWriteTool,
  hasExternalProgressEvidence,
  hasUnfinishedTodo,
  itemsOnly,
  parseTodoMarkdown,
  readTodoLedger,
  renderTodoLedgerContext,
  runTodoSupervised,
  serializeTodoMarkdown,
  summarizeTodoLedger,
  type TodoItem,
  type TodoLedger,
  type TodoWriteResult,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.length = 0;
});

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sparkwright-todo-"));
  tempDirs.push(dir);
  return join(dir, ".sparkwright", "sessions", "s1", "todo.md");
}

describe("parseTodoMarkdown", () => {
  it("parses all five states", () => {
    const md = [
      "- [ ] pending one",
      "- [ ] 🔄 in progress",
      "- [x] completed",
      "- [ ] ❌ failed",
      "- [~] skipped (reason)",
    ].join("\n");
    const items = itemsOnly(parseTodoMarkdown(md));
    expect(items.map((i) => i.status)).toEqual([
      "pending",
      "in_progress",
      "completed",
      "failed",
      "skipped",
    ]);
    expect(items[4]!.title).toBe("skipped");
    expect(items[4]!.note).toBe("reason");
  });

  it("parses metadata and evidence blocks", () => {
    const md = [
      "- [ ] ⛔ fix flaky test (needs logs)",
      "  id: t1",
      "  priority: high",
      "  done-when: regression passes",
      "  owner: primary",
      "  evidence:",
      "    - file_changed: packages/core/src/run.ts",
      "    - command: npm test (exit 0)",
      "    - test: npm test -- todo (passed)",
    ].join("\n");
    const [item] = itemsOnly(parseTodoMarkdown(md));
    expect(item).toMatchObject({
      id: "t1",
      title: "fix flaky test",
      status: "blocked",
      priority: "high",
      doneWhen: "regression passes",
      owner: "primary",
      note: "needs logs",
    });
    expect(item?.evidence).toEqual([
      { kind: "file_changed", path: "packages/core/src/run.ts" },
      { kind: "command", command: "npm test", exitCode: 0 },
      { kind: "test", command: "npm test -- todo", passed: true },
    ]);
  });

  it("captures depth from indentation", () => {
    const md = ["- [ ] top", "  - [x] nested", "    - [ ] deeper"].join("\n");
    const items = itemsOnly(parseTodoMarkdown(md));
    expect(items.map((i) => i.depth)).toEqual([0, 1, 2]);
  });

  it("preserves blank lines and comments through round-trip", () => {
    const md = ["# Stage 1", "", "- [x] done", "- [ ] next", ""].join("\n");
    const entries = parseTodoMarkdown(md);
    const out = serializeTodoMarkdown(entries);
    expect(out).toBe(md);
  });
});

describe("serializeTodoMarkdown", () => {
  it("emits the expected marker for each status", () => {
    const items: TodoItem[] = [
      { title: "a", status: "pending", depth: 0 },
      { title: "b", status: "in_progress", depth: 0 },
      { title: "c", status: "completed", depth: 0 },
      { title: "blocked", status: "blocked", depth: 0 },
      { title: "d", status: "failed", depth: 0, note: "reason" },
      { title: "e", status: "skipped", depth: 1 },
    ];
    const out = serializeTodoMarkdown(
      items.map((i) => ({ kind: "item", ...i })),
    );
    expect(out).toBe(
      [
        "- [ ] a",
        "- [ ] 🔄 b",
        "- [x] c",
        "- [ ] ⛔ blocked",
        "- [ ] ❌ d (reason)",
        "  - [~] e",
        "",
      ].join("\n"),
    );
  });

  it("round-trips new metadata fields", () => {
    const items: TodoItem[] = [
      {
        id: "todo-1",
        title: "run tests",
        status: "pending",
        depth: 0,
        priority: "high",
        doneWhen: "tests pass",
        owner: "supervisor",
        evidence: [
          { kind: "artifact", artifactId: "artifact_1" },
          { kind: "trace_event", eventId: "event_1" },
        ],
      },
    ];
    const out = serializeTodoMarkdown(
      items.map((i) => ({ kind: "item", ...i })),
    );
    const parsed = itemsOnly(parseTodoMarkdown(out));
    expect(parsed).toEqual(items);
  });
});

describe("createTodoWriteTool", () => {
  it("write creates the file and echoes the resulting state", async () => {
    const path = await tempPath();
    const write = createTodoWriteTool({ getTodoPath: () => path });
    const items: TodoItem[] = [
      { title: "stage 0", status: "completed", depth: 0 },
      { title: "stage 1", status: "in_progress", depth: 0 },
      { title: "substep", status: "pending", depth: 1 },
    ];
    const writeRes = (await write.execute(
      { items },
      {} as never,
    )) as TodoWriteResult;
    expect(writeRes.saved).toBe(true);
    expect(writeRes.total).toBe(3);
    expect(writeRes.completed).toBe(1);
    expect(writeRes.remaining).toBe(2);
    expect(writeRes.todos).toEqual([
      { title: "stage 0", status: "completed" },
      { title: "stage 1", status: "in_progress" },
      { title: "substep", status: "pending" },
    ]);
    expect(writeRes.summary).toContain("1/3 done");
    expect(writeRes.summary).toContain("stage 1");

    const onDisk = await readFile(path, "utf8");
    expect(onDisk).toContain("- [x] stage 0");
    expect(onDisk).toContain("- [ ] 🔄 stage 1");
    expect(onDisk).toContain("  - [ ] substep");
  });

  it("write still accepts (but no longer advertises) rich item fields", async () => {
    const path = await tempPath();
    const write = createTodoWriteTool({ getTodoPath: () => path });
    await write.execute(
      {
        items: [
          {
            id: "oc-1",
            content: "implement ledger",
            status: "blocked",
            priority: "medium",
            doneWhen: "agent-runtime tests pass",
            evidence: [{ kind: "command", command: "npm test", exitCode: 0 }],
          },
        ],
      },
      {} as never,
    );
    const ledger = await readTodoLedger(path);
    expect(ledger.items[0]).toMatchObject({
      id: "oc-1",
      title: "implement ledger",
      status: "blocked",
      priority: "medium",
      doneWhen: "agent-runtime tests pass",
    });
    expect(ledger.items[0]?.evidence).toEqual([
      { kind: "command", command: "npm test", exitCode: 0 },
    ]);
  });

  it("write rejects invalid status values", async () => {
    const path = await tempPath();
    const write = createTodoWriteTool({ getTodoPath: () => path });
    await expect(
      write.execute({ items: [{ title: "bad", status: "wat" }] }, {} as never),
    ).rejects.toThrow(/status must be one of/);
  });

  it("write is not approval-gated (internal ledger, no write side effect)", () => {
    const write = createTodoWriteTool({ getTodoPath: () => "/tmp/x/todo.md" });
    expect(write.policy?.risk).toBe("safe");
    expect(write.governance?.sideEffects ?? ["none"]).not.toContain("write");
  });

  it("write skips a byte-identical rewrite as a no-op", async () => {
    const path = await tempPath();
    const write = createTodoWriteTool({ getTodoPath: () => path });
    const items = [{ title: "a", status: "pending", depth: 0 }];
    const first = (await write.execute(
      { items },
      {} as never,
    )) as TodoWriteResult;
    expect(first.saved).toBe(true);
    const mtime1 = (await stat(path)).mtimeMs;
    const second = (await write.execute(
      { items },
      {} as never,
    )) as TodoWriteResult;
    expect(second.saved).toBe(false);
    // The file was not rewritten.
    expect((await stat(path)).mtimeMs).toBe(mtime1);
  });

  it("nudges after repeated no-op writes, and resets on a real change", async () => {
    const path = await tempPath();
    const write = createTodoWriteTool({ getTodoPath: () => path });
    const items = [{ title: "a", status: "pending", depth: 0 }];
    const run = (todoItems: unknown[]) =>
      write.execute(
        { items: todoItems },
        {} as never,
      ) as Promise<TodoWriteResult>;
    // First write changes the file — no nudge.
    expect((await run(items)).hint).toBeUndefined();
    // 1st no-op: below threshold, no nudge yet.
    expect((await run(items)).hint).toBeUndefined();
    // 2nd consecutive no-op: nudge.
    const nudged = await run(items);
    expect(nudged.saved).toBe(false);
    expect(nudged.hint).toMatch(/calling todo_write again/);
    // A real change resets the counter.
    const changed = [{ title: "a", status: "completed", depth: 0 }];
    expect((await run(changed)).hint).toBeUndefined();
    expect((await run(changed)).hint).toBeUndefined();
  });

  it("write accepts common status synonyms (todo/done) case-insensitively", async () => {
    const path = await tempPath();
    const write = createTodoWriteTool({ getTodoPath: () => path });
    await write.execute(
      {
        items: [
          { title: "a", status: "todo" },
          { title: "b", status: "Done" },
          { title: "c", status: "WIP" },
          { title: "d", status: "cancelled" },
        ],
      },
      {} as never,
    );
    const ledger = await readTodoLedger(path);
    expect(ledger.items.map((i) => i.status)).toEqual([
      "pending",
      "completed",
      "in_progress",
      "skipped",
    ]);
  });

  it("createTodoTools exposes only the write tool to the model", async () => {
    const path = await tempPath();
    const { todoWrite, all } = createTodoTools({
      getTodoPath: () => path,
    });
    expect(all().map((t) => t.name)).toEqual(["todo_write"]);
    await todoWrite.execute(
      { items: [{ title: "x", status: "pending", depth: 0 }] },
      {} as never,
    );
    const ledger = await readTodoLedger(path);
    expect(ledger.items).toHaveLength(1);
  });
});

describe("TodoLedger helpers", () => {
  it("reads, summarizes, and renders todo context", async () => {
    const path = await tempPath();
    const write = createTodoWriteTool({ getTodoPath: () => path });
    await write.execute(
      {
        items: [
          { title: "done", status: "completed" },
          { title: "next", status: "pending", priority: "high" },
          { title: "blocked", status: "blocked", note: "needs input" },
        ],
      },
      {} as never,
    );
    const ledger = await readTodoLedger(path);
    const summary = summarizeTodoLedger(ledger);
    expect(summary).toMatchObject({
      total: 3,
      completed: 1,
      pending: 1,
      blocked: 1,
      unfinished: 2,
      hasUnfinished: true,
    });
    expect(hasUnfinishedTodo(ledger)).toBe(true);
    const context = renderTodoLedgerContext(ledger, { sessionId: "s1" });
    expect(context.source).toEqual({ kind: "todo_ledger", uri: "s1" });
    expect(context.content).toContain("pending: next");
    expect(context.metadata.todoLedger).toBe(true);
  });

  it("audits terminal runs and recommends continuation only when safe", async () => {
    const ledger = {
      schemaVersion: "todo-ledger.v1" as const,
      metadata: {},
      items: [{ title: "next", status: "pending" as const, depth: 0 }],
    };
    const decision = auditTodoAfterTerminal(ledger, {
      result: {
        signal: "completed",
        state: "completed",
        stopReason: "final_answer",
        metadata: {},
      },
      events: [{ type: "workspace.write.completed" } as never],
      maxContinuations: 3,
      continuationCount: 0,
    });
    expect(decision.kind).toBe("continue");
    expect(decision.kind === "continue" ? decision.prompt : "").toContain(
      "First reconcile the list",
    );

    const denied = auditTodoAfterTerminal(ledger, {
      result: {
        signal: "cancelled",
        state: "cancelled",
        stopReason: "manual_cancelled",
        metadata: {},
      },
    });
    expect(denied).toMatchObject({
      kind: "handoff",
      reason: "non_resumable_stop_reason",
    });
  });

  it("does not count reads or empty tool calls as external progress", () => {
    // A tool.completed (e.g. an empty glob in a dead-end path) is NOT progress:
    // counting it let a model thrash forever without the stall guard firing.
    expect(
      hasExternalProgressEvidence([
        { type: "tool.completed" } as never,
        { type: "workspace.read" } as never,
      ]),
    ).toBe(false);
    expect(
      hasExternalProgressEvidence([
        { type: "workspace.write.completed" } as never,
      ]),
    ).toBe(true);
  });

  it("hands off a stalled continuation when only reads occur", () => {
    const ledger = {
      schemaVersion: "todo-ledger.v1" as const,
      metadata: {},
      items: [{ title: "next", status: "pending" as const, depth: 0 }],
    };
    const decision = auditTodoAfterTerminal(ledger, {
      result: {
        signal: "completed",
        state: "completed",
        stopReason: "final_answer",
        metadata: {},
      },
      // Only a read happened — no external side effect.
      events: [{ type: "tool.completed" } as never],
      maxContinuations: 5,
      continuationCount: 1,
      maxStalledContinuations: 2,
      stalledContinuationCount: 2,
    });
    expect(decision).toMatchObject({
      kind: "handoff",
      reason: "stalled_without_progress",
    });
  });
});

describe("runTodoSupervised", () => {
  it("creates synthetic continuation requests until the ledger is complete", async () => {
    let ledger: TodoLedger = {
      schemaVersion: "todo-ledger.v1",
      metadata: {},
      items: [{ title: "finish work", status: "pending", depth: 0 }],
    };
    const continuationPrompts: string[] = [];
    const result = await runTodoSupervised({
      readLedger: () => ledger,
      maxContinuations: 2,
      runOnce(input) {
        if (input.continuation) {
          continuationPrompts.push(input.continuation.prompt);
          expect(input.continuation.metadata.synthetic).toBe(true);
          expect(input.continuation.context.source?.kind).toBe("todo_ledger");
          ledger = {
            ...ledger,
            items: [
              { title: "finish work", status: "completed" as const, depth: 0 },
            ],
          };
        }
        return {
          result: {
            signal: "completed",
            state: "completed",
            stopReason: "final_answer",
            metadata: {},
          },
          events: [{ type: "workspace.write.completed" } as never],
        };
      },
    });

    expect(continuationPrompts).toHaveLength(1);
    expect(continuationPrompts[0]).toContain("First reconcile the list");
    expect(result.decision.kind).toBe("complete");
    expect(result.continuationCount).toBe(1);
  });

  it("does not stall a read-only run that completes items without write events", async () => {
    // A multi-step investigation: each round completes one more item but emits
    // no workspace.write/artifact events (pure reads). The event-only progress
    // signal never fires, yet the newly-completed item must count as progress
    // so the supervisor keeps continuing instead of handing off as "stalled".
    const titles = ["step-1", "step-2", "step-3"];
    let completedCount = 0;
    let ledger: TodoLedger = {
      schemaVersion: "todo-ledger.v1",
      metadata: {},
      items: titles.map((title) => ({
        title,
        status: "pending" as const,
        depth: 0,
      })),
    };
    let handoffs = 0;
    const result = await runTodoSupervised({
      readLedger: () => ledger,
      maxContinuations: 10,
      // Tight stall budget: without the completed-item progress signal this
      // would hand off after 2 read-only rounds.
      maxStalledContinuations: 2,
      onDecision(decision) {
        if (decision.kind === "handoff") handoffs += 1;
      },
      runOnce() {
        completedCount = Math.min(completedCount + 1, titles.length);
        ledger = {
          ...ledger,
          items: titles.map((title, i) => ({
            title,
            status:
              i < completedCount
                ? ("completed" as const)
                : ("pending" as const),
            depth: 0,
          })),
        };
        return {
          result: {
            signal: "completed",
            state: "completed",
            stopReason: "final_answer",
            metadata: {},
          },
          // Read-only: no workspace.write/anchored_edit/artifact events.
          events: [{ type: "workspace.read" } as never],
        };
      },
    });

    expect(handoffs).toBe(0);
    expect(result.decision.kind).toBe("complete");
    expect(result.stalledContinuationCount).toBe(0);
  });
});

describe("policy denies todo_write for child agents", () => {
  it("a CapabilityRule on the child profile denies tool.execute on todo_write", async () => {
    // Recipe: deny on action="tool.execute" with resource="todo_write".
    const childPolicy = createAgentProfilePolicy({
      id: "worker",
      allowedTools: ["read_file", "todo_write"],
      policy: [
        {
          action: "tool.execute",
          resource: "todo_write",
          effect: "deny",
          reason: "Only the Leader (primary agent) may update the todo file.",
        },
      ],
    });
    await expect(
      childPolicy.decide({
        action: "tool.execute",
        resource: { kind: "tool", name: "todo_write" },
      }),
    ).resolves.toMatchObject({ decision: "deny" });
    await expect(
      childPolicy.decide({
        action: "tool.execute",
        resource: { kind: "tool", name: "read_file" },
      }),
    ).resolves.toMatchObject({ decision: "allow" });
  });
});
