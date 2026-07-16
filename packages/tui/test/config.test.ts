import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTuiConfig } from "../src/lib/config.js";

describe("loadTuiConfig", () => {
  let tempDirs: string[] = [];
  const originalXdg = process.env.XDG_CONFIG_HOME;
  const originalExplicit = process.env.SPARKWRIGHT_CONFIG;

  afterEach(async () => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    if (originalExplicit === undefined) delete process.env.SPARKWRIGHT_CONFIG;
    else process.env.SPARKWRIGHT_CONFIG = originalExplicit;
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    tempDirs = [];
  });

  it("uses the host loader for shared config and TUI overlay for UI fields", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-config-"));
    const xdg = await mkdtemp(join(tmpdir(), "sparkwright-tui-xdg-"));
    tempDirs.push(workspace, xdg);
    process.env.XDG_CONFIG_HOME = xdg;
    delete process.env.SPARKWRIGHT_CONFIG;
    await mkdir(join(workspace, ".sparkwright"), { recursive: true });
    await writeFile(
      join(workspace, ".sparkwright", "config.json"),
      JSON.stringify({
        identity: {
          model: "openai/gpt-test",
          providers: { openai: { apiKey: "sk-test" } },
        },
        run: { accessMode: "accept-edits" },
        ui: {
          theme: "mono",
          mouse: false,
          keybindings: { "help.open": "ctrl+h" },
        },
      }),
      "utf8",
    );

    const loaded = await loadTuiConfig(workspace);

    expect(loaded.config.model).toBe("openai/gpt-test");
    expect(loaded.config.providers?.openai?.apiKey).toBe("sk-test");
    expect(loaded.config.tuiPermissionMode).toBe("accept-edits");
    expect(loaded.config.theme).toBe("mono");
    expect(loaded.config.mouse).toBe(false);
    expect(loaded.config.resolvedBindings?.["help.open"]).toMatchObject([
      { ctrl: true, key: "h" },
    ]);
    expect(loaded.errors).toEqual([]);
  });

  it("uses project accessMode as a ceiling for user TUI access", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-config-"));
    const xdg = await mkdtemp(join(tmpdir(), "sparkwright-tui-xdg-"));
    tempDirs.push(workspace, xdg);
    process.env.XDG_CONFIG_HOME = xdg;
    delete process.env.SPARKWRIGHT_CONFIG;
    await mkdir(join(xdg, "sparkwright"), { recursive: true });
    await mkdir(join(workspace, ".sparkwright"), { recursive: true });
    const userConfig = join(xdg, "sparkwright", "config.json");
    await writeFile(
      userConfig,
      JSON.stringify({ run: { accessMode: "bypass" } }),
      "utf8",
    );
    const projectConfig = join(workspace, ".sparkwright", "config.json");
    await writeFile(
      projectConfig,
      JSON.stringify({ run: { accessMode: "ask" } }),
      "utf8",
    );

    const loaded = await loadTuiConfig(workspace);

    expect(loaded.config.tuiPermissionMode).toBe("ask");
    expect(loaded.config.accessModeCeiling).toBe("ask");
    expect(loaded.sources.tuiPermissionMode).toContain(projectConfig);
    expect(loaded.warnings).toEqual([
      expect.objectContaining({
        file: projectConfig,
        field: "accessMode",
        message: "requested bypass was clamped to project ceiling ask",
      }),
    ]);
    expect(loaded.errors).toEqual([]);
  });

  it("reports removed TUI-owned permission config", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-config-"));
    const xdg = await mkdtemp(join(tmpdir(), "sparkwright-tui-xdg-"));
    tempDirs.push(workspace, xdg);
    process.env.XDG_CONFIG_HOME = xdg;
    delete process.env.SPARKWRIGHT_CONFIG;
    await mkdir(join(workspace, ".sparkwright"), { recursive: true });
    await writeFile(
      join(workspace, ".sparkwright", "config.json"),
      JSON.stringify({ ui: { tuiPermissionMode: "bypass" } }),
      "utf8",
    );

    const loaded = await loadTuiConfig(workspace);

    expect(loaded.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "ui.tuiPermissionMode",
        }),
      ]),
    );
  });
});
