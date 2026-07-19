import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTodoTools,
  createTodoWriteTool,
  hasUnfinishedTodo,
  itemsOnly,
  parseTodoMarkdown,
  readTodoLedger,
  renderTodoLedgerContext,
  serializeTodoMarkdown,
  summarizeTodoLedger,
  type TodoItem,
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

describe("Todo Markdown", () => {
  it("parses the four advisory states, nesting, and priority", () => {
    const items = itemsOnly(
      parseTodoMarkdown(
        [
          "- [ ] pending",
          "  priority: high",
          "  - [ ] 🔄 active",
          "- [x] completed",
          "- [ ] ⛔ blocked",
        ].join("\n"),
      ),
    );

    expect(items).toEqual([
      { title: "pending", status: "pending", depth: 0, priority: "high" },
      { title: "active", status: "in_progress", depth: 1 },
      { title: "completed", status: "completed", depth: 0 },
      { title: "blocked", status: "blocked", depth: 0 },
    ]);
  });

  it("round-trips comments and the minimal item shape", () => {
    const entries = [
      { kind: "comment" as const, text: "# Plan" },
      { kind: "blank" as const },
      {
        kind: "item" as const,
        title: "verify",
        status: "in_progress" as const,
        depth: 0,
        priority: "medium" as const,
      },
    ];
    const markdown = serializeTodoMarkdown(entries);
    expect(markdown).toContain("# Plan\n\n- [ ] 🔄 verify");
    expect(parseTodoMarkdown(markdown)).toEqual(entries);
  });
});

describe("todo_write", () => {
  it("writes the session ledger and echoes current progress", async () => {
    const path = await tempPath();
    const tool = createTodoWriteTool({ getTodoPath: () => path });
    const result = (await tool.execute(
      {
        items: [
          { title: "inspect", status: "completed" },
          { title: "implement", status: "in_progress" },
          { title: "verify", status: "pending" },
        ],
      },
      {} as never,
    )) as TodoWriteResult;

    expect(result).toMatchObject({
      saved: true,
      total: 3,
      completed: 1,
      remaining: 2,
    });
    expect(await readFile(path, "utf8")).toContain("- [ ] 🔄 implement");
  });

  it("keeps identical writes as no-ops", async () => {
    const path = await tempPath();
    const tool = createTodoWriteTool({ getTodoPath: () => path });
    const args = { items: [{ title: "inspect", status: "pending" }] };

    await tool.execute(args, {} as never);
    const duplicate = (await tool.execute(
      args,
      {} as never,
    )) as TodoWriteResult;
    expect(duplicate.saved).toBe(false);
    expect(duplicate.hint).toContain("unchanged");
  });

  it("does not impose a hidden write-count budget", async () => {
    const path = await tempPath();
    const tool = createTodoWriteTool({ getTodoPath: () => path });
    let last: TodoWriteResult | undefined;
    for (let index = 0; index < 5; index += 1) {
      last = (await tool.execute(
        {
          items: [
            {
              title: `revision ${index}`,
              status: index === 4 ? "completed" : "in_progress",
            },
          ],
        },
        {} as never,
      )) as TodoWriteResult;
    }
    expect(last).toMatchObject({ saved: true, completed: 1, remaining: 0 });
  });

  it("accepts common status synonyms into the four-state model", async () => {
    const path = await tempPath();
    const tool = createTodoWriteTool({ getTodoPath: () => path });
    await tool.execute(
      {
        items: [
          { title: "a", status: "todo" },
          { title: "b", status: "done" },
          { title: "c", status: "wip" },
          { title: "d", status: "cancelled" },
        ],
      },
      {} as never,
    );
    expect(
      (await readTodoLedger(path)).items.map((item) => item.status),
    ).toEqual(["pending", "completed", "in_progress", "blocked"]);
  });

  it("exposes only todo_write", () => {
    const tools = createTodoTools({ getTodoPath: () => "/tmp/todo.md" });
    expect(tools.all().map((tool) => tool.name)).toEqual(["todo_write"]);
  });
});

describe("Todo advisory helpers", () => {
  it("summarizes and renders the current plan without scheduling semantics", () => {
    const items: TodoItem[] = [
      { title: "done", status: "completed", depth: 0 },
      { title: "next", status: "pending", depth: 0 },
      { title: "wait", status: "blocked", depth: 0 },
    ];
    const summary = summarizeTodoLedger(items);
    expect(summary).toMatchObject({
      total: 3,
      completed: 1,
      pending: 1,
      blocked: 1,
      unfinished: 2,
      hasUnfinished: true,
    });
    const ledger = {
      schemaVersion: "todo-ledger.v1" as const,
      items,
      metadata: {},
    };
    expect(hasUnfinishedTodo(ledger)).toBe(true);
    expect(renderTodoLedgerContext(ledger).content).toContain("pending: next");
  });
});
