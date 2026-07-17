import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRunId, type ModelInput } from "@sparkwright/core";
import { describe, expect, it } from "vitest";
import {
  createModel,
  inspectResolvedModelConfig,
  resolveProfileModelAdapters,
} from "../src/model-factory.js";

describe("model factory pricing diagnostics", () => {
  it("surfaces missing pricing before and after adapter construction", async () => {
    const workspace = await configuredWorkspace({
      identity: {
        model: "openai/gpt-5.4-mini",
        providers: {
          openai: {
            apiKey: "sk-test",
          },
        },
      },
    });
    try {
      const inspected = await inspectResolvedModelConfig({
        workspaceRoot: workspace,
      });
      expect(inspected).toMatchObject({
        ok: true,
        resolved: {
          modelRef: "openai/gpt-5.4-mini",
          pricingSource: "unavailable",
          pricing: {
            source: "unavailable",
            costStatus: "unavailable",
            costUnavailableReason: "missing_pricing",
          },
        },
      });
      if (inspected.ok) {
        expect(inspected.resolved.pricing?.warning).toContain(
          "cost estimates will be unavailable",
        );
      }

      const created = await createModel({
        workspaceRoot: workspace,
        goal: "diagnose pricing",
      });
      expect(created).toMatchObject({
        ok: true,
        resolved: {
          pricingSource: "unavailable",
          pricing: {
            source: "unavailable",
            costStatus: "unavailable",
            costUnavailableReason: "missing_pricing",
          },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reports configured pricing when a cost block is present", async () => {
    const workspace = await configuredWorkspace({
      identity: {
        model: "openai/gpt-5.4-mini",
        providers: {
          openai: {
            models: {
              "gpt-5.4-mini": {
                cost: { input: 0.1, output: 0.4 },
              },
            },
          },
        },
      },
    });
    try {
      await expect(
        inspectResolvedModelConfig({ workspaceRoot: workspace }),
      ).resolves.toMatchObject({
        ok: true,
        resolved: {
          pricingSource: "configured",
          pricing: {
            source: "configured",
            costStatus: "estimated",
          },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("resolveProfileModelAdapters", () => {
  it("dedupes adapters by modelRef and keys them by profile", async () => {
    const workspace = await configuredWorkspace({
      identity: { model: "deterministic" },
    });
    try {
      const result = await resolveProfileModelAdapters({
        requests: [
          { profileId: "a", modelRef: "deterministic" },
          { profileId: "b", modelRef: "deterministic" },
        ],
        goal: "g",
        workspaceRoot: workspace,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect([...result.adapters.keys()].sort()).toEqual(["a", "b"]);
        // Same ref → one adapter instance shared across profiles.
        expect(result.adapters.get("a")).toBe(result.adapters.get("b"));
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails with the profile attribution when a model is unresolvable", async () => {
    const workspace = await configuredWorkspace({
      identity: { model: "deterministic" },
    });
    try {
      const result = await resolveProfileModelAdapters({
        requests: [{ profileId: "reviewer", modelRef: "nope/missing-model" }],
        goal: "g",
        workspaceRoot: workspace,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("reviewer");
        expect(result.message).toContain("nope/missing-model");
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("returns an empty map when there are no requests", async () => {
    const workspace = await configuredWorkspace({
      identity: { model: "deterministic" },
    });
    try {
      const result = await resolveProfileModelAdapters({
        requests: [],
        goal: "g",
        workspaceRoot: workspace,
      });
      expect(result).toEqual({ ok: true, adapters: new Map() });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("deterministic demo model", () => {
  it("uses the active run goal and keeps turn state isolated by run", async () => {
    const workspace = await configuredWorkspace({
      identity: { model: "deterministic" },
    });
    try {
      const created = await createModel({
        modelRef: "deterministic",
        goal: "parent construction goal",
        workspaceRoot: workspace,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const childA = modelInput("child A goal");
      const childB = modelInput("child B goal");

      await expect(created.adapter.complete(childA)).resolves.toMatchObject({
        message: expect.stringContaining('goal: "child A goal"'),
        toolCalls: [{ toolName: "read", arguments: { path: "README.md" } }],
      });
      await expect(created.adapter.complete(childB)).resolves.toMatchObject({
        message: expect.stringContaining('goal: "child B goal"'),
        toolCalls: [{ toolName: "read", arguments: { path: "README.md" } }],
      });
      await expect(
        created.adapter.complete({ ...childA, step: 2 }),
      ).resolves.toMatchObject({
        message: expect.stringContaining('Goal was: "child A goal"'),
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

function modelInput(goal: string): ModelInput {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    run: {
      id: createRunId(),
      goal,
      state: "running",
      createdAt: now,
      updatedAt: now,
      metadata: {},
    },
    context: [],
    tools: [],
    events: [],
    step: 1,
  };
}

async function configuredWorkspace(config: unknown): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "sparkwright-model-"));
  await mkdir(join(workspace, ".sparkwright"), { recursive: true });
  await writeFile(
    join(workspace, ".sparkwright", "config.json"),
    JSON.stringify(config),
    "utf8",
  );
  return workspace;
}
