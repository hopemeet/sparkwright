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
      )) as { signal: string; childRunId: string };

      expect(output.signal).toBe("completed");

      // (1) The child's own trace is persisted under its agent directory.
      const childTrace = await readFile(
        join(
          sessionRootDir,
          sessionId,
          "agents",
          "dynamic_inspector",
          "trace.jsonl",
        ),
        "utf8",
      );
      expect(childTrace.length).toBeGreaterThan(0);
      expect(childTrace).toContain(output.childRunId);
      expect(childTrace).toContain("glob_paths");

      // (2) The child agent is registered in session.json (not just "main").
      const sessionJson = JSON.parse(
        await readFile(join(sessionRootDir, sessionId, "session.json"), "utf8"),
      ) as { agents: string[] };
      expect(sessionJson.agents).toContain("dynamic_inspector");

      // (3) The child's tool + model usage rolled up into the parent tracker,
      //     even though the parent's own loop never ran here.
      const usage = parent.usage();
      expect(usage.toolCalls).toBeGreaterThanOrEqual(1);
      expect(usage.byTool.glob_paths?.calls).toBeGreaterThanOrEqual(1);
      expect(usage.modelCalls).toBeGreaterThanOrEqual(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
