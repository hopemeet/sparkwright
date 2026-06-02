import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defineTool,
  createRunId,
  LocalWorkspace,
  type RuntimeContext,
} from "@sparkwright/core";
import {
  createAgentManagerTool,
  applyToolConfig,
  createGlobPathsTool,
  createReadFileTool,
  createSkillManagerTool,
} from "../src/tools.js";

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

  it("applies enabled, disabled, and deferred tool config", () => {
    const read = defineTool({
      name: "read_file",
      description: "read",
      inputSchema: { type: "object" },
      execute: () => ({}),
    });
    const mcpSearch = defineTool({
      name: "mcp_docs_search",
      description: "search",
      inputSchema: { type: "object" },
      execute: () => ({}),
    });
    const shell = defineTool({
      name: "shell",
      description: "shell",
      inputSchema: { type: "object" },
      execute: () => ({}),
    });
    const eager = defineTool({
      name: "mcp_required",
      description: "required",
      inputSchema: { type: "object" },
      alwaysLoad: true,
      execute: () => ({}),
    });

    const tools = applyToolConfig([read, mcpSearch, shell, eager], {
      enabled: ["read_file", "mcp_*", "shell"],
      disabled: ["shell"],
      defer: ["mcp_*"],
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "read_file",
      "mcp_docs_search",
      "mcp_required",
    ]);
    expect(tools.find((tool) => tool.name === "mcp_docs_search")).toMatchObject(
      { deferLoading: true },
    );
    expect(tools.find((tool) => tool.name === "mcp_required")).toMatchObject({
      alwaysLoad: true,
    });
    expect(
      tools.find((tool) => tool.name === "mcp_required")?.deferLoading,
    ).toBeUndefined();
  });

  it("creates and lists workspace skills", async () => {
    const ctx = await createWorkspace({});
    const tool = createSkillManagerTool(ctx.workspaceRoot, undefined);

    const created = await tool.execute(
      {
        action: "create",
        name: "repo-review",
        description: "review repository changes",
      },
      ctx,
    );
    const listed = await tool.execute({ action: "list" }, ctx);

    expect(created).toMatchObject({
      action: "create",
      name: "repo-review",
      changed: true,
    });
    expect(listed).toMatchObject({
      skills: [
        {
          name: "repo-review",
          description: "review repository changes",
        },
      ],
      errors: [],
    });
  });

  it("creates project agent profiles and delegate tools", async () => {
    const ctx = await createWorkspace({});
    const tool = createAgentManagerTool(ctx.workspaceRoot);

    const created = await tool.execute(
      {
        action: "create",
        id: "reviewer",
        name: "Reviewer",
        mode: "child",
        prompt: "Review changes and report concrete risks.",
        allowedTools: ["read_file"],
        maxSteps: 2,
        delegateToolName: "delegate_reviewer",
      },
      ctx,
    );
    const listed = await tool.execute({ action: "list" }, ctx);

    expect(created).toMatchObject({
      action: "create",
      id: "reviewer",
      changed: true,
      errors: [],
    });
    expect(listed).toMatchObject({
      agents: {
        profiles: [
          {
            id: "reviewer",
            name: "Reviewer",
            mode: "child",
            experimental: {
              mode: "child",
              prompt: "Review changes and report concrete risks.",
            },
            allowedTools: ["read_file"],
            maxSteps: 2,
          },
        ],
        delegateTools: [
          {
            profileId: "reviewer",
            toolName: "delegate_reviewer",
            requiresApproval: true,
            forbidNesting: true,
            maxSteps: 2,
          },
        ],
      },
      errors: [],
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
