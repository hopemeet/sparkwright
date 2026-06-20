import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCapability } from "../src/lib/create-capability.js";

describe("createCapability", () => {
  let tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    tempDirs = [];
  });

  it("omits cwd when creating stdio MCP servers", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-create-"));
    tempDirs.push(workspace);

    await createCapability(
      {
        kind: "mcp",
        name: "notes",
        serverType: "stdio",
        commandOrUrl: "node",
        args: ["server.mjs"],
      },
      workspace,
    );

    const config = JSON.parse(
      await readFile(join(workspace, ".sparkwright", "config.json"), "utf8"),
    );
    expect(config.capabilities.mcp.servers).toEqual([
      {
        type: "stdio",
        name: "notes",
        command: "node",
        args: ["server.mjs"],
        enabled: true,
      },
    ]);
  });
});
