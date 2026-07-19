import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveHostExecutableArgs,
  resolveHostStdioSpawn,
} from "../src/client-spawn.js";

describe("host client spawn resolution", () => {
  it("builds stdio host args from shared run settings", () => {
    const resolved = resolveHostStdioSpawn({
      workspaceRoot: "/repo",
      sessionRootDir: "/repo/.sparkwright/sessions",
      accessMode: "read-only",
      modelName: "deterministic",
      env: {},
    });

    expect(resolved.command).toBe(process.execPath);
    expect(resolved.args[0]).toMatch(/[\\/]dist[\\/]bin\.js$/);
    expect(resolved.args.slice(1)).toEqual([
      "--stdio",
      "--workspace",
      "/repo",
      "--session-root",
      "/repo/.sparkwright/sessions",
      "--access-mode",
      "read-only",
      "--model",
      "deterministic",
    ]);
  });

  it("lets an explicit host bin override source mode", () => {
    expect(
      resolveHostExecutableArgs({
        SPARKWRIGHT_HOST_BIN: "/tmp/custom-host.js",
        SPARKWRIGHT_HOST_SOURCE: "1",
      }),
    ).toEqual(["/tmp/custom-host.js"]);
  });

  it("resolves source mode through tsx and src/bin.ts", () => {
    const args = resolveHostExecutableArgs({ SPARKWRIGHT_HOST_SOURCE: "1" });

    expect(basename(args[0] ?? "")).toBe("cli.mjs");
    expect(args[1]).toMatch(/[\\/]host[\\/]src[\\/]bin\.ts$/);
  });
});
