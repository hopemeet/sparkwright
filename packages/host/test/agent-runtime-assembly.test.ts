import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBufferedEmitter,
  createDefaultPolicy,
  FileSessionStore,
  type ModelAdapter,
} from "@sparkwright/core";
import { InMemoryTaskStore, TaskManager } from "@sparkwright/agent-runtime";
import { AgentRuntimeAssembly } from "../src/runtime/agent-runtime-assembly.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("AgentRuntimeAssembly", () => {
  it("assembles configured, indexed, parallel, dynamic, and task Agent surfaces", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-agent-runtime-assembly-"),
    );
    tempDirs.push(workspace);
    const sessionRootDir = join(workspace, ".sparkwright", "sessions");
    const taskManager = new TaskManager({ store: new InMemoryTaskStore() });
    const assembly = new AgentRuntimeAssembly({ taskManager });
    const parentModel: ModelAdapter = {
      async complete() {
        return { message: "done" };
      },
    };

    const prepared = await assembly.prepareRun({
      goal: "review the repository",
      workspaceRoot: workspace,
      sessionId: "session_agent_runtime_owner",
      sessionRootDir,
      sessionStore: new FileSessionStore({ rootDir: sessionRootDir }),
      traceLevel: "standard",
      agentConfig: {
        profiles: [
          {
            id: "reviewer",
            mode: "child",
            description: "Review repository changes.",
            allowedTools: ["read", "glob", "grep"],
          },
        ],
        exposure: "all",
        enableParallelDelegates: true,
      },
      skillRoots: [],
      configPaths: [],
      pendingEvents: createBufferedEmitter(),
      parentRunRef: {},
      parentModel,
      parentModelRef: "deterministic",
      parentRunPolicy: createDefaultPolicy(),
      interactionChannel: {
        approve(request) {
          return { approvalId: request.id, decision: "approved" };
        },
      },
      allowReadWriteWorkspaceAccess: false,
      backgroundTasks: "enabled",
    });

    expect(prepared.mainAgent).toMatchObject({
      id: "main",
      mode: "primary",
    });
    expect(prepared.resolvedProfiles).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "reviewer" })]),
    );
    expect(prepared.derivedAgents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          effectiveProfile: expect.objectContaining({ id: "reviewer" }),
        }),
      ]),
    );
    expect(prepared.delegateTools.map((tool) => tool.name)).toContain(
      "delegate_reviewer",
    );
    expect(prepared.delegateAgentTool.name).toBe("delegate_agent");
    expect(prepared.delegateParallelTool?.name).toBe("delegate_parallel");
    expect(prepared.dynamicSpawnTool.name).toBe("spawn_agent");
    expect(prepared.delegateDescriptors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profileId: "reviewer",
          protocol: "in_process",
          workspaceAccess: "none",
        }),
      ]),
    );
    expect(prepared.taskRunner).toEqual(expect.any(Function));
  });
});
