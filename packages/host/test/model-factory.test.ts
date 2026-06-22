import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  createModel,
  inspectResolvedModelConfig,
} from "../src/model-factory.js";

describe("model factory pricing diagnostics", () => {
  it("surfaces missing pricing before and after adapter construction", async () => {
    const workspace = await configuredWorkspace({
      model: "openai/gpt-5.4-mini",
      providers: {
        openai: {
          apiKey: "sk-test",
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
