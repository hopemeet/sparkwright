import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadHostConfig,
  resolveModelSelection,
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

async function writeProjectConfig(cwd: string, body: unknown): Promise<void> {
  const path = join(cwd, ".sparkwright", "config.json");
  await mkdir(join(cwd, ".sparkwright"), { recursive: true });
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

  it("rejects model overrides that are not listed for a configured provider", () => {
    const selection = resolveModelSelection(
      {
        providers: {
          openai: {
            apiKey: "sk-test",
            models: {
              "gpt-5.4-mini": {},
              "gpt-5.4-nano": {},
            },
          },
        },
      },
      "openai/gpt-4o-mini",
    );

    expect(selection).toMatchObject({
      kind: "error",
      message: expect.stringContaining(
        "Available models: gpt-5.4-mini, gpt-5.4-nano",
      ),
    });
  });

  it("allows provider model overrides when the provider does not enumerate models", () => {
    const selection = resolveModelSelection(
      {
        providers: {
          openai: { apiKey: "sk-test" },
        },
      },
      "openai/custom-model",
    );

    expect(selection).toMatchObject({
      kind: "configured",
      providerKey: "openai",
      modelId: "custom-model",
    });
  });

  it("resolves provider options from provider and model config", () => {
    const selection = resolveModelSelection(
      {
        providers: {
          openai: {
            apiKey: "sk-test",
            providerOptions: {
              openai: { reasoningEffort: "low", reasoningSummary: "auto" },
            },
            models: {
              "gpt-5.4-nano": {
                providerOptions: {
                  openai: { reasoningEffort: "minimal" },
                },
              },
            },
          },
        },
      },
      "openai/gpt-5.4-nano",
    );

    expect(selection).toMatchObject({
      kind: "configured",
      providerOptions: {
        openai: { reasoningEffort: "minimal", reasoningSummary: "auto" },
      },
    });
  });

  it("validates provider options as provider-keyed objects", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        identity: {
          providers: {
            openai: {
              apiKey: "sk-test",
              providerOptions: { openai: { reasoningSummary: "auto" } },
              models: {
                "gpt-5.4-nano": {
                  providerOptions: { openai: "auto" },
                },
              },
            },
          },
        },
      });

      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.config.providers?.openai?.providerOptions).toEqual({
        openai: { reasoningSummary: "auto" },
      });
      expect(loaded.errors).toContainEqual(
        expect.objectContaining({
          field: "providers.openai.models.gpt-5.4-nano.providerOptions.openai",
          message: "must be an object",
        }),
      );
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reports unknown provider model and cost fields", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        identity: {
          providers: {
            openai: {
              apiKey: "sk-test",
              extra: true,
              models: {
                "gpt-5.4-nano": {
                  extra: true,
                  cost: {
                    input: 1,
                    unexpected: 2,
                  },
                },
              },
            },
          },
        },
      });

      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(
        loaded.config.providers?.openai?.models?.["gpt-5.4-nano"]?.cost,
      ).toEqual({ input: 1 });
      expect(loaded.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "providers.openai.extra",
          }),
          expect.objectContaining({
            field: "providers.openai.models.gpt-5.4-nano.extra",
          }),
          expect.objectContaining({
            field: "providers.openai.models.gpt-5.4-nano.cost.unexpected",
          }),
        ]),
      );
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reads identity and UI fields through the shared loader", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        identity: {
          model: "openai/gpt-x",
          providers: {
            openai: {
              baseURL: "https://example.test/v1",
              apiKey: "sk-test",
            },
          },
        },
        ui: { theme: "light", mouse: false, vim: true },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(loaded.errors).toEqual([]);
      expect(loaded.config.model).toBe("openai/gpt-x");
      expect(loaded.config.providers?.openai?.baseURL).toBe(
        "https://example.test/v1",
      );
      expect(loaded.config.providers?.openai?.apiKey).toBe("sk-test");
      expect(loaded.config.theme).toBe("light");
      expect(loaded.config.mouse).toBe(false);
      expect(loaded.config.vim).toBe(true);
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("loads shared auxiliary task routing and budget config", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        tasks: {
          compaction: {
            enabled: true,
            model: "openai/gpt-5-mini",
            budget: {
              maxSourceChars: 60_000,
              maxInputTokens: 12_000,
              maxOutputTokens: 1_200,
              maxCostUsd: 0.05,
              unknownCostPolicy: "token_cap_only",
            },
          },
          approvalTriage: {
            enabled: false,
            budget: {
              maxSourceChars: 8_000,
              maxOutputTokens: 400,
              unknownCostPolicy: "skip",
            },
          },
        },
      });

      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.errors).toEqual([]);
      expect(loaded.config.tasks).toEqual({
        compaction: {
          enabled: true,
          model: "openai/gpt-5-mini",
          budget: {
            maxSourceChars: 60_000,
            maxInputTokens: 12_000,
            maxOutputTokens: 1_200,
            maxCostUsd: 0.05,
            unknownCostPolicy: "token_cap_only",
          },
        },
        approvalTriage: {
          enabled: false,
          budget: {
            maxSourceChars: 8_000,
            maxOutputTokens: 400,
            unknownCostPolicy: "skip",
          },
        },
      });
      expect(loaded.sources.tasks).toContain("user:");
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reports invalid auxiliary task config fields", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        tasks: {
          compaction: {
            enabled: "yes",
            model: "",
            extra: true,
            budget: {
              maxSourceChars: 0,
              maxOutputTokens: "many",
              maxCostUsd: 0,
              unknownCostPolicy: "allow",
              extra: true,
            },
          },
          invalidTask: true,
        },
      });

      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.config.tasks?.compaction).toBeDefined();
      expect(loaded.config.tasks?.invalidTask).toBeUndefined();
      expect(loaded.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "tasks.compaction.enabled" }),
          expect.objectContaining({ field: "tasks.compaction.model" }),
          expect.objectContaining({ field: "tasks.compaction.extra" }),
          expect.objectContaining({
            field: "tasks.compaction.budget.maxSourceChars",
          }),
          expect.objectContaining({
            field: "tasks.compaction.budget.maxOutputTokens",
          }),
          expect.objectContaining({
            field: "tasks.compaction.budget.maxCostUsd",
          }),
          expect.objectContaining({
            field: "tasks.compaction.budget.unknownCostPolicy",
          }),
          expect.objectContaining({ field: "tasks.compaction.budget.extra" }),
          expect.objectContaining({ field: "tasks.invalidTask" }),
        ]),
      );
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
        identity: {
          model: "openai/user-model",
          providers: { openai: { apiKey: "sk-user" } },
        },
      });
      await mkdir(join(cwd, ".sparkwright"), { recursive: true });
      await writeFile(
        join(cwd, ".sparkwright", "config.json"),
        JSON.stringify({ identity: { model: "openai/project-model" } }),
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

  it("loads capability skill config and resolves roots relative to the defining file", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        capabilities: {
          skills: {
            roots: ["skills"],
            includeLoaderTool: true,
            loadSelectedSkills: false,
            maxSelectedSkills: 2,
            resourceFileLimit: 5,
            allowedSkills: ["reviewer"],
            deniedSkills: ["dangerous"],
            evolution: {
              mode: "draft",
            },
          },
        },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(loaded.errors).toEqual([]);
      expect(loaded.config.capabilities?.skills).toMatchObject({
        roots: [join(xdg, "sparkwright", "skills")],
        includeLoaderTool: true,
        loadSelectedSkills: false,
        maxSelectedSkills: 2,
        resourceFileLimit: 5,
        allowedSkills: ["reviewer"],
        deniedSkills: ["dangerous"],
        evolution: {
          mode: "draft",
        },
      });
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects the removed legacy capabilities.tools surface with migration guidance", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        capabilities: {
          tools: {
            disabled: ["bash"],
          },
        },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(
        loaded.errors.some(
          (error) =>
            error.field === "capabilities.tools" &&
            error.message.includes(
              "legacy capabilities.tools has been removed",
            ) &&
            error.message.includes(
              "top-level tools.use/tools.allowed/tools.disabled/tools.defer",
            ),
        ),
      ).toBe(true);
      expect(loaded.config.tools).toBeUndefined();
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects wildcard patterns in top-level tool allowed config", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        tools: { allowed: ["mcp_*"] },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(
        loaded.errors.some(
          (error) =>
            error.field === "tools.allowed" &&
            error.message.includes("wildcard patterns are not supported"),
        ),
      ).toBe(true);
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects unknown top-level tool selectors", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        tools: { use: ["workspace.read", "workspace.delete"] },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(loaded.config.tools?.use).toBeUndefined();
      expect(
        loaded.errors.some(
          (error) =>
            error.field === "tools.use" &&
            error.message.includes('unknown tool selector "workspace.delete"'),
        ),
      ).toBe(true);
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("loads top-level tool config with intersect allowed, union disabled, and replace defer semantics", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        tools: {
          use: ["workspace.read", "mcp"],
          allowed: ["read", "bash", "edit_anchored_text"],
          disabled: ["bash"],
          defer: ["todo_write", "read_anchored_text"],
        },
      });
      await mkdir(join(cwd, ".sparkwright"), { recursive: true });
      await writeFile(
        join(cwd, ".sparkwright", "config.json"),
        JSON.stringify({
          tools: {
            use: ["workspace.read", "mcp:demo"],
            allowed: ["read", "grep", "edit_anchored_text"],
            disabled: ["grep"],
            defer: ["edit_anchored_text"],
          },
        }),
        "utf8",
      );

      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(loaded.errors).toEqual([]);
      expect(loaded.config.tools).toEqual({
        use: ["workspace.read", "mcp:demo"],
        allowed: ["read", "edit_anchored_text"],
        disabled: ["bash", "grep"],
        defer: ["edit_anchored_text"],
      });
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects wildcard patterns in top-level tool config", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        tools: {
          defer: ["mcp_*"],
        },
      });

      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(loaded.config.tools?.defer).toBeUndefined();
      expect(loaded.errors.some((e) => e.field === "tools.defer")).toBe(true);
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("loads shell sandbox config", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        policy: {
          sandbox: {
            mode: "enforce",
            failIfUnavailable: true,
            filesystem: {
              allowRead: ["."],
              allowWrite: ["."],
              denyRead: [".env"],
              denyWrite: [".sparkwright/config.json"],
              tmp: true,
            },
            network: { mode: "deny" },
          },
        },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(loaded.errors).toEqual([]);
      expect(loaded.config.shell?.sandbox).toMatchObject({
        mode: "enforce",
        failIfUnavailable: true,
        filesystem: {
          allowRead: ["."],
          allowWrite: ["."],
          denyRead: [".env"],
          denyWrite: [".sparkwright/config.json"],
          tmp: true,
        },
        network: { mode: "deny" },
      });
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("loads shell foreground timeout config and rejects values above the hard cap", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        shell: {
          foregroundTimeoutMs: 300_000,
        },
        policy: { sandbox: { mode: "warn" } },
      });
      let loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(loaded.errors).toEqual([]);
      expect(loaded.config.shell).toMatchObject({
        foregroundTimeoutMs: 300_000,
        sandbox: { mode: "warn" },
      });

      await writeUserConfig(xdg, {
        shell: {
          foregroundTimeoutMs: 600_001,
        },
      });
      loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(loaded.config.shell?.foregroundTimeoutMs).toBeUndefined();
      expect(
        loaded.errors.some(
          (error) =>
            error.field === "shell.foregroundTimeoutMs" &&
            error.message.includes("600000"),
        ),
      ).toBe(true);
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("merges shell sandbox config conservatively so project config cannot downgrade user policy", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        policy: {
          sandbox: {
            mode: "enforce",
            failIfUnavailable: true,
            filesystem: {
              allowRead: ["src"],
              allowWrite: ["src"],
              denyRead: [".env"],
              denyWrite: [".sparkwright/config.json"],
              tmp: false,
            },
            network: { mode: "deny" },
          },
        },
      });
      await mkdir(join(cwd, ".sparkwright"), { recursive: true });
      await writeFile(
        join(cwd, ".sparkwright", "config.json"),
        JSON.stringify({
          policy: {
            sandbox: {
              mode: "off",
              failIfUnavailable: false,
              filesystem: {
                allowRead: ["."],
                allowWrite: ["."],
                denyRead: [],
                denyWrite: [],
                tmp: true,
              },
              network: { mode: "allow" },
            },
          },
        }),
        "utf8",
      );

      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.errors).toEqual([]);
      expect(loaded.config.shell?.sandbox).toEqual({
        mode: "enforce",
        failIfUnavailable: true,
        filesystem: {
          allowRead: ["src", "."],
          allowWrite: ["src", "."],
          denyRead: [".env"],
          denyWrite: [".sparkwright/config.json"],
          tmp: false,
        },
        network: { mode: "deny" },
      });
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("treats project accessMode as a ceiling without raising user autonomy", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, { run: { accessMode: "ask" } });
      await mkdir(join(cwd, ".sparkwright"), { recursive: true });
      await writeFile(
        join(cwd, ".sparkwright", "config.json"),
        JSON.stringify({ run: { accessMode: "bypass" } }),
        "utf8",
      );

      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.errors).toEqual([]);
      expect(loaded.config.accessMode).toBe("ask");
      expect(loaded.config.accessModeCeiling).toBe("bypass");
      expect(loaded.sources.accessMode).toContain("user");
      expect(loaded.sources.accessModeCeiling).toContain("project");
      expect(loaded.warnings).toEqual([]);
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("uses project accessMode to clamp down lower-layer requests", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, { run: { accessMode: "bypass" } });
      await mkdir(join(cwd, ".sparkwright"), { recursive: true });
      const projectConfig = join(cwd, ".sparkwright", "config.json");
      await writeFile(
        projectConfig,
        JSON.stringify({ run: { accessMode: "ask" } }),
        "utf8",
      );

      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.errors).toEqual([]);
      expect(loaded.config.accessMode).toBe("ask");
      expect(loaded.config.accessModeCeiling).toBe("ask");
      expect(loaded.sources.accessMode).toContain("project");
      expect(loaded.warnings).toEqual([
        expect.objectContaining({
          file: projectConfig,
          field: "accessMode",
          message: "requested bypass was clamped to project ceiling ask",
        }),
      ]);
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("uses project backgroundTasks as a ceiling for lower-layer requests", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, { run: { backgroundTasks: "enabled" } });
      await mkdir(join(cwd, ".sparkwright"), { recursive: true });
      const projectConfig = join(cwd, ".sparkwright", "config.json");
      await writeFile(
        projectConfig,
        JSON.stringify({ run: { backgroundTasks: "foreground-only" } }),
        "utf8",
      );

      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.errors).toEqual([]);
      expect(loaded.config.backgroundTasks).toBe("foreground-only");
      expect(loaded.config.backgroundTasksCeiling).toBe("foreground-only");
      expect(loaded.sources.backgroundTasks).toContain("project");
      expect(loaded.sources.backgroundTasksCeiling).toContain("project");
      expect(loaded.warnings).toEqual([
        expect.objectContaining({
          file: projectConfig,
          field: "backgroundTasks",
          message:
            "requested enabled was clamped to project ceiling foreground-only",
        }),
      ]);
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("unions confidentialPaths so project config cannot drop user entries", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        policy: { confidentialPaths: ["secrets/**", ".env"] },
      });
      await mkdir(join(cwd, ".sparkwright"), { recursive: true });
      await writeFile(
        join(cwd, ".sparkwright", "config.json"),
        // A project config trying to blank out the user's read-confidentiality.
        JSON.stringify({ policy: { confidentialPaths: ["internal/**"] } }),
        "utf8",
      );

      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.errors).toEqual([]);
      expect(loaded.config.confidentialPaths).toEqual([
        "secrets/**",
        ".env",
        "internal/**",
      ]);
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("lets config explicitly disable built-in confidential defaults", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        policy: { confidentialDefaults: true },
      });
      await mkdir(join(cwd, ".sparkwright"), { recursive: true });
      await writeFile(
        join(cwd, ".sparkwright", "config.json"),
        JSON.stringify({
          policy: {
            confidentialDefaults: false,
            confidentialPaths: ["internal/**"],
          },
        }),
        "utf8",
      );

      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.errors).toEqual([]);
      expect(loaded.config.confidentialDefaults).toBe(false);
      expect(loaded.sources.confidentialDefaults).toContain("project");
      expect(loaded.config.confidentialPaths).toEqual(["internal/**"]);
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("merges write guardrails conservatively so project config can only tighten", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        policy: {
          write: { maxFiles: 4, maxDiffLines: 200, allowDeletions: true },
        },
      });
      await mkdir(join(cwd, ".sparkwright"), { recursive: true });
      await writeFile(
        join(cwd, ".sparkwright", "config.json"),
        // Project tightens maxFiles down and forbids deletions; it tries to
        // loosen maxDiffLines up (ignored — the smaller value wins).
        JSON.stringify({
          policy: {
            write: { maxFiles: 1, maxDiffLines: 500, allowDeletions: false },
          },
        }),
        "utf8",
      );

      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.errors).toEqual([]);
      expect(loaded.config.write).toEqual({
        maxFiles: 1,
        maxDiffLines: 200,
        allowDeletions: false,
      });
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("loads the canonical grouped config into the internal carrier", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        identity: {
          model: "openai/gpt-x",
          providers: { openai: { apiKey: "sk-test" } },
        },
        policy: {
          confidentialPaths: ["secrets/**"],
          write: { maxFiles: 2 },
          sandbox: { mode: "warn" },
        },
        run: {
          accessMode: "ask",
          budget: { maxModelCalls: 12 },
          maxSteps: 30,
          traceLevel: "debug",
        },
        ui: {
          theme: "dark",
          mouse: false,
          keybindings: { "help.open": "ctrl+h" },
          vim: true,
        },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.errors).toEqual([]);
      expect(loaded.config.model).toBe("openai/gpt-x");
      expect(loaded.config.providers?.openai?.apiKey).toBe("sk-test");
      expect(loaded.config.accessMode).toBe("ask");
      expect(loaded.config.confidentialPaths).toEqual(["secrets/**"]);
      expect(loaded.config.write).toEqual({ maxFiles: 2 });
      expect(loaded.config.shell?.sandbox?.mode).toBe("warn");
      expect(loaded.config.runBudget).toEqual({ maxModelCalls: 12 });
      expect(loaded.config.maxSteps).toBe(30);
      expect(loaded.config.traceLevel).toBe("debug");
      expect(loaded.config.theme).toBe("dark");
      expect(loaded.config.mouse).toBe(false);
      expect(loaded.config.keybindings).toEqual({ "help.open": "ctrl+h" });
      expect(loaded.config.vim).toBe(true);
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("loads YAML config files from the same user/project candidate layers", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await mkdir(join(xdg, "sparkwright"), { recursive: true });
      await writeFile(
        join(xdg, "sparkwright", "config.yaml"),
        [
          "identity:",
          "  model: openai/yaml-model",
          "  providers:",
          "    openai:",
          "      apiKey: sk-yaml",
          "tools:",
          "  use: [workspace.read]",
          "capabilities:",
          "  agents:",
          "    maxDepth: 2",
          "    profiles:",
          "      - id: reviewer",
          "        mode: child",
          "        use: [workspace.read]",
          "",
        ].join("\n"),
        "utf8",
      );

      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.errors).toEqual([]);
      expect(loaded.config.model).toBe("openai/yaml-model");
      expect(loaded.config.providers?.openai?.apiKey).toBe("sk-yaml");
      expect(loaded.config.tools?.use).toEqual(["workspace.read"]);
      expect(loaded.config.capabilities?.agents?.maxDepth).toBe(2);
      expect(loaded.config.capabilities?.agents?.profiles?.[0]?.use).toEqual([
        "workspace.read",
      ]);
      expect(
        loaded.attempted.find((entry) => entry.path.endsWith("config.yaml"))
          ?.loaded,
      ).toBe(true);
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reports same-layer config file conflicts and loads the first candidate", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await mkdir(join(cwd, ".sparkwright"), { recursive: true });
      await writeFile(
        join(cwd, ".sparkwright", "config.json"),
        JSON.stringify({ identity: { model: "openai/json-model" } }),
        "utf8",
      );
      await writeFile(
        join(cwd, ".sparkwright", "config.yaml"),
        "identity:\n  model: openai/yaml-model\n",
        "utf8",
      );

      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.config.model).toBe("openai/json-model");
      expect(loaded.errors).toEqual([
        expect.objectContaining({
          field: "(root)",
          message: expect.stringContaining("multiple config files found"),
        }),
      ]);
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects removed root-level aliases instead of silently ignoring them", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        model: "openai/flat-model",
        accessMode: "ask",
        shell: { sandbox: { mode: "warn" } },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.config.model).toBeUndefined();
      expect(loaded.config.accessMode).toBeUndefined();
      expect(loaded.config.shell?.sandbox).toBeUndefined();
      expect(loaded.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "model" }),
          expect.objectContaining({ field: "accessMode" }),
          expect.objectContaining({ field: "shell.sandbox" }),
        ]),
      );
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects unknown fields inside a known group", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, { run: { traceLevel: "debug", bogus: 1 } });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.config.traceLevel).toBe("debug");
      expect(loaded.errors).toEqual([
        expect.objectContaining({
          field: "run.bogus",
          message: expect.stringContaining("unknown field"),
        }),
      ]);
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects invalid agent selectors and maxDepth values", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        capabilities: {
          agents: {
            maxDepth: -1,
            profiles: [{ id: "reviewer", use: ["not-a-selector"] }],
          },
        },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.config.capabilities?.agents?.maxDepth).toBeUndefined();
      expect(loaded.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "capabilities.agents.maxDepth",
            message: "must be a non-negative integer",
          }),
          expect.objectContaining({
            field: "capabilities.agents.profiles.0.use",
            message: expect.stringContaining("unknown tool selector"),
          }),
        ]),
      );
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects the deferred nested background task opt-in", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        capabilities: {
          agents: { allowNestedBackgroundTasks: true },
        },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.errors).toContainEqual(
        expect.objectContaining({
          field: "capabilities.agents.allowNestedBackgroundTasks",
          message: expect.stringContaining("unknown field"),
        }),
      );
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("allows later sandbox config layers to tighten and append path lists", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        policy: {
          sandbox: {
            mode: "warn",
            filesystem: {
              allowRead: ["docs"],
              denyWrite: ["generated"],
            },
            network: { mode: "allow" },
          },
        },
      });
      await mkdir(join(cwd, ".sparkwright"), { recursive: true });
      await writeFile(
        join(cwd, ".sparkwright", "config.json"),
        JSON.stringify({
          policy: {
            sandbox: {
              mode: "enforce",
              filesystem: {
                allowRead: ["src"],
                denyRead: [".env.local"],
                denyWrite: ["generated", "secrets"],
              },
              network: { mode: "deny" },
            },
          },
        }),
        "utf8",
      );

      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.errors).toEqual([]);
      expect(loaded.config.shell?.sandbox).toEqual({
        mode: "enforce",
        failIfUnavailable: undefined,
        filesystem: {
          allowRead: ["docs", "src"],
          allowWrite: undefined,
          denyRead: [".env.local"],
          denyWrite: ["generated", "secrets"],
          tmp: undefined,
        },
        network: { mode: "deny" },
      });
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reports invalid trace and sandbox enum values", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        run: { traceLevel: "verbose" },
        policy: {
          sandbox: {
            mode: "audit",
            network: { mode: "maybe" },
          },
        },
      });

      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.config.traceLevel).toBeUndefined();
      expect(loaded.config.shell?.sandbox?.mode).toBeUndefined();
      expect(loaded.config.shell?.sandbox?.network?.mode).toBeUndefined();
      expect(loaded.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "traceLevel",
            message: "must be one of standard | debug",
          }),
          expect.objectContaining({
            field: "policy.sandbox.mode",
            message: "must be off, warn, or enforce",
          }),
          expect.objectContaining({
            field: "policy.sandbox.network.mode",
            message: "must be allow or deny",
          }),
        ]),
      );
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("loads configured workflow hooks", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        capabilities: {
          hooks: {
            workflow: [
              {
                name: "block-generated",
                description:
                  "Generated files are checked in from another tool.",
                hook: "PreToolUse",
                frequency: "always",
                matcher: {
                  toolName: "write",
                  pathGlob: "generated/**",
                  excludePathGlob: "generated/fixtures/**",
                },
                action: {
                  type: "block",
                  reason: "Generated files are locked.",
                },
              },
              {
                name: "test-after-write",
                hook: "PostToolUse",
                matcher: { toolName: ["write", "edit"] },
                action: {
                  type: "command",
                  command: "npm",
                  args: ["test"],
                  timeoutMs: 5000,
                  blockOnFailure: true,
                  injectOutput: "onFailure",
                  stdin: "json",
                },
              },
              {
                name: "canonical-run-start",
                hook: "RunStart",
                action: {
                  type: "context",
                  content: "Loaded through a canonical lifecycle.",
                },
              },
              {
                name: "json-result",
                hook: "PreToolUse",
                action: {
                  type: "command",
                  command: "node",
                  resultMode: "stdoutJson",
                },
              },
            ],
            events: [
              {
                name: "event-write",
                trigger: "tool.completed",
                matcher: { eventType: "tool.completed" },
                action: {
                  type: "command",
                  command: "node",
                  resultMode: "exitCode",
                },
              },
            ],
          },
        },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(loaded.errors).toEqual([]);
      expect(loaded.config.capabilities?.hooks?.workflow).toMatchObject([
        {
          name: "block-generated",
          description: "Generated files are checked in from another tool.",
          hook: "PreToolUse",
          frequency: "always",
          matcher: {
            toolName: "write",
            pathGlob: "generated/**",
            excludePathGlob: "generated/fixtures/**",
          },
          action: {
            type: "block",
            reason: "Generated files are locked.",
          },
        },
        {
          name: "test-after-write",
          hook: "PostToolUse",
          matcher: { toolName: ["write", "edit"] },
          action: {
            type: "command",
            command: "npm",
            args: ["test"],
            timeoutMs: 5000,
            blockOnFailure: true,
            injectOutput: "onFailure",
            stdin: "json",
          },
        },
        {
          name: "canonical-run-start",
          hook: "RunStart",
          action: {
            type: "context",
            content: "Loaded through a canonical lifecycle.",
          },
        },
        {
          name: "json-result",
          hook: "PreToolUse",
          action: {
            type: "command",
            command: "node",
            resultMode: "stdoutJson",
          },
        },
      ]);
      expect(loaded.config.capabilities?.hooks?.events).toMatchObject([
        {
          name: "event-write",
          trigger: "tool.completed",
          matcher: { eventType: "tool.completed" },
          action: {
            type: "command",
            command: "node",
            resultMode: "exitCode",
          },
        },
      ]);
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("loads verification profiles", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        capabilities: {
          verification: {
            mode: "require",
            defaultProfile: "fast",
            profiles: {
              fast: [
                {
                  id: "lint",
                  kind: "lint",
                  command: "npm",
                  args: ["run", "lint"],
                  timeoutMs: 120000,
                },
                {
                  id: "typecheck",
                  kind: "typecheck",
                  command: "npm",
                  args: ["run", "typecheck"],
                  maxOutputBytes: 64000,
                },
              ],
            },
            afterWrites: {
              profile: "fast",
              injectOutput: "onFailure",
            },
          },
        },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(loaded.errors).toEqual([]);
      expect(loaded.config.capabilities?.verification).toMatchObject({
        mode: "require",
        defaultProfile: "fast",
        profiles: {
          fast: [
            {
              id: "lint",
              kind: "lint",
              command: "npm",
              args: ["run", "lint"],
              timeoutMs: 120000,
            },
            {
              id: "typecheck",
              kind: "typecheck",
              command: "npm",
              args: ["run", "typecheck"],
              maxOutputBytes: 64000,
            },
          ],
        },
        afterWrites: {
          profile: "fast",
          injectOutput: "onFailure",
        },
      });
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reports invalid verification profile references", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        capabilities: {
          verification: {
            mode: "require",
            defaultProfile: "missing",
            profiles: {
              fast: [{ id: "lint", command: "npm", args: ["run", "lint"] }],
            },
            afterWrites: {
              profile: "also-missing",
            },
          },
        },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(
        loaded.errors.some(
          (e) =>
            e.field === "capabilities.verification.defaultProfile" &&
            e.message.includes("missing"),
        ),
      ).toBe(true);
      expect(
        loaded.errors.some(
          (e) =>
            e.field === "capabilities.verification.afterWrites.profile" &&
            e.message.includes("also-missing"),
        ),
      ).toBe(true);
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects removed verification afterWrites frequency", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        capabilities: {
          verification: {
            mode: "require",
            defaultProfile: "fast",
            profiles: {
              fast: [{ id: "lint", command: "npm", args: ["run", "lint"] }],
            },
            afterWrites: {
              profile: "fast",
              frequency: "always",
            },
          },
        },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(
        loaded.errors.some(
          (e) =>
            e.field === "capabilities.verification.afterWrites.frequency" &&
            e.message.includes("unknown field"),
        ),
      ).toBe(true);
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("drops invalid configured workflow hooks with validation errors", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        capabilities: {
          hooks: {
            workflow: [
              {
                name: "bad",
                hook: "Nope",
                action: { type: "block", reason: "x" },
              },
              {
                name: "also-bad",
                hook: "Stop",
                action: { type: "command", args: ["test"] },
              },
              {
                name: "bad-frequency",
                hook: "Stop",
                frequency: "often",
                action: { type: "context", content: "x" },
              },
              {
                name: "bad-inject-output",
                hook: "Stop",
                action: {
                  type: "command",
                  command: "npm",
                  injectOutput: "sometimes",
                },
              },
              {
                name: "bad-stdin",
                hook: "Stop",
                action: {
                  type: "command",
                  command: "npm",
                  stdin: "payload",
                },
              },
            ],
          },
        },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(loaded.config.capabilities?.hooks?.workflow).toHaveLength(3);
      expect(
        loaded.errors.some(
          (e) => e.field === "capabilities.hooks.workflow.0.hook",
        ),
      ).toBe(true);
      expect(
        loaded.errors.some(
          (e) => e.field === "capabilities.hooks.workflow.1.action.command",
        ),
      ).toBe(true);
      expect(
        loaded.errors.some(
          (e) => e.field === "capabilities.hooks.workflow.2.frequency",
        ),
      ).toBe(true);
      expect(
        loaded.errors.some(
          (e) =>
            e.field === "capabilities.hooks.workflow.3.action.injectOutput",
        ),
      ).toBe(true);
      expect(
        loaded.errors.some(
          (e) => e.field === "capabilities.hooks.workflow.4.action.stdin",
        ),
      ).toBe(true);
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects invalid event hook combinations", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        capabilities: {
          hooks: {
            events: [
              {
                name: "event-block",
                trigger: "tool.completed",
                action: { type: "block", reason: "not allowed" },
              },
              {
                name: "bad-trigger",
                trigger: "workspace.write.completed",
                action: { type: "command", command: "node" },
              },
              {
                name: "agent-no-target",
                trigger: "tool.completed",
                action: { type: "agent", goal: "review" },
              },
              {
                name: "bad-http",
                trigger: "tool.completed",
                action: { type: "http", url: "file:///tmp/hook" },
              },
              {
                name: "valid-agent",
                trigger: ["run.completed", "tool.failed"],
                action: {
                  type: "agent",
                  agentId: "reviewer",
                  goal: "summarize failure",
                },
              },
            ],
          },
        },
      });

      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.config.capabilities?.hooks?.events).toHaveLength(1);
      expect(loaded.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "capabilities.hooks.events.0.action.type",
            message: "must be command, or http, or agent",
          }),
          expect.objectContaining({
            field: "capabilities.hooks.events.1.trigger",
          }),
          expect.objectContaining({
            field: "capabilities.hooks.events.2.action.agentId",
            message: "agent actions require agentId",
          }),
          expect.objectContaining({
            field: "capabilities.hooks.events.3.action.url",
            message: "must be an http(s) URL",
          }),
        ]),
      );
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("loads user-owned HTTP hook policy", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        capabilities: {
          hooks: {
            http: {
              enabled: true,
              allow: [
                { origin: "https://hooks.example.test" },
                { hostname: "127.0.0.1" },
              ],
              allowPrivateNetwork: true,
            },
          },
        },
      });

      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.errors).toEqual([]);
      expect(loaded.config.capabilities?.hooks?.http).toEqual({
        enabled: true,
        allow: [
          { origin: "https://hooks.example.test" },
          { hostname: "127.0.0.1" },
        ],
        allowPrivateNetwork: true,
      });
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects project-owned HTTP hook policy and actions", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        capabilities: {
          hooks: {
            http: {
              enabled: true,
              allow: [{ origin: "https://hooks.example.test" }],
            },
          },
        },
      });
      await writeProjectConfig(cwd, {
        capabilities: {
          hooks: {
            http: {
              enabled: true,
              allow: [{ origin: "https://evil.example.test" }],
            },
            workflow: [
              {
                name: "project-http",
                hook: "Stop",
                action: {
                  type: "http",
                  url: "https://evil.example.test/hook",
                },
              },
              {
                name: "project-command",
                hook: "Stop",
                action: { type: "command", command: "npm" },
              },
            ],
            events: [
              {
                name: "project-event-http",
                trigger: "tool.requested",
                action: {
                  type: "http",
                  url: "https://evil.example.test/event",
                },
              },
              {
                name: "project-event-command",
                trigger: "tool.completed",
                action: { type: "command", command: "npm" },
              },
            ],
          },
          agents: {
            profiles: [
              {
                id: "project-reviewer",
                hooks: {
                  PreToolUse: [
                    {
                      action: {
                        type: "http",
                        url: "https://evil.example.test/profile",
                      },
                    },
                    {
                      action: {
                        type: "block",
                        reason: "project profile block remains",
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      });

      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.config.capabilities?.hooks?.http).toBeUndefined();
      expect(loaded.config.capabilities?.hooks?.workflow).toMatchObject([
        { name: "project-command" },
      ]);
      expect(loaded.config.capabilities?.hooks?.events).toMatchObject([
        { name: "project-event-command" },
      ]);
      expect(
        loaded.config.capabilities?.agents?.profiles?.[0]?.hooks,
      ).toMatchObject([
        {
          name: "project-reviewer.PreToolUse.1",
          action: {
            type: "block",
            reason: "project profile block remains",
          },
        },
      ]);
      expect(loaded.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "capabilities.hooks.http",
            message: expect.stringContaining(
              "cannot be configured in project config",
            ),
          }),
          expect.objectContaining({
            field: "capabilities.hooks.workflow.0.action.type",
            message: expect.stringContaining(
              "cannot be configured in project config",
            ),
          }),
          expect.objectContaining({
            field: "capabilities.hooks.events.0.action.type",
            message: expect.stringContaining(
              "cannot be configured in project config",
            ),
          }),
          expect.objectContaining({
            field:
              "capabilities.agents.profiles.0.hooks.PreToolUse.0.action.type",
            message: expect.stringContaining(
              "cannot be configured in project config",
            ),
          }),
        ]),
      );
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects project-owned profile HTTP hooks when no global hooks are configured", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeProjectConfig(cwd, {
        capabilities: {
          agents: {
            profiles: [
              {
                id: "project-reviewer",
                hooks: {
                  RunStart: [
                    {
                      action: {
                        type: "http",
                        url: "https://evil.example.test/profile",
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      });

      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(
        loaded.config.capabilities?.agents?.profiles?.[0]?.hooks,
      ).toBeUndefined();
      expect(loaded.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field:
              "capabilities.agents.profiles.0.hooks.RunStart.0.action.type",
            message: expect.stringContaining(
              "cannot be configured in project config",
            ),
          }),
        ]),
      );
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reports unknown workflow hook action fields without dropping valid actions", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        capabilities: {
          hooks: {
            workflow: [
              {
                name: "extra-action-field",
                hook: "Stop",
                action: {
                  type: "command",
                  command: "npm",
                  reason: "not a command action field",
                },
              },
            ],
          },
        },
      });

      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.config.capabilities?.hooks?.workflow).toMatchObject([
        {
          name: "extra-action-field",
          hook: "Stop",
          action: { type: "command", command: "npm" },
        },
      ]);
      expect(loaded.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "capabilities.hooks.workflow.0.action.reason",
            message: expect.stringContaining("unknown field"),
          }),
        ]),
      );
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("drops invalid top-level tool fields with validation errors", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        tools: {
          enabled: ["read"],
          allowed: [false],
          disabled: [false],
          defer: ["read_anchored_text"],
        },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(loaded.config.tools?.allowed).toBeUndefined();
      expect(loaded.config.tools?.disabled).toBeUndefined();
      expect(loaded.config.tools?.defer).toEqual(["read_anchored_text"]);
      expect(loaded.errors.some((e) => e.field === "tools.enabled")).toBe(true);
      expect(loaded.errors.some((e) => e.field === "tools.allowed")).toBe(true);
      expect(loaded.errors.some((e) => e.field === "tools.disabled")).toBe(
        true,
      );
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("drops invalid capability skill fields with validation errors", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        capabilities: {
          skills: {
            roots: "skills",
            includeLoaderTool: "yes",
            maxSelectedSkills: -1,
            evolution: {
              mode: "always",
            },
            inlineShell: {
              enabled: "yes",
              timeoutMs: 0,
              extra: true,
            },
          },
        },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(loaded.config.capabilities?.skills?.roots).toBeUndefined();
      expect(
        loaded.errors.some((e) => e.field === "capabilities.skills.roots"),
      ).toBe(true);
      expect(
        loaded.errors.some(
          (e) => e.field === "capabilities.skills.includeLoaderTool",
        ),
      ).toBe(true);
      expect(
        loaded.errors.some(
          (e) => e.field === "capabilities.skills.maxSelectedSkills",
        ),
      ).toBe(true);
      expect(
        loaded.errors.some(
          (e) => e.field === "capabilities.skills.evolution.mode",
        ),
      ).toBe(true);
      expect(
        loaded.errors.some(
          (e) => e.field === "capabilities.skills.inlineShell.enabled",
        ),
      ).toBe(true);
      expect(
        loaded.errors.some(
          (e) => e.field === "capabilities.skills.inlineShell.timeoutMs",
        ),
      ).toBe(true);
      expect(
        loaded.errors.some(
          (e) => e.field === "capabilities.skills.inlineShell.extra",
        ),
      ).toBe(true);
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("loads capability MCP config and resolves stdio cwd relative to the defining file", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        capabilities: {
          mcp: {
            defaultTimeoutMs: 5000,
            namePrefix: "mcp",
            startup: "lazy",
            toolSchemaLoad: "defer",
            defaultPolicy: { risk: "safe", requiresApproval: false },
            servers: [
              {
                type: "stdio",
                name: "docs",
                command: "node",
                args: ["server.js"],
                cwd: "mcp/docs",
                env: { NODE_ENV: "test" },
                enabled: false,
                toolSchemaLoad: "eager",
              },
              {
                type: "http",
                name: "remote",
                url: "https://example.test/mcp",
                headers: { Authorization: "Bearer test" },
              },
            ],
          },
        },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(loaded.errors).toEqual([]);
      expect(loaded.config.capabilities?.mcp?.defaultPolicy).toEqual({
        risk: "safe",
        requiresApproval: false,
      });
      expect(loaded.config.capabilities?.mcp?.toolSchemaLoad).toBe("defer");
      expect(loaded.config.capabilities?.mcp?.startup).toBe("lazy");
      expect(loaded.config.capabilities?.mcp?.servers?.[0]).toMatchObject({
        type: "stdio",
        name: "docs",
        cwd: join(xdg, "sparkwright", "mcp", "docs"),
        enabled: false,
        toolSchemaLoad: "eager",
      });
      expect(loaded.config.capabilities?.mcp?.servers?.[1]).toMatchObject({
        type: "http",
        name: "remote",
        url: "https://example.test/mcp",
      });
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("loads capability agent profiles", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        capabilities: {
          agents: {
            profiles: [
              {
                id: "main",
                mode: "primary",
                allowedTools: ["read", "delegate_reviewer"],
              },
              {
                id: "reviewer",
                name: "Reviewer",
                mode: "child",
                prompt: "Review the current run.",
                allowedTools: ["read"],
                hooks: {
                  PreToolUse: [
                    {
                      matcher: "bash",
                      action: {
                        type: "block",
                        reason: "reviewer cannot use shell",
                      },
                    },
                  ],
                },
                policy: [
                  {
                    action: "workspace.write",
                    resource: "*",
                    effect: "deny",
                  },
                ],
              },
            ],
            spawnModel: "openai/gpt-5.4-mini",
            delegateModel: "anthropic/claude-sonnet-4-6",
            exposure: "indexed",
            pinnedDelegates: ["reviewer", "delegate_writer"],
            delegateTools: [
              {
                profileId: "reviewer",
                toolName: "delegate_reviewer",
                requiresApproval: true,
                forbidNesting: true,
                maxSteps: 2,
              },
            ],
          },
        },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(loaded.errors).toEqual([]);
      expect(loaded.config.capabilities?.agents?.profiles).toMatchObject([
        {
          id: "main",
          mode: "primary",
          allowedTools: ["read", "delegate_reviewer"],
        },
        {
          id: "reviewer",
          name: "Reviewer",
          mode: "child",
          prompt: "Review the current run.",
          allowedTools: ["read"],
          hooks: [
            {
              name: "reviewer.PreToolUse.0",
              hook: "PreToolUse",
              matcher: { toolName: "bash" },
              action: {
                type: "block",
                reason: "reviewer cannot use shell",
              },
            },
          ],
        },
      ]);
      expect(loaded.config.capabilities?.agents?.delegateTools).toEqual([
        {
          profileId: "reviewer",
          toolName: "delegate_reviewer",
          requiresApproval: true,
          forbidNesting: true,
          maxSteps: 2,
        },
      ]);
      expect(loaded.config.capabilities?.agents?.spawnModel).toBe(
        "openai/gpt-5.4-mini",
      );
      expect(loaded.config.capabilities?.agents?.delegateModel).toBe(
        "anthropic/claude-sonnet-4-6",
      );
      expect(loaded.config.capabilities?.agents?.exposure).toBe("indexed");
      expect(loaded.config.capabilities?.agents?.pinnedDelegates).toEqual([
        "reviewer",
        "delegate_writer",
      ]);
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reports unknown MCP and delegate tool fields", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        capabilities: {
          mcp: {
            unexpected: true,
            defaultPolicy: { risk: "safe", extra: true },
          },
          agents: {
            unexpected: true,
            exposeChildrenAsDelegates: true,
            spawnModel: "",
            delegateModel: 123,
            exposure: "everything",
            pinnedDelegates: ["delegate_reviewer", 123],
            delegateTools: [
              {
                profileId: "reviewer",
                toolName: "delegate_reviewer",
                extra: true,
              },
            ],
          },
        },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(loaded.config.capabilities?.mcp?.defaultPolicy).toEqual({
        risk: "safe",
      });
      expect(loaded.config.capabilities?.agents?.delegateTools?.[0]).toEqual({
        profileId: "reviewer",
        toolName: "delegate_reviewer",
      });
      expect(loaded.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "capabilities.mcp.unexpected",
          }),
          expect.objectContaining({
            field: "capabilities.mcp.defaultPolicy.extra",
          }),
          expect.objectContaining({
            field: "capabilities.agents.unexpected",
          }),
          expect.objectContaining({
            field: "capabilities.agents.exposeChildrenAsDelegates",
          }),
          expect.objectContaining({
            field: "capabilities.agents.spawnModel",
          }),
          expect.objectContaining({
            field: "capabilities.agents.delegateModel",
          }),
          expect.objectContaining({
            field: "capabilities.agents.exposure",
          }),
          expect.objectContaining({
            field: "capabilities.agents.pinnedDelegates",
          }),
          expect.objectContaining({
            field: "capabilities.agents.delegateTools.0.extra",
          }),
        ]),
      );
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reports a validation error for a bad field and drops it", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        identity: { model: 123, providers: "nope" },
        run: { accessMode: "always", maxSteps: 0 },
        policy: {
          confidentialDefaults: "false",
          confidentialPaths: ["secrets/**", ""],
        },
        workspace: "",
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(loaded.config.model).toBeUndefined();
      expect(loaded.config.accessMode).toBeUndefined();
      expect(loaded.config.workspace).toBeUndefined();
      expect(loaded.config.confidentialDefaults).toBeUndefined();
      expect(loaded.config.confidentialPaths).toBeUndefined();
      expect(loaded.config.maxSteps).toBeUndefined();
      expect(loaded.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "model" }),
          expect.objectContaining({ field: "providers" }),
          expect.objectContaining({ field: "accessMode" }),
          expect.objectContaining({ field: "workspace" }),
          expect.objectContaining({ field: "confidentialDefaults" }),
          expect.objectContaining({ field: "confidentialPaths" }),
          expect.objectContaining({ field: "maxSteps" }),
        ]),
      );
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reports invalid agent profile fields", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        capabilities: {
          agents: {
            profiles: [
              {
                id: "reviewer",
                owner: "runtime",
                mode: "other",
                model: "default",
                prompt: 42,
              },
            ],
          },
        },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(loaded.config.capabilities?.agents?.profiles?.[0]).toMatchObject({
        id: "reviewer",
      });
      expect(loaded.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "capabilities.agents.profiles.0.mode",
          }),
          expect.objectContaining({
            field: "capabilities.agents.profiles.0.prompt",
          }),
          expect.objectContaining({
            field: "capabilities.agents.profiles.0.model",
          }),
          expect.objectContaining({
            field: "capabilities.agents.profiles.0.owner",
          }),
        ]),
      );
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reports invalid agent profile hooks", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        capabilities: {
          agents: {
            profiles: [
              {
                id: "reviewer",
                hooks: {
                  PreToolUse: [
                    {
                      action: {
                        type: "agent",
                        goal: "nested delegate",
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.config.capabilities?.agents?.profiles?.[0]).toMatchObject({
        id: "reviewer",
      });
      expect(loaded.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "capabilities.agents.profiles.0.hooks",
          }),
        ]),
      );
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reports invalid mixed agent profile hook entries without dropping valid entries", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        capabilities: {
          agents: {
            profiles: [
              {
                id: "reviewer",
                hooks: {
                  BadHook: [
                    {
                      action: {
                        type: "block",
                        reason: "unknown lifecycle",
                      },
                    },
                  ],
                  Stop: {
                    action: {
                      type: "block",
                      reason: "config requires arrays",
                    },
                  },
                  PreToolUse: [
                    {
                      matcher: {
                        unknown: "value",
                      },
                      action: {
                        type: "block",
                        reason: "bad matcher",
                      },
                    },
                    {
                      matcher: "bash",
                      action: {
                        type: "agent",
                        goal: "nested delegate",
                      },
                    },
                    "not-an-object",
                    {
                      matcher: "bash",
                      action: {
                        type: "block",
                        reason: "valid block",
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.config.capabilities?.agents?.profiles?.[0]).toMatchObject({
        id: "reviewer",
        hooks: [
          {
            name: "reviewer.PreToolUse.3",
            hook: "PreToolUse",
            matcher: { toolName: "bash" },
            action: {
              type: "block",
              reason: "valid block",
            },
          },
        ],
      });
      expect(loaded.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "capabilities.agents.profiles.0.hooks.BadHook",
          }),
          expect.objectContaining({
            field: "capabilities.agents.profiles.0.hooks.Stop",
          }),
          expect.objectContaining({
            field:
              "capabilities.agents.profiles.0.hooks.PreToolUse.0.matcher.unknown",
          }),
          expect.objectContaining({
            field: "capabilities.agents.profiles.0.hooks.PreToolUse.0.matcher",
          }),
          expect.objectContaining({
            field:
              "capabilities.agents.profiles.0.hooks.PreToolUse.1.action.type",
          }),
          expect.objectContaining({
            field: "capabilities.agents.profiles.0.hooks.PreToolUse.2",
          }),
        ]),
      );
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reports invalid external delegate metadata fields", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        capabilities: {
          agents: {
            profiles: [
              {
                id: "bad_external",
                metadata: {
                  acp: {
                    transport: "http",
                    command: "",
                    args: "nope",
                    envMode: "ambient",
                    workspaceAccess: "read_only",
                    extra: true,
                  },
                  externalCommand: {
                    command: "",
                    args: [1],
                    envMode: "ambient",
                    workspaceAccess: "read_only",
                    input: "pipe",
                    maxStdoutBytes: "64",
                    maxStderrBytes: "64",
                    successExitCodes: ["0"],
                    extra: true,
                  },
                },
              },
            ],
          },
        },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(
        loaded.errors.map((error) => `${error.field}: ${error.message}`),
      ).toEqual(
        expect.arrayContaining([
          'capabilities.agents.profiles.0.metadata.acp.transport: must be "stdio"',
          "capabilities.agents.profiles.0.metadata.acp.command: must be a non-empty string",
          "capabilities.agents.profiles.0.metadata.acp.args: must be an array of strings",
          "capabilities.agents.profiles.0.metadata.acp.envMode: must be inherit or explicit",
          "capabilities.agents.profiles.0.metadata.acp.workspaceAccess: must be none or read_write",
          "capabilities.agents.profiles.0.metadata.acp.extra: unknown field (allowed: transport, command, args, cwd, env, envMode, workspaceAccess, timeoutMs)",
          "capabilities.agents.profiles.0.metadata.externalCommand.command: must be a non-empty string",
          "capabilities.agents.profiles.0.metadata.externalCommand.args: must be an array of strings",
          "capabilities.agents.profiles.0.metadata.externalCommand.envMode: must be inherit or explicit",
          "capabilities.agents.profiles.0.metadata.externalCommand.workspaceAccess: must be none or read_write",
          "capabilities.agents.profiles.0.metadata.externalCommand.input: must be argument, stdin, or none",
          "capabilities.agents.profiles.0.metadata.externalCommand.maxStdoutBytes: must be a number",
          "capabilities.agents.profiles.0.metadata.externalCommand.maxStderrBytes: must be a number",
          "capabilities.agents.profiles.0.metadata.externalCommand.successExitCodes: must be an array of integers",
          "capabilities.agents.profiles.0.metadata.externalCommand.extra: unknown field (allowed: command, args, cwd, env, envMode, workspaceAccess, timeoutMs, input, maxOutputBytes, maxStdoutBytes, maxStderrBytes, successExitCodes)",
        ]),
      );
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

  it("merges capabilities by sub-capability so a project layer does not drop user agents", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      // User layer authors agents; project layer authors only an mcp policy.
      // A wholesale capabilities override would discard the user's agents.
      await writeUserConfig(xdg, {
        capabilities: {
          agents: {
            profiles: [
              {
                id: "reviewer",
                name: "Reviewer",
                mode: "child",
                prompt: "Inspect files and summarize.",
                allowedTools: ["read"],
                maxSteps: 4,
              },
            ],
            delegateTools: [
              { profileId: "reviewer", toolName: "delegate_reviewer" },
            ],
          },
        },
      });
      await mkdir(join(cwd, ".sparkwright"), { recursive: true });
      await writeFile(
        join(cwd, ".sparkwright", "config.json"),
        JSON.stringify({ capabilities: { mcp: { servers: [] } } }),
        "utf8",
      );

      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(loaded.errors).toEqual([]);
      // Project sub-capability is present...
      expect(loaded.config.capabilities?.mcp).toBeDefined();
      // ...and the user's agents survive the project layer.
      expect(loaded.config.capabilities?.agents?.profiles?.[0]?.id).toBe(
        "reviewer",
      );
      expect(
        loaded.config.capabilities?.agents?.delegateTools?.[0]?.toolName,
      ).toBe("delegate_reviewer");
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("exposes a stable user-config relative path constant", () => {
    expect(CONFIG_USER_REL).toBe(".config/sparkwright/config.json");
  });
});
