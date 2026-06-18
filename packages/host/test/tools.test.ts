import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  defineTool,
  createRunId,
  LocalWorkspace,
  type CapabilityMutationEvent,
  type RuntimeContext,
} from "@sparkwright/core";
import {
  InMemoryTaskStore,
  TaskManager,
  type TaskId,
} from "@sparkwright/agent-runtime";
import {
  createPlatformShellSandboxRuntime,
  type ShellSandboxRuntime,
} from "@sparkwright/shell-sandbox";
import {
  createAgentInspectorTool,
  createAgentManagerTool,
  applyToolConfig,
  createGlobPathsTool,
  createReadFileTool,
  createSkillInspectorTool,
  createSkillManagerTool,
  createSkillUpdateTool,
} from "../src/tools.js";
import {
  catalogEntryOrigin,
  createCliDiagnosticToolCatalog,
  createMainHostToolCatalog,
  createReadOnlyChildToolCatalog,
} from "../src/tool-catalog.js";
import { createHostShellTool } from "../src/shell.js";

describe("host tools", () => {
  it("rejects read_file glob paths with tool guidance", async () => {
    const ctx = await createWorkspace({
      "packages/tui/package.json": "{}\n",
    });
    const tool = createReadFileTool();

    await expect(
      tool.execute({ path: "packages/*/package.json" }, ctx),
    ).rejects.toThrow(/read_file does not support glob patterns.*glob/);
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
      /expected a file path.*directory.*glob/,
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

  it("exposes glob for safe file discovery", async () => {
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

  it("applies disabled and deferred tool config", () => {
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
      disabled: ["shell"],
      defer: ["mcp_docs_search"],
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

  it("marks low-frequency and capability mutation tools as deferred by default", () => {
    const todo = defineTool({
      name: "todo_write",
      description: "todo",
      inputSchema: { type: "object" },
      execute: () => ({}),
    });
    const anchoredRead = defineTool({
      name: "read_anchored_text",
      description: "read anchored",
      inputSchema: { type: "object" },
      execute: () => ({}),
    });
    const createSkill = defineTool({
      name: "create_skill",
      description: "create skill",
      inputSchema: { type: "object" },
      execute: () => ({}),
    });
    const createAgent = defineTool({
      name: "create_agent",
      description: "create agent",
      inputSchema: { type: "object" },
      execute: () => ({}),
    });
    const cron = defineTool({
      name: "cron",
      description: "cron",
      inputSchema: { type: "object" },
      execute: () => ({}),
    });
    const read = defineTool({
      name: "read_file",
      description: "read",
      inputSchema: { type: "object" },
      execute: () => ({}),
    });

    const defaults = applyToolConfig(
      [todo, anchoredRead, createSkill, createAgent, cron, read],
      undefined,
    );
    expect(defaults.find((tool) => tool.name === "todo_write")).toMatchObject({
      deferLoading: true,
    });
    expect(
      defaults.find((tool) => tool.name === "read_anchored_text"),
    ).toMatchObject({ deferLoading: true });
    expect(defaults.find((tool) => tool.name === "create_skill")).toMatchObject(
      { deferLoading: true },
    );
    expect(defaults.find((tool) => tool.name === "create_agent")).toMatchObject(
      { deferLoading: true },
    );
    expect(defaults.find((tool) => tool.name === "cron")).toMatchObject({
      deferLoading: true,
    });
    expect(
      defaults.find((tool) => tool.name === "read_file")?.deferLoading,
    ).toBeUndefined();

    const eager = applyToolConfig(
      [todo, anchoredRead, createSkill, createAgent, cron, read],
      { defer: [] },
    );
    expect(eager.some((tool) => tool.deferLoading === true)).toBe(false);
  });

  it("lets disabled config remove capability tools explicitly", () => {
    const tools = applyToolConfig(
      [
        createSkillInspectorTool("/tmp/ws", undefined),
        createSkillManagerTool("/tmp/ws", undefined),
      ],
      { disabled: ["create_skill"] },
    );

    expect(tools.map((tool) => tool.name)).toEqual(["list_skills"]);
  });

  it("builds the main host tool catalog with stable source metadata", () => {
    const manager = new TaskManager({ store: new InMemoryTaskStore() });
    const entries = createMainHostToolCatalog({
      workspaceRoot: "/tmp/ws",
      skillRoots: [],
      taskManager: manager,
      getParentRunId: () => createRunId(),
      todoPath: "/tmp/ws/.sparkwright/sessions/test/todo.md",
      dynamicSpawnTool: defineTool({
        name: "spawn_agent",
        description: "spawn",
        inputSchema: { type: "object" },
        execute: () => ({}),
      }),
      shell: { sandbox: { mode: "off" } },
    });
    const byName = new Map(
      entries.map((entry) => [entry.definition.name, entry]),
    );

    expect(byName.get("read_file")).toMatchObject({ source: "coding" });
    expect(catalogEntryOrigin(byName.get("read_file")!)).toBe(
      "local:@sparkwright/coding-tools",
    );
    expect(byName.get("shell")).toMatchObject({ source: "shell" });
    expect(byName.get("cron")).toMatchObject({ source: "cron" });
    expect(byName.get("create_skill")).toMatchObject({ source: "skill" });
    expect(byName.get("task")).toMatchObject({ source: "task" });
    expect(byName.get("todo_write")).toMatchObject({ source: "todo" });
    expect(byName.get("spawn_agent")).toMatchObject({ source: "agent" });
    expect(byName.get("create_skill")?.definition.deferLoading).toBe(true);
    expect(byName.get("tool_search")).toMatchObject({ source: "core" });
  });

  it("keeps read-only child tool catalog aligned with spawnable tools", () => {
    const entries = createReadOnlyChildToolCatalog({
      workspaceRoot: "/tmp/ws",
    });

    expect(entries.map((entry) => entry.definition.name)).toEqual([
      "read_file",
      "glob",
      "grep",
      "list_dir",
    ]);
    expect(new Set(entries.map((entry) => entry.source))).toEqual(
      new Set(["coding"]),
    );

    const disabled = createReadOnlyChildToolCatalog({
      workspaceRoot: "/tmp/ws",
      toolConfig: { disabled: ["list_dir"] },
    });
    expect(disabled.map((entry) => entry.definition.name)).toEqual([
      "read_file",
      "glob",
      "grep",
    ]);
  });

  it("builds CLI diagnostic tools from the shared coding catalog", () => {
    const entries = createCliDiagnosticToolCatalog({
      workspaceRoot: "/tmp/ws",
    });

    expect(entries.map((entry) => entry.definition.name)).toEqual([
      "read_file",
      "glob",
      "grep",
      "list_dir",
      "read_anchored_text",
      "edit_anchored_text",
      "apply_patch",
      "tool_search",
    ]);
    expect(
      entries.find((entry) => entry.definition.name === "read_file"),
    ).toMatchObject({
      source: "coding",
      exposure: "diagnostic",
    });
    expect(
      entries.find((entry) => entry.definition.name === "tool_search"),
    ).toMatchObject({
      source: "core",
      exposure: "diagnostic",
    });
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

  it("treats duplicate skill creation as an idempotent skip", async () => {
    const ctx = await createWorkspace({});
    const tool = createSkillManagerTool(ctx.workspaceRoot, undefined);

    await tool.execute(
      {
        action: "create",
        name: "repo-review",
        description: "review repository changes",
      },
      ctx,
    );
    const duplicate = await tool.execute(
      {
        action: "create",
        name: "repo-review",
        description: "review repository changes",
      },
      ctx,
    );

    expect(duplicate).toMatchObject({
      action: "create",
      name: "repo-review",
      path: ".sparkwright/skills/repo-review/SKILL.md",
      changed: false,
      status: "already_exists",
    });
    expect(ctx.skippedWrites).toEqual([
      {
        path: ".sparkwright/skills/repo-review/SKILL.md",
        reason: "Skill repo-review already matches requested content.",
      },
    ]);
  });

  it("rejects duplicate skill creation with different content unless forced", async () => {
    const ctx = await createWorkspace({});
    const tool = createSkillManagerTool(ctx.workspaceRoot, undefined);

    await tool.execute(
      {
        action: "create",
        name: "repo-review",
        description: "review repository changes",
      },
      ctx,
    );

    await expect(
      tool.execute(
        {
          action: "create",
          name: "repo-review",
          description: "review repository changes with test gaps",
        },
        ctx,
      ),
    ).rejects.toThrow(/Skill already exists with different content/);
  });

  it("normalizes create_skill root to the project skill root", async () => {
    const ctx = await createWorkspace({});
    const tool = createSkillManagerTool(ctx.workspaceRoot, undefined);

    const created = await tool.execute(
      {
        action: "create",
        name: "repo-review",
        description: "review repository changes",
        root: ".",
      },
      ctx,
    );

    expect(created).toMatchObject({
      path: ".sparkwright/skills/repo-review/SKILL.md",
      changed: true,
    });
    await expect(
      readFile(
        join(
          ctx.workspaceRoot,
          ".sparkwright",
          "skills",
          "repo-review",
          "SKILL.md",
        ),
        "utf8",
      ),
    ).resolves.toContain("name: repo-review");
    await expect(
      readFile(join(ctx.workspaceRoot, "repo-review", "SKILL.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects create_skill roots outside the project skill root", async () => {
    const ctx = await createWorkspace({});
    const tool = createSkillManagerTool(ctx.workspaceRoot, undefined);

    await expect(
      tool.execute(
        {
          action: "create",
          name: "repo-review",
          description: "review repository changes",
          root: "custom-skills",
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "TOOL_ARGUMENTS_INVALID" });
  });

  it("keeps update_skill deferred by default", () => {
    const tool = createSkillUpdateTool("/tmp/ws", []);

    expect(tool.deferLoading).toBe(true);
  });

  it("drafts skill update proposals without applying them", async () => {
    const ctx = await createWorkspace({
      ".sparkwright/skills/repo-review/SKILL.md": [
        "---",
        "name: repo-review",
        "description: review repository changes",
        "---",
        "",
        "Review changes.",
        "",
      ].join("\n"),
    });
    const tool = createSkillUpdateTool(ctx.workspaceRoot, undefined);

    const drafted = await tool.execute(
      {
        action: "draft",
        name: "repo-review",
        description: "Add missing-test guidance",
      },
      ctx,
    );

    expect(drafted).toMatchObject({
      action: "draft",
      changed: true,
      state: "draft",
      kind: "update",
      skillName: "repo-review",
      sourceLayer: "project",
      targetPath: join(
        ctx.workspaceRoot,
        ".sparkwright",
        "skills",
        "repo-review",
      ),
    });
    const proposal = drafted as { proposalPath: string };
    await expect(
      readFile(
        join(proposal.proposalPath, "after", "repo-review", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toContain("## Proposed Evolution");
    await expect(
      readFile(
        join(proposal.proposalPath, "after", "repo-review", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toContain("Add missing-test guidance");
    expect(ctx.capabilityMutations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "snapshot_skill_package",
          fileCount: 1,
        }),
        expect.objectContaining({
          action: "write_text",
          path: expect.stringContaining(
            ".sparkwright/skill-evolution/proposals/",
          ),
        }),
      ]),
    );
    await expect(
      readFile(
        join(
          ctx.workspaceRoot,
          ".sparkwright",
          "skills",
          "repo-review",
          "SKILL.md",
        ),
        "utf8",
      ),
    ).resolves.toContain("Review changes.");
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
            prompt: "Review changes and report concrete risks.",
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

  it("treats duplicate agent creation as an idempotent skip", async () => {
    const ctx = await createWorkspace({});
    const tool = createAgentManagerTool(ctx.workspaceRoot);

    const input = {
      action: "create",
      id: "reviewer",
      name: "Reviewer",
      mode: "child",
      prompt: "Review changes and report concrete risks.",
      allowedTools: ["read_file"],
      maxSteps: 2,
      delegateToolName: "delegate_reviewer",
    };
    await tool.execute(input, ctx);
    const duplicate = await tool.execute(input, ctx);

    expect(duplicate).toMatchObject({
      action: "create",
      id: "reviewer",
      path: ".sparkwright/config.json",
      changed: false,
      status: "already_exists",
    });
    expect(ctx.skippedWrites).toContainEqual({
      path: ".sparkwright/config.json",
      reason: "Agent profile reviewer already matches requested config.",
    });
  });

  it("rejects duplicate agent creation with different config unless forced", async () => {
    const ctx = await createWorkspace({});
    const tool = createAgentManagerTool(ctx.workspaceRoot);

    await tool.execute(
      {
        action: "create",
        id: "reviewer",
        prompt: "Review changes and report concrete risks.",
      },
      ctx,
    );

    await expect(
      tool.execute(
        {
          action: "create",
          id: "reviewer",
          prompt: "Review changes and report missing tests.",
        },
        ctx,
      ),
    ).rejects.toThrow(/Agent profile already exists with different config/);
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
      sandbox: { mode: "off" },
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
      sandbox: { mode: "off" },
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
    const tool = createHostShellTool(ctx.workspaceRoot, {
      sandbox: { mode: "off" },
    });

    await expect(
      tool.execute({ command: "echo leaked > leak.txt" }, ctx),
    ).rejects.toMatchObject({ code: "UNTRACKED_WORKSPACE_MUTATION" });
    await expect(
      readFile(join(ctx.workspaceRoot, "leak.txt")),
    ).rejects.toThrow();
  });

  it("rolls back shell writes to managed skill packages", async () => {
    const ctx = await createWorkspace({});
    const tool = createHostShellTool(ctx.workspaceRoot, {
      sandbox: { mode: "off" },
    });

    await expect(
      tool.execute(
        {
          command:
            "mkdir -p .sparkwright/skills/release-reviewer && echo bad > .sparkwright/skills/release-reviewer/skill.md",
        },
        ctx,
      ),
    ).rejects.toThrow(/dedicated SparkWright capability tools/);
    await expect(
      readFile(
        join(
          ctx.workspaceRoot,
          ".sparkwright/skills/release-reviewer/skill.md",
        ),
      ),
    ).rejects.toThrow();
  });

  it("still ignores runtime session files in shell mutation audits", async () => {
    const ctx = await createWorkspace({});
    const tool = createHostShellTool(ctx.workspaceRoot, {
      sandbox: { mode: "off" },
    });

    const result = await tool.execute(
      {
        command:
          "mkdir -p .sparkwright/sessions/session-test && echo runtime > .sparkwright/sessions/session-test/log.txt",
      },
      ctx,
    );

    expect(result.exitCode).toBe(0);
  });

  it("sets Python shell runs to avoid bytecode cache writes", async () => {
    const ctx = await createWorkspace({});
    const tool = createHostShellTool(ctx.workspaceRoot, {
      sandbox: { mode: "off" },
    });

    const result = await tool.execute(
      {
        command: 'node -e "console.log(process.env.PYTHONDONTWRITEBYTECODE)"',
      },
      ctx,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("1");
  });

  it("ignores Python bytecode cache directories in shell mutation audits", async () => {
    const ctx = await createWorkspace({});
    const tool = createHostShellTool(ctx.workspaceRoot, {
      sandbox: { mode: "off" },
    });

    const result = await tool.execute(
      {
        command:
          "node -e \"require('fs').mkdirSync('__pycache__'); require('fs').writeFileSync('__pycache__/logic.cpython-313.pyc', 'cache')\"",
      },
      ctx,
    );

    expect(result.exitCode).toBe(0);
  });

  it("fails closed when enforce-mode sandbox is unavailable", async () => {
    const ctx = await createWorkspace({});
    const runtime: ShellSandboxRuntime = {
      id: "test-unavailable",
      platform: "unsupported",
      isAvailable: async () => false,
      execute: async () => {
        throw new Error("should not execute");
      },
    };
    const tool = createHostShellTool(ctx.workspaceRoot, {
      sandbox: { mode: "enforce" },
      sandboxRuntime: runtime,
    });

    const result = await tool.execute({ command: "echo hi" }, ctx);

    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("test-unavailable");
    expect(result.timedOut).toBe(false);
    expect(result.sandbox).toMatchObject({
      sandboxed: false,
      mode: "enforce",
      runtime: "test-unavailable",
      networkMode: "deny",
      unavailable: expect.stringContaining("test-unavailable"),
      available: false,
      fallbackReason: expect.stringContaining("test-unavailable"),
      enforced: true,
    });
  });

  it("falls back in warn mode when sandbox is unavailable", async () => {
    const ctx = await createWorkspace({});
    const runtime: ShellSandboxRuntime = {
      id: "test-unavailable",
      platform: "unsupported",
      isAvailable: async () => false,
      execute: async () => {
        throw new Error("should not execute");
      },
    };
    const tool = createHostShellTool(ctx.workspaceRoot, {
      sandbox: { mode: "warn" },
      sandboxRuntime: runtime,
    });

    const result = await tool.execute({ command: "echo hi" }, ctx);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi\n");
    expect(result.sandbox).toMatchObject({
      sandboxed: false,
      mode: "warn",
      runtime: "test-unavailable",
      networkMode: "deny",
      unavailable: expect.stringContaining("test-unavailable"),
      available: false,
      fallbackReason: expect.stringContaining("test-unavailable"),
      enforced: false,
    });
  });

  it("keeps shell commands from writing forced deny config and skill roots when runtime is available", async () => {
    const runtime = createPlatformShellSandboxRuntime();
    if (!(await runtime.isAvailable())) return;

    const ctx = await createWorkspace({});
    const configPath = join(ctx.workspaceRoot, ".sparkwright", "config.json");
    const skillRoot = join(ctx.workspaceRoot, ".sparkwright", "skills");
    const skillPath = join(skillRoot, "guarded", "SKILL.md");
    await mkdir(join(skillRoot, "guarded"), { recursive: true });
    await writeFile(configPath, "original config\n", "utf8");
    await writeFile(skillPath, "original skill\n", "utf8");

    const tool = createHostShellTool(ctx.workspaceRoot, {
      sandbox: { mode: "enforce" },
      sandboxRuntime: runtime,
      extraForcedDenyWrite: [configPath],
      skillRoots: [skillRoot],
    });

    const configWrite = await tool.execute(
      { command: "echo bad > .sparkwright/config.json" },
      ctx,
    );
    const skillWrite = await tool.execute(
      { command: "echo bad > .sparkwright/skills/guarded/SKILL.md" },
      ctx,
    );

    expect(configWrite.exitCode).not.toBe(0);
    expect(skillWrite.exitCode).not.toBe(0);
    await expect(readFile(configPath, "utf8")).resolves.toBe(
      "original config\n",
    );
    await expect(readFile(skillPath, "utf8")).resolves.toBe("original skill\n");
  });
});

async function createWorkspace(files: Record<string, string>): Promise<
  RuntimeContext & {
    workspaceRoot: string;
    skippedWrites: Array<{ path: string; reason?: string }>;
    capabilityMutations: CapabilityMutationEvent[];
  }
> {
  const root = await mkdtemp(join(tmpdir(), "sparkwright-host-tools-"));
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(root, path);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }
  const skippedWrites: Array<{ path: string; reason?: string }> = [];
  const capabilityMutations: CapabilityMutationEvent[] = [];

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
    skippedWrites,
    capabilityMutations,
    reportWorkspaceWriteSkipped(payload) {
      skippedWrites.push(payload);
    },
    reportCapabilityMutationCompleted(payload) {
      capabilityMutations.push(payload);
    },
  };
}
