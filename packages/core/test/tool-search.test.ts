import { describe, expect, it } from "vitest";
import { ToolRegistry, defineTool } from "../src/tools.js";
import {
  createToolSearchTool,
  toolSearchSourceFromRegistry,
} from "../src/tool-search.js";
import type { RuntimeContext } from "../src/types.js";

const stubContext = {} as RuntimeContext;

function buildRegistry() {
  const registry = new ToolRegistry();
  registry.register(
    defineTool({
      name: "notebook_edit",
      description: "Edit a Jupyter notebook cell.",
      inputSchema: { type: "object" },
      deferLoading: true,
      execute: () => ({ ok: true }),
    }),
  );
  registry.register(
    defineTool({
      name: "web_fetch",
      description: "Fetch a URL.",
      inputSchema: { type: "object" },
      deferLoading: true,
      execute: () => ({ ok: true }),
    }),
  );
  registry.register(
    defineTool({
      name: "always_visible",
      description: "Eagerly loaded.",
      inputSchema: { type: "object" },
      execute: () => ({ ok: true }),
    }),
  );
  return registry;
}

describe("tool_search", () => {
  it("returns deferred tools matching keywords", async () => {
    const registry = buildRegistry();
    const tool = createToolSearchTool({
      source: toolSearchSourceFromRegistry(registry),
    });
    const result = await tool.execute(
      { query: "notebook jupyter" },
      stubContext,
    );
    expect(result.mode).toBe("keyword");
    expect(result.matches[0]?.name).toBe("notebook_edit");
    expect(result.matches[0]?.deferred).toBe(true);
    expect(result.deferredCatalogSize).toBe(2);
  });

  it("supports select:name1,name2 exact lookup", async () => {
    const registry = buildRegistry();
    const tool = createToolSearchTool({
      source: toolSearchSourceFromRegistry(registry),
    });
    const result = await tool.execute(
      { query: "select:web_fetch,notebook_edit" },
      stubContext,
    );
    expect(result.mode).toBe("select");
    expect(result.matches.map((m) => m.name).sort()).toEqual([
      "notebook_edit",
      "web_fetch",
    ]);
  });

  it("excludes eagerly-loaded tools when deferredOnly", async () => {
    const registry = buildRegistry();
    const tool = createToolSearchTool({
      source: toolSearchSourceFromRegistry(registry),
    });
    const result = await tool.execute(
      { query: "select:always_visible" },
      stubContext,
    );
    expect(result.matches).toHaveLength(0);
  });

  it("includes eager tools when deferredOnly=false", async () => {
    const registry = buildRegistry();
    const tool = createToolSearchTool({
      source: toolSearchSourceFromRegistry(registry),
      deferredOnly: false,
    });
    const result = await tool.execute(
      { query: "select:always_visible" },
      stubContext,
    );
    expect(result.matches).toHaveLength(1);
  });

  it("respects maxResults", async () => {
    const registry = buildRegistry();
    const tool = createToolSearchTool({
      source: toolSearchSourceFromRegistry(registry),
    });
    const result = await tool.execute(
      { query: "edit fetch", maxResults: 1 },
      stubContext,
    );
    expect(result.matches.length).toBeLessThanOrEqual(1);
  });
});
