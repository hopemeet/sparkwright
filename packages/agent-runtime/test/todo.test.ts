import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentProfilePolicy,
  createTodoReadTool,
  createTodoTools,
  createTodoWriteTool,
  itemsOnly,
  parseTodoMarkdown,
  serializeTodoMarkdown,
  type TodoItem,
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
        "- [ ] ❌ d (reason)",
        "  - [~] e",
        "",
      ].join("\n"),
    );
  });
});

describe("createTodoReadTool / createTodoWriteTool", () => {
  it("write creates the file, read returns the items", async () => {
    const path = await tempPath();
    const write = createTodoWriteTool({ getTodoPath: () => path });
    const read = createTodoReadTool({ getTodoPath: () => path });
    const items: TodoItem[] = [
      { title: "stage 0", status: "completed", depth: 0 },
      { title: "stage 1", status: "in_progress", depth: 0 },
      { title: "substep", status: "pending", depth: 1 },
    ];
    const writeRes = (await write.execute({ items }, {} as never)) as {
      written: number;
      path: string;
    };
    expect(writeRes.written).toBe(3);
    expect(writeRes.path).toBe(path);

    const onDisk = await readFile(path, "utf8");
    expect(onDisk).toContain("- [x] stage 0");
    expect(onDisk).toContain("- [ ] 🔄 stage 1");
    expect(onDisk).toContain("  - [ ] substep");

    const readRes = (await read.execute({}, {} as never)) as {
      items: TodoItem[];
    };
    expect(readRes.items.map((i) => i.status)).toEqual([
      "completed",
      "in_progress",
      "pending",
    ]);
  });

  it("read returns empty when the file does not exist", async () => {
    const path = await tempPath();
    const read = createTodoReadTool({ getTodoPath: () => path });
    const res = (await read.execute({}, {} as never)) as { items: TodoItem[] };
    expect(res.items).toEqual([]);
  });

  it("write rejects invalid status values", async () => {
    const path = await tempPath();
    const write = createTodoWriteTool({ getTodoPath: () => path });
    await expect(
      write.execute({ items: [{ title: "bad", status: "wat" }] }, {} as never),
    ).rejects.toThrow(/status must be one of/);
  });

  it("createTodoTools returns both tools wired to the same path", async () => {
    const path = await tempPath();
    await writeFile(path.replace(/\/[^/]+$/, ""), "", { flag: "a" }).catch(
      () => undefined,
    );
    const { todoRead, todoWrite, all } = createTodoTools({
      getTodoPath: () => path,
    });
    expect(
      all()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["todo_read", "todo_write"]);
    await todoWrite.execute(
      { items: [{ title: "x", status: "pending", depth: 0 }] },
      {} as never,
    );
    const out = (await todoRead.execute({}, {} as never)) as {
      items: TodoItem[];
    };
    expect(out.items).toHaveLength(1);
  });
});

describe("policy denies todo_write for child agents", () => {
  it("a CapabilityRule on the child profile denies tool.execute on todo_write", async () => {
    // Recipe: deny on action="tool.execute" with resource="todo_write".
    const childPolicy = createAgentProfilePolicy({
      id: "worker",
      allowedTools: ["todo_read", "todo_write"],
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
        resource: { kind: "tool", name: "todo_read" },
      }),
    ).resolves.toMatchObject({ decision: "allow" });
  });
});
