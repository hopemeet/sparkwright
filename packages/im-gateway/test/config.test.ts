import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultConfigPath,
  defaultDataDir,
  legacyConfigPath,
  legacyDataDir,
  loadConfig,
  migrateLegacyPaths,
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

  it("keeps legacy ~/.sparkwright paths discoverable for migration", () => {
    expect(legacyConfigPath()).toBe(
      join(homedir(), ".sparkwright", "im-gateway.json"),
    );
    expect(legacyDataDir()).toBe(join(homedir(), ".sparkwright", "im-gateway"));
  });

  it("reads a legacy config when the new default does not exist", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sparkwright-im-config-"));
    try {
      const xdgConfig = join(tmp, "xdg-config");
      const home = join(tmp, "home");
      const legacy = join(home, ".sparkwright", "im-gateway.json");
      await mkdir(join(home, ".sparkwright"), { recursive: true });
      await writeFile(
        legacy,
        JSON.stringify({ hostUrl: "ws://legacy.example" }),
        "utf8",
      );

      const previousHome = process.env.HOME;
      const previousXdg = process.env.XDG_CONFIG_HOME;
      try {
        process.env.HOME = home;
        process.env.XDG_CONFIG_HOME = xdgConfig;
        const resolved = await resolveConfigPathForRead(undefined, {
          XDG_CONFIG_HOME: xdgConfig,
          HOME: home,
        });
        expect(resolved).toEqual({ path: legacy, legacy: true });
        await expect(loadConfig()).resolves.toMatchObject({
          hostUrl: "ws://legacy.example",
        });
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = previousXdg;
      }
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

  it("migrates legacy config and optional state to explicit targets", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sparkwright-im-migrate-"));
    try {
      const fromConfig = join(tmp, "legacy", "im-gateway.json");
      const toConfig = join(
        tmp,
        "xdg-config",
        "sparkwright",
        "im-gateway.json",
      );
      const fromData = join(tmp, "legacy", "im-gateway");
      const toData = join(tmp, "xdg-state", "sparkwright", "im-gateway");
      await mkdir(fromData, { recursive: true });
      await writeFile(
        fromConfig,
        JSON.stringify({ hostUrl: "ws://legacy.example" }),
        "utf8",
      );
      await writeFile(join(fromData, "state.json"), '{"sessions":[]}\n');

      const result = await migrateLegacyPaths({
        fromConfigPath: fromConfig,
        toConfigPath: toConfig,
        fromDataDir: fromData,
        toDataDir: toData,
        copyState: true,
      });

      expect(result.config).toEqual({
        from: fromConfig,
        to: toConfig,
        migrated: true,
      });
      expect(result.state).toEqual({
        from: fromData,
        to: toData,
        migrated: true,
      });
      await expect(loadConfig(toConfig)).resolves.toMatchObject({
        hostUrl: "ws://legacy.example",
      });
      await expect(readFile(join(toData, "state.json"), "utf8")).resolves.toBe(
        '{"sessions":[]}\n',
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite migrated config unless force is set", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sparkwright-im-migrate-"));
    try {
      const fromConfig = join(tmp, "legacy", "im-gateway.json");
      const toConfig = join(
        tmp,
        "xdg-config",
        "sparkwright",
        "im-gateway.json",
      );
      await mkdir(join(tmp, "legacy"), { recursive: true });
      await mkdir(join(tmp, "xdg-config", "sparkwright"), { recursive: true });
      await writeFile(
        fromConfig,
        JSON.stringify({ hostUrl: "ws://legacy.example" }),
        "utf8",
      );
      await writeFile(
        toConfig,
        JSON.stringify({ hostUrl: "ws://new.example" }),
        "utf8",
      );

      await expect(
        migrateLegacyPaths({
          fromConfigPath: fromConfig,
          toConfigPath: toConfig,
        }),
      ).rejects.toThrow("target config already exists");
      await expect(
        migrateLegacyPaths({
          fromConfigPath: fromConfig,
          toConfigPath: toConfig,
          force: true,
        }),
      ).resolves.toMatchObject({
        config: { from: fromConfig, to: toConfig, migrated: true },
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
