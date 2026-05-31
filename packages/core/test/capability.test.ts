import { describe, expect, it } from "vitest";
import {
  CapabilityRegistry,
  capabilityFromTool,
  capabilitiesFromTools,
} from "../src/capability.js";

describe("capability registry", () => {
  it("maps tool descriptors into discoverable capabilities", () => {
    const tool = {
      name: "mcp_docs.search",
      description: "Search docs.",
      inputSchema: { type: "object" },
      governance: {
        origin: {
          kind: "mcp" as const,
          name: "docs",
        },
      },
    };

    expect(capabilityFromTool(tool)).toMatchObject({
      id: "tool:mcp_docs.search",
      kind: "mcp_tool",
      name: "mcp_docs.search",
      origin: {
        kind: "mcp",
        name: "docs",
      },
    });
  });

  it("filters capabilities without exposing execution methods", () => {
    const registry = new CapabilityRegistry({
      capabilities: capabilitiesFromTools([
        {
          name: "read_file",
          description: "Read a file.",
          inputSchema: { type: "object" },
        },
      ]),
    });

    registry.register({
      id: "skill:reviewer",
      kind: "skill",
      name: "reviewer",
      origin: { kind: "skill", uri: "skills/reviewer/SKILL.md" },
      enabled: false,
    });

    expect(registry.list({ kind: "tool" })).toHaveLength(1);
    expect(registry.list({ enabled: false })).toMatchObject([
      {
        id: "skill:reviewer",
      },
    ]);
    expect(() =>
      registry.register({
        id: "skill:reviewer",
        kind: "skill",
        name: "reviewer",
        origin: { kind: "skill" },
      }),
    ).toThrow("Capability already registered");
  });
});
