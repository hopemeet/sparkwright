import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryTaskStore, TaskManager } from "@sparkwright/agent-runtime";
import type { InteractionChannel } from "@sparkwright/core";
import { AgentRuntimeAssembly } from "../src/runtime/agent-runtime-assembly.js";
import { CapabilityRuntimeOperations } from "../src/runtime/capability-runtime-operations.js";
import { RunPreparationOperations } from "../src/runtime/run-preparation-operations.js";
import { resolveRunAccessFields } from "../src/run-access.js";
import { WorkspaceLeaseCoordinator } from "../src/workspace-lease-coordinator.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("RunPreparationOperations", () => {
  it("owns the complete Host run preparation chain behind one interaction seam", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "sparkwright-run-preparation-owner-"),
    );
    tempDirs.push(workspaceRoot);
    const sessionRootDir = join(workspaceRoot, ".sparkwright", "sessions");
    const taskManager = new TaskManager({ store: new InMemoryTaskStore() });
    const capabilities = new CapabilityRuntimeOperations({
      workspaceRoot,
      sessionRootDir,
      taskManager,
      taskRootDir: join(workspaceRoot, ".sparkwright", "tasks"),
      defaultModel: "deterministic",
      emit: () => {},
      prepareMcp: async () => ({ servers: [], prepared: null }),
    });
    const prepareWorkflowEpisode = vi.fn(async () => ({
      ok: true as const,
      prepared: { workflowModelAdapters: new Map() },
    }));
    const interactionChannelFactory = vi.fn(
      (_runIdHolder: { value: string | null }): InteractionChannel => ({
        approve(request) {
          return { approvalId: request.id, decision: "approved" };
        },
      }),
    );
    const operations = new RunPreparationOperations({
      workspaceRoot,
      sessionRootDir,
      workspaceLeaseCoordinator: new WorkspaceLeaseCoordinator(),
      taskManager,
      agents: new AgentRuntimeAssembly({ taskManager }),
      capabilities,
      workflowEpisodes: {
        prepare: prepareWorkflowEpisode,
      },
      createInteractionChannel: interactionChannelFactory,
    });
    const access = resolveRunAccessFields(
      { accessMode: "read-only", backgroundTasks: "foreground-only" },
      {},
    );

    const prepared = await operations.prepare({
      goal: "inspect the workspace",
      modelRef: "deterministic",
      access,
      sessionId: "session_run_preparation_owner",
      traceLevel: "debug",
      runMetadata: { ownerTest: true },
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(interactionChannelFactory).toHaveBeenCalledTimes(1);
    expect(interactionChannelFactory).toHaveBeenCalledWith(
      prepared.env.runIdHolder,
    );
    expect(prepareWorkflowEpisode).toHaveBeenCalledWith(
      expect.objectContaining({
        goal: "inspect the workspace",
        sessionId: "session_run_preparation_owner",
        workspaceRoot,
        access: expect.objectContaining({ accessMode: "read-only" }),
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "read" }),
        ]),
      }),
    );
    expect(prepared.env).toMatchObject({
      workspaceRoot,
      sessionRootDir,
      modelRef: "deterministic",
      mainAgent: { id: "main", mode: "primary" },
      traceLevel: "debug",
      runMetadata: {
        source: "host",
        ownerTest: true,
        sessionId: "session_run_preparation_owner",
        workspaceRoot,
        permissionMode: "plan",
        traceLevel: "debug",
      },
      runStoreMetadata: {
        source: "host",
        ownerTest: true,
        sessionId: "session_run_preparation_owner",
        traceLevel: "debug",
      },
    });
    expect(prepared.env.runMetadata.capabilitySnapshot).toMatchObject({
      tools: expect.any(Number),
      agents: expect.any(Object),
    });
    expect(
      prepared.env.toolCatalog.map((entry) => entry.definition.name),
    ).toContain("read");
  });
});
