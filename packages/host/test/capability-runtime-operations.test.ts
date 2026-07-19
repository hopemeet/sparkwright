import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  FileTaskStore,
  TaskManager,
  type AgentProfile,
} from "@sparkwright/agent-runtime";
import type { HostEvent } from "@sparkwright/protocol";
import type { SparkwrightEvent } from "@sparkwright/core";
import { CapabilityRuntimeOperations } from "../src/runtime/capability-runtime-operations.js";

describe("CapabilityRuntimeOperations", () => {
  it("owns configured inspection, automation roots, and last-run snapshot merging", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "sparkwright-capability-owner-"),
    );
    try {
      const taskRootDir = join(workspaceRoot, ".sparkwright", "tasks");
      const closeMcp = vi.fn(async () => {});
      const operations = new CapabilityRuntimeOperations({
        workspaceRoot,
        sessionRootDir: join(workspaceRoot, ".sparkwright", "sessions"),
        taskManager: new TaskManager({
          store: new FileTaskStore({ rootDir: taskRootDir }),
        }),
        taskRootDir,
        defaultModel: "deterministic",
        emit: () => {},
        prepareMcp: async () => ({
          servers: [
            { name: "snapshot", type: "stdio", command: "snapshot-server" },
          ],
          prepared: {
            tools: [],
            statuses: { snapshot: { status: "connected" } },
            toolNameMap: [],
            close: closeMcp,
          },
        }),
      });
      const runtimeProfile: AgentProfile = {
        id: "runtime-reviewer",
        name: "Runtime Reviewer",
        mode: "child",
      };
      const captured = operations.captureRunSnapshot({
        toolCatalog: [],
        indexedSkills: [],
        loadedSkills: [],
        agentProfiles: [runtimeProfile],
      });

      expect(operations.summarize(captured)).toMatchObject({
        tools: 0,
        agents: { profiles: 1, profileIds: ["runtime-reviewer"] },
      });

      const inspected = await operations.inspect();
      expect(inspected.ok).toBe(true);
      if (!inspected.ok) return;
      expect(inspected.snapshot.agents.profiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "main", mode: "primary" }),
          expect.objectContaining({
            id: "runtime-reviewer",
            mode: "child",
          }),
        ]),
      );
      expect(inspected.snapshot.automation?.tasks.rootDir).toBe(taskRootDir);
      expect(inspected.snapshot.mcp.statuses).toEqual([
        expect.objectContaining({
          serverName: "snapshot",
          status: "connected",
        }),
      ]);
      expect(closeMcp).toHaveBeenCalledTimes(1);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("persists and emits the canonical Skill index failure sequence", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "sparkwright-capability-failure-"),
    );
    const sessionRootDir = join(workspaceRoot, ".sparkwright", "sessions");
    const taskRootDir = join(workspaceRoot, ".sparkwright", "tasks");
    const emitted: HostEvent[] = [];
    try {
      const operations = new CapabilityRuntimeOperations({
        workspaceRoot,
        sessionRootDir,
        taskManager: new TaskManager({
          store: new FileTaskStore({ rootDir: taskRootDir }),
        }),
        taskRootDir,
        defaultModel: "deterministic",
        emit: (event) => emitted.push(event),
        prepareMcp: async () => ({ servers: [], prepared: null }),
      });
      const sessionId = "session_capability_index_failure";

      await operations.recordIndexFailure({
        goal: "inspect the workspace",
        sessionId,
        traceLevel: "standard",
        message: "Invalid Skill index",
        source: join(
          workspaceRoot,
          ".sparkwright",
          "skills",
          "bad",
          "SKILL.md",
        ),
        targetPath: "README.md",
        metadata: { testCase: "owner" },
      });

      const streamed = emitted
        .filter((event) => event.kind === "run.event")
        .map((event) => event.payload.event as SparkwrightEvent);
      expect(streamed.map((event) => event.type)).toEqual([
        "run.created",
        "capability.index.failed",
        "run.failed",
      ]);
      expect(streamed[1]).toMatchObject({
        payload: {
          kind: "skills",
          code: "SKILL_INDEX_FAILED",
          message: "Invalid Skill index",
        },
        metadata: {
          source: "host",
          failurePhase: "capability_index",
          agentId: "main",
        },
      });

      const trace = (
        await readFile(join(sessionRootDir, sessionId, "trace.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as SparkwrightEvent);
      expect(trace.map((event) => event.type)).toEqual([
        "run.created",
        "capability.index.failed",
        "run.failed",
      ]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
