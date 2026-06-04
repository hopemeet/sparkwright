import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRun,
  createSessionFileRunStoreFactory,
  createSessionRunStoreFactory,
  defineTool,
  FileSessionStore,
  type ModelAdapter,
  type ToolDefinition,
} from "@sparkwright/core";
import { createDynamicSpawnAgentTool } from "../src/runtime.js";

/**
 * The session run store flushes to disk asynchronously, so a trace/session file
 * may not be fully written the instant `spawn_agent` resolves. Reading it
 * immediately races that flush — fine on fast Linux/macOS CI, but it
 * intermittently ENOENTs on the slower Windows runner. Poll until the file
 * exists AND contains the marker we are about to assert on, rather than reading
 * once and hoping the flush already landed.
 */
async function readFileWhenReady(
  path: string,
  contains: string,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const content = await readFile(path, "utf8");
      if (content.includes(contains)) {
        return content;
      }
    } catch {
      // File not created yet — keep waiting.
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${path} to contain "${contains}"`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Regression guard for the host spawn_agent wiring. Two bugs were observed in a
 * real TUI trace: the spawned child agent's trace was never persisted (only
 * `agents/main/` existed on disk), and the child's token/tool usage was not
 * rolled up into the parent run's usage snapshot (the TUI under-reported spend
 * as "2 model / 1 tool", hiding the child entirely).
 *
 * The fix threads `runStore` + `parentUsageTracker` into `spawnSubAgent` from
 * `createDynamicSpawnAgentTool`. This test invokes that tool directly with a
 * scripted child model and asserts both fixes hold.
 */
describe("host spawn_agent wiring", () => {
  it("persists the child trace into the session and rolls usage into the parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-host-spawn-"));
    try {
      const sessionId = "session_spawn_test";
      const sessionRootDir = root;
      const sessionStore = new FileSessionStore({ rootDir: sessionRootDir });
      const childRunStoreFactory = (childAgentId: string) =>
        createSessionRunStoreFactory({
          sessionStore,
          sessionId,
          runStoreFactory: createSessionFileRunStoreFactory({
            sessionRootDir,
            sessionId,
            agentId: childAgentId,
            traceLevel: "standard",
          }),
          metadata: { source: "host" },
        });

      // Child model: one glob_paths call, then a final answer.
      const childModel: ModelAdapter = {
        async complete(input) {
          const used = input.context.some((item) =>
            item.content.includes("glob_paths"),
          );
          if (!used) {
            return {
              toolCalls: [
                { toolName: "glob_paths", arguments: { pattern: "*" } },
              ],
            };
          }
          return { message: "top-level: README.md, package.json" };
        },
      };

      const globTool: ToolDefinition = defineTool({
        name: "glob_paths",
        description: "Fake glob for the test.",
        inputSchema: {
          type: "object",
          properties: { pattern: { type: "string" } },
        },
        async execute() {
          return { paths: ["README.md", "package.json"] };
        },
      });

      const parent = createRun({
        goal: "ask a child to list files",
        model: {
          async complete() {
            return { message: "parent done" };
          },
        },
        maxSteps: 1,
        runStore: createSessionRunStoreFactory({
          sessionStore,
          sessionId,
          runStoreFactory: createSessionFileRunStoreFactory({
            sessionRootDir,
            sessionId,
            agentId: "main",
            traceLevel: "standard",
          }),
          metadata: { source: "host" },
        }),
      });

      const spawnTool = createDynamicSpawnAgentTool({
        getParent: () => parent,
        model: childModel,
        childTools: [globTool],
        childRunStoreFactory,
      });

      const output = (await spawnTool.execute(
        {
          goal: "list top-level files",
          role: "inspector",
          prompt: "List the files. Use glob_paths only.",
          allowedTools: ["glob_paths"],
          maxSteps: 3,
        },
        { run: parent.record } as never,
      )) as {
        signal: string;
        childRunId: string;
        stepLimitReached?: boolean;
      };

      expect(output.signal).toBe("completed");
      // Child finished on step 2 of 3 — it had budget to spare.
      expect(output.stepLimitReached).toBe(false);

      // (1) The child's own trace is persisted under its agent directory.
      const childTrace = await readFileWhenReady(
        join(
          sessionRootDir,
          sessionId,
          "agents",
          "dynamic_inspector",
          "trace.jsonl",
        ),
        output.childRunId,
      );
      expect(childTrace.length).toBeGreaterThan(0);
      expect(childTrace).toContain(output.childRunId);
      expect(childTrace).toContain("glob_paths");

      // (2) The child agent is registered in session.json (not just "main").
      const sessionJson = JSON.parse(
        await readFileWhenReady(
          join(sessionRootDir, sessionId, "session.json"),
          "dynamic_inspector",
        ),
      ) as { agents: string[] };
      expect(sessionJson.agents).toContain("dynamic_inspector");

      // (3) The child's tool + model usage rolled up into the parent tracker,
      //     even though the parent's own loop never ran here.
      const usage = parent.usage();
      expect(usage.toolCalls).toBeGreaterThanOrEqual(1);
      expect(usage.byTool.glob_paths?.calls).toBeGreaterThanOrEqual(1);
      expect(usage.modelCalls).toBeGreaterThanOrEqual(2);
    } finally {
      // Child session-store writes can still be flushing as the run resolves;
      // retry the cleanup rather than racing them into an ENOTEMPTY.
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
    // Generous timeout: the session-store flush is async, so readFileWhenReady
    // may poll for a beat on a loaded CI runner. The default 5s collides with
    // that poll's own deadline; 15s gives the flush room to land.
  }, 15000);

  it("flags stepLimitReached when the child answers on its last allowed step", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-host-spawn-cap-"));
    try {
      const sessionId = "session_spawn_cap";
      const sessionStore = new FileSessionStore({ rootDir: root });
      const childRunStoreFactory = (childAgentId: string) =>
        createSessionRunStoreFactory({
          sessionStore,
          sessionId,
          runStoreFactory: createSessionFileRunStoreFactory({
            sessionRootDir: root,
            sessionId,
            agentId: childAgentId,
            traceLevel: "standard",
          }),
          metadata: { source: "host" },
        });

      // Child answers immediately (step 1) but maxSteps is 1, so it finishes
      // with zero budget left: a final_answer that may have been cut short.
      const childModel: ModelAdapter = {
        async complete() {
          return { message: "partial list: README.md, ... (more omitted)" };
        },
      };

      const parent = createRun({
        goal: "ask a child to list files under a tight budget",
        model: {
          async complete() {
            return { message: "parent done" };
          },
        },
        maxSteps: 1,
        runStore: childRunStoreFactory("main"),
      });

      const spawnTool = createDynamicSpawnAgentTool({
        getParent: () => parent,
        model: childModel,
        childTools: [
          defineTool({
            name: "glob_paths",
            description: "Fake glob.",
            inputSchema: { type: "object", properties: {} },
            async execute() {
              return { paths: [] };
            },
          }),
        ],
        childRunStoreFactory,
      });

      const output = (await spawnTool.execute(
        {
          goal: "list files",
          role: "inspector",
          prompt: "List the files.",
          allowedTools: ["glob_paths"],
          maxSteps: 1,
        },
        { run: parent.record } as never,
      )) as { signal: string; stopReason: string; stepLimitReached?: boolean };

      expect(output.signal).toBe("completed");
      expect(output.stopReason).toBe("final_answer");
      expect(output.stepLimitReached).toBe(true);
    } finally {
      // Child session-store writes can still be flushing as the run resolves;
      // retry the cleanup rather than racing them into an ENOTEMPTY.
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  // The parent allocates the child's step budget via `maxSteps`. It must be
  // honored up to a ceiling (16) with a sane default (8) when omitted — a real
  // trace showed a search child strangled by the former hard cap of 4. The
  // clamped value is observable through the promotion hint's suggested profile.
  it("clamps a parent-allocated maxSteps to 16 and defaults to 8", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sparkwright-host-spawn-budget-"),
    );
    try {
      const sessionId = "session_spawn_budget";
      const sessionStore = new FileSessionStore({ rootDir: root });
      const childRunStoreFactory = (childAgentId: string) =>
        createSessionRunStoreFactory({
          sessionStore,
          sessionId,
          runStoreFactory: createSessionFileRunStoreFactory({
            sessionRootDir: root,
            sessionId,
            agentId: childAgentId,
            traceLevel: "standard",
          }),
          metadata: { source: "host" },
        });

      const makeParent = () =>
        createRun({
          goal: "allocate a child budget",
          model: {
            async complete() {
              return { message: "parent done" };
            },
          },
          maxSteps: 1,
          runStore: childRunStoreFactory("main"),
        });

      const childModel: ModelAdapter = {
        async complete() {
          return { message: "done" };
        },
      };
      const childTools = [
        defineTool({
          name: "glob_paths",
          description: "Fake glob.",
          inputSchema: { type: "object", properties: {} },
          async execute() {
            return { paths: [] };
          },
        }),
      ];

      type Output = {
        promotionHint: { suggestedProfile: { maxSteps: number } };
      };
      const allocate = async (maxSteps?: number): Promise<number> => {
        const parent = makeParent();
        const spawnTool = createDynamicSpawnAgentTool({
          getParent: () => parent,
          model: childModel,
          childTools,
          childRunStoreFactory,
        });
        const output = (await spawnTool.execute(
          {
            goal: "list files",
            role: "inspector",
            prompt: "List the files.",
            allowedTools: ["glob_paths"],
            ...(maxSteps === undefined ? {} : { maxSteps }),
          },
          { run: parent.record } as never,
        )) as Output;
        return output.promotionHint.suggestedProfile.maxSteps;
      };

      expect(await allocate(100)).toBe(16);
      expect(await allocate()).toBe(8);
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  // A real trace showed a search child burn its whole step budget on filename
  // globs and never find a *function named* frobnicate — because glob_paths
  // only matches paths and the child had no content search. grep_text must be
  // an allowed, executable child tool so "find symbol X" is one call.
  it("lets a spawned child request and run grep_text", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-host-spawn-grep-"));
    try {
      const sessionId = "session_spawn_grep";
      const sessionStore = new FileSessionStore({ rootDir: root });
      const childRunStoreFactory = (childAgentId: string) =>
        createSessionRunStoreFactory({
          sessionStore,
          sessionId,
          runStoreFactory: createSessionFileRunStoreFactory({
            sessionRootDir: root,
            sessionId,
            agentId: childAgentId,
            traceLevel: "standard",
          }),
          metadata: { source: "host" },
        });

      let grepCalls = 0;
      const grepTool = defineTool({
        name: "grep_text",
        description: "Fake content search.",
        inputSchema: {
          type: "object",
          properties: { pattern: { type: "string" } },
        },
        async execute() {
          grepCalls += 1;
          return { matches: [] };
        },
      });

      // Child uses grep_text once, then concludes.
      const childModel: ModelAdapter = {
        async complete(input) {
          const used = input.context.some((item) =>
            item.content.includes("grep_text"),
          );
          return used
            ? { message: "no symbol named frobnicate found" }
            : {
                toolCalls: [
                  {
                    toolName: "grep_text",
                    arguments: { pattern: "frobnicate" },
                  },
                ],
              };
        },
      };

      const parent = createRun({
        goal: "find a symbol by name",
        model: {
          async complete() {
            return { message: "parent done" };
          },
        },
        maxSteps: 1,
        runStore: childRunStoreFactory("main"),
      });

      const spawnTool = createDynamicSpawnAgentTool({
        getParent: () => parent,
        model: childModel,
        childTools: [grepTool],
        childRunStoreFactory,
      });

      const output = (await spawnTool.execute(
        {
          goal: "find frobnicate",
          role: "scout",
          prompt: "Find a function named frobnicate.",
          allowedTools: ["grep_text"],
        },
        { run: parent.record } as never,
      )) as { signal: string };

      expect(output.signal).toBe("completed");
      expect(grepCalls).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });
});
