import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionRegistration } from "@sparkwright/core";
import type { HostEvent } from "@sparkwright/protocol";
import { createTestHostRuntime } from "./helpers/host-runtime.js";

function demoExtension(
  input: { onContextLoad?: () => void } = {},
): ExtensionRegistration {
  return {
    id: "demo.runtime",
    version: "1.0.0",
    description: "Runtime extension fixture.",
    context: {
      name: "demo-context",
      describe: () => [
        { name: "demo-guidance", description: "Demo run guidance." },
      ],
      load: () => {
        input.onContextLoad?.();
        return [
          {
            id: "ctx_demo_runtime" as never,
            type: "system",
            content: "Extension guidance is active.",
            metadata: { layer: "working", stability: "session" },
          },
        ];
      },
    },
    tools: {
      name: "demo-tools",
      listTools: () => [
        {
          name: "demo.lookup",
          description: "Look up demo data.",
          inputSchema: { type: "object", additionalProperties: false },
          execute: () => ({ value: "demo" }),
        },
      ],
    },
  };
}

describe("Host governed extensions", () => {
  it("inspects registered surfaces without loading context", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-extension-"));
    let contextLoads = 0;
    const runtime = createTestHostRuntime({
      workspaceRoot: workspace,
      sessionRootDir: join(workspace, "sessions"),
      defaultModel: "deterministic",
      extensions: [
        demoExtension({
          onContextLoad: () => {
            contextLoads += 1;
          },
        }),
      ],
      emit: () => {},
    });

    try {
      const inspected = await runtime.inspectCapabilities();
      expect(inspected.ok).toBe(true);
      if (!inspected.ok) return;
      expect(contextLoads).toBe(0);
      expect(inspected.snapshot.extensions).toEqual([
        {
          id: "demo.runtime",
          version: "1.0.0",
          description: "Runtime extension fixture.",
          context: [
            { name: "demo-guidance", description: "Demo run guidance." },
          ],
          tools: ["demo.lookup"],
        },
      ]);
      expect(
        inspected.snapshot.tools.find((tool) => tool.name === "demo.lookup"),
      ).toMatchObject({
        source: "extension",
        origin: "local:demo.runtime",
        risk: "risky",
        governance: {
          sideEffects: ["external"],
          origin: {
            metadata: { extensionId: "demo.runtime" },
          },
        },
      });
    } finally {
      runtime.cleanup();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("loads extension context per run and records extension identity", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-extension-"));
    const sessionRootDir = join(workspace, "sessions");
    let contextLoads = 0;
    let resolveTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const events: HostEvent[] = [];
    const runtime = createTestHostRuntime({
      workspaceRoot: workspace,
      sessionRootDir,
      defaultModel: "deterministic",
      extensions: [
        demoExtension({
          onContextLoad: () => {
            contextLoads += 1;
          },
        }),
      ],
      emit: (event) => {
        events.push(event);
        if (event.kind === "run.completed" || event.kind === "run.failed") {
          resolveTerminal();
        }
      },
    });

    try {
      const started = await runtime.startRun({
        goal: "inspect this repo",
        sessionId: "session_extension_runtime",
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      await terminal;
      expect(contextLoads).toBe(1);
      const record = JSON.parse(
        await readFile(
          join(
            sessionRootDir,
            started.sessionId,
            "agents",
            "main",
            "runs",
            started.runId,
            "run.json",
          ),
          "utf8",
        ),
      ) as { metadata?: Record<string, unknown> };
      expect(record.metadata?.extensions).toEqual([
        {
          id: "demo.runtime",
          version: "1.0.0",
          description: "Runtime extension fixture.",
          context: [
            { name: "demo-guidance", description: "Demo run guidance." },
          ],
          tools: ["demo.lookup"],
        },
      ]);
      expect(
        events.some(
          (event) =>
            event.kind === "run.completed" &&
            event.payload.runId === started.runId,
        ),
      ).toBe(true);
    } finally {
      runtime.cleanup();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed when an extension collides with a built-in tool", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-extension-"));
    await mkdir(join(workspace, ".sparkwright"), { recursive: true });
    await writeFile(
      join(workspace, ".sparkwright", "config.json"),
      JSON.stringify({ tools: { use: ["extensions"] } }),
      "utf8",
    );
    const collision = demoExtension();
    collision.tools = {
      name: "collision",
      listTools: () => [
        {
          name: "read",
          description: "Collides with the built-in reader.",
          inputSchema: { type: "object" },
          execute: () => null,
        },
      ],
    };
    const runtime = createTestHostRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      extensions: [collision],
      emit: () => {},
    });

    try {
      const inspected = await runtime.inspectCapabilities();
      expect(inspected).toMatchObject({
        ok: false,
        error: { code: "internal_error" },
      });
      if (!inspected.ok) {
        expect(inspected.error.message).toContain("Tool name collision");
      }
    } finally {
      runtime.cleanup();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("selects all or one registered extension through canonical selectors", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-extension-"));
    await mkdir(join(workspace, ".sparkwright"), { recursive: true });
    await writeFile(
      join(workspace, ".sparkwright", "config.json"),
      JSON.stringify({ tools: { use: ["extension:demo.runtime"] } }),
      "utf8",
    );
    const runtime = createTestHostRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      extensions: [
        demoExtension(),
        {
          id: "other.runtime",
          tools: {
            name: "other",
            listTools: () => [
              {
                name: "other.lookup",
                description: "Look up other data.",
                inputSchema: { type: "object" },
                execute: () => null,
              },
            ],
          },
        },
      ],
      emit: () => {},
    });

    try {
      const inspected = await runtime.inspectCapabilities();
      expect(inspected.ok).toBe(true);
      if (!inspected.ok) return;
      expect(inspected.snapshot.tools.map((tool) => tool.name)).toEqual([
        "demo.lookup",
      ]);
      expect(
        inspected.snapshot.extensions?.map((extension) => extension.id),
      ).toEqual(["demo.runtime", "other.runtime"]);
    } finally {
      runtime.cleanup();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
