import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultConfigPath,
  defaultDataDir,
  loadConfig,
  resolveConfigPathForRead,
  writeConfig,
} from "../src/config.js";

describe("im gateway config paths", () => {
  it("uses XDG config and state homes by default", () => {
    const env = {
      XDG_CONFIG_HOME: "/tmp/sparkwright-config",
      XDG_STATE_HOME: "/tmp/sparkwright-state",
    };

    expect(defaultConfigPath(env)).toBe(
      join("/tmp/sparkwright-config", "sparkwright", "im-gateway.json"),
    );
    expect(defaultDataDir(env)).toBe(
      join("/tmp/sparkwright-state", "sparkwright", "im-gateway"),
    );
  });

  it("resolves explicit paths or the XDG default without fallback", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sparkwright-im-config-"));
    try {
      const xdgConfig = join(tmp, "xdg-config");
      const explicit = join(tmp, "custom", "im-gateway.json");
      expect(
        resolveConfigPathForRead(undefined, { XDG_CONFIG_HOME: xdgConfig }),
      ).toBe(join(xdgConfig, "sparkwright", "im-gateway.json"));
      expect(resolveConfigPathForRead(explicit)).toBe(explicit);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("writes new config paths without touching the legacy location", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sparkwright-im-config-"));
    try {
      const path = join(tmp, "xdg-config", "sparkwright", "im-gateway.json");
      await writeConfig({ hostUrl: "ws://new.example" }, path);
      await expect(loadConfig(path)).resolves.toMatchObject({
        hostUrl: "ws://new.example",
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
