import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  defineTool,
  createRunId,
  LocalWorkspace,
  type RuntimeContext,
} from "@sparkwright/core";
import {
  InMemoryTaskStore,
  TaskManager,
  type TaskId,
} from "@sparkwright/agent-runtime";
import {
  createAgentInspectorTool,
  createAgentManagerTool,
  applyToolConfig,
  createAppendFileTool,
  createGlobPathsTool,
  createReadFileTool,
  createSkillInspectorTool,
  createSkillManagerTool,
} from "../src/tools.js";
import { createHostShellTool } from "../src/shell.js";

describe("host tools", () => {
  it("rejects read_file glob paths with tool guidance", async () => {
    const ctx = await createWorkspace({
      "packages/tui/package.json": "{}\n",
    });
    const tool = createReadFileTool();

    await expect(
      tool.execute({ path: "packages/*/package.json" }, ctx),
    ).rejects.toThrow(/read_file does not support glob patterns.*glob_paths/);
    await expect(
      tool.execute({ path: "packages/*/package.json" }, ctx),
    ).rejects.toMatchObject({ code: "TOOL_ARGUMENTS_INVALID" });
  });

  it("rejects read_file directory paths with tool guidance", async () => {
    const ctx = await createWorkspace({
      "docs/README.md": "# Docs\n",
    });
    const tool = createReadFileTool();

    await expect(tool.execute({ path: "docs" }, ctx)).rejects.toThrow(
      /expected a file path.*directory.*glob_paths/,
    );
    await expect(tool.execute({ path: "docs" }, ctx)).rejects.toMatchObject({
      code: "TOOL_ARGUMENTS_INVALID",
    });
  });

  it("normalizes read_file absolute and file URL paths", async () => {
    const ctx = await createWorkspace({
      "docs/README.md": "# Docs\n",
    });
    const tool = createReadFileTool();

    const absolutePath = join(ctx.workspaceRoot, "docs/README.md");
    await expect(
      tool.execute({ path: absolutePath }, ctx),
    ).resolves.toMatchObject({
      path: "docs/README.md",
      inputPath: absolutePath,
      content: "# Docs\n",
    });

    const fileUrl = pathToFileURL(
      join(ctx.workspaceRoot, "docs/README.md"),
    ).href;
    await expect(tool.execute({ path: fileUrl }, ctx)).resolves.toMatchObject({
      path: "docs/README.md",
      inputPath: fileUrl,
      content: "# Docs\n",
    });
  });

  it("rejects read_file escaped paths as tool argument errors", async () => {
    const ctx = await createWorkspace({
      "README.md": "# Demo\n",
    });
    const tool = createReadFileTool();

    await expect(tool.execute({ path: "../README.md" }, ctx)).rejects.toThrow(
      "Path escapes workspace root",
    );
    await expect(
      tool.execute({ path: "../README.md" }, ctx),
    ).rejects.toMatchObject({ code: "TOOL_ARGUMENTS_INVALID" });
    await expect(tool.execute({ path: 42 }, ctx)).rejects.toMatchObject({
      code: "TOOL_ARGUMENTS_INVALID",
    });
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

  it("rejects append_file headings that normalize to empty text", async () => {
    const ctx = await createWorkspace({
      "NOTES.md": "",
    });
    const tool = createAppendFileTool();

    await expect(
      tool.execute({ path: "NOTES.md", heading: "## ", body: "body" }, ctx),
    ).rejects.toMatchObject({ code: "TOOL_ARGUMENTS_INVALID" });
    await expect(
      readFile(join(ctx.workspaceRoot, "NOTES.md"), "utf8"),
    ).resolves.toBe("");
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
    const inspector = createSkillInspectorTool(ctx.workspaceRoot, undefined);

    const created = await tool.execute(
      {
        action: "create",
        name: "repo-review",
        description: "review repository changes",
      },
      ctx,
    );
    const listed = await inspector.execute({ action: "list" }, ctx);

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
          layer: "project",
        },
      ],
      shadows: [],
      errors: [],
    });
  });

  it("creates project agent profiles and delegate tools", async () => {
    const ctx = await createWorkspace({});
    const tool = createAgentManagerTool(ctx.workspaceRoot);
    const inspector = createAgentInspectorTool(ctx.workspaceRoot);

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
    const listed = await inspector.execute({ action: "list" }, ctx);

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

  it("keeps inspector tools read-only and managers write-scoped", () => {
    const skillInspector = createSkillInspectorTool("/tmp/ws", undefined);
    const agentInspector = createAgentInspectorTool("/tmp/ws");
    const skillManager = createSkillManagerTool("/tmp/ws", undefined);
    const agentManager = createAgentManagerTool("/tmp/ws");

    // Read-only inspectors declare no write side effect, so the governance
    // policy allows them without an approval prompt.
    for (const tool of [skillInspector, agentInspector]) {
      expect(tool.governance?.sideEffects).toEqual(["read"]);
      expect(tool.policy?.risk).toBe("safe");
      expect(tool.isReplaySafe).toBe(true);
    }

    // Managers still carry the write side effect that triggers approval.
    for (const tool of [skillManager, agentManager]) {
      expect(tool.governance?.sideEffects).toContain("write");
      expect(tool.policy?.risk).toBe("risky");
    }

    // The read-only actions are no longer accepted by the managers.
    expect(
      (
        skillManager.inputSchema as {
          properties: { action: { enum: string[] } };
        }
      ).properties.action.enum,
    ).toEqual(["create"]);
    expect(
      (
        agentManager.inputSchema as {
          properties: { action: { enum: string[] } };
        }
      ).properties.action.enum,
    ).toEqual(["create", "remove"]);
  });

  it("reports manager and inspector validation failures as tool argument errors", async () => {
    const ctx = await createWorkspace({});
    const skillInspector = createSkillInspectorTool(
      ctx.workspaceRoot,
      undefined,
    );
    const skillManager = createSkillManagerTool(ctx.workspaceRoot, undefined);
    const agentManager = createAgentManagerTool(ctx.workspaceRoot);

    await expect(
      skillInspector.execute({ action: "create" }, ctx),
    ).rejects.toMatchObject({ code: "TOOL_ARGUMENTS_INVALID" });
    await expect(
      skillManager.execute({ action: "list" }, ctx),
    ).rejects.toMatchObject({ code: "TOOL_ARGUMENTS_INVALID" });
    await expect(
      agentManager.execute(
        { action: "create", id: "agent", prompt: "x", maxSteps: 0 },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "TOOL_ARGUMENTS_INVALID" });
  });

  it("promotes long-running shell commands to background tasks", async () => {
    const ctx = await createWorkspace({});
    const manager = new TaskManager({ store: new InMemoryTaskStore() });
    const tool = createHostShellTool(ctx.workspaceRoot, {
      taskManager: manager,
      foregroundTimeoutMs: 20,
    });

    const result = await tool.execute(
      {
        command:
          "node -e \"setTimeout(() => console.log('promoted done'), 80)\"",
      },
      ctx,
    );

    expect(result.promoted).toBe(true);
    expect(result.taskId).toMatch(/^task_/);
    const handle = manager.handle(result.taskId as TaskId);
    expect(handle).toBeDefined();
    const record = await handle!.wait();
    expect(record.status).toBe("completed");

    const chunks = [];
    for await (const chunk of manager.store.loadOutput(
      result.taskId as TaskId,
    )) {
      chunks.push(chunk.data);
    }
    expect(chunks.join("")).toContain("promoted done");
  });

  it("rolls back workspace mutations made by promoted shell tasks", async () => {
    const ctx = await createWorkspace({});
    const manager = new TaskManager({ store: new InMemoryTaskStore() });
    const tool = createHostShellTool(ctx.workspaceRoot, {
      taskManager: manager,
      foregroundTimeoutMs: 20,
    });

    const result = await tool.execute(
      {
        command:
          "node -e \"setTimeout(() => require('fs').writeFileSync('leak.txt', 'x'), 80)\"",
      },
      ctx,
    );

    expect(result.promoted).toBe(true);
    const handle = manager.handle(result.taskId as TaskId);
    expect(handle).toBeDefined();
    const record = await handle!.wait();
    expect(record.status).toBe("failed");
    expect(record.error?.code).toBe("UNTRACKED_WORKSPACE_MUTATION");
    await expect(
      readFile(join(ctx.workspaceRoot, "leak.txt")),
    ).rejects.toThrow();
  });

  it("does not use the read-only shell fast path for redirects", async () => {
    const ctx = await createWorkspace({});
    const tool = createHostShellTool(ctx.workspaceRoot);

    await expect(
      tool.execute({ command: "echo leaked > leak.txt" }, ctx),
    ).rejects.toMatchObject({ code: "UNTRACKED_WORKSPACE_MUTATION" });
    await expect(
      readFile(join(ctx.workspaceRoot, "leak.txt")),
    ).rejects.toThrow();
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
