import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadHostConfig,
  userConfigPath,
  CONFIG_USER_REL,
} from "../src/index.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sparkwright-cfg-"));
}

async function writeUserConfig(xdgHome: string, body: unknown): Promise<void> {
  const path = join(xdgHome, "sparkwright", "config.json");
  await mkdir(join(xdgHome, "sparkwright"), { recursive: true });
  await writeFile(path, JSON.stringify(body), "utf8");
}

describe("loadHostConfig", () => {
  it("resolves the user config under XDG_CONFIG_HOME", async () => {
    const xdg = await makeTempDir();
    try {
      expect(userConfigPath({ XDG_CONFIG_HOME: xdg })).toBe(
        join(xdg, "sparkwright", "config.json"),
      );
    } finally {
      await rm(xdg, { recursive: true, force: true });
    }
  });

  it("reads shared fields and applies them, ignoring UI-only keys", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        model: "openai/gpt-x",
        providers: {
          openai: { baseURL: "https://example.test/v1", apiKey: "sk-test" },
        },
        // UI-only field the host loader must ignore without erroring:
        theme: "light",
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(loaded.errors).toEqual([]);
      expect(loaded.config.model).toBe("openai/gpt-x");
      expect(loaded.config.providers?.openai?.baseURL).toBe(
        "https://example.test/v1",
      );
      expect(loaded.config.providers?.openai?.apiKey).toBe("sk-test");
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("lets the project config override the user config", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        model: "openai/user-model",
        providers: { openai: { apiKey: "sk-user" } },
      });
      await mkdir(join(cwd, ".sparkwright"), { recursive: true });
      await writeFile(
        join(cwd, ".sparkwright", "config.json"),
        JSON.stringify({ model: "openai/project-model" }),
        "utf8",
      );
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      // providers merge by key across layers; model is wholesale-overridden.
      expect(loaded.config.providers?.openai?.apiKey).toBe("sk-user");
      expect(loaded.config.model).toBe("openai/project-model");
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reports a validation error for a bad field and drops it", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, { model: 123, providers: "nope" });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(loaded.config.model).toBeUndefined();
      expect(loaded.errors.some((e) => e.field === "model")).toBe(true);
      expect(loaded.errors.some((e) => e.field === "providers")).toBe(true);
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns empty config when no files exist", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(loaded.config).toEqual({});
      expect(loaded.errors).toEqual([]);
      expect(loaded.attempted.every((a) => a.loaded === false)).toBe(true);
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("exposes a stable user-config relative path constant", () => {
    expect(CONFIG_USER_REL).toBe(".config/sparkwright/config.json");
  });
});
