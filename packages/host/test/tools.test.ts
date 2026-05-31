import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRunId,
  LocalWorkspace,
  type RuntimeContext,
} from "@sparkwright/core";
import { createGlobPathsTool, createReadFileTool } from "../src/tools.js";

describe("host tools", () => {
  it("rejects read_file glob paths with tool guidance", async () => {
    const ctx = await createWorkspace({
      "packages/tui/package.json": "{}\n",
    });
    const tool = createReadFileTool();

    await expect(
      tool.execute({ path: "packages/*/package.json" }, ctx),
    ).rejects.toThrow(/read_file does not support glob patterns.*glob_paths/);
  });

  it("exposes glob_paths for safe file discovery", async () => {
    const ctx = await createWorkspace({
      "packages/tui/package.json": "{}\n",
      "packages/host/package.json": "{}\n",
      "README.md": "# Demo\n",
    });
    const tool = createGlobPathsTool(ctx.workspaceRoot);

    const result = await tool.execute(
      { patterns: "packages/*/package.json" },
      ctx,
    );

    expect(result).toEqual({
      patterns: ["packages/*/package.json"],
      paths: ["packages/host/package.json", "packages/tui/package.json"],
      truncated: false,
      offset: 0,
      totalPaths: 2,
      hasMore: false,
    });
  });
});

async function createWorkspace(
  files: Record<string, string>,
): Promise<RuntimeContext & { workspaceRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "sparkwright-host-tools-"));
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(root, path);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }

  return {
    workspaceRoot: root,
    run: {
      id: createRunId(),
      goal: "test",
      state: "running",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      metadata: {},
    },
    workspace: new LocalWorkspace(root),
  };
}
