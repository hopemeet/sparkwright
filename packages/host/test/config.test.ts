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
