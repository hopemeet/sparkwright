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

  it("loads capability tool config", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        capabilities: {
          tools: {
            enabled: ["read_file", "mcp_*"],
            disabled: ["shell"],
            defer: ["mcp_*"],
          },
        },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(loaded.errors).toEqual([]);
      expect(loaded.config.capabilities?.tools).toEqual({
        enabled: ["read_file", "mcp_*"],
        disabled: ["shell"],
        defer: ["mcp_*"],
      });
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
        shell: {
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

  it("merges shell sandbox config conservatively so project config cannot downgrade user policy", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        shell: {
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
          shell: {
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

  it("merges permissionMode conservatively so project config cannot escalate privilege", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, { permissionMode: "default" });
      await mkdir(join(cwd, ".sparkwright"), { recursive: true });
      await writeFile(
        join(cwd, ".sparkwright", "config.json"),
        JSON.stringify({ permissionMode: "bypass_permissions" }),
        "utf8",
      );

      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.errors).toEqual([]);
      // The project's looser mode is ignored; the stricter user mode wins.
      expect(loaded.config.permissionMode).toBe("default");
      expect(loaded.sources.permissionMode).toContain("user");
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("lets a later permissionMode layer tighten but not weaken", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, { permissionMode: "default" });
      await mkdir(join(cwd, ".sparkwright"), { recursive: true });
      await writeFile(
        join(cwd, ".sparkwright", "config.json"),
        JSON.stringify({ permissionMode: "plan" }),
        "utf8",
      );

      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.errors).toEqual([]);
      // plan is stricter than default, so the project layer is allowed to win.
      expect(loaded.config.permissionMode).toBe("plan");
      expect(loaded.sources.permissionMode).toContain("project");
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("unions confidentialPaths so project config cannot drop user entries", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, { confidentialPaths: ["secrets/**", ".env"] });
      await mkdir(join(cwd, ".sparkwright"), { recursive: true });
      await writeFile(
        join(cwd, ".sparkwright", "config.json"),
        // A project config trying to blank out the user's read-confidentiality.
        JSON.stringify({ confidentialPaths: ["internal/**"] }),
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

  it("merges write guardrails conservatively so project config can only tighten", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        write: { maxFiles: 4, maxDiffLines: 200, allowDeletions: true },
      });
      await mkdir(join(cwd, ".sparkwright"), { recursive: true });
      await writeFile(
        join(cwd, ".sparkwright", "config.json"),
        // Project tightens maxFiles down and forbids deletions; it tries to
        // loosen maxDiffLines up (ignored — the smaller value wins).
        JSON.stringify({
          write: { maxFiles: 1, maxDiffLines: 500, allowDeletions: false },
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

  it("reads the grouped config form and normalizes it to the flat shape", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        identity: {
          model: "openai/gpt-x",
          providers: { openai: { apiKey: "sk-test" } },
        },
        policy: {
          permissionMode: "default",
          confidentialPaths: ["secrets/**"],
          write: { maxFiles: 2 },
          sandbox: { mode: "warn" },
        },
        run: {
          budget: { maxModelCalls: 12 },
          maxSteps: 30,
          traceLevel: "debug",
          approvals: { shellSafe: true },
        },
        ui: { theme: "dark" },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.errors).toEqual([]);
      expect(loaded.config.model).toBe("openai/gpt-x");
      expect(loaded.config.providers?.openai?.apiKey).toBe("sk-test");
      expect(loaded.config.permissionMode).toBe("default");
      expect(loaded.config.confidentialPaths).toEqual(["secrets/**"]);
      expect(loaded.config.write).toEqual({ maxFiles: 2 });
      expect(loaded.config.shell?.sandbox?.mode).toBe("warn");
      expect(loaded.config.runBudget).toEqual({ maxModelCalls: 12 });
      expect(loaded.config.maxSteps).toBe(30);
      expect(loaded.config.traceLevel).toBe("debug");
      expect(loaded.config.approvals).toEqual({ shellSafe: true });
    } finally {
      await rm(xdg, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reports a conflict when grouped and flat keys are both set, preferring grouped", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        model: "openai/flat-model",
        identity: { model: "openai/grouped-model" },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });

      expect(loaded.config.model).toBe("openai/grouped-model");
      expect(loaded.errors).toEqual([
        expect.objectContaining({
          field: "identity.model",
          message: expect.stringContaining('conflicts with top-level "model"'),
        }),
      ]);
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

  it("allows later sandbox config layers to tighten and append path lists", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        shell: {
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
          shell: {
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
                  toolName: "write_file",
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
                matcher: { toolName: ["write_file", "apply_patch"] },
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
            toolName: "write_file",
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
          matcher: { toolName: ["write_file", "apply_patch"] },
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
              frequency: "always",
              injectOutput: "onFailure",
            },
            stopGate: {
              enabled: true,
              requireCleanAfterLastWrite: true,
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
          frequency: "always",
          injectOutput: "onFailure",
        },
        stopGate: {
          enabled: true,
          requireCleanAfterLastWrite: true,
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

  it("drops invalid capability tool fields with validation errors", async () => {
    const xdg = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await writeUserConfig(xdg, {
        capabilities: {
          tools: {
            enabled: "read_file",
            disabled: [false],
            defer: ["mcp_*"],
          },
        },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(loaded.config.capabilities?.tools?.enabled).toBeUndefined();
      expect(loaded.config.capabilities?.tools?.disabled).toBeUndefined();
      expect(loaded.config.capabilities?.tools?.defer).toEqual(["mcp_*"]);
      expect(
        loaded.errors.some((e) => e.field === "capabilities.tools.enabled"),
      ).toBe(true);
      expect(
        loaded.errors.some((e) => e.field === "capabilities.tools.disabled"),
      ).toBe(true);
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
      expect(loaded.config.capabilities?.mcp?.servers?.[0]).toMatchObject({
        type: "stdio",
        name: "docs",
        cwd: join(xdg, "sparkwright", "mcp", "docs"),
        enabled: false,
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
                allowedTools: ["read_file", "delegate_reviewer"],
              },
              {
                id: "reviewer",
                name: "Reviewer",
                mode: "child",
                experimental: {
                  mode: "child",
                  prompt: "Review the current run.",
                },
                allowedTools: ["read_file"],
                policy: [
                  {
                    action: "workspace.write",
                    resource: "*",
                    effect: "deny",
                  },
                ],
              },
            ],
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
        { id: "main", mode: "primary" },
        {
          id: "reviewer",
          name: "Reviewer",
          mode: "child",
          experimental: {
            mode: "child",
            prompt: "Review the current run.",
          },
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

  it("reports invalid experimental agent profile fields", async () => {
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
                experimental: {
                  mode: "other",
                  prompt: 42,
                  owner: "runtime",
                },
              },
            ],
          },
        },
      });
      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(loaded.config.capabilities?.agents?.profiles?.[0]).toMatchObject({
        id: "reviewer",
        experimental: {},
      });
      expect(loaded.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "capabilities.agents.profiles.0.experimental.mode",
          }),
          expect.objectContaining({
            field: "capabilities.agents.profiles.0.experimental.prompt",
          }),
          expect.objectContaining({
            field: "capabilities.agents.profiles.0.experimental.owner",
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
                    workspaceAccess: "read_only",
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
          "capabilities.agents.profiles.0.metadata.acp.workspaceAccess: must be none or read_write",
          "capabilities.agents.profiles.0.metadata.externalCommand.command: must be a non-empty string",
          "capabilities.agents.profiles.0.metadata.externalCommand.args: must be an array of strings",
          "capabilities.agents.profiles.0.metadata.externalCommand.envMode: must be inherit or explicit",
          "capabilities.agents.profiles.0.metadata.externalCommand.workspaceAccess: must be none or read_write",
          "capabilities.agents.profiles.0.metadata.externalCommand.input: must be argument, stdin, or none",
          "capabilities.agents.profiles.0.metadata.externalCommand.maxStdoutBytes: must be a number",
          "capabilities.agents.profiles.0.metadata.externalCommand.maxStderrBytes: must be a number",
          "capabilities.agents.profiles.0.metadata.externalCommand.successExitCodes: must be an array of integers",
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
      // User layer authors agents; project layer authors only a tools policy.
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
                allowedTools: ["read_file"],
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
        JSON.stringify({ capabilities: { tools: { defer: [] } } }),
        "utf8",
      );

      const loaded = await loadHostConfig(cwd, { XDG_CONFIG_HOME: xdg });
      expect(loaded.errors).toEqual([]);
      // Project sub-capability is present...
      expect(loaded.config.capabilities?.tools).toBeDefined();
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
