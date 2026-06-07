import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCapabilityDirs, userConfigBase } from "../src/layers.js";

describe("capability layers", () => {
  it("resolves builtin, user, project dirs in weak-to-strong order", () => {
    const dirs = resolveCapabilityDirs("skills", {
      cwd: "/repo",
      env: { XDG_CONFIG_HOME: "/xdg" },
    });

    expect(dirs.map((dir) => dir.layer)).toEqual([
      "builtin",
      "user",
      "project",
    ]);
    expect(dirs[0]).toMatchObject({
      layer: "builtin",
      readOnly: true,
    });
    expect(dirs[0]?.dir.split(/[\\/]/).slice(-3)).toEqual([
      "host",
      "builtin",
      "skills",
    ]);
    expect(dirs[1]).toEqual({
      layer: "user",
      dir: join("/xdg", "sparkwright", "skills"),
      readOnly: false,
    });
    expect(dirs[2]).toEqual({
      layer: "project",
      dir: join("/repo", ".sparkwright", "skills"),
      readOnly: false,
    });
  });

  it("honors XDG_CONFIG_HOME for the user config base", () => {
    expect(userConfigBase({ XDG_CONFIG_HOME: "/custom" })).toBe("/custom");
  });
});
