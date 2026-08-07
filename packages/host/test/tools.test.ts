import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createDefaultPolicy,
  createLayeredPolicy,
  createRun,
  createWorkspaceMutationPolicy,
  defineTool,
  createRunId,
  isToolConcurrencySafe,
  type CapabilityMutationEvent,
  type ModelAdapter,
  type RuntimeContext,
} from "@sparkwright/core";
import { EventLog, LocalWorkspace } from "@sparkwright/core/internal";
import {
  FileTaskStore,
  IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT,
  InMemoryTaskStore,
  TaskManager,
  type TaskId,
} from "@sparkwright/agent-runtime";
import {
  createPlatformShellSandboxRuntime,
  type ShellSandboxRuntime,
} from "@sparkwright/shell-sandbox";
import type { ShellToolOutput } from "@sparkwright/shell-tool";
import {
  createMarkdownAgentManagerTool,
  applyToolConfig,
  createGlobPathsTool,
  createReadFileTool,
} from "../src/tools.js";
import {
  catalogEntryOrigin,
  createCliDiagnosticToolCatalog,
  createConfiguredDelegateChildToolCatalog,
  createDynamicChildToolCatalog,
  createMainHostToolCatalog,
  createReadOnlyChildToolCatalog,
  resolveConfiguredToolAllowlist,
} from "../src/tool-catalog.js";
import { createHostShellTool } from "../src/shell.js";
import { deriveDelegatePolicyProfile } from "../src/delegate-capability.js";
import {
  assertCodingToolsCoveredByWorkspaceSelectors,
  resolveSelectorAllowlist,
} from "../src/tool-selectors.js";
import {
  createConfiguredDelegateTools,
  createDelegateParallelTool,
  createDynamicSpawnAgentTool,
  createInProcessDelegateHooksResolver,
  createInProcessDelegateModelResolver,
} from "../src/runtime.js";
import { createDelegateAgentTool } from "../src/indexed-delegate-tool.js";
import { createReadAgentReportTool } from "../src/agent-report-tool.js";
import {
  lifecycleTypes,
  projectAgentLifecycle,
  terminalLifecycleCount,
} from "./helpers/agent-lifecycle.js";

function completedAgentMessage(message: string): string {
  return message;
}

describe("host tools", () => {
  it("classifies indexed delegate concurrency from the selected target", () => {
    const delegates = [
      { profileId: "reader", toolName: "delegate_reader" },
      { profileId: "writer", toolName: "delegate_writer" },
    ];
    const derivedAgents = [
      { effectiveProfile: { id: "reader", name: "Reader" } },
      { effectiveProfile: { id: "writer", name: "Writer" } },
    ];
    const delegateTools = [
      defineTool({
        name: "delegate_reader",
        description: "Read-only delegate.",
        inputSchema: { type: "object" },
        policy: { risk: "safe" },
        governance: { sideEffects: ["read"], idempotency: "conditional" },
        execute() {
          return { ok: true };
        },
      }),
      defineTool({
        name: "delegate_writer",
        description: "Write-capable delegate.",
        inputSchema: { type: "object" },
        policy: { risk: "risky", requiresApproval: true },
        governance: { sideEffects: ["write"], idempotency: "conditional" },
        execute() {
          return { ok: true };
        },
      }),
    ];
    const indexed = createDelegateAgentTool({
      delegates,
      derivedAgents: derivedAgents as never,
      delegateTools,
    });

    expect(indexed.inputSchema).toMatchObject({
      required: ["agentId", "goal"],
    });
    expect(indexed.resultPresentation).toEqual({ kind: "agent_result" });
    expect(
      (indexed.inputSchema as { properties: Record<string, unknown> })
        .properties,
    ).not.toHaveProperty("toolName");

    expect(
      isToolConcurrencySafe(indexed, {
        agentId: "reader",
        goal: "Inspect README.md.",
      }),
    ).toBe(true);
    expect(
      isToolConcurrencySafe(indexed, {
        agentId: "writer",
        goal: "Update README.md.",
      }),
    ).toBe(false);
    expect(isToolConcurrencySafe(indexed, { goal: "Missing target." })).toBe(
      false,
    );
  });

  it("authors a validated Markdown Agent without mutating config profiles", async () => {
    const ctx = await createWorkspace({
      ".sparkwright/config.yaml": "capabilities:\n  agents:\n    maxDepth: 1\n",
    });
    const tool = createMarkdownAgentManagerTool(ctx.workspaceRoot);
    expect(tool.inputSchema).toMatchObject({
      properties: {
        name: expect.objectContaining({ type: "string" }),
      },
      required: ["action", "name"],
    });
    expect(
      (tool.inputSchema as { properties: Record<string, unknown> }).properties,
    ).not.toHaveProperty("id");
    await expect(
      tool.execute(
        {
          action: "create",
          id: "legacy-reviewer",
          prompt: "Review changes.",
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "TOOL_ARGUMENTS_INVALID" });
    const created = await tool.execute(
      {
        action: "create",
        name: "reviewer",
        prompt: "Review changes and report concrete risks.",
        use: ["workspace.read"],
        allowedTools: ["read"],
        maxSteps: 2,
      },
      ctx,
    );

    expect(created).toMatchObject({
      action: "create",
      name: "reviewer",
      changed: true,
      profile: { name: "reviewer" },
      callability: { callable: true, mode: "child" },
      semanticSummary: {
        allowedTools: ["read"],
        identity: { artifactKind: "agent", packageHashPolicyVersion: 2 },
      },
    });
    expect(created).not.toHaveProperty("id");
    expect((created as { profile: unknown }).profile).not.toHaveProperty("id");
    const document = await readFile(
      join(ctx.workspaceRoot, ".sparkwright", "agents", "reviewer.md"),
      "utf8",
    );
    expect(document).toContain('name: "reviewer"');
    expect(document).toContain("Review changes and report concrete risks.");
    expect(document).not.toContain("id:");
    expect(document).not.toContain("mode:");
    await expect(
      readFile(join(ctx.workspaceRoot, ".sparkwright", "config.yaml"), "utf8"),
    ).resolves.toContain("maxDepth: 1");
    expect(ctx.capabilityMutations).toEqual([
      expect.objectContaining({ action: "create_markdown_agent" }),
    ]);
  });

  it("accepts only the canonical Markdown Agent inheritance marker", async () => {
    const ctx = await createWorkspace({});
    const tool = createMarkdownAgentManagerTool(ctx.workspaceRoot);
    const modelSchema = (
      tool.inputSchema as {
        properties: { model: { oneOf: Array<{ enum?: string[] }> } };
      }
    ).properties.model;

    expect(modelSchema.oneOf[0]?.enum).toEqual(["inherit"]);
    await expect(
      tool.execute(
        {
          action: "create",
          name: "reviewer",
          prompt: "Review changes.",
          model: "default",
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "TOOL_ARGUMENTS_INVALID" });

    await expect(
      tool.execute(
        {
          action: "create",
          name: "reviewer",
          prompt: "Review changes.",
          model: "inherit",
        },
        ctx,
      ),
    ).resolves.toMatchObject({
      profile: { name: "reviewer" },
      semanticSummary: { model: undefined },
    });
    const document = await readFile(
      join(ctx.workspaceRoot, ".sparkwright", "agents", "reviewer.md"),
      "utf8",
    );
    expect(document).not.toContain("\nmodel:");
  });

  it("rejects a syntactically valid but unconfigured Markdown Agent model before writing", async () => {
    const ctx = await createWorkspace({});
    const tool = createMarkdownAgentManagerTool(ctx.workspaceRoot);

    await expect(
      tool.execute(
        {
          action: "create",
          name: "reviewer",
          prompt: "Review changes.",
          model: "inherit/not-a-real-model",
        },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "TOOL_ARGUMENTS_INVALID",
      message: expect.stringContaining("Unknown provider"),
    });
    await expect(
      readFile(
        join(ctx.workspaceRoot, ".sparkwright", "agents", "reviewer.md"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(ctx.capabilityMutations).toEqual([]);
  });

  it("fails post-write validation when another Markdown file owns the same basename", async () => {
    const ctx = await createWorkspace({
      ".sparkwright/agents/a/reviewer.md": "Existing reviewer.\n",
    });
    const tool = createMarkdownAgentManagerTool(ctx.workspaceRoot);
    await expect(
      tool.execute(
        { action: "create", name: "reviewer", prompt: "New reviewer." },
        ctx,
      ),
    ).rejects.toThrow(/not uniquely callable/);
  });

  it("removes the authored Markdown Agent without mutating config profiles", async () => {
    const ctx = await createWorkspace({
      ".sparkwright/config.yaml": "capabilities:\n  agents:\n    maxDepth: 1\n",
      ".sparkwright/agents/reviewer.md":
        '---\nname: "reviewer"\n---\n\nReview changes.\n',
    });
    const tool = createMarkdownAgentManagerTool(ctx.workspaceRoot);
    await expect(
      tool.execute({ action: "remove", name: "reviewer" }, ctx),
    ).resolves.toMatchObject({
      action: "remove",
      name: "reviewer",
      path: ".sparkwright/agents/reviewer.md",
      changed: true,
    });
    await expect(
      readFile(
        join(ctx.workspaceRoot, ".sparkwright", "agents", "reviewer.md"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(ctx.workspaceRoot, ".sparkwright", "config.yaml"), "utf8"),
    ).resolves.toContain("maxDepth: 1");
    expect(ctx.capabilityMutations).toEqual([
      expect.objectContaining({
        action: "remove_markdown_agent",
        path: ".sparkwright/agents/reviewer.md",
        reason: "Remove Markdown Agent reviewer",
      }),
    ]);
  });
  it("derives explicit in-process spawn approval without marking spawn risky", () => {
    const profile = deriveDelegatePolicyProfile({
      risk: "safe",
      configuredRequiresApproval: true,
      defaultRequiresApproval: false,
      runWriteEnabled: false,
    });

    expect(profile.policy).toEqual({ risk: "safe", requiresApproval: true });
    expect(profile.approvalRequiredUnderCurrentRun).toBe(true);
    expect(profile.approvalReasons).toEqual([
      "tool.requiresApproval:true",
      "delegate.requiresApproval:true",
    ]);
  });

  it("treats path metacharacters as literal read paths", async () => {
    const ctx = await createWorkspace({
      "app/[slug]/page.tsx": "export default function Page() {}\n",
      "packages/*/package.json": '{"name":"literal-star"}\n',
    });
    const tool = createReadFileTool();

    await expect(
      tool.validateInput!({ path: "app/[slug]/page.tsx" }, ctx),
    ).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      tool.execute({ path: "app/[slug]/page.tsx" }, ctx),
    ).resolves.toMatchObject({
      path: "app/[slug]/page.tsx",
      content: "export default function Page() {}\n",
    });
    await expect(
      tool.validateInput!({ path: "packages/*/package.json" }, ctx),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      tool.execute({ path: "packages/*/package.json" }, ctx),
    ).resolves.toMatchObject({
      path: "packages/*/package.json",
      content: '{"name":"literal-star"}\n',
    });
  });

  it("rejects read directory paths with tool guidance", async () => {
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

  it("normalizes read absolute and file URL paths", async () => {
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

  it("returns a structured nextOffset for paginated reads", async () => {
    const ctx = await createWorkspace({
      "PROJECT_NOTES.md": ["one", "two", "three", "four", "five"].join("\n"),
    });
    const tool = createReadFileTool();

    await expect(
      tool.execute({ path: "PROJECT_NOTES.md", limit: 2 }, ctx),
    ).resolves.toMatchObject({
      path: "PROJECT_NOTES.md",
      startLine: 1,
      endLine: 2,
      hasMore: true,
      nextOffset: 3,
    });
    await expect(
      tool.execute({ path: "PROJECT_NOTES.md", offset: 3, limit: 2 }, ctx),
    ).resolves.toMatchObject({
      startLine: 3,
      endLine: 4,
      hasMore: true,
      nextOffset: 5,
    });
  });

  it("caps default read windows to a model-visible character budget", async () => {
    const lines = Array.from(
      { length: 300 },
      (_, index) => `line ${index + 1}: ${"x".repeat(80)}`,
    ).join("\n");
    const ctx = await createWorkspace({ "PROJECT_NOTES.md": lines });
    const tool = createReadFileTool();

    const result = await tool.execute({ path: "PROJECT_NOTES.md" }, ctx);

    expect(result).toMatchObject({
      path: "PROJECT_NOTES.md",
      startLine: 1,
      hasMore: true,
      truncated: true,
    });
    expect(result.content.length).toBeLessThanOrEqual(6000);
    expect(result.endLine).toBeGreaterThan(1);
    expect("nextOffset" in result).toBe(true);
    if (!("nextOffset" in result)) {
      throw new Error("expected capped read result to expose nextOffset");
    }
    expect(result.nextOffset).toBe(result.endLine + 1);
    expect(result.note).toContain("capped at 6000 chars");
  });

  it("rejects read escaped paths as tool argument errors", async () => {
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
      name: "read",
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
      name: "bash",
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
      disabled: ["bash"],
      defer: ["mcp_docs_search"],
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "read",
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

  it("restricts tool config to allowed names before disabled and defer", () => {
    const read = defineTool({
      name: "read",
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
      name: "bash",
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
      allowed: ["read", "mcp_docs_search", "bash"],
      disabled: ["bash"],
      defer: ["mcp_docs_search"],
    });

    expect(tools.map((tool) => tool.name)).toEqual(["read", "mcp_docs_search"]);
    expect(tools.find((tool) => tool.name === "mcp_docs_search")).toMatchObject(
      { deferLoading: true },
    );
    expect(tools.find((tool) => tool.name === "mcp_required")).toBeUndefined();
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
      name: "read",
      description: "read",
      inputSchema: { type: "object" },
      execute: () => ({}),
    });

    const defaults = applyToolConfig(
      [todo, anchoredRead, createAgent, cron, read],
      undefined,
    );
    expect(defaults.find((tool) => tool.name === "todo_write")).toMatchObject({
      deferLoading: true,
    });
    expect(
      defaults.find((tool) => tool.name === "read_anchored_text"),
    ).toMatchObject({ deferLoading: true });
    expect(defaults.find((tool) => tool.name === "create_agent")).toMatchObject(
      { deferLoading: true },
    );
    expect(defaults.find((tool) => tool.name === "cron")).toMatchObject({
      deferLoading: true,
    });
    expect(
      defaults.find((tool) => tool.name === "read")?.deferLoading,
    ).toBeUndefined();

    const eager = applyToolConfig(
      [todo, anchoredRead, createAgent, cron, read],
      { defer: [] },
    );
    expect(eager.some((tool) => tool.deferLoading === true)).toBe(false);
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
      agentReportTool: createReadAgentReportTool({
        sessionRootDir: "/tmp/sessions",
        sessionId: "test",
      }),
      shell: { sandbox: { mode: "off" } },
    });
    const byName = new Map(
      entries.map((entry) => [entry.definition.name, entry]),
    );

    expect(byName.get("read")).toMatchObject({ source: "coding" });
    expect(catalogEntryOrigin(byName.get("read")!)).toBe(
      "local:@sparkwright/coding-tools",
    );
    expect(byName.get("bash")).toMatchObject({ source: "shell" });
    expect(byName.get("web_fetch")).toMatchObject({
      source: "web",
      definition: {
        canonicalName: "web_fetch",
        defaultExposureTier: "advanced",
        deferLoading: true,
        delegation: "parent_only",
        resultPresentation: { kind: "web_content" },
      },
    });
    expect(byName.get("web_fetch")?.definition.description).toContain(
      "public HTTPS URL",
    );
    expect(catalogEntryOrigin(byName.get("web_fetch")!)).toBe(
      "local:@sparkwright/web-tools",
    );
    expect(byName.get("cron")).toMatchObject({ source: "cron" });
    expect(byName.get("list_skills")).toMatchObject({ source: "skill" });
    expect(byName.get("task_create")).toMatchObject({ source: "task" });
    expect(byName.get("task_create")?.definition.description).toContain(
      "Registered kinds: agent",
    );
    expect(byName.get("task_create")?.definition.inputSchema).toMatchObject({
      properties: {
        kind: { enum: ["agent"] },
        payload: {
          required: ["goal"],
          description: expect.stringContaining(
            "Runtime configuration determines model, tools, permissions, and budgets",
          ),
          properties: {
            context: {
              description: expect.stringContaining("working task context"),
              maxLength: 8000,
            },
            label: {
              description: expect.stringContaining("UI/trace label"),
            },
          },
        },
      },
      required: ["kind", "payload"],
    });
    expect(byName.get("task")).toMatchObject({ source: "task" });
    expect(byName.get("task")?.definition.inputSchema).toMatchObject({
      properties: {
        action: {
          type: "string",
          enum: ["list", "get", "output", "wait", "stop"],
        },
        taskId: { type: "string", minLength: 1 },
        ids: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
        },
      },
    });
    expect(
      byName.get("task")?.definition.inputSchema as Record<string, unknown>,
    ).not.toHaveProperty("oneOf");
    expect(
      byName.get("task")?.definition.inputSchema as Record<string, unknown>,
    ).not.toHaveProperty("anyOf");
    expect(
      byName.get("task")?.definition.inputSchema as Record<string, unknown>,
    ).not.toHaveProperty("allOf");
    expect(byName.get("todo_write")).toMatchObject({ source: "todo" });
    expect(byName.get("spawn_agent")).toMatchObject({ source: "agent" });
    expect(byName.get("read_agent_report")).toMatchObject({
      source: "agent",
      definition: {
        canonicalName: "read_agent_report",
        defaultExposureTier: "advanced",
        deferLoading: true,
        delegation: "parent_only",
        resultPresentation: { kind: "file_read" },
      },
    });
    expect(byName.get("list_skills")?.definition.deferLoading).toBe(true);
    expect(byName.get("tool_search")).toMatchObject({ source: "core" });
  });

  it("builds web_fetch in hardened mode only when configured", async () => {
    const manager = new TaskManager({ store: new InMemoryTaskStore() });
    const entries = createMainHostToolCatalog({
      workspaceRoot: "/tmp/ws",
      skillRoots: [],
      taskManager: manager,
      getParentRunId: () => createRunId(),
      todoPath: "/tmp/ws/.sparkwright/sessions/test/todo.md",
      web: { security: "hardened" },
      shell: { sandbox: { mode: "off" } },
    });
    const webFetch = entries.find(
      (entry) => entry.definition.name === "web_fetch",
    )?.definition;

    expect(webFetch?.description).toContain("public HTTP(S) URL");
    await expect(
      Promise.resolve(
        webFetch?.validateInput?.({ url: "http://example.com/" }, {} as never),
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("keeps the main host tool catalog inside allowed tool names", () => {
    const manager = new TaskManager({ store: new InMemoryTaskStore() });
    const entries = createMainHostToolCatalog({
      workspaceRoot: "/tmp/ws",
      skillRoots: [],
      taskManager: manager,
      getParentRunId: () => createRunId(),
      todoPath: "/tmp/ws/.sparkwright/sessions/test/todo.md",
      preparedMcp: {
        tools: [
          defineTool({
            name: "mcp_demo_call_tool",
            description: "call",
            inputSchema: { type: "object" },
            execute: () => ({}),
          }),
        ],
      },
      shell: { sandbox: { mode: "off" } },
      toolConfig: {
        allowed: ["read", "todo_write", "mcp_demo_call_tool"],
      },
    });

    // tool_search is derived infrastructure: because a deferred tool
    // (todo_write) survives the allowlist, the discovery tool is appended even
    // though it is not itself listed in `allowed`. This matches the `use` path
    // and keeps the deferred tool reachable.
    expect(entries.map((entry) => entry.definition.name)).toEqual([
      "read",
      "todo_write",
      "mcp_demo_call_tool",
      "tool_search",
    ]);
    expect(
      entries.find((entry) => entry.definition.name === "todo_write"),
    ).toMatchObject({ definition: { deferLoading: true }, source: "todo" });
  });

  it("resolves tool selectors from catalog source metadata", () => {
    const manager = new TaskManager({ store: new InMemoryTaskStore() });
    const entries = createMainHostToolCatalog({
      workspaceRoot: "/tmp/ws",
      skillRoots: [],
      taskManager: manager,
      getParentRunId: () => createRunId(),
      todoPath: "/tmp/ws/.sparkwright/sessions/test/todo.md",
      preparedMcp: {
        tools: [
          defineTool({
            name: "mcp_demo_call_tool",
            description: "call demo",
            inputSchema: { type: "object" },
            governance: { origin: { kind: "mcp", name: "demo" } },
            execute: () => ({}),
          }),
          defineTool({
            name: "mcp_docs_call_tool",
            description: "call docs",
            inputSchema: { type: "object" },
            governance: { origin: { kind: "mcp", name: "docs" } },
            execute: () => ({}),
          }),
        ],
      },
      shell: { sandbox: { mode: "off" } },
    });

    expect(resolveSelectorAllowlist(entries, undefined)).toBeUndefined();
    // resolveSelectorAllowlist returns only selector-matched tools; tool_search
    // is appended later as derived infrastructure, not by the resolver.
    expect(resolveSelectorAllowlist(entries, ["workspace.write"])).toEqual([
      "create",
      "replace",
      "write",
      "edit_anchored_text",
      "edit",
    ]);
    expect(resolveSelectorAllowlist(entries, ["mcp:demo"])).toEqual([
      "mcp_demo_call_tool",
    ]);
    expect(resolveSelectorAllowlist(entries, ["web"])).toEqual(["web_fetch"]);
  });

  it("keeps selector-filtered deferred tools discoverable through tool_search", () => {
    const manager = new TaskManager({ store: new InMemoryTaskStore() });
    const entries = createMainHostToolCatalog({
      workspaceRoot: "/tmp/ws",
      skillRoots: [],
      taskManager: manager,
      getParentRunId: () => createRunId(),
      todoPath: "/tmp/ws/.sparkwright/sessions/test/todo.md",
      shell: { sandbox: { mode: "off" } },
      toolConfig: {
        use: ["workspace.read"],
      },
    });

    expect(entries.map((entry) => entry.definition.name)).toEqual([
      "read",
      "glob",
      "grep",
      "list_dir",
      "read_anchored_text",
      "tool_search",
    ]);
    expect(
      entries.find((entry) => entry.definition.name === "todo_write"),
    ).toBeUndefined();
  });

  it("resolves a configured allowlist from selectors against the real catalog", () => {
    // No use/allowed -> no restriction.
    expect(
      resolveConfiguredToolAllowlist({
        workspaceRoot: "/tmp/ws",
        toolConfig: undefined,
      }),
    ).toBeUndefined();

    // workspace.read resolves to the catalog's read tools by source, without a
    // hand-maintained name list in the caller.
    expect(
      resolveConfiguredToolAllowlist({
        workspaceRoot: "/tmp/ws",
        toolConfig: { use: ["workspace.read"] },
      }),
    ).toEqual(["read", "glob", "grep", "list_dir", "read_anchored_text"]);

    expect(
      resolveConfiguredToolAllowlist({
        workspaceRoot: "/tmp/ws",
        toolConfig: { use: ["web"] },
      }),
    ).toEqual(["web_fetch"]);

    // mcp:<server> matches by origin server name across provided MCP tools.
    expect(
      resolveConfiguredToolAllowlist({
        workspaceRoot: "/tmp/ws",
        toolConfig: { use: ["mcp:demo"] },
        mcpTools: [
          { name: "mcp_demo_call_tool", serverName: "demo" },
          { name: "mcp_docs_call_tool", serverName: "docs" },
        ],
      }),
    ).toEqual(["mcp_demo_call_tool"]);
  });

  it("omits tool_search when it is explicitly disabled despite deferred tools", () => {
    const manager = new TaskManager({ store: new InMemoryTaskStore() });
    const entries = createMainHostToolCatalog({
      workspaceRoot: "/tmp/ws",
      skillRoots: [],
      taskManager: manager,
      getParentRunId: () => createRunId(),
      todoPath: "/tmp/ws/.sparkwright/sessions/test/todo.md",
      shell: { sandbox: { mode: "off" } },
      toolConfig: {
        use: ["workspace.read"],
        disabled: ["tool_search"],
      },
    });

    const names = entries.map((entry) => entry.definition.name);
    expect(names).toContain("read_anchored_text"); // a deferred survivor
    expect(names).not.toContain("tool_search");
  });

  it("filters MCP tools by server selector before model inventory is built", () => {
    const manager = new TaskManager({ store: new InMemoryTaskStore() });
    const entries = createMainHostToolCatalog({
      workspaceRoot: "/tmp/ws",
      skillRoots: [],
      taskManager: manager,
      getParentRunId: () => createRunId(),
      todoPath: "/tmp/ws/.sparkwright/sessions/test/todo.md",
      preparedMcp: {
        tools: [
          defineTool({
            name: "mcp_demo_call_tool",
            description: "call demo",
            inputSchema: { type: "object" },
            governance: { origin: { kind: "mcp", name: "demo" } },
            execute: () => ({}),
          }),
          defineTool({
            name: "mcp_docs_call_tool",
            description: "call docs",
            inputSchema: { type: "object" },
            governance: { origin: { kind: "mcp", name: "docs" } },
            execute: () => ({}),
          }),
        ],
      },
      shell: { sandbox: { mode: "off" } },
      toolConfig: {
        use: ["mcp:demo"],
      },
    });

    expect(entries.map((entry) => entry.definition.name)).toEqual([
      "mcp_demo_call_tool",
      "tool_search",
    ]);
  });

  it("keeps every coding catalog tool classified by a workspace selector", () => {
    expect(() =>
      assertCodingToolsCoveredByWorkspaceSelectors(
        createCliDiagnosticToolCatalog({ workspaceRoot: "/tmp/ws" }),
      ),
    ).not.toThrow();
  });

  it("keeps read-only child tool catalog aligned with spawnable tools", () => {
    const entries = createReadOnlyChildToolCatalog({
      workspaceRoot: "/tmp/ws",
    });

    expect(entries.map((entry) => entry.definition.name)).toEqual([
      "read",
      "glob",
      "grep",
      "list_dir",
      "tool_search",
    ]);
    expect(new Set(entries.map((entry) => entry.source))).toEqual(
      new Set(["coding", "core"]),
    );

    const disabled = createReadOnlyChildToolCatalog({
      workspaceRoot: "/tmp/ws",
      toolConfig: { disabled: ["list_dir"] },
    });
    expect(disabled.map((entry) => entry.definition.name)).toEqual([
      "read",
      "glob",
      "grep",
    ]);
  });

  it("builds dynamic child tools with revisioned writes and child-safe shell", () => {
    const entries = createDynamicChildToolCatalog({
      workspaceRoot: "/tmp/ws",
    });

    expect(entries.map((entry) => entry.definition.name)).toEqual([
      "read",
      "glob",
      "grep",
      "list_dir",
      "create",
      "replace",
      "edit_anchored_text",
      "edit",
      "bash",
      "tool_search",
    ]);
    expect(entries.map((entry) => entry.definition.name)).not.toContain(
      "write",
    );

    const writeOnly = createDynamicChildToolCatalog({
      workspaceRoot: "/tmp/ws",
      toolConfig: { use: ["workspace.write"] },
    });
    expect(writeOnly.map((entry) => entry.definition.name)).toEqual([
      "create",
      "replace",
      "edit_anchored_text",
      "edit",
      "tool_search",
    ]);
  });

  it("rejects noncanonical agent task payload fields", async () => {
    const manager = new TaskManager({ store: new InMemoryTaskStore() });
    const taskCreate = createMainHostToolCatalog({
      workspaceRoot: "/tmp/ws",
      skillRoots: [],
      taskManager: manager,
      getParentRunId: () => createRunId(),
      todoPath: "/tmp/ws/.sparkwright/sessions/test/todo.md",
      shell: { sandbox: { mode: "off" } },
    }).find((entry) => entry.definition.name === "task_create")?.definition;

    expect(
      taskCreate?.policyForArgs?.({
        kind: "agent",
        payload: {
          goal: "write a file",
          role: "writer",
          context: "Write a file.",
          allowedTools: ["write"],
        },
      }),
    ).toEqual({});
    expect(
      taskCreate?.approvalSummaryForArgs?.(
        {
          kind: "agent",
          payload: {
            goal: "write a file",
            role: "writer",
            context: "Write a file.",
            allowedTools: ["write"],
          },
        },
        { maxChars: 200 },
      ),
    ).toBeUndefined();
    expect(
      await taskCreate?.approvalSubjectForArgs?.({
        kind: "agent",
        payload: {
          goal: "write a file",
          role: "writer",
          context: "Write a file.",
          allowedTools: ["write"],
        },
      }),
    ).toMatchObject({
      kind: "one_shot",
      label: "Allow task_create(agent) once",
    });
  });

  it("shares the effective spawn schema and semantic validator with agent task_create", async () => {
    const manager = new TaskManager({ store: new InMemoryTaskStore() });
    const readTool = defineTool({
      name: "read",
      description: "Read only.",
      inputSchema: { type: "object" },
      delegation: "child",
      execute: () => ({ content: "unused" }),
    });
    const dynamicSpawnTool = createDynamicSpawnAgentTool({
      getParent: () => undefined,
      model: { complete: async () => ({ message: "unused" }) },
      childTools: [readTool],
      parentRunPolicy: createDefaultPolicy(),
      childRunStoreFactory: () => undefined as never,
    });
    expect(dynamicSpawnTool.resultPresentation).toEqual({
      kind: "agent_result",
    });
    const taskCreate = createMainHostToolCatalog({
      workspaceRoot: "/tmp/ws",
      skillRoots: [],
      taskManager: manager,
      taskRunners: { agent: async () => ({ message: "unused" }) },
      getParentRunId: () => createRunId(),
      todoPath: "/tmp/ws/.sparkwright/sessions/test/todo.md",
      dynamicSpawnTool,
      shell: { sandbox: { mode: "off" } },
    }).find((entry) => entry.definition.name === "task_create")?.definition;
    expect(taskCreate).toBeDefined();

    const schema = taskCreate!.inputSchema as {
      properties: {
        payload: {
          properties: Record<string, unknown>;
          additionalProperties: boolean;
        };
      };
    };
    expect(Object.keys(schema.properties.payload.properties).sort()).toEqual([
      "context",
      "goal",
      "label",
    ]);
    expect(schema.properties.payload.additionalProperties).toBe(false);
    expect(dynamicSpawnTool.inputSchema).toMatchObject({
      additionalProperties: false,
    });
    expect(schema.properties.payload.properties).not.toHaveProperty("prompt");
    await expect(
      taskCreate!.validateInput?.(
        {
          kind: "agent",
          payload: {
            goal: "inspect a file",
            label: "reader",
            context: "x".repeat(8_001),
          },
        },
        {} as RuntimeContext,
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: "AGENT_SPAWN_CAPABILITY_INVALID",
    });
    await expect(
      taskCreate!.validateInput?.(
        {
          kind: "agent",
          payload: {
            goal: "edit a file",
            role: "writer",
            context: "Edit only.",
            allowedTools: ["edit"],
            grant: { workspaceWrite: true },
          },
        },
        {} as RuntimeContext,
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: "AGENT_SPAWN_CAPABILITY_INVALID",
    });
    expect(manager.store.list()).toEqual([]);
  });

  it("creates agent tasks with only the generic task approval", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sparkwright-host-task-create-gate-"),
    );
    try {
      const manager = new TaskManager({ store: new InMemoryTaskStore() });
      manager.registerKind("agent", async () => ({ message: "agent done" }));
      const taskCreate = createMainHostToolCatalog({
        workspaceRoot: root,
        skillRoots: [],
        taskManager: manager,
        getParentRunId: (ctx) => {
          if (!ctx) throw new Error("task_create requires runtime context.");
          return ctx.run.id;
        },
        todoPath: join(root, ".sparkwright", "sessions", "test", "todo.md"),
        shell: { sandbox: { mode: "off" } },
      }).find((entry) => entry.definition.name === "task_create")?.definition;
      expect(taskCreate).toBeDefined();

      const policy = createLayeredPolicy([
        createDefaultPolicy(),
        createWorkspaceMutationPolicy({ allowWorkspaceWrites: true }),
      ]);
      let modelCalls = 0;
      let approvalCalls = 0;
      const run = createRun({
        goal: "create a writer agent task",
        workspace: new LocalWorkspace(root),
        tools: [taskCreate!],
        policy,
        maxSteps: 4,
        interactionChannel: {
          approve(request) {
            approvalCalls += 1;
            return {
              approvalId: request.id,
              decision: "approved",
              message: "approved",
            };
          },
        },
        model: {
          async complete() {
            modelCalls += 1;
            return modelCalls === 1
              ? {
                  toolCalls: [
                    {
                      toolName: "task_create",
                      arguments: {
                        kind: "agent",
                        mode: "foreground",
                        title: "writer",
                        payload: {
                          goal: "write a file",
                          label: "writer",
                          context: "Write a file.",
                        },
                      },
                    },
                  ],
                }
              : { message: "parent done" };
          },
        },
      });

      await run.start();

      expect(approvalCalls).toBe(1);
      expect(manager.store.list({ kind: "agent" })).toHaveLength(1);
      expect(
        run.events.all().filter((event) => event.type === "approval.requested"),
      ).toHaveLength(1);
      expect(run.record.state).toBe("completed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("builds configured delegate child tools from the writable coding catalog", () => {
    const entries = createConfiguredDelegateChildToolCatalog({
      workspaceRoot: "/tmp/ws",
      toolConfig: { use: ["workspace.write"] },
    });

    expect(entries.map((entry) => entry.definition.name)).toEqual([
      "create",
      "replace",
      "edit_anchored_text",
      "edit",
      "tool_search",
    ]);
    expect(new Set(entries.map((entry) => entry.source))).toEqual(
      new Set(["coding", "core"]),
    );
  });

  it("lets configured delegate child tools expose shell by selector", () => {
    const entries = createConfiguredDelegateChildToolCatalog({
      workspaceRoot: "/tmp/ws",
      shell: { sandbox: { mode: "off" } },
      toolConfig: { use: ["bash"] },
    });

    expect(entries.map((entry) => entry.definition.name)).toEqual(["bash"]);
    expect(entries.map((entry) => entry.source)).toEqual(["shell"]);
  });

  it("anchors configured delegate child shell cwd relative to the workspace", async () => {
    const ctx = await createWorkspace({});
    const entries = createConfiguredDelegateChildToolCatalog({
      workspaceRoot: ctx.workspaceRoot,
      shell: { sandbox: { mode: "off" } },
      toolConfig: { use: ["bash"] },
    });
    const shell = entries.find(
      (entry) => entry.definition.name === "bash",
    )?.definition;

    const result = (await shell!.execute(
      { command: "pwd", cwd: "." },
      ctx,
    )) as ShellToolOutput;

    expect(result.stdout.trim()).toBe(await realpath(ctx.workspaceRoot));
    expect(result.promotionAvailable).toBe(false);
  });

  it("runs configured delegates with the effective profile tool set", async () => {
    const ctx = await createWorkspace({ "README.md": "# Demo\n" });
    const childToolCatalog = createConfiguredDelegateChildToolCatalog({
      workspaceRoot: ctx.workspaceRoot,
    });
    let childToolNames: string[] = [];
    let childSystemText = "";
    const childModel: ModelAdapter = {
      async complete(input) {
        childToolNames = input.tools.map((tool) => tool.name);
        childSystemText = (input.prompt ?? [])
          .filter((message) => message.role === "system")
          .map((message) => message.content)
          .join("\n");
        return { message: "child done" };
      },
    };
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      workspace: new LocalWorkspace(ctx.workspaceRoot),
      maxSteps: 2,
    });
    const [delegate] = createConfiguredDelegateTools({
      getParent: () => parent,
      delegates: [{ profileId: "reader", toolName: "delegate_reader" }],
      derivedAgents: [
        {
          effectiveProfile: {
            id: "reader",
            name: "Reader",
            mode: "child",
            prompt: "Inspect files.",
            use: ["workspace.read"],
            allowedTools: ["read"],
            maxSteps: 2,
          },
          inheritedPolicy: [],
          effectivePolicy: [],
          parentAgentDenyCount: 0,
          parentRunDenyCount: 0,
          childDenyCount: 0,
          effectiveToolCount: 1,
        },
      ],
      model: childModel,
      childTools: childToolCatalog.map((entry) => entry.definition),
      workspaceRoot: ctx.workspaceRoot,
      parentRunPolicy: createDefaultPolicy(),
      allowReadWriteWorkspaceAccess: false,
      childRunStoreFactory: () => undefined as never,
    });

    expect(delegate?.policy).toEqual({ risk: "safe", requiresApproval: false });
    expect(
      isToolConcurrencySafe(delegate, { goal: "Inspect README.md." }),
    ).toBe(true);

    const delegateResult = (await delegate!.execute(
      { goal: "Inspect README.md." },
      {
        run: parent.record,
      } as never,
    )) as { childRunId: string };

    expect(childToolNames).toEqual(["read"]);
    expect(childSystemText).toContain("Inspect files.");
    expect(childSystemText).toContain(IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT);
    expect(childSystemText.indexOf("Inspect files.")).toBeLessThan(
      childSystemText.indexOf("Child agent contract:"),
    );
    expect(
      lifecycleTypes(parent.events.all(), delegateResult.childRunId),
    ).toEqual(["subagent.requested", "subagent.started", "subagent.completed"]);
    expect(
      projectAgentLifecycle(parent.events.all(), delegateResult.childRunId),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          childAgentId: "reader",
          agentProfileId: "reader",
          entrypoint: "delegate",
          identityConsistent: true,
        }),
      ]),
    );
    expect(
      parent.events.all().find((event) => event.type === "subagent.requested")
        ?.metadata,
    ).toMatchObject({
      workspaceAccess: "read_only",
      agentConcurrency: "concurrent",
    });
    expect(
      terminalLifecycleCount(parent.events.all(), delegateResult.childRunId),
    ).toBe(1);
  });

  it("delegates by agentId through the generic delegate_agent tool", async () => {
    const ctx = await createWorkspace({ "README.md": "# Demo\n" });
    const childToolCatalog = createConfiguredDelegateChildToolCatalog({
      workspaceRoot: ctx.workspaceRoot,
    });
    let childCalls = 0;
    const childModel: ModelAdapter = {
      async complete() {
        childCalls += 1;
        return { message: completedAgentMessage("reader done") };
      },
    };
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      workspace: new LocalWorkspace(ctx.workspaceRoot),
      maxSteps: 2,
    });
    const delegates = [
      {
        profileId: "reader",
        toolName: "delegate_reader",
        requiresApproval: true,
      },
    ];
    const derivedAgents = [
      {
        effectiveProfile: {
          id: "reader",
          name: "Reader",
          mode: "child" as const,
          prompt: "Inspect files.",
          use: ["workspace.read"],
          allowedTools: ["read"],
          maxSteps: 2,
        },
        inheritedPolicy: [],
        effectivePolicy: [],
        parentAgentDenyCount: 0,
        parentRunDenyCount: 0,
        childDenyCount: 0,
        effectiveToolCount: 1,
      },
    ];
    const hiddenDelegateTools = createConfiguredDelegateTools({
      getParent: () => parent,
      delegates,
      derivedAgents,
      model: childModel,
      childTools: childToolCatalog.map((entry) => entry.definition),
      workspaceRoot: ctx.workspaceRoot,
      parentRunPolicy: createDefaultPolicy(),
      allowReadWriteWorkspaceAccess: false,
      childRunStoreFactory: () => undefined as never,
    });
    const delegateAgent = createDelegateAgentTool({
      delegates,
      derivedAgents,
      delegateTools: hiddenDelegateTools,
    });

    expect(
      isToolConcurrencySafe(hiddenDelegateTools[0], {
        goal: "Inspect README.md.",
      }),
    ).toBe(false);
    expect(
      isToolConcurrencySafe(delegateAgent, {
        agentId: "reader",
        goal: "Inspect README.md.",
      }),
    ).toBe(false);

    expect(
      delegateAgent.policyForArgs?.({
        agentId: "reader",
        goal: "Inspect README.md.",
      }),
    ).toMatchObject({
      policy: { risk: "safe", requiresApproval: true },
    });
    expect(
      delegateAgent.managesRepeatedCalls?.({
        agentId: "reader",
        goal: "Inspect README.md.",
      }),
    ).toBe(false);

    const indexedResult = (await delegateAgent.execute(
      { agentId: "reader", goal: "Inspect README.md." },
      {
        run: parent.record,
      } as never,
    )) as { childRunId: string; status: string; report: string };
    expect(indexedResult).toMatchObject({
      status: "completed",
      report: "reader done",
      workspace: { writes: 0 },
    });
    expect(
      lifecycleTypes(parent.events.all(), indexedResult.childRunId),
    ).toEqual(["subagent.requested", "subagent.started", "subagent.completed"]);
    expect(
      projectAgentLifecycle(
        parent.events.all(),
        indexedResult.childRunId,
      ).every((event) => event.entrypoint === "delegate_agent"),
    ).toBe(true);
    expect(
      terminalLifecycleCount(parent.events.all(), indexedResult.childRunId),
    ).toBe(1);
    expect(childCalls).toBe(1);
    expect(
      delegateAgent.managesRepeatedCalls?.({
        agentId: "reader",
        goal: "Inspect README.md.",
      }),
    ).toBe(true);

    const reusedResult = (await delegateAgent.execute(
      { agentId: "reader", goal: "Inspect README.md." },
      { run: parent.record } as never,
    )) as { childRunId: string; warnings?: string[] };
    expect(reusedResult).toMatchObject({
      childRunId: indexedResult.childRunId,
      warnings: [
        "The runtime reused this completed child result; no new child ran.",
      ],
    });
    expect(childCalls).toBe(1);
  });

  it("applies profile workflow hooks to configured delegate child runs", async () => {
    const ctx = await createWorkspace({ "README.md": "# Demo\n" });
    let childCalls = 0;
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      workspace: new LocalWorkspace(ctx.workspaceRoot),
      maxSteps: 2,
    });
    const delegates = [{ profileId: "reader", toolName: "delegate_reader" }];
    const derivedAgents = [
      {
        effectiveProfile: {
          id: "reader",
          name: "Reader",
          mode: "child" as const,
          prompt: "Inspect files.",
          allowedTools: [],
          maxSteps: 1,
          hooks: [
            {
              name: "reader.RunStart.0",
              hook: "RunStart" as const,
              action: {
                type: "block" as const,
                reason: "reader guard blocked",
              },
            },
          ],
        },
        inheritedPolicy: [],
        effectivePolicy: [],
        parentAgentDenyCount: 0,
        parentRunDenyCount: 0,
        childDenyCount: 0,
        effectiveToolCount: 0,
      },
    ];
    const [delegate] = createConfiguredDelegateTools({
      getParent: () => parent,
      delegates,
      derivedAgents,
      model: {
        async complete() {
          childCalls += 1;
          return { message: completedAgentMessage("reader done") };
        },
      },
      workflowHooksForProfile: createInProcessDelegateHooksResolver({
        delegates,
        derivedAgents,
        workspaceRoot: ctx.workspaceRoot,
      }),
      childTools: [],
      workspaceRoot: ctx.workspaceRoot,
      parentRunPolicy: createDefaultPolicy(),
      allowReadWriteWorkspaceAccess: false,
      childRunStoreFactory: () => undefined as never,
    });

    await expect(
      delegate!.execute({ goal: "Inspect README.md." }, {
        run: parent.record,
      } as never),
    ).rejects.toThrow(/hook_stopped/);

    expect(childCalls).toBe(0);
  });

  it("runs read-only configured delegates in foreground parallel", async () => {
    const ctx = await createWorkspace({ "README.md": "# Demo\n" });
    let active = 0;
    let maxActive = 0;
    const childSystemPrompts = new Map<string, string>();
    const makeModel = (label: string): ModelAdapter => ({
      async complete(input) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        childSystemPrompts.set(
          label,
          (input.prompt ?? [])
            .filter((message) => message.role === "system")
            .map((message) => message.content)
            .join("\n"),
        );
        await new Promise((resolve) => setTimeout(resolve, 40));
        active -= 1;
        return { message: completedAgentMessage(`${label} done`) };
      },
    });
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      workspace: new LocalWorkspace(ctx.workspaceRoot),
      maxSteps: 2,
    });
    const parallel = createDelegateParallelTool({
      getParent: () => parent,
      delegates: [
        { profileId: "reviewer", toolName: "delegate_reviewer" },
        { profileId: "auditor", toolName: "delegate_auditor" },
      ],
      derivedAgents: [
        {
          effectiveProfile: {
            id: "reviewer",
            name: "Reviewer",
            mode: "child",
            prompt: "Review.",
            allowedTools: [],
            maxSteps: 2,
          },
          inheritedPolicy: [],
          effectivePolicy: [],
          parentAgentDenyCount: 0,
          parentRunDenyCount: 0,
          childDenyCount: 0,
          effectiveToolCount: 0,
        },
        {
          effectiveProfile: {
            id: "auditor",
            name: "Auditor",
            mode: "child",
            prompt: "Audit.",
            allowedTools: [],
            maxSteps: 2,
          },
          inheritedPolicy: [],
          effectivePolicy: [],
          parentAgentDenyCount: 0,
          parentRunDenyCount: 0,
          childDenyCount: 0,
          effectiveToolCount: 0,
        },
      ],
      model: makeModel("fallback"),
      modelForProfile: async (profileId) =>
        profileId === "reviewer"
          ? makeModel("reviewer")
          : profileId === "auditor"
            ? makeModel("auditor")
            : undefined,
      childTools: [],
      parentRunPolicy: createDefaultPolicy(),
      allowReadWriteWorkspaceAccess: false,
      childRunStoreFactory: () => undefined as never,
    });

    expect(parallel.inputSchema).toMatchObject({
      properties: {
        delegates: {
          items: { required: ["agentId", "goal"] },
        },
      },
    });
    expect(parallel.resultPresentation).toEqual({ kind: "agent_batch" });
    const delegateItemSchema = (
      parallel.inputSchema as {
        properties: {
          delegates: { items: { properties: Record<string, unknown> } };
        };
      }
    ).properties.delegates.items;
    expect(delegateItemSchema.properties).not.toHaveProperty("toolName");
    await expect(
      parallel.execute(
        {
          delegates: [
            {
              agentId: "reviewer",
              goal: "Review the patch.",
              metadata: { grant: "full" },
            },
          ],
        },
        { run: parent.record } as never,
      ),
    ).rejects.toThrow(
      /accepts only agentId, goal, context, and label; received metadata/,
    );

    const output = (await parallel.execute(
      {
        delegates: [
          {
            agentId: "reviewer",
            goal: "Review the patch.",
          },
          { agentId: "auditor", goal: "Audit the risks." },
        ],
      },
      { run: parent.record } as never,
    )) as {
      mode: string;
      completed: number;
      incomplete: number;
      results: Array<{
        agentId: string;
        status: string;
        report: string;
        childRunId: string;
      }>;
    };

    expect(maxActive).toBe(2);
    expect(childSystemPrompts.get("reviewer")).toContain(
      IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT,
    );
    expect(childSystemPrompts.get("auditor")).toContain(
      IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT,
    );
    expect(childSystemPrompts.get("reviewer")?.indexOf("Review.")).toBeLessThan(
      childSystemPrompts.get("reviewer")?.indexOf("Child agent contract:") ??
        -1,
    );
    expect(childSystemPrompts.get("auditor")?.indexOf("Audit.")).toBeLessThan(
      childSystemPrompts.get("auditor")?.indexOf("Child agent contract:") ?? -1,
    );
    expect(output).toMatchObject({
      mode: "parallel",
      completed: 2,
      incomplete: 0,
      results: [
        { agentId: "reviewer", status: "completed", report: "reviewer done" },
        { agentId: "auditor", status: "completed", report: "auditor done" },
      ],
    });
    for (const result of output.results) {
      expect(lifecycleTypes(parent.events.all(), result.childRunId)).toEqual([
        "subagent.requested",
        "subagent.started",
        "subagent.completed",
      ]);
      expect(
        projectAgentLifecycle(parent.events.all(), result.childRunId).every(
          (event) =>
            event.entrypoint === "delegate_parallel" &&
            event.identityConsistent,
        ),
      ).toBe(true);
      expect(
        terminalLifecycleCount(parent.events.all(), result.childRunId),
      ).toBe(1);
    }
  });

  it("returns runtime-partial child reports without failing parallel orchestration", async () => {
    const ctx = await createWorkspace({ "README.md": "# Demo\n" });
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      workspace: new LocalWorkspace(ctx.workspaceRoot),
      maxSteps: 2,
    });
    const parallel = createDelegateParallelTool({
      getParent: () => parent,
      delegates: [{ profileId: "partial", toolName: "delegate_partial" }],
      derivedAgents: [
        {
          effectiveProfile: {
            id: "partial",
            name: "Partial",
            mode: "child",
            prompt: "Inspect both files.",
            allowedTools: [],
            maxSteps: 1,
          },
          inheritedPolicy: [],
          effectivePolicy: [],
          parentAgentDenyCount: 0,
          parentRunDenyCount: 0,
          childDenyCount: 0,
          effectiveToolCount: 0,
        },
      ],
      model: {
        async complete() {
          return {};
        },
      },
      childTools: [],
      parentRunPolicy: createDefaultPolicy(),
      allowReadWriteWorkspaceAccess: false,
      childRunStoreFactory: () => undefined as never,
    });

    await expect(
      parallel.execute(
        { delegates: [{ agentId: "partial", goal: "Inspect both files." }] },
        { run: parent.record } as never,
      ),
    ).resolves.toMatchObject({
      completed: 0,
      incomplete: 1,
      results: [
        expect.objectContaining({
          status: "partial",
          report: "Child run completed without a report.",
          blockers: [expect.objectContaining({ code: "AGENT_REPORT_MISSING" })],
          workspace: { writes: 0 },
        }),
      ],
    });
  });

  it("keeps raw child health in diagnostics and projects actionable parent warnings", async () => {
    const ctx = await createWorkspace({ "README.md": "# Demo\n" });
    const failingProbe = defineTool({
      name: "failing_probe",
      description: "Return a deterministic diagnostic failure.",
      inputSchema: { type: "object" },
      policy: { risk: "safe" },
      async execute() {
        throw new Error("probe failed");
      },
    });
    const calls = new Map<string, number>();
    const childModel = (profileId: string): ModelAdapter => ({
      async complete() {
        const call = (calls.get(profileId) ?? 0) + 1;
        calls.set(profileId, call);
        if (profileId === "reviewer" && call === 1) {
          return {
            toolCalls: [{ toolName: "failing_probe", arguments: {} }],
          };
        }
        return { message: completedAgentMessage(`${profileId} done`) };
      },
    });
    const parent = createRun({
      goal: "parent",
      model: childModel("parent"),
      workspace: new LocalWorkspace(ctx.workspaceRoot),
      maxSteps: 3,
    });
    const parallel = createDelegateParallelTool({
      getParent: () => parent,
      delegates: [
        { profileId: "reviewer", toolName: "delegate_reviewer" },
        { profileId: "auditor", toolName: "delegate_auditor" },
      ],
      derivedAgents: [
        {
          effectiveProfile: {
            id: "reviewer",
            name: "Reviewer",
            mode: "child",
            prompt: "Review.",
            allowedTools: ["failing_probe"],
            maxSteps: 3,
          },
          inheritedPolicy: [],
          effectivePolicy: [],
          parentAgentDenyCount: 0,
          parentRunDenyCount: 0,
          childDenyCount: 0,
          effectiveToolCount: 1,
        },
        {
          effectiveProfile: {
            id: "auditor",
            name: "Auditor",
            mode: "child",
            prompt: "Audit.",
            allowedTools: [],
            maxSteps: 2,
          },
          inheritedPolicy: [],
          effectivePolicy: [],
          parentAgentDenyCount: 0,
          parentRunDenyCount: 0,
          childDenyCount: 0,
          effectiveToolCount: 0,
        },
      ],
      model: childModel("fallback"),
      modelForProfile: async (profileId) => childModel(profileId),
      childTools: [failingProbe],
      parentRunPolicy: createDefaultPolicy(),
      allowReadWriteWorkspaceAccess: false,
      childRunStoreFactory: () => undefined as never,
    });

    const output = (await parallel.execute(
      {
        delegates: [
          { agentId: "reviewer", goal: "Review the patch." },
          { agentId: "auditor", goal: "Audit the patch." },
        ],
      },
      { run: parent.record } as never,
    )) as {
      completed: number;
      incomplete: number;
      results: Array<{
        agentId: string;
        status: string;
        warnings?: string[];
      }>;
    };

    expect(output).toMatchObject({
      completed: 2,
      incomplete: 0,
    });
    expect(output).not.toHaveProperty("unhealthy");
    expect(output.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: "reviewer",
          status: "completed",
        }),
        expect.objectContaining({
          agentId: "auditor",
          status: "completed",
        }),
      ]),
    );
    expect(
      output.results.find((result) => result.agentId === "reviewer"),
    ).toMatchObject({
      warnings: [
        expect.stringContaining(
          "failing_probe failed: probe failed (TOOL_EXECUTION_FAILED)",
        ),
      ],
    });
    expect(
      output.results
        .find((result) => result.agentId === "reviewer")
        ?.warnings?.join("\n"),
    ).not.toContain("UNRESOLVED_TOOL_FAILURE");
  });

  it("applies profile workflow hooks to delegate_parallel child runs", async () => {
    const ctx = await createWorkspace({ "README.md": "# Demo\n" });
    let reviewerCalls = 0;
    let auditorCalls = 0;
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      workspace: new LocalWorkspace(ctx.workspaceRoot),
      maxSteps: 2,
    });
    const delegates = [
      { profileId: "reviewer", toolName: "delegate_reviewer" },
      { profileId: "auditor", toolName: "delegate_auditor" },
    ];
    const derivedAgents = [
      {
        effectiveProfile: {
          id: "reviewer",
          name: "Reviewer",
          mode: "child" as const,
          prompt: "Review.",
          allowedTools: [],
          maxSteps: 1,
          hooks: [
            {
              name: "reviewer.RunStart.0",
              hook: "RunStart" as const,
              action: {
                type: "block" as const,
                reason: "parallel guard blocked",
              },
            },
          ],
        },
        inheritedPolicy: [],
        effectivePolicy: [],
        parentAgentDenyCount: 0,
        parentRunDenyCount: 0,
        childDenyCount: 0,
        effectiveToolCount: 0,
      },
      {
        effectiveProfile: {
          id: "auditor",
          name: "Auditor",
          mode: "child" as const,
          prompt: "Audit.",
          allowedTools: [],
          maxSteps: 2,
        },
        inheritedPolicy: [],
        effectivePolicy: [],
        parentAgentDenyCount: 0,
        parentRunDenyCount: 0,
        childDenyCount: 0,
        effectiveToolCount: 0,
      },
    ];
    const parallel = createDelegateParallelTool({
      getParent: () => parent,
      delegates,
      derivedAgents,
      model: {
        async complete() {
          return { message: completedAgentMessage("fallback done") };
        },
      },
      modelForProfile: (profileId) =>
        profileId === "reviewer"
          ? {
              async complete() {
                reviewerCalls += 1;
                return { message: completedAgentMessage("reviewer done") };
              },
            }
          : profileId === "auditor"
            ? {
                async complete() {
                  auditorCalls += 1;
                  return { message: completedAgentMessage("auditor done") };
                },
              }
            : undefined,
      workflowHooksForProfile: createInProcessDelegateHooksResolver({
        delegates,
        derivedAgents,
        workspaceRoot: ctx.workspaceRoot,
      }),
      childTools: [],
      parentRunPolicy: createDefaultPolicy(),
      allowReadWriteWorkspaceAccess: false,
      childRunStoreFactory: () => undefined as never,
    });

    const output = (await parallel.execute(
      {
        delegates: [
          { agentId: "reviewer", goal: "Review the patch." },
          { agentId: "auditor", goal: "Audit the risks." },
        ],
      },
      { run: parent.record } as never,
    )) as {
      completed: number;
      incomplete: number;
      results: Array<{
        agentId: string;
        status: string;
        report: string;
        blockers?: Array<{ code: string }>;
      }>;
    };

    expect(output).toMatchObject({
      completed: 1,
      incomplete: 1,
    });
    expect(output).not.toHaveProperty("unhealthy");
    expect(output.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: "reviewer",
          status: "partial",
          blockers: [expect.objectContaining({ code: "AGENT_RUN_INCOMPLETE" })],
        }),
        expect.objectContaining({
          agentId: "auditor",
          status: "completed",
          report: "auditor done",
        }),
      ]),
    );
    expect(reviewerCalls).toBe(0);
    expect(auditorCalls).toBe(1);
  });

  it("does not request delegate_parallel children when model resolution fails", async () => {
    const ctx = await createWorkspace({ "README.md": "# Demo\n" });
    let childRunStoreCalls = 0;
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      workspace: new LocalWorkspace(ctx.workspaceRoot),
      maxSteps: 2,
    });
    const parallel = createDelegateParallelTool({
      getParent: () => parent,
      delegates: [
        { profileId: "reviewer", toolName: "delegate_reviewer" },
        { profileId: "auditor", toolName: "delegate_auditor" },
      ],
      derivedAgents: [
        {
          effectiveProfile: {
            id: "reviewer",
            name: "Reviewer",
            mode: "child",
            prompt: "Review.",
            allowedTools: [],
            maxSteps: 1,
          },
          inheritedPolicy: [],
          effectivePolicy: [],
          parentAgentDenyCount: 0,
          parentRunDenyCount: 0,
          childDenyCount: 0,
          effectiveToolCount: 0,
        },
        {
          effectiveProfile: {
            id: "auditor",
            name: "Auditor",
            mode: "child",
            prompt: "Audit.",
            allowedTools: [],
            maxSteps: 1,
          },
          inheritedPolicy: [],
          effectivePolicy: [],
          parentAgentDenyCount: 0,
          parentRunDenyCount: 0,
          childDenyCount: 0,
          effectiveToolCount: 0,
        },
      ],
      model: {
        async complete() {
          return { message: completedAgentMessage("fallback done") };
        },
      },
      modelForProfile: async (profileId) => {
        if (profileId === "auditor") {
          throw new Error('agent "auditor" model "missing/model": unavailable');
        }
        return {
          async complete() {
            return { message: completedAgentMessage("reviewer done") };
          },
        };
      },
      childTools: [],
      parentRunPolicy: createDefaultPolicy(),
      allowReadWriteWorkspaceAccess: false,
      childRunStoreFactory: () => {
        childRunStoreCalls += 1;
        return undefined as never;
      },
    });

    await expect(
      parallel.execute(
        {
          delegates: [
            { agentId: "reviewer", goal: "Review the patch." },
            { agentId: "auditor", goal: "Audit the risks." },
          ],
        },
        { run: parent.record } as never,
      ),
    ).rejects.toThrow(/missing\/model/);

    expect(childRunStoreCalls).toBe(0);
    expect(
      parent.events
        .all()
        .filter((event) => event.type === "subagent.requested"),
    ).toHaveLength(0);
  });

  it("reuses completed delegate results across single and parallel entrypoints", async () => {
    const ctx = await createWorkspace({ "README.md": "# Demo\n" });
    let reviewerCalls = 0;
    let auditorCalls = 0;
    const reviewerModel: ModelAdapter = {
      async complete() {
        reviewerCalls += 1;
        return { message: completedAgentMessage("reviewer done") };
      },
    };
    const auditorModel: ModelAdapter = {
      async complete() {
        auditorCalls += 1;
        return { message: completedAgentMessage("auditor done") };
      },
    };
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      workspace: new LocalWorkspace(ctx.workspaceRoot),
      maxSteps: 3,
    });
    const delegates = [
      { profileId: "reviewer", toolName: "delegate_reviewer" },
      { profileId: "auditor", toolName: "delegate_auditor" },
    ];
    const derivedAgents = [
      {
        effectiveProfile: {
          id: "reviewer",
          name: "Reviewer",
          mode: "child" as const,
          prompt: "Review.",
          allowedTools: [],
          maxSteps: 2,
        },
        inheritedPolicy: [],
        effectivePolicy: [],
        parentAgentDenyCount: 0,
        parentRunDenyCount: 0,
        childDenyCount: 0,
        effectiveToolCount: 0,
      },
      {
        effectiveProfile: {
          id: "auditor",
          name: "Auditor",
          mode: "child" as const,
          prompt: "Audit.",
          allowedTools: [],
          maxSteps: 2,
        },
        inheritedPolicy: [],
        effectivePolicy: [],
        parentAgentDenyCount: 0,
        parentRunDenyCount: 0,
        childDenyCount: 0,
        effectiveToolCount: 0,
      },
    ];
    const modelForProfile = (profileId: string) =>
      profileId === "reviewer"
        ? reviewerModel
        : profileId === "auditor"
          ? auditorModel
          : undefined;
    const singleDelegates = createConfiguredDelegateTools({
      getParent: () => parent,
      delegates,
      derivedAgents,
      model: reviewerModel,
      modelForProfile,
      childTools: [],
      workspaceRoot: ctx.workspaceRoot,
      parentRunPolicy: createDefaultPolicy(),
      allowReadWriteWorkspaceAccess: false,
      childRunStoreFactory: () => undefined as never,
    });
    const reviewer = singleDelegates.find(
      (tool) => tool.name === "delegate_reviewer",
    );
    const auditor = singleDelegates.find(
      (tool) => tool.name === "delegate_auditor",
    );
    const parallel = createDelegateParallelTool({
      getParent: () => parent,
      delegates,
      derivedAgents,
      model: reviewerModel,
      modelForProfile,
      childTools: [],
      parentRunPolicy: createDefaultPolicy(),
      allowReadWriteWorkspaceAccess: false,
      childRunStoreFactory: () => undefined as never,
    });

    await reviewer!.execute({ goal: "Review README.md." }, {
      run: parent.record,
    } as never);
    const parallelOutput = (await parallel.execute(
      {
        delegates: [
          { agentId: "reviewer", goal: "Review README.md." },
          { agentId: "auditor", goal: "Audit README.md." },
        ],
      },
      { run: parent.record } as never,
    )) as {
      results: Array<{
        agentId: string;
        report?: string;
        warnings?: string[];
      }>;
    };
    const repeatedAuditor = await auditor!.execute(
      { goal: "Audit README.md." },
      { run: parent.record } as never,
    );

    expect(reviewerCalls).toBe(1);
    expect(auditorCalls).toBe(1);
    expect(parallelOutput.results).toMatchObject([
      {
        agentId: "reviewer",
        report: "reviewer done",
        warnings: [
          "The runtime reused this completed child result; no new child ran.",
        ],
      },
      { agentId: "auditor", report: "auditor done" },
    ]);
    expect(repeatedAuditor).toMatchObject({
      report: "auditor done",
      warnings: [
        "The runtime reused this completed child result; no new child ran.",
      ],
    });
  });

  it("reuses completed dynamic spawn results for the same child scope", async () => {
    const ctx = await createWorkspace({ "README.md": "# Demo\n" });
    let childCalls = 0;
    const childModel: ModelAdapter = {
      async complete() {
        childCalls += 1;
        if (childCalls === 1) {
          return {
            toolCalls: [{ toolName: "read", arguments: { path: "README.md" } }],
          };
        }
        // Deliberately make a false mutation claim: the runtime-owned
        // workspace evidence returned beside it must remain authoritative.
        return { message: completedAgentMessage("Created print_numbers.py.") };
      },
    };
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      workspace: new LocalWorkspace(ctx.workspaceRoot),
      maxSteps: 3,
    });
    const childTools = createReadOnlyChildToolCatalog({
      workspaceRoot: ctx.workspaceRoot,
    }).map((entry) => entry.definition);
    const spawnAgent = createDynamicSpawnAgentTool({
      getParent: () => parent,
      model: childModel,
      childTools,
      parentRunPolicy: createDefaultPolicy(),
      childRunStoreFactory: () => undefined as never,
    });
    const args = {
      label: "Risk Reader",
      context: "Read project files and report one risk.",
      goal: "Inspect README.md for one risk.",
    };

    const first = await spawnAgent.execute(args, {
      run: parent.record,
    } as never);
    expect(spawnAgent.managesRepeatedCalls?.(args)).toBe(true);
    const second = await spawnAgent.execute(args, {
      run: parent.record,
    } as never);

    expect(childCalls).toBe(2);
    expect(first).toMatchObject({
      status: "completed",
      report: "Created print_numbers.py.",
      workspace: { writes: 0 },
    });
    expect(second).toMatchObject({
      status: "completed",
      report: "Created print_numbers.py.",
      workspace: { writes: 0 },
      warnings: [
        "The runtime reused this completed child result; no new child ran.",
      ],
    });
  });

  it("runs dynamic spawn_agent on the configured spawn model when provided", async () => {
    const ctx = await createWorkspace({ "README.md": "# Demo\n" });
    let inheritedModelUsed = false;
    let spawnModelUsed = false;
    const inheritedModel: ModelAdapter = {
      async complete() {
        inheritedModelUsed = true;
        return { message: "inherited child done" };
      },
    };
    const spawnModel: ModelAdapter = {
      async complete() {
        spawnModelUsed = true;
        return { message: "spawn-model child done" };
      },
    };
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      workspace: new LocalWorkspace(ctx.workspaceRoot),
      maxSteps: 3,
    });
    const childTools = createReadOnlyChildToolCatalog({
      workspaceRoot: ctx.workspaceRoot,
    }).map((entry) => entry.definition);
    const spawnAgent = createDynamicSpawnAgentTool({
      getParent: () => parent,
      model: inheritedModel,
      modelForSpawn: async () => spawnModel,
      childTools,
      parentRunPolicy: createDefaultPolicy(),
      childRunStoreFactory: () => undefined as never,
    });

    await expect(
      spawnAgent.execute(
        {
          label: "Risk Reader",
          context: "Read project files and report one risk.",
          goal: "Inspect README.md for one risk.",
        },
        { run: parent.record } as never,
      ),
    ).resolves.toMatchObject({
      status: "completed",
      report: "spawn-model child done",
      workspace: { writes: 0 },
    });

    expect(spawnModelUsed).toBe(true);
    expect(inheritedModelUsed).toBe(false);
  });

  it("does not request a dynamic child when spawn model resolution fails", async () => {
    const ctx = await createWorkspace({ "README.md": "# Demo\n" });
    let childRunStoreCalls = 0;
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      workspace: new LocalWorkspace(ctx.workspaceRoot),
      maxSteps: 3,
    });
    const childTools = createReadOnlyChildToolCatalog({
      workspaceRoot: ctx.workspaceRoot,
    }).map((entry) => entry.definition);
    const spawnAgent = createDynamicSpawnAgentTool({
      getParent: () => parent,
      model: {
        async complete() {
          return { message: "inherited child done" };
        },
      },
      modelForSpawn: async () => {
        throw new Error('spawn_agent model "missing/model": unavailable');
      },
      childTools,
      parentRunPolicy: createDefaultPolicy(),
      childRunStoreFactory: () => {
        childRunStoreCalls += 1;
        return undefined as never;
      },
    });

    await expect(
      spawnAgent.execute(
        {
          label: "Risk Reader",
          context: "Read project files and report one risk.",
          goal: "Inspect README.md for one risk.",
        },
        { run: parent.record } as never,
      ),
    ).rejects.toThrow(/missing\/model/);

    expect(childRunStoreCalls).toBe(0);
    expect(
      parent.events
        .all()
        .filter((event) => event.type === "subagent.requested"),
    ).toHaveLength(0);
  });

  it("rejects write-capable delegates in delegate_parallel", async () => {
    const ctx = await createWorkspace({ "README.md": "# Demo\n" });
    const childToolCatalog = createConfiguredDelegateChildToolCatalog({
      workspaceRoot: ctx.workspaceRoot,
    });
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      workspace: new LocalWorkspace(ctx.workspaceRoot),
      maxSteps: 2,
    });
    const delegates = [{ profileId: "writer", toolName: "delegate_writer" }];
    const derivedAgents = [
      {
        effectiveProfile: {
          id: "writer",
          name: "Writer",
          mode: "child" as const,
          prompt: "Write.",
          allowedTools: ["replace"],
          maxSteps: 1,
        },
        inheritedPolicy: [],
        effectivePolicy: [],
        parentAgentDenyCount: 0,
        parentRunDenyCount: 0,
        childDenyCount: 0,
        effectiveToolCount: 1,
      },
    ];
    const [writerDelegate] = createConfiguredDelegateTools({
      getParent: () => parent,
      delegates,
      derivedAgents,
      model: {
        async complete() {
          return { message: "writer done" };
        },
      },
      childTools: childToolCatalog.map((entry) => entry.definition),
      workspaceRoot: ctx.workspaceRoot,
      parentRunPolicy: createDefaultPolicy(),
      allowReadWriteWorkspaceAccess: true,
      childRunStoreFactory: () => undefined as never,
    });
    const indexedWriter = createDelegateAgentTool({
      delegates,
      derivedAgents,
      delegateTools: [writerDelegate!],
    });

    expect(
      isToolConcurrencySafe(writerDelegate, { goal: "Write a file." }),
    ).toBe(false);
    expect(
      isToolConcurrencySafe(indexedWriter, {
        agentId: "writer",
        goal: "Write a file.",
      }),
    ).toBe(false);

    const writerResult = (await writerDelegate!.execute(
      { goal: "Prepare a write-capable answer." },
      { run: parent.record } as never,
    )) as { childRunId: string };
    expect(
      parent.events
        .all()
        .find(
          (event) =>
            event.type === "subagent.requested" &&
            (event.payload as { childRunId?: string }).childRunId ===
              writerResult.childRunId,
        )?.metadata,
    ).toMatchObject({
      workspaceAccess: "read_write",
      agentConcurrency: "serial",
    });

    const parallel = createDelegateParallelTool({
      getParent: () => parent,
      delegates,
      derivedAgents,
      model: {
        async complete() {
          return { message: "writer done" };
        },
      },
      childTools: childToolCatalog.map((entry) => entry.definition),
      parentRunPolicy: createDefaultPolicy(),
      allowReadWriteWorkspaceAccess: true,
      childRunStoreFactory: () => undefined as never,
    });

    await expect(
      parallel.execute(
        {
          delegates: [{ agentId: "writer", goal: "Write a file." }],
        },
        { run: parent.record } as never,
      ),
    ).rejects.toThrow(
      /delegate_parallel cannot run "writer": workspaceAccess read_write is not allowed/,
    );
  });

  it("rejects delegates with write side effects even when the tool name is custom", async () => {
    const ctx = await createWorkspace({ "README.md": "# Demo\n" });
    const customWriteTool = defineTool({
      name: "custom_write",
      description: "Custom workspace mutator.",
      inputSchema: { type: "object" },
      policy: { risk: "safe" },
      governance: {
        origin: { kind: "local", name: "test" },
        sideEffects: ["write"],
        idempotency: "conditional",
      },
      async execute() {
        return { ok: true };
      },
    });
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      workspace: new LocalWorkspace(ctx.workspaceRoot),
      maxSteps: 2,
    });
    const parallel = createDelegateParallelTool({
      getParent: () => parent,
      delegates: [{ profileId: "writer", toolName: "delegate_writer" }],
      derivedAgents: [
        {
          effectiveProfile: {
            id: "writer",
            name: "Writer",
            mode: "child",
            prompt: "Write.",
            allowedTools: ["custom_write"],
            maxSteps: 1,
          },
          inheritedPolicy: [],
          effectivePolicy: [],
          parentAgentDenyCount: 0,
          parentRunDenyCount: 0,
          childDenyCount: 0,
          effectiveToolCount: 1,
        },
      ],
      model: {
        async complete() {
          return { message: "writer done" };
        },
      },
      childTools: [customWriteTool],
      parentRunPolicy: createDefaultPolicy(),
      allowReadWriteWorkspaceAccess: true,
      childRunStoreFactory: () => undefined as never,
    });

    await expect(
      parallel.execute(
        {
          delegates: [{ agentId: "writer", goal: "Write a note." }],
        },
        { run: parent.record } as never,
      ),
    ).rejects.toThrow(
      /delegate_parallel cannot run "writer": workspaceAccess read_write is not allowed/,
    );
  });

  it("runs an in-process delegate on its profile model when overridden", async () => {
    const ctx = await createWorkspace({ "README.md": "# Demo\n" });
    const childToolCatalog = createConfiguredDelegateChildToolCatalog({
      workspaceRoot: ctx.workspaceRoot,
    });
    let parentModelUsed = false;
    let overrideModelUsed = false;
    const parentChildModel: ModelAdapter = {
      async complete() {
        parentModelUsed = true;
        return { message: "parent-model child done" };
      },
    };
    const overrideModel: ModelAdapter = {
      async complete() {
        overrideModelUsed = true;
        return { message: "override-model child done" };
      },
    };
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      workspace: new LocalWorkspace(ctx.workspaceRoot),
      maxSteps: 2,
    });
    const [delegate] = createConfiguredDelegateTools({
      getParent: () => parent,
      delegates: [{ profileId: "reviewer", toolName: "delegate_reviewer" }],
      derivedAgents: [
        {
          effectiveProfile: {
            id: "reviewer",
            name: "Reviewer",
            mode: "child",
            model: "anthropic/opus",
            prompt: "Review.",
            allowedTools: [],
            maxSteps: 1,
          },
          inheritedPolicy: [],
          effectivePolicy: [],
          parentAgentDenyCount: 0,
          parentRunDenyCount: 0,
          childDenyCount: 0,
          effectiveToolCount: 0,
        },
      ],
      model: parentChildModel,
      modelForProfile: (id) => (id === "reviewer" ? overrideModel : undefined),
      childTools: childToolCatalog.map((entry) => entry.definition),
      workspaceRoot: ctx.workspaceRoot,
      parentRunPolicy: createDefaultPolicy(),
      allowReadWriteWorkspaceAccess: false,
      childRunStoreFactory: () => undefined as never,
    });

    await delegate!.execute({ goal: "Review README.md." }, {
      run: parent.record,
    } as never);

    expect(overrideModelUsed).toBe(true);
    expect(parentModelUsed).toBe(false);
  });

  it("resolves configured delegate models lazily when the delegate is called", async () => {
    const ctx = await createWorkspace({ "README.md": "# Demo\n" });
    const childToolCatalog = createConfiguredDelegateChildToolCatalog({
      workspaceRoot: ctx.workspaceRoot,
    });
    let parentModelUsed = false;
    let delegateModelUsed = false;
    let resolverCalls = 0;
    const parentChildModel: ModelAdapter = {
      async complete() {
        parentModelUsed = true;
        return { message: "parent-model child done" };
      },
    };
    const delegateDefaultModel: ModelAdapter = {
      async complete() {
        delegateModelUsed = true;
        return { message: "delegate-default child done" };
      },
    };
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      workspace: new LocalWorkspace(ctx.workspaceRoot),
      maxSteps: 2,
    });
    const [delegate] = createConfiguredDelegateTools({
      getParent: () => parent,
      delegates: [{ profileId: "reviewer", toolName: "delegate_reviewer" }],
      derivedAgents: [
        {
          effectiveProfile: {
            id: "reviewer",
            name: "Reviewer",
            mode: "child",
            prompt: "Review.",
            allowedTools: [],
            maxSteps: 1,
          },
          inheritedPolicy: [],
          effectivePolicy: [],
          parentAgentDenyCount: 0,
          parentRunDenyCount: 0,
          childDenyCount: 0,
          effectiveToolCount: 0,
        },
      ],
      model: parentChildModel,
      modelForProfile: async (id) => {
        resolverCalls += 1;
        return id === "reviewer" ? delegateDefaultModel : undefined;
      },
      childTools: childToolCatalog.map((entry) => entry.definition),
      workspaceRoot: ctx.workspaceRoot,
      parentRunPolicy: createDefaultPolicy(),
      allowReadWriteWorkspaceAccess: false,
      childRunStoreFactory: () => undefined as never,
    });

    expect(resolverCalls).toBe(0);

    await expect(
      delegate!.execute({ goal: "Review README.md." }, {
        run: parent.record,
      } as never),
    ).resolves.toMatchObject({
      status: "completed",
      report: "delegate-default child done",
      workspace: { writes: 0 },
    });

    expect(resolverCalls).toBe(1);
    expect(delegateModelUsed).toBe(true);
    expect(parentModelUsed).toBe(false);
  });

  it("fails a configured delegate call when its lazy model resolver fails", async () => {
    const ctx = await createWorkspace({ "README.md": "# Demo\n" });
    const [delegate] = createConfiguredDelegateTools({
      getParent: () =>
        createRun({
          goal: "parent",
          model: {
            async complete() {
              return { message: "parent done" };
            },
          },
          workspace: new LocalWorkspace(ctx.workspaceRoot),
          maxSteps: 2,
        }),
      delegates: [{ profileId: "reviewer", toolName: "delegate_reviewer" }],
      derivedAgents: [
        {
          effectiveProfile: {
            id: "reviewer",
            name: "Reviewer",
            mode: "child",
            prompt: "Review.",
            allowedTools: [],
            maxSteps: 1,
          },
          inheritedPolicy: [],
          effectivePolicy: [],
          parentAgentDenyCount: 0,
          parentRunDenyCount: 0,
          childDenyCount: 0,
          effectiveToolCount: 0,
        },
      ],
      model: {
        async complete() {
          return { message: "parent-model child done" };
        },
      },
      modelForProfile: async () => {
        throw new Error('agent "reviewer" model "missing/model": unavailable');
      },
      childTools: [],
      workspaceRoot: ctx.workspaceRoot,
      parentRunPolicy: createDefaultPolicy(),
      allowReadWriteWorkspaceAccess: false,
      childRunStoreFactory: () => undefined as never,
    });

    await expect(
      delegate!.execute({ goal: "Review README.md." }, {
        run: {} as never,
      } as never),
    ).rejects.toThrow(/missing\/model/);
  });

  it("resolves in-process delegate models by profile, delegate default, then parent", async () => {
    const ctx = await createWorkspace({ "README.md": "# Demo\n" });
    const parentModel: ModelAdapter = {
      async complete() {
        return { message: "parent done" };
      },
    };
    const delegates = [
      { profileId: "profile_override", toolName: "delegate_profile" },
      { profileId: "delegate_default", toolName: "delegate_default" },
      { profileId: "acp_child", toolName: "delegate_acp" },
      { profileId: "external_child", toolName: "delegate_external" },
    ];
    const derivedAgents = [
      {
        effectiveProfile: {
          id: "profile_override",
          mode: "child" as const,
          model: "deterministic",
          allowedTools: [],
        },
        inheritedPolicy: [],
        effectivePolicy: [],
        parentAgentDenyCount: 0,
        parentRunDenyCount: 0,
        childDenyCount: 0,
        effectiveToolCount: 0,
      },
      {
        effectiveProfile: {
          id: "delegate_default",
          mode: "child" as const,
          allowedTools: [],
        },
        inheritedPolicy: [],
        effectivePolicy: [],
        parentAgentDenyCount: 0,
        parentRunDenyCount: 0,
        childDenyCount: 0,
        effectiveToolCount: 0,
      },
      {
        effectiveProfile: {
          id: "acp_child",
          mode: "child" as const,
          allowedTools: [],
          metadata: {
            acp: {
              transport: "stdio",
              command: "delegate-acp",
            },
          },
        },
        inheritedPolicy: [],
        effectivePolicy: [],
        parentAgentDenyCount: 0,
        parentRunDenyCount: 0,
        childDenyCount: 0,
        effectiveToolCount: 0,
      },
      {
        effectiveProfile: {
          id: "external_child",
          mode: "child" as const,
          allowedTools: [],
          metadata: {
            externalCommand: {
              command: "delegate-external",
            },
          },
        },
        inheritedPolicy: [],
        effectivePolicy: [],
        parentAgentDenyCount: 0,
        parentRunDenyCount: 0,
        childDenyCount: 0,
        effectiveToolCount: 0,
      },
    ];
    const resolver = createInProcessDelegateModelResolver({
      delegates,
      derivedAgents,
      delegateModelRef: "deterministic",
      parentModelRef: "scripted",
      parentModel,
      goal: "delegate",
      workspaceRoot: ctx.workspaceRoot,
    });

    await expect(resolver("profile_override")).resolves.not.toBe(parentModel);
    await expect(resolver("delegate_default")).resolves.not.toBe(parentModel);
    await expect(resolver("acp_child")).resolves.toBeUndefined();
    await expect(resolver("external_child")).resolves.toBeUndefined();

    const inheritResolver = createInProcessDelegateModelResolver({
      delegates,
      derivedAgents,
      parentModelRef: "scripted",
      parentModel,
      goal: "delegate",
      workspaceRoot: ctx.workspaceRoot,
    });
    await expect(inheritResolver("delegate_default")).resolves.toBeUndefined();
  });

  it("resolves profile workflow hooks only for in-process delegates", async () => {
    const ctx = await createWorkspace({ "README.md": "# Demo\n" });
    const delegates = [
      { profileId: "in_process", toolName: "delegate_in_process" },
      { profileId: "acp_child", toolName: "delegate_acp" },
      { profileId: "external_child", toolName: "delegate_external" },
    ];
    const derivedAgents = [
      {
        effectiveProfile: {
          id: "in_process",
          mode: "child" as const,
          allowedTools: [],
          hooks: [
            {
              name: "in_process.RunStart.0",
              hook: "RunStart" as const,
              action: { type: "context" as const, content: "child hook" },
            },
          ],
        },
        inheritedPolicy: [],
        effectivePolicy: [],
        parentAgentDenyCount: 0,
        parentRunDenyCount: 0,
        childDenyCount: 0,
        effectiveToolCount: 0,
      },
      {
        effectiveProfile: {
          id: "acp_child",
          mode: "child" as const,
          allowedTools: [],
          hooks: [
            {
              name: "acp_child.RunStart.0",
              hook: "RunStart" as const,
              action: { type: "context" as const, content: "ignored" },
            },
          ],
          metadata: {
            acp: {
              transport: "stdio",
              command: "delegate-acp",
            },
          },
        },
        inheritedPolicy: [],
        effectivePolicy: [],
        parentAgentDenyCount: 0,
        parentRunDenyCount: 0,
        childDenyCount: 0,
        effectiveToolCount: 0,
      },
      {
        effectiveProfile: {
          id: "external_child",
          mode: "child" as const,
          allowedTools: [],
          hooks: [
            {
              name: "external_child.RunStart.0",
              hook: "RunStart" as const,
              action: { type: "context" as const, content: "ignored" },
            },
          ],
          metadata: {
            externalCommand: {
              command: "delegate-external",
            },
          },
        },
        inheritedPolicy: [],
        effectivePolicy: [],
        parentAgentDenyCount: 0,
        parentRunDenyCount: 0,
        childDenyCount: 0,
        effectiveToolCount: 0,
      },
    ];
    const resolver = createInProcessDelegateHooksResolver({
      delegates,
      derivedAgents,
      workspaceRoot: ctx.workspaceRoot,
    });

    expect(
      resolver("in_process", () => undefined)?.map((hook) => hook.name),
    ).toEqual(["in_process.RunStart.0"]);
    expect(resolver("acp_child", () => undefined)).toBeUndefined();
    expect(resolver("external_child", () => undefined)).toBeUndefined();
  });

  it("does not inject global verifier hooks into in-process delegate children", async () => {
    const ctx = await createWorkspace({ "README.md": "# Demo\n" });
    const delegates = [
      { profileId: "in_process", toolName: "delegate_in_process" },
      { profileId: "acp_child", toolName: "delegate_acp" },
    ];
    const derivedAgents = [
      {
        effectiveProfile: {
          id: "in_process",
          mode: "child" as const,
          allowedTools: [],
        },
        inheritedPolicy: [],
        effectivePolicy: [],
        parentAgentDenyCount: 0,
        parentRunDenyCount: 0,
        childDenyCount: 0,
        effectiveToolCount: 0,
      },
      {
        effectiveProfile: {
          id: "acp_child",
          mode: "child" as const,
          allowedTools: [],
          metadata: {
            acp: {
              transport: "stdio",
              command: "delegate-acp",
            },
          },
        },
        inheritedPolicy: [],
        effectivePolicy: [],
        parentAgentDenyCount: 0,
        parentRunDenyCount: 0,
        childDenyCount: 0,
        effectiveToolCount: 0,
      },
    ];
    const resolver = createInProcessDelegateHooksResolver({
      delegates,
      derivedAgents,
      workspaceRoot: ctx.workspaceRoot,
    });

    const hooks = resolver("in_process", () => undefined, {
      goal: "Prepare this repo for handoff and verify documented commands",
      shouldWrite: true,
    });

    expect(hooks).toBeUndefined();
    expect(
      resolver("acp_child", () => undefined, {
        goal: "Prepare this repo for handoff and verify documented commands",
        shouldWrite: true,
      }),
    ).toBeUndefined();
  });

  it("attributes cached delegate model failures to the requested profile", async () => {
    const ctx = await createWorkspace({ "README.md": "# Demo\n" });
    const parentModel: ModelAdapter = {
      async complete() {
        return { message: "parent done" };
      },
    };
    const delegates = [
      { profileId: "reviewer", toolName: "delegate_reviewer" },
      { profileId: "auditor", toolName: "delegate_auditor" },
    ];
    const derivedAgents = delegates.map((delegate) => ({
      effectiveProfile: {
        id: delegate.profileId,
        mode: "child" as const,
        allowedTools: [],
      },
      inheritedPolicy: [],
      effectivePolicy: [],
      parentAgentDenyCount: 0,
      parentRunDenyCount: 0,
      childDenyCount: 0,
      effectiveToolCount: 0,
    }));
    const resolver = createInProcessDelegateModelResolver({
      delegates,
      derivedAgents,
      delegateModelRef: "missing/model",
      parentModelRef: "scripted",
      parentModel,
      goal: "delegate",
      workspaceRoot: ctx.workspaceRoot,
    });

    await expect(resolver("reviewer")).rejects.toThrow(
      /agent "reviewer" model "missing\/model"/,
    );
    await expect(resolver("auditor")).rejects.toThrow(
      /agent "auditor" model "missing\/model"/,
    );
  });

  it("lets configured delegates inherit the parent maxSteps when unset", async () => {
    const ctx = await createWorkspace({ "README.md": "# Demo\n" });
    let childCalls = 0;
    const childModel: ModelAdapter = {
      async complete() {
        childCalls += 1;
        if (childCalls < 9) {
          return {
            toolCalls: [
              { toolName: "noop", arguments: { iteration: childCalls } },
            ],
          };
        }
        return { message: "child finished on inherited budget" };
      },
    };
    const noop = defineTool({
      name: "noop",
      description: "Advance one scripted child step.",
      inputSchema: {
        type: "object",
        properties: { iteration: { type: "integer" } },
      },
      policy: { risk: "safe" },
      async execute(args) {
        return args;
      },
    });
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      workspace: new LocalWorkspace(ctx.workspaceRoot),
      maxSteps: 9,
    });
    const [delegate] = createConfiguredDelegateTools({
      getParent: () => parent,
      delegates: [{ profileId: "worker", toolName: "delegate_worker" }],
      derivedAgents: [
        {
          effectiveProfile: {
            id: "worker",
            name: "Worker",
            mode: "child",
            prompt: "Finish after several turns.",
            allowedTools: ["noop"],
          },
          inheritedPolicy: [],
          effectivePolicy: [],
          parentAgentDenyCount: 0,
          parentRunDenyCount: 0,
          childDenyCount: 0,
          effectiveToolCount: 1,
        },
      ],
      model: childModel,
      childTools: [noop],
      workspaceRoot: ctx.workspaceRoot,
      parentRunPolicy: createDefaultPolicy(),
      allowReadWriteWorkspaceAccess: false,
      childRunStoreFactory: () => undefined as never,
    });

    await expect(
      delegate!.execute({ goal: "Finish after several turns." }, {
        run: parent.record,
      } as never),
    ).resolves.toMatchObject({
      status: "completed",
      report: "child finished on inherited budget",
      workspace: { writes: 0 },
    });
    expect(childCalls).toBe(9);
  });

  it("builds CLI diagnostic tools from the shared coding catalog", () => {
    const entries = createCliDiagnosticToolCatalog({
      workspaceRoot: "/tmp/ws",
    });

    expect(entries.map((entry) => entry.definition.name)).toEqual([
      "read",
      "glob",
      "grep",
      "list_dir",
      "read_anchored_text",
      "create",
      "replace",
      "write",
      "edit_anchored_text",
      "edit",
      "tool_search",
    ]);
    expect(
      entries.find((entry) => entry.definition.name === "list_dir")?.definition,
    ).toMatchObject({
      defaultExposureTier: "advanced",
      deferLoading: true,
    });
    expect(
      entries.find((entry) => entry.definition.name === "read"),
    ).toMatchObject({
      source: "coding",
    });
    expect(
      entries.find((entry) => entry.definition.name === "tool_search"),
    ).toMatchObject({
      source: "core",
    });
  });

  it("promotes long-running shell commands to background tasks", async () => {
    const ctx = await createWorkspace({});
    const manager = new TaskManager({ store: new InMemoryTaskStore() });
    const events = new EventLog(ctx.run.id);
    const tool = createHostShellTool(ctx.workspaceRoot, {
      taskManager: manager,
      foregroundTimeoutMs: 20,
      sandbox: { mode: "off" },
      getRunEvents: () => events,
    });

    const result = await tool.execute(
      {
        command:
          "node -e \"setTimeout(() => console.log('promoted done'), 200)\"",
      },
      ctx,
    );

    expect(result.promoted).toBe(true);
    expect(result.taskId).toMatch(/^task_/);
    const handle = manager.handle(result.taskId as TaskId);
    expect(handle).toBeDefined();
    expect(handle!.record.status).toBe("running");
    const record = await handle!.wait();
    expect(record.status).toBe("completed");

    const chunks = [];
    for await (const chunk of manager.store.loadOutput(
      result.taskId as TaskId,
    )) {
      chunks.push(chunk.data);
    }
    expect(chunks.join("")).toContain("promoted done");
    const taskEvents = events
      .all()
      .filter((event) => event.type.startsWith("task."));
    expect(taskEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "task.created",
        "task.started",
        "task.output",
        "task.completed",
      ]),
    );
    expect(
      events.all().some((event) => event.type.startsWith("extension.")),
    ).toBe(false);
    const taskStarted = taskEvents.find(
      (event) => event.type === "task.started",
    );
    const taskCreated = taskEvents.find(
      (event) => event.type === "task.created",
    );
    const taskOutput = taskEvents.find((event) => event.type === "task.output");
    const taskCompleted = taskEvents.find(
      (event) => event.type === "task.completed",
    );
    expect(taskCreated).toMatchObject({
      payload: expect.objectContaining({
        taskId: result.taskId,
        parentRunId: ctx.run.id,
      }),
    });
    expect(taskOutput).toMatchObject({
      spanId: taskStarted?.spanId,
      payload: expect.objectContaining({
        taskId: result.taskId,
        channel: "stdout",
      }),
    });
    expect(taskOutput?.payload).toEqual(
      expect.objectContaining({ data: expect.stringContaining("promoted") }),
    );
    expect(taskCompleted).toMatchObject({
      spanId: taskStarted?.spanId,
      payload: expect.objectContaining({
        output: expect.objectContaining({
          stdoutPreview: expect.stringContaining("promoted done"),
        }),
      }),
    });
  });

  it("starts explicit background shells detached without reporting promotion", async () => {
    const ctx = await createWorkspace({});
    const manager = new TaskManager({ store: new InMemoryTaskStore() });
    const tool = createHostShellTool(ctx.workspaceRoot, {
      taskManager: manager,
      foregroundTimeoutMs: 5 * 60 * 1000,
      sandbox: { mode: "off" },
    });

    const result = await tool.execute(
      {
        command: 'node -e "setTimeout(() => process.exit(0), 200)"',
        background: true,
      },
      ctx,
    );

    expect(result).toMatchObject({
      background: true,
      backgroundOrigin: "explicit",
      exitCode: null,
    });
    expect(result.promoted).toBeUndefined();
    expect(result.promotionGuidance).toBeUndefined();
    expect(result.backgroundGuidance).toMatch(/successful start/i);
    const record = manager.store.get(result.taskId as TaskId);
    expect(record).toMatchObject({
      kind: "shell.background",
      awaited: false,
      status: "running",
      metadata: expect.objectContaining({ backgroundOrigin: "explicit" }),
    });

    const duplicate = await tool.execute(
      {
        command: 'node -e "setTimeout(() => process.exit(0), 200)"',
        background: true,
      },
      ctx,
    );
    expect(duplicate).toMatchObject({
      taskId: result.taskId,
      background: true,
      backgroundOrigin: "explicit",
      deduplicated: true,
      executed: false,
    });
    expect(manager.store.list({ parentRunId: ctx.run.id })).toHaveLength(1);
    await manager.handle(result.taskId as TaskId)!.wait();
  });

  it("resolves shell approval before an explicit background process can detach", async () => {
    const ctx = await createWorkspace({});
    const manager = new TaskManager({ store: new InMemoryTaskStore() });
    const shell = createHostShellTool(ctx.workspaceRoot, {
      taskManager: manager,
      sandbox: { mode: "off" },
    });
    let modelCalls = 0;
    let approvalCalls = 0;
    const run = createRun({
      goal: "deny a background shell",
      workspace: new LocalWorkspace(ctx.workspaceRoot),
      tools: [shell],
      interactionChannel: {
        approve(request) {
          approvalCalls += 1;
          expect(manager.store.list()).toHaveLength(0);
          return {
            approvalId: request.id,
            decision: "denied",
            message: "denied for test",
          };
        },
      },
      model: {
        async complete() {
          modelCalls += 1;
          return modelCalls === 1
            ? {
                toolCalls: [
                  {
                    toolName: "bash",
                    arguments: {
                      command:
                        'node -e "setTimeout(() => process.exit(0), 1000)"',
                      background: true,
                      lifetime: "service",
                    },
                  },
                ],
              }
            : { message: "approval denied" };
        },
      },
      maxSteps: 2,
    });

    await run.start();

    expect(approvalCalls).toBe(1);
    expect(manager.store.list()).toHaveLength(0);
    expect(
      run.events.all().some((event) => event.type === "task.created"),
    ).toBe(false);
  });

  it("returns an immediate service exit inline instead of detaching it", async () => {
    const ctx = await createWorkspace({});
    const manager = new TaskManager({ store: new InMemoryTaskStore() });
    const tool = createHostShellTool(ctx.workspaceRoot, {
      taskManager: manager,
      sandbox: { mode: "off" },
    });

    const result = await tool.execute(
      {
        command: "exit 3",
        background: true,
        lifetime: "service",
      },
      ctx,
    );

    expect(result.exitCode).toBe(3);
    expect(result.background).toBeUndefined();
    expect(result.taskId).toBeUndefined();
    expect(manager.store.list({ parentRunId: ctx.run.id })).toHaveLength(0);
  });

  it("kills a long-running shell at the foreground budget when task promotion is unavailable", async () => {
    const ctx = await createWorkspace({});
    const tool = createHostShellTool(ctx.workspaceRoot, {
      foregroundTimeoutMs: 20,
      sandbox: { mode: "off" },
    });

    const result = await tool.execute(
      {
        command:
          "node -e \"setTimeout(() => console.log('should not print'), 500)\"",
      },
      ctx,
    );

    expect(result.promoted).toBeUndefined();
    expect(result.taskId).toBeUndefined();
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.foregroundTimeoutMs).toBe(20);
    expect(result.promotionAvailable).toBe(false);
    expect(result.stderr).toContain(
      "foreground timeout reached; process killed because promotion unavailable",
    );
    expect(result.promotionUnavailableReason).toContain(
      "promotion unavailable",
    );
  });

  it("keeps promoted shell task writes and records a durable terminal task instead of rolling back", async () => {
    const ctx = await createWorkspace({});
    const tasksRoot = join(ctx.workspaceRoot, ".sparkwright", "tasks");
    const manager = new TaskManager({
      store: new FileTaskStore({ rootDir: tasksRoot }),
    });
    const events = new EventLog(ctx.run.id);
    const tool = createHostShellTool(ctx.workspaceRoot, {
      taskManager: manager,
      foregroundTimeoutMs: 20,
      sandbox: { mode: "off" },
      getRunEvents: () => events,
    });

    const result = await tool.execute(
      {
        command:
          "node -e \"setTimeout(() => { require('fs').writeFileSync('leak.txt', 'x'); console.log('promoted done'); }, 80)\"",
      },
      ctx,
    );

    expect(result.promoted).toBe(true);
    const handle = manager.handle(result.taskId as TaskId);
    expect(handle).toBeDefined();
    const record = await handle!.wait();

    // Promotion turns the shell into a background task that runs concurrently
    // with the rest of the session, so the foreground snapshot can no longer be
    // diffed/rolled back without clobbering concurrent work. (a) The task
    // reaches a real terminal state — not a rollback-induced failure...
    expect(record.status).toBe("completed");
    expect(record.completedAt).toBeDefined();
    expect(events.all().some((event) => event.type === "task.failed")).toBe(
      false,
    );

    // ...(b) the write the promoted shell made survives instead of being rolled
    // back...
    await expect(
      readFile(join(ctx.workspaceRoot, "leak.txt"), "utf8"),
    ).resolves.toBe("x");

    // ...(c) the untracked-write-capable boundary is disclosed via the shared
    // marker (with the background_shell protocol + sandbox status) rather than
    // audited away...
    const marker = events
      .all()
      .find(
        (event) => event.type === "workspace.write.untracked_access_granted",
      );
    expect(marker?.payload).toEqual(
      expect.objectContaining({
        protocol: "background_shell",
        backgroundOrigin: "promoted",
        marker: "untracked-write-capable",
        taskId: result.taskId,
        sandboxMode: "off",
      }),
    );

    // ...(d) and the terminal status is durable: a fresh FileTaskStore reader
    // (as the `tasks get` CLI uses) must not see the task stuck at "running".
    const reread = new FileTaskStore({ rootDir: tasksRoot, createRoot: false });
    const persisted = reread.get(result.taskId as TaskId);
    expect(persisted?.status).toBe("completed");
    expect(persisted?.completedAt).toBeDefined();
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
    ).rejects.toThrow(/controlled workspace write tools/);
    await expect(
      readFile(
        join(
          ctx.workspaceRoot,
          ".sparkwright/skills/release-reviewer/skill.md",
        ),
      ),
    ).rejects.toThrow();
  });

  it("still ignores runtime control-plane files in shell mutation audits", async () => {
    const ctx = await createWorkspace({});
    const tool = createHostShellTool(ctx.workspaceRoot, {
      sandbox: { mode: "off" },
    });

    const result = await tool.execute(
      {
        command:
          "mkdir -p .sparkwright/sessions/session-test .sparkwright/workflow-runs && " +
          "echo runtime > .sparkwright/sessions/session-test/log.txt && " +
          "echo workflow > .sparkwright/workflow-runs/workflow-test.json",
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
