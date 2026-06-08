import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

describe("runCli", () => {
  let tempDirs: string[] = [];
  let prevXdg: string | undefined;
  let prevHostSource: string | undefined;

  beforeEach(async () => {
    tempDirs = [];
    // Isolate the shared config loader from any real ~/.config/sparkwright so
    // tests that rely on process.env can't pick up the developer's own config.
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevHostSource = process.env.SPARKWRIGHT_HOST_SOURCE;
    const xdg = await mkdtemp(join(tmpdir(), "sparkwright-xdg-"));
    tempDirs.push(xdg);
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.SPARKWRIGHT_HOST_SOURCE = "1";
  });

  afterEach(async () => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevHostSource === undefined)
      delete process.env.SPARKWRIGHT_HOST_SOURCE;
    else process.env.SPARKWRIGHT_HOST_SOURCE = prevHostSource;
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("prints top-level help without starting a run", async () => {
    const output = createOutputCapture();

    const result = await runCli(["--help"], {
      io: {
        stdout: output.stdout,
        stderr: output.stderr,
        stdinIsTTY: false,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(output.stdoutText()).toContain("Usage: sparkwright init");
    expect(output.stdoutText()).toContain('sparkwright run "your goal"');
    expect(output.stdoutText()).not.toContain("run.started");
    expect(output.stdoutText()).not.toContain("Trace written to");
    expect(output.stderrText()).toBe("");
  });

  it("prints command help without treating help as a goal", async () => {
    const output = createOutputCapture();

    const result = await runCli(["run", "--help"], {
      io: {
        stdout: output.stdout,
        stderr: output.stderr,
        stdinIsTTY: false,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(output.stdoutText()).toContain('Usage: sparkwright run "your goal"');
    expect(output.stdoutText()).not.toContain("run.started");
    expect(output.stdoutText()).not.toContain("Trace written to");
    expect(output.stderrText()).toBe("");
  });

  it("rejects an empty run goal with a focused message", async () => {
    const output = createOutputCapture();

    const result = await runCli(["run", ""], {
      io: {
        stdout: output.stdout,
        stderr: output.stderr,
        stdinIsTTY: false,
      },
    });

    expect(result.exitCode).toBe(1);
    expect(output.stderrText()).toContain("requires a non-empty goal");
    expect(output.stderrText()).not.toContain("sparkwright init");
    expect(output.stdoutText()).not.toContain("Trace written to");
  });

  it("runs the read-only golden path and writes a trace", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const output = createOutputCapture();

    const result = await runCli(
      [
        "run",
        "--direct-core",
        "inspect temp",
        "--workspace",
        workspace,
        "--target",
        "README.md",
        "--trace-level",
        "minimal",
      ],
      {
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.runState).toBe("completed");
    expect(result.stopReason).toBe("final_answer");
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
      "# Demo\n",
    );
    expect(output.stdoutText()).toContain("run.completed final_answer");
    expect(result.tracePath).toBeTruthy();
    expect(result.sessionId).toBeTruthy();

    const events = await readTrace(result.tracePath);
    const runId = events[0]?.runId;
    if (!runId) throw new Error("Missing run id in trace.");
    const sessionDir = join(
      workspace,
      ".sparkwright",
      "sessions",
      result.sessionId!,
    );
    const runJson = JSON.parse(
      await readFile(
        join(sessionDir, "agents", "main", "runs", runId, "run.json"),
        "utf8",
      ),
    ) as { state: string; stopReason: string };
    const resultJson = JSON.parse(
      await readFile(
        join(sessionDir, "agents", "main", "runs", runId, "result.json"),
        "utf8",
      ),
    ) as { signal: string; state: string; stopReason: string };
    const sessionJson = JSON.parse(
      await readFile(join(sessionDir, "session.json"), "utf8"),
    ) as { id: string; runIds: string[]; agents: string[] };
    const transcript = await readFile(
      join(sessionDir, "transcript.jsonl"),
      "utf8",
    );

    expect(runJson).toMatchObject({
      state: "completed",
      stopReason: "final_answer",
    });
    expect(resultJson).toMatchObject({
      signal: "completed",
      state: "completed",
      stopReason: "final_answer",
    });
    expect(sessionJson).toMatchObject({
      id: result.sessionId,
      runIds: [runId],
      agents: ["main"],
    });
    expect(transcript).toContain('"type":"prompt"');
    expect(transcript).toContain('"type":"assistant"');
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "run.created",
        "workspace.read",
        "tool.completed",
        "run.completed",
      ]),
    );
    expect(events.map((event) => event.type)).not.toContain(
      "workspace.write.requested",
    );
  });

  it("runs through the host by default", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const output = createOutputCapture();

    const result = await runCli(
      ["run", "inspect temp", "--workspace", workspace],
      {
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.runState).toBe("completed");
    expect(result.tracePath).toBe(
      join(
        workspace,
        ".sparkwright",
        "sessions",
        result.sessionId!,
        "trace.jsonl",
      ),
    );
    expect(output.stdoutText()).toContain("run.completed");

    const sessionJson = JSON.parse(
      await readFile(
        join(
          workspace,
          ".sparkwright",
          "sessions",
          result.sessionId!,
          "session.json",
        ),
        "utf8",
      ),
    ) as { id: string; runIds: string[] };
    expect(sessionJson.id).toBe(result.sessionId);
    expect(sessionJson.runIds).toHaveLength(1);
  });

  it("denies non-interactive writes and leaves the workspace unchanged", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const output = createOutputCapture();

    const result = await runCli(
      [
        "run",
        "--direct-core",
        "deny temp write",
        "--workspace",
        workspace,
        "--target",
        "README.md",
        "--write",
      ],
      {
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
      "# Demo\n",
    );
    expect(output.stderrText()).toContain(
      "Approval denied because stdin is not interactive",
    );

    const events = await readTrace(result.tracePath);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "workspace.write.requested",
        "approval.resolved",
        "workspace.write.denied",
        "tool.failed",
      ]),
    );
    expect(events.map((event) => event.type)).not.toContain(
      "workspace.write.completed",
    );
    const completed = events.find((event) => event.type === "run.completed");
    expect(completed?.payload?.message).toContain(
      "Write was not applied for README.md because approval was denied.",
    );
    expect(completed?.payload?.message).not.toContain(
      "Completed approval-gated write path",
    );
  });

  it("auto-approves writes with --yes and records the write path", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const output = createOutputCapture();

    const result = await runCli(
      [
        "run",
        "--direct-core",
        "approve temp write",
        "--workspace",
        workspace,
        "--target",
        "README.md",
        "--write",
        "--yes",
      ],
      {
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(output.stderrText()).toContain("Approval auto-approved");
    await expect(
      readFile(join(workspace, "README.md"), "utf8"),
    ).resolves.toContain("## Sparkwright CLI Golden Path");

    const events = await readTrace(result.tracePath);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "workspace.write.requested",
        "workspace.anchored_read",
        "workspace.anchored_edit.requested",
        "workspace.anchored_edit.verified",
        "artifact.created",
        "approval.resolved",
        "workspace.write.completed",
        "tool.completed",
      ]),
    );
  });

  it("allows workspace writes without approval in accept_edits mode", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const output = createOutputCapture();

    const result = await runCli(
      [
        "run",
        "--direct-core",
        "accept temp write",
        "--workspace",
        workspace,
        "--target",
        "README.md",
        "--write",
        "--permission-mode",
        "accept_edits",
      ],
      {
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(result.exitCode).toBe(0);
    await expect(
      readFile(join(workspace, "README.md"), "utf8"),
    ).resolves.toContain("## Sparkwright CLI Golden Path");

    const events = await readTrace(result.tracePath);
    expect(events.map((event) => event.type)).toContain(
      "workspace.write.completed",
    );
    expect(events.map((event) => event.type)).not.toContain(
      "approval.requested",
    );
  });

  it("denies approval-gated writes in dont_ask mode", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const output = createOutputCapture();

    const result = await runCli(
      [
        "run",
        "--direct-core",
        "dont ask temp write",
        "--workspace",
        workspace,
        "--target",
        "README.md",
        "--write",
        "--permission-mode",
        "dont_ask",
      ],
      {
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(result.exitCode).toBe(0);
    await expect(readFile(join(workspace, "README.md"), "utf8")).resolves.toBe(
      "# Demo\n",
    );

    const events = await readTrace(result.tracePath);
    expect(events.map((event) => event.type)).toContain(
      "workspace.write.denied",
    );
    expect(events.map((event) => event.type)).not.toContain(
      "approval.requested",
    );
  });

  it("requires an OpenAI API key for provider-backed runs", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const output = createOutputCapture();
    await mkdir(join(workspace, "sparkwright"), { recursive: true });
    await writeFile(
      join(workspace, "sparkwright", "config.json"),
      JSON.stringify({
        providers: { openai: { baseURL: "https://api.openai.com/v1" } },
      }),
      "utf8",
    );

    const result = await runCli(
      [
        "run",
        "--direct-core",
        "inspect temp",
        "--workspace",
        workspace,
        "--model",
        "openai/test-model",
      ],
      {
        // Point the user-config dir at the temp workspace so the host config
        // loader picks up the provider we just wrote (no apiKey set).
        env: { XDG_CONFIG_HOME: workspace },
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(output.stderrText()).toContain('No API key for provider "openai"');
    expect(output.stdoutText()).toBe("");
  });

  it("rejects a model ref that is not in provider/model form", async () => {
    const output = createOutputCapture();
    const workspace = await createWorkspace("# Demo\n");

    const result = await runCli(
      [
        "run",
        "--direct-core",
        "inspect temp",
        "--workspace",
        workspace,
        "--model",
        "barename",
      ],
      {
        env: { XDG_CONFIG_HOME: workspace, OPENAI_API_KEY: "sk-x" },
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(output.stderrText()).toContain(
      'must be in the form "provider/model"',
    );
  });

  it("init scaffolds a private user config and refuses to overwrite it", async () => {
    const xdg = process.env.XDG_CONFIG_HOME as string;
    const configPath = join(xdg, "sparkwright", "config.json");
    const first = createOutputCapture();

    const created = await runCli(["init"], {
      io: { stdout: first.stdout, stderr: first.stderr, stdinIsTTY: false },
    });
    expect(created.exitCode).toBe(0);
    expect(first.stdoutText()).toContain(configPath);

    const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
      model?: string;
      providers?: Record<string, { apiKey?: string }>;
    };
    expect(parsed.model).toBe("openai/gpt-5.4-mini");
    expect(parsed.providers?.openai?.apiKey).toBe("REPLACE_WITH_YOUR_API_KEY");
    if (process.platform !== "win32") {
      // Secret-bearing file must not be group/world readable on POSIX.
      const mode = (await stat(configPath)).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    const second = createOutputCapture();
    const again = await runCli(["init"], {
      io: { stdout: second.stdout, stderr: second.stderr, stdinIsTTY: false },
    });
    expect(again.exitCode).toBe(0);
    expect(second.stdoutText()).toContain("already exists");
  });

  it("init --project scaffolds project config and capability directories", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const configPath = join(workspace, ".sparkwright", "config.json");
    const first = createOutputCapture();

    const created = await runCli(["init", "--project"], {
      cwd: workspace,
      io: { stdout: first.stdout, stderr: first.stderr, stdinIsTTY: false },
    });

    expect(created.exitCode).toBe(0);
    expect(first.stdoutText()).toContain(`Created ${configPath}`);
    expect(first.stdoutText()).toContain(
      "sparkwright capabilities inspect --workspace . --format text",
    );
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
      permissionMode?: string;
      capabilities?: {
        tools?: { disabled?: string[]; defer?: string[]; enabled?: string[] };
        skills?: {
          roots?: string[];
          includeLoaderTool?: boolean;
          loadSelectedSkills?: boolean;
          resourceFileLimit?: number;
        };
        mcp?: { servers?: unknown[] };
      };
    };
    expect(parsed.permissionMode).toBe("default");
    expect(parsed.capabilities?.tools?.disabled).toEqual(["shell"]);
    expect(parsed.capabilities?.tools?.defer).toEqual(["mcp_*"]);
    expect(parsed.capabilities?.tools?.enabled).toBeUndefined();
    expect(parsed.capabilities?.skills?.includeLoaderTool).toBe(true);
    expect(parsed.capabilities?.skills?.loadSelectedSkills).toBe(false);
    expect(parsed.capabilities?.skills?.resourceFileLimit).toBe(8);
    expect(parsed.capabilities?.skills?.roots).toBeUndefined();
    expect(parsed.capabilities?.mcp?.servers).toEqual([]);
    for (const dir of ["skills", "agents", "command"]) {
      expect(
        (await stat(join(workspace, ".sparkwright", dir))).isDirectory(),
      ).toBe(true);
    }

    await rm(join(workspace, ".sparkwright", "agents"), {
      recursive: true,
      force: true,
    });
    const originalConfig = await readFile(configPath, "utf8");
    const second = createOutputCapture();
    const rerun = await runCli(["init", "--project"], {
      cwd: workspace,
      io: { stdout: second.stdout, stderr: second.stderr, stdinIsTTY: false },
    });

    expect(rerun.exitCode).toBe(0);
    expect(second.stdoutText()).toContain("Project config already exists");
    expect(await readFile(configPath, "utf8")).toBe(originalConfig);
    expect(
      (await stat(join(workspace, ".sparkwright", "agents"))).isDirectory(),
    ).toBe(true);
  });

  it("lists tool config without creating a user config", async () => {
    const xdg = process.env.XDG_CONFIG_HOME as string;
    const output = createOutputCapture();

    const result = await runCli(["tools", "list", "--format", "text"], {
      io: { stdout: output.stdout, stderr: output.stderr },
    });

    expect(result.exitCode).toBe(0);
    expect(output.stdoutText()).toContain(
      join(xdg, "sparkwright", "config.json"),
    );
    expect(output.stdoutText()).toContain("enabled: (all)");
    expect(output.stdoutText()).toContain("disabled: (none)");
    await expect(
      stat(join(xdg, "sparkwright", "config.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("inspects configured capability layers", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const stateHome = await mkdtemp(join(tmpdir(), "sparkwright-state-"));
    tempDirs.push(stateHome);
    await mkdir(join(workspace, ".sparkwright", "skills", "reviewer"), {
      recursive: true,
    });
    await mkdir(join(workspace, ".sparkwright", "agents"), {
      recursive: true,
    });
    await mkdir(join(workspace, ".sparkwright", "command"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, ".sparkwright", "skills", "reviewer", "SKILL.md"),
      [
        "---",
        "name: reviewer",
        "description: Reviews changes.",
        "---",
        "Review changes.",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspace, ".sparkwright", "agents", "reviewer.md"),
      [
        "---",
        "name: Reviewer",
        "mode: child",
        "---",
        "Review changes.",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspace, ".sparkwright", "config.json"),
      JSON.stringify({
        capabilities: {
          tools: { disabled: ["shell"], defer: ["mcp_*"] },
          skills: { roots: ["skills"] },
          agents: {
            profiles: [{ id: "reviewer", name: "Config Reviewer" }],
            delegateTools: [
              { profileId: "reviewer", toolName: "delegate_reviewer" },
            ],
          },
          mcp: {
            namePrefix: "mcp_",
            servers: [
              { type: "http", name: "docs", url: "http://127.0.0.1/mcp" },
            ],
          },
        },
      }),
      "utf8",
    );

    const textOutput = createOutputCapture();
    const text = await runCli(
      ["capabilities", "inspect", "--workspace", workspace, "--format", "text"],
      {
        env: { ...process.env, XDG_STATE_HOME: stateHome },
        io: { stdout: textOutput.stdout, stderr: textOutput.stderr },
      },
    );

    expect(text.exitCode).toBe(0);
    expect(textOutput.stdoutText()).toContain(
      "tools: enabled=(all); disabled=shell; defer=mcp_*",
    );
    expect(textOutput.stdoutText()).toContain("skills:");
    expect(textOutput.stdoutText()).toContain("reviewer (legacy)");
    expect(textOutput.stdoutText()).toContain("agents: 1 effective");
    expect(textOutput.stdoutText()).toContain("agent shadows: 1");
    expect(textOutput.stdoutText()).toContain("mcp: 1 servers");
    expect(textOutput.stdoutText()).toContain(
      `cron state: ${join(stateHome, "sparkwright", "cron")}`,
    );

    const jsonOutput = createOutputCapture();
    const json = await runCli(
      ["capabilities", "inspect", "--workspace", workspace, "--format", "json"],
      {
        env: { ...process.env, XDG_STATE_HOME: stateHome },
        io: { stdout: jsonOutput.stdout, stderr: jsonOutput.stderr },
      },
    );

    expect(json.exitCode).toBe(0);
    const report = JSON.parse(jsonOutput.stdoutText()) as {
      tools: { disabled?: string[]; defer?: string[] };
      skills: { skills: Array<{ name: string; layer?: string }> };
      agents: {
        profiles: Array<{ id: string; layer: string }>;
        shadows: Array<{
          id: string;
          shadowed: { layer: string };
          shadowedBy: { layer: string };
        }>;
      };
      mcp: { servers: Array<{ name: string; type: string; enabled: boolean }> };
      cron: { stateRoot: string; legacyStateRoot: string };
      command: { dirs: Array<{ layer: string; exists: boolean }> };
    };
    expect(report.tools.disabled).toEqual(["shell"]);
    expect(report.tools.defer).toEqual(["mcp_*"]);
    expect(report.skills.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "reviewer", layer: "legacy" }),
      ]),
    );
    expect(report.agents.profiles).toEqual([
      expect.objectContaining({ id: "reviewer", layer: "config" }),
    ]);
    expect(report.agents.shadows).toEqual([
      expect.objectContaining({
        id: "reviewer",
        shadowed: expect.objectContaining({ layer: "project" }),
        shadowedBy: expect.objectContaining({ layer: "config" }),
      }),
    ]);
    expect(report.mcp.servers).toEqual([
      { name: "docs", type: "http", enabled: true },
    ]);
    expect(report.cron.stateRoot).toBe(join(stateHome, "sparkwright", "cron"));
    expect(report.command.dirs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ layer: "project", exists: true }),
      ]),
    );
  });

  it("updates user tool config commands without dropping existing fields", async () => {
    const xdg = process.env.XDG_CONFIG_HOME as string;
    const configPath = join(xdg, "sparkwright", "config.json");
    await mkdir(join(xdg, "sparkwright"), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        model: "deterministic/demo",
        capabilities: {
          skills: { roots: ["./skills"] },
          tools: { disabled: ["shell"] },
        },
      }),
      "utf8",
    );

    for (const argv of [
      ["tools", "enable", "read_file", "mcp_*"],
      ["tools", "disable", "read_file"],
      ["tools", "defer", "mcp_*"],
    ]) {
      const output = createOutputCapture();
      const result = await runCli(argv, {
        io: { stdout: output.stdout, stderr: output.stderr },
      });
      expect(result.exitCode).toBe(0);
    }

    const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
      model?: string;
      capabilities?: {
        skills?: { roots?: string[] };
        tools?: {
          enabled?: string[];
          disabled?: string[];
          defer?: string[];
        };
      };
    };
    expect(parsed.model).toBe("deterministic/demo");
    expect(parsed.capabilities?.skills?.roots).toEqual(["./skills"]);
    expect(parsed.capabilities?.tools).toEqual({
      enabled: ["mcp_*"],
      disabled: ["shell", "read_file"],
      defer: ["mcp_*"],
    });
    if (process.platform !== "win32") {
      const mode = (await stat(configPath)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("marks missing command capability dirs as optional in inspect output", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const output = createOutputCapture();

    const result = await runCli(
      ["capabilities", "inspect", "--workspace", workspace, "--format", "text"],
      {
        io: { stdout: output.stdout, stderr: output.stderr, stdinIsTTY: false },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(output.stdoutText()).toContain("command dirs:");
    expect(output.stdoutText()).toContain("(optional, missing)");
    expect(output.stdoutText()).not.toContain(" (missing)");
  });

  it("creates, lists, and validates workspace skills", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const createOutput = createOutputCapture();

    const created = await runCli(
      [
        "skills",
        "create",
        "code-reviewer",
        "--description",
        "Reviews code changes for risk and missing tests.",
        "--workspace",
        workspace,
      ],
      {
        io: { stdout: createOutput.stdout, stderr: createOutput.stderr },
      },
    );
    expect(created.exitCode).toBe(0);
    expect(createOutput.stdoutText()).toContain("code-reviewer/SKILL.md");

    const skillPath = join(
      workspace,
      ".sparkwright",
      "skills",
      "code-reviewer",
      "SKILL.md",
    );
    await expect(readFile(skillPath, "utf8")).resolves.toContain(
      "name: code-reviewer",
    );

    const listOutput = createOutputCapture();
    const listed = await runCli(
      ["skills", "list", "--workspace", workspace, "--format", "text"],
      {
        io: { stdout: listOutput.stdout, stderr: listOutput.stderr },
      },
    );
    expect(listed.exitCode).toBe(0);
    expect(listOutput.stdoutText()).toContain("code-reviewer@1.0.0");
    expect(listOutput.stdoutText()).toContain("layer: project");

    const validateOutput = createOutputCapture();
    const validated = await runCli(
      ["skills", "validate", "--workspace", workspace, "--format", "json"],
      {
        io: { stdout: validateOutput.stdout, stderr: validateOutput.stderr },
      },
    );
    expect(validated.exitCode).toBe(0);
    const report = JSON.parse(validateOutput.stdoutText()) as {
      skills: Array<{ name: string }>;
      errors: unknown[];
    };
    expect(report.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "code-reviewer" }),
      ]),
    );
    expect(report.errors).toEqual([]);
  });

  it("reports skill source layers and shadowed skills", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const xdg = process.env.XDG_CONFIG_HOME as string;
    const userSkillDir = join(xdg, "sparkwright", "skills", "reviewer");
    const projectSkillDir = join(
      workspace,
      ".sparkwright",
      "skills",
      "reviewer",
    );
    await mkdir(userSkillDir, { recursive: true });
    await mkdir(projectSkillDir, { recursive: true });
    await writeFile(
      join(userSkillDir, "SKILL.md"),
      [
        "---",
        "name: reviewer",
        "description: User reviewer.",
        "---",
        "Use user reviewer.",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(projectSkillDir, "SKILL.md"),
      [
        "---",
        "name: reviewer",
        "description: Project reviewer.",
        "---",
        "Use project reviewer.",
        "",
      ].join("\n"),
      "utf8",
    );

    const output = createOutputCapture();
    const result = await runCli(
      ["skills", "validate", "--workspace", workspace, "--format", "json"],
      {
        io: { stdout: output.stdout, stderr: output.stderr },
      },
    );

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(output.stdoutText()) as {
      skills: Array<{ name: string; description: string; layer?: string }>;
      shadows: Array<{
        name: string;
        shadowed: { layer?: string };
        shadowedBy: { layer?: string };
      }>;
      errors: unknown[];
    };
    expect(report.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "reviewer",
          description: "Project reviewer.",
          layer: "project",
        }),
      ]),
    );
    expect(report.shadows).toEqual([
      expect.objectContaining({
        name: "reviewer",
        shadowed: expect.objectContaining({ layer: "user" }),
        shadowedBy: expect.objectContaining({ layer: "project" }),
      }),
    ]);
    expect(report.errors).toEqual([]);
  });

  it("reports skill validation errors", async () => {
    const workspace = await createWorkspace("# Demo\n");
    await mkdir(join(workspace, ".sparkwright", "skills", "bad"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, ".sparkwright", "skills", "bad", "SKILL.md"),
      [
        "---",
        "name: Bad Name",
        "description: Invalid name.",
        "---",
        "Broken.",
        "",
      ].join("\n"),
      "utf8",
    );
    const output = createOutputCapture();

    const result = await runCli(
      ["skills", "validate", "--workspace", workspace, "--format", "text"],
      {
        io: { stdout: output.stdout, stderr: output.stderr },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(output.stdoutText()).toContain("errors: 1");
    expect(output.stdoutText()).toContain("Skill name must use lowercase");
  });

  it("creates, lists, and validates workspace agents", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const createOutput = createOutputCapture();

    const created = await runCli(
      [
        "agents",
        "create",
        "reviewer",
        "--name",
        "Reviewer",
        "--prompt",
        "Inspect changes for correctness and risk.",
        "--allow",
        "read_file",
        "--allow",
        "glob_paths",
        "--max-steps",
        "4",
        "--delegate",
        "delegate_reviewer",
        "--workspace",
        workspace,
      ],
      {
        io: { stdout: createOutput.stdout, stderr: createOutput.stderr },
      },
    );
    expect(created.exitCode).toBe(0);
    expect(createOutput.stdoutText()).toContain(
      join(workspace, ".sparkwright", "config.json"),
    );
    expect(createOutput.stdoutText()).toContain(
      'Agent profile "reviewer" is now defined.',
    );
    expect(createOutput.stdoutText()).toContain(
      "Callable delegate tool: delegate_reviewer -> reviewer",
    );
    expect(createOutput.stdoutText()).toContain(
      "sparkwright agents validate --workspace .",
    );

    const configPath = join(workspace, ".sparkwright", "config.json");
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
      capabilities?: {
        agents?: {
          profiles?: Array<{
            id: string;
            name?: string;
            prompt?: string;
            allowedTools?: string[];
            maxSteps?: number;
          }>;
          delegateTools?: Array<{
            profileId: string;
            toolName?: string;
            requiresApproval?: boolean;
            forbidNesting?: boolean;
          }>;
        };
      };
    };
    expect(parsed.capabilities?.agents?.profiles).toEqual([
      expect.objectContaining({
        id: "reviewer",
        name: "Reviewer",
        prompt: "Inspect changes for correctness and risk.",
        allowedTools: ["read_file", "glob_paths"],
        maxSteps: 4,
      }),
    ]);
    expect(parsed.capabilities?.agents?.delegateTools).toEqual([
      {
        profileId: "reviewer",
        toolName: "delegate_reviewer",
        requiresApproval: true,
        forbidNesting: true,
        maxSteps: 4,
      },
    ]);

    const listOutput = createOutputCapture();
    const listed = await runCli(
      ["agents", "list", "--workspace", workspace, "--format", "text"],
      {
        io: { stdout: listOutput.stdout, stderr: listOutput.stderr },
      },
    );
    expect(listed.exitCode).toBe(0);
    expect(listOutput.stdoutText()).toContain("reviewer (Reviewer)");
    expect(listOutput.stdoutText()).toContain("delegate_reviewer -> reviewer");

    const validateOutput = createOutputCapture();
    const validated = await runCli(
      ["agents", "validate", "--workspace", workspace, "--format", "json"],
      {
        io: { stdout: validateOutput.stdout, stderr: validateOutput.stderr },
      },
    );
    expect(validated.exitCode).toBe(0);
    const report = JSON.parse(validateOutput.stdoutText()) as {
      errors: unknown[];
    };
    expect(report.errors).toEqual([]);
  });

  it("reports agent validation errors", async () => {
    const workspace = await createWorkspace("# Demo\n");
    await mkdir(join(workspace, ".sparkwright"), { recursive: true });
    await writeFile(
      join(workspace, ".sparkwright", "config.json"),
      JSON.stringify({
        capabilities: {
          agents: {
            profiles: [{ id: "main", mode: "primary" }],
            delegateTools: [{ profileId: "missing", toolName: "delegate_bad" }],
          },
        },
      }),
      "utf8",
    );
    const output = createOutputCapture();

    const result = await runCli(
      ["agents", "validate", "--workspace", workspace, "--format", "text"],
      {
        io: { stdout: output.stdout, stderr: output.stderr },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(output.stdoutText()).toContain("errors: 1");
    expect(output.stdoutText()).toContain(
      "delegateTools.0.profileId: must reference an existing profile id",
    );
  });

  it("seeds the model ref from the shared config file", async () => {
    const xdg = process.env.XDG_CONFIG_HOME as string;
    await mkdir(join(xdg, "sparkwright"), { recursive: true });
    await writeFile(
      join(xdg, "sparkwright", "config.json"),
      JSON.stringify({
        model: "openai/cfg-model",
        providers: { openai: { baseURL: "https://api.openai.com/v1" } },
      }),
      "utf8",
    );
    const workspace = await createWorkspace("# Demo\n");
    const output = createOutputCapture();

    // No --model on the CLI: the ref must come from the config file. With an
    // openai ref but no key, we reach the key check — proving the model was
    // seeded (otherwise it'd fail the "provider/model" form check).
    const result = await runCli(
      ["run", "--direct-core", "inspect temp", "--workspace", workspace],
      {
        // Explicit env (no OPENAI_API_KEY) so a dev shell key can't leak in.
        env: { XDG_CONFIG_HOME: xdg },
        io: { stdout: output.stdout, stderr: output.stderr, stdinIsTTY: false },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(output.stderrText()).toContain('No API key for provider "openai"');
  });

  it("loads project config from --workspace before choosing the host model", async () => {
    const workspace = await createWorkspace("# Demo\n");
    await mkdir(join(workspace, ".sparkwright"), { recursive: true });
    await writeFile(
      join(workspace, ".sparkwright", "config.json"),
      JSON.stringify({
        model: "openai/project-model",
        providers: { openai: { baseURL: "https://api.openai.com/v1" } },
      }),
      "utf8",
    );
    const output = createOutputCapture();

    const result = await runCli(
      ["run", "inspect temp", "--workspace", workspace],
      {
        env: {
          XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
          SPARKWRIGHT_HOST_SOURCE: process.env.SPARKWRIGHT_HOST_SOURCE,
        },
        io: { stdout: output.stdout, stderr: output.stderr, stdinIsTTY: false },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(output.stderrText()).toContain('No API key for provider "openai"');
    expect(output.stdoutText()).not.toContain("run.completed");
  });

  it("writes a minimal trace when host startup fails before the run starts", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const output = createOutputCapture();

    const result = await runCli(
      [
        "run",
        "inspect temp",
        "--workspace",
        workspace,
        "--model",
        "invalidmodel",
      ],
      {
        io: { stdout: output.stdout, stderr: output.stderr, stdinIsTTY: false },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(output.stderrText()).toContain("must be in the form");
    expect(output.stdoutText()).toContain("Trace written to");
    const events = await readTrace(result.tracePath);
    expect(events.map((event) => event.type)).toEqual([
      "run.created",
      "run.failed",
    ]);
    expect(
      events.find((event) => event.type === "run.failed")?.payload,
    ).toMatchObject({
      reason: "host_start_failed",
      code: "HOST_START_FAILED",
    });

    const checkOutput = createOutputCapture();
    const check = await runCli(
      [
        "session",
        "check",
        result.sessionId!,
        "--workspace",
        workspace,
        "--format",
        "text",
      ],
      {
        io: { stdout: checkOutput.stdout, stderr: checkOutput.stderr },
      },
    );
    expect(check.exitCode).toBe(0);
    expect(checkOutput.stdoutText()).toContain("findings: 0");
  });

  it("passes --target through the host deterministic run", async () => {
    const workspace = await createWorkspace("# Demo\n");
    await writeFile(join(workspace, "NOTES.md"), "# Notes\n", "utf8");
    const output = createOutputCapture();

    const result = await runCli(
      [
        "run",
        "inspect the target",
        "--workspace",
        workspace,
        "--target",
        "NOTES.md",
        "--model",
        "deterministic",
        "--trace-level",
        "debug",
      ],
      {
        io: { stdout: output.stdout, stderr: output.stderr, stdinIsTTY: false },
      },
    );

    expect(result.exitCode).toBe(0);
    const events = await readTrace(result.tracePath);
    expect(
      events.find((event) => event.type === "tool.requested")?.payload,
    ).toMatchObject({
      toolName: "read_file",
      arguments: { path: "NOTES.md" },
    });
    expect(
      events.find((event) => event.type === "model.requested")?.payload,
    ).toMatchObject({
      adapterId: "deterministic",
    });
    expect(
      events.find((event) => event.type === "run.started")?.payload,
    ).toMatchObject({
      resolvedModel: {
        modelRef: "deterministic",
        providerKey: "deterministic",
        modelId: "deterministic",
        adapterId: "deterministic",
        modelSource: { layer: "request" },
      },
    });
  });

  it("lets provider env override configured apiKey without leaking the key", async () => {
    const mock = await createProviderMock();
    try {
      const workspace = await createWorkspace("# Demo\n");
      await mkdir(join(workspace, ".sparkwright"), { recursive: true });
      await writeFile(
        join(workspace, ".sparkwright", "config.json"),
        JSON.stringify({
          model: "openai/mock-model",
          providers: {
            openai: {
              baseURL: mock.baseURL,
              apiKey: "CONFIG_KEY",
              models: { "mock-model": {} },
            },
          },
        }),
        "utf8",
      );
      const output = createOutputCapture();

      const result = await runCli(
        [
          "run",
          "inspect temp",
          "--workspace",
          workspace,
          "--trace-level",
          "debug",
        ],
        {
          env: {
            XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
            SPARKWRIGHT_HOST_SOURCE: process.env.SPARKWRIGHT_HOST_SOURCE,
            OPENAI_API_KEY: "ENV_KEY",
          },
          io: {
            stdout: output.stdout,
            stderr: output.stderr,
            stdinIsTTY: false,
          },
        },
      );

      expect(result.exitCode).toBe(1);
      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0]?.authorization).toBe("Bearer ENV_KEY");
      const events = await readTrace(result.tracePath);
      const started = events.find((event) => event.type === "run.started");
      expect(started?.payload).toMatchObject({
        resolvedModel: {
          adapterId: "openai:mock-model",
          modelSource: { layer: "project" },
          providerSource: { layer: "project" },
          authSource: "env:OPENAI_API_KEY",
          baseURLSource: "config",
        },
      });
      expect(JSON.stringify(events)).not.toContain("ENV_KEY");
      expect(JSON.stringify(events)).not.toContain("CONFIG_KEY");
    } finally {
      await mock.close();
    }
  });

  it("lets OPENAI_BASE_URL override configured baseURL", async () => {
    const mock = await createProviderMock();
    try {
      const workspace = await createWorkspace("# Demo\n");
      await mkdir(join(workspace, ".sparkwright"), { recursive: true });
      await writeFile(
        join(workspace, ".sparkwright", "config.json"),
        JSON.stringify({
          model: "openai/mock-model",
          providers: {
            openai: {
              baseURL: "http://127.0.0.1:9/v1",
              models: { "mock-model": {} },
            },
          },
        }),
        "utf8",
      );
      const output = createOutputCapture();

      const result = await runCli(
        [
          "run",
          "inspect temp",
          "--workspace",
          workspace,
          "--trace-level",
          "debug",
        ],
        {
          env: {
            XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
            SPARKWRIGHT_HOST_SOURCE: process.env.SPARKWRIGHT_HOST_SOURCE,
            OPENAI_API_KEY: "ENV_KEY",
            OPENAI_BASE_URL: mock.baseURL,
          },
          io: {
            stdout: output.stdout,
            stderr: output.stderr,
            stdinIsTTY: false,
          },
        },
      );

      expect(result.exitCode).toBe(1);
      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0]?.url).toBe("/v1/responses");
      const events = await readTrace(result.tracePath);
      expect(
        events.find((event) => event.type === "run.started")?.payload,
      ).toMatchObject({
        resolvedModel: {
          adapterId: "openai:mock-model",
          authSource: "env:OPENAI_API_KEY",
          baseURLSource: "env:OPENAI_BASE_URL",
        },
      });
    } finally {
      await mock.close();
    }
  });

  it("summarizes a trace file", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const runOutput = createOutputCapture();
    const run = await runCli(
      ["run", "--direct-core", "inspect", "--workspace", workspace],
      {
        io: { stdout: runOutput.stdout, stderr: runOutput.stderr },
      },
    );
    const output = createOutputCapture();

    const result = await runCli(["trace", "summary", run.tracePath!], {
      io: { stdout: output.stdout, stderr: output.stderr },
    });

    expect(result.exitCode).toBe(0);
    const summary = JSON.parse(output.stdoutText()) as {
      eventCount: number;
      runIds: string[];
      byType: Record<string, number>;
    };
    expect(summary.eventCount).toBeGreaterThan(0);
    expect(summary.runIds).toHaveLength(1);
    expect(summary.byType["run.completed"]).toBe(1);

    const textOutput = createOutputCapture();
    const text = await runCli(
      ["trace", "summary", run.tracePath!, "--format", "text"],
      {
        io: { stdout: textOutput.stdout, stderr: textOutput.stderr },
      },
    );
    expect(text.exitCode).toBe(0);
    expect(textOutput.stdoutText()).toContain("events:");
  });

  it("counts failed MCP preparation in trace summaries", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const tracePath = join(workspace, "mcp-failed.trace.jsonl");
    await writeFile(
      tracePath,
      JSON.stringify({
        id: "evt_mcp_failed",
        runId: "run_mcp_failed",
        type: "mcp.server.prepared",
        timestamp: "2026-01-01T00:00:00.000Z",
        sequence: 1,
        payload: { name: "slow", status: "failed", toolCount: 0 },
        metadata: { error: "MCP error -32001: Request timed out" },
      }) + "\n",
      "utf8",
    );
    const output = createOutputCapture();

    const result = await runCli(["trace", "summary", tracePath], {
      io: { stdout: output.stdout, stderr: output.stderr },
    });

    expect(result.exitCode).toBe(0);
    const summary = JSON.parse(output.stdoutText()) as {
      errorCount: number;
      errorCodes: Record<string, number>;
    };
    expect(summary.errorCount).toBe(1);
    expect(summary.errorCodes.MCP_SERVER_PREPARE_FAILED).toBe(1);
  });

  it("filters trace events", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const runOutput = createOutputCapture();
    const run = await runCli(
      ["run", "--direct-core", "inspect", "--workspace", workspace],
      {
        io: { stdout: runOutput.stdout, stderr: runOutput.stderr },
      },
    );
    const output = createOutputCapture();

    const result = await runCli(
      [
        "trace",
        "events",
        run.tracePath!,
        "--type",
        "run.completed",
        "--format",
        "text",
      ],
      {
        io: { stdout: output.stdout, stderr: output.stderr },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(output.stdoutText()).toContain("run.completed");
    expect(output.stdoutText()).not.toContain("run.created");

    const jsonlOutput = createOutputCapture();
    const jsonl = await runCli(
      ["trace", "events", run.tracePath!, "--limit", "1", "--jsonl"],
      {
        io: { stdout: jsonlOutput.stdout, stderr: jsonlOutput.stderr },
      },
    );
    expect(jsonl.exitCode).toBe(0);
    expect(jsonlOutput.stdoutText().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(jsonlOutput.stdoutText())).toMatchObject({
      type: "run.created",
    });

    const timelineOutput = createOutputCapture();
    const timeline = await runCli(
      ["trace", "timeline", run.tracePath!, "--format", "text"],
      {
        io: { stdout: timelineOutput.stdout, stderr: timelineOutput.stderr },
      },
    );
    expect(timeline.exitCode).toBe(0);
    expect(timelineOutput.stdoutText()).toContain("phases:");
    expect(timelineOutput.stdoutText()).toContain("completed run");
  });

  it("prints compact payload details for trace events text output", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const tracePath = join(workspace, "trace.jsonl");
    await writeFile(
      tracePath,
      [
        {
          id: "evt_1",
          runId: "run_1",
          type: "model.completed",
          timestamp: "2026-01-01T00:00:00.000Z",
          sequence: 1,
          payload: {
            message: "done",
            usage: { totalTokens: 12 },
            trace: { adapterId: "openai:test-model" },
          },
        },
        {
          id: "evt_2",
          runId: "run_1",
          type: "tool.completed",
          timestamp: "2026-01-01T00:00:01.000Z",
          sequence: 2,
          payload: {
            status: "completed",
            output: { path: "README.md" },
            artifacts: [],
          },
        },
      ]
        .map((event) => `${JSON.stringify(event)}\n`)
        .join(""),
      "utf8",
    );

    const output = createOutputCapture();
    const result = await runCli(
      ["trace", "events", tracePath, "--format", "text"],
      {
        io: { stdout: output.stdout, stderr: output.stderr },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(output.stdoutText()).toContain("adapter=openai:test-model");
    expect(output.stdoutText()).toContain("tokens=12");
    expect(output.stdoutText()).toContain("path=README.md");
  });

  it("checks and summarizes a persisted session", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const runOutput = createOutputCapture();
    const run = await runCli(
      ["run", "--direct-core", "inspect", "--workspace", workspace],
      {
        io: { stdout: runOutput.stdout, stderr: runOutput.stderr },
      },
    );

    const checkOutput = createOutputCapture();
    const check = await runCli(
      ["session", "check", run.sessionId!, "--workspace", workspace],
      {
        io: { stdout: checkOutput.stdout, stderr: checkOutput.stderr },
      },
    );
    const summaryOutput = createOutputCapture();
    const summary = await runCli(
      ["session", "summary", run.sessionId!, "--workspace", workspace],
      {
        io: { stdout: summaryOutput.stdout, stderr: summaryOutput.stderr },
      },
    );

    expect(check.exitCode).toBe(0);
    expect(JSON.parse(checkOutput.stdoutText())).toMatchObject({
      ok: true,
      sessionId: run.sessionId,
    });
    expect(summary.exitCode).toBe(0);
    expect(JSON.parse(summaryOutput.stdoutText())).toMatchObject({
      sessionIds: [run.sessionId],
    });
  });

  it("repairs derived session metadata on request", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const runOutput = createOutputCapture();
    const run = await runCli(
      ["run", "--direct-core", "inspect", "--workspace", workspace],
      {
        io: { stdout: runOutput.stdout, stderr: runOutput.stderr },
      },
    );
    const sessionPath = join(
      workspace,
      ".sparkwright",
      "sessions",
      run.sessionId!,
      "session.json",
    );
    const session = JSON.parse(await readFile(sessionPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      sessionPath,
      `${JSON.stringify(
        {
          ...session,
          runIds: [],
          agents: [],
          eventCount: 999,
          updatedAt: "2000-01-01T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const output = createOutputCapture();
    const result = await runCli(
      [
        "session",
        "repair",
        run.sessionId!,
        "--workspace",
        workspace,
        "--apply",
        "--format",
        "text",
      ],
      {
        io: { stdout: output.stdout, stderr: output.stderr },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(output.stdoutText()).toContain("mode: applied");
    expect(JSON.parse(await readFile(sessionPath, "utf8"))).toMatchObject({
      runIds: expect.arrayContaining([expect.stringMatching(/^run_/)]),
      agents: ["main"],
      eventCount: 2,
      updatedAt: expect.not.stringMatching(/^2000-/),
    });
  });

  it("resumes a session with replay-derived context", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const firstOutput = createOutputCapture();
    const first = await runCli(
      ["run", "--direct-core", "inspect", "--workspace", workspace],
      {
        io: { stdout: firstOutput.stdout, stderr: firstOutput.stderr },
      },
    );
    const secondOutput = createOutputCapture();

    const second = await runCli(
      [
        "session",
        "resume",
        first.sessionId!,
        "continue inspection",
        "--workspace",
        workspace,
        "--direct-core",
      ],
      {
        io: { stdout: secondOutput.stdout, stderr: secondOutput.stderr },
      },
    );

    const session = JSON.parse(
      await readFile(
        join(
          workspace,
          ".sparkwright",
          "sessions",
          first.sessionId!,
          "session.json",
        ),
        "utf8",
      ),
    ) as { runIds: string[] };

    expect(second.exitCode).toBe(0);
    expect(second.sessionId).toBe(first.sessionId);
    expect(session.runIds).toHaveLength(2);
    expect(secondOutput.stdoutText()).toContain("run.completed");
  });

  it("resumes a session through the host by default", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const firstOutput = createOutputCapture();
    const first = await runCli(["run", "inspect", "--workspace", workspace], {
      io: {
        stdout: firstOutput.stdout,
        stderr: firstOutput.stderr,
        stdinIsTTY: false,
      },
    });
    const secondOutput = createOutputCapture();

    const second = await runCli(
      [
        "session",
        "resume",
        first.sessionId!,
        "continue inspection",
        "--workspace",
        workspace,
      ],
      {
        io: {
          stdout: secondOutput.stdout,
          stderr: secondOutput.stderr,
          stdinIsTTY: false,
        },
      },
    );

    const session = JSON.parse(
      await readFile(
        join(
          workspace,
          ".sparkwright",
          "sessions",
          first.sessionId!,
          "session.json",
        ),
        "utf8",
      ),
    ) as { runIds: string[] };

    expect(second.exitCode).toBe(0);
    expect(second.sessionId).toBe(first.sessionId);
    expect(session.runIds).toHaveLength(2);
    expect(secondOutput.stdoutText()).toContain("run.completed");
  });

  it("run resume reports a clear error when the run id cannot be found", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const output = createOutputCapture();

    const res = await runCli(
      ["run", "resume", "run_does_not_exist", "--workspace", workspace],
      {
        io: { stdout: output.stdout, stderr: output.stderr, stdinIsTTY: false },
      },
    );

    expect(res.exitCode).toBe(1);
    expect(output.stderrText()).toContain("Could not find run directory");
  });

  it("run resume defaults to the host while --direct-core bypasses it", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const brokenHostEnv = {
      ...process.env,
      SPARKWRIGHT_HOST_BIN: join(workspace, "missing-host.js"),
    };

    const hostOutput = createOutputCapture();
    const hostResume = await runCli(
      ["run", "resume", "run_does_not_exist", "--workspace", workspace],
      {
        env: brokenHostEnv,
        io: {
          stdout: hostOutput.stdout,
          stderr: hostOutput.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(hostResume.exitCode).toBe(1);
    expect(hostOutput.stderrText()).toMatch(
      /Cannot find module|transport closed/,
    );

    const directOutput = createOutputCapture();
    const directResume = await runCli(
      [
        "run",
        "resume",
        "run_does_not_exist",
        "--direct-core",
        "--workspace",
        workspace,
      ],
      {
        env: brokenHostEnv,
        io: {
          stdout: directOutput.stdout,
          stderr: directOutput.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(directResume.exitCode).toBe(1);
    expect(directOutput.stderrText()).toContain("Could not find run directory");
  });

  it("run resume through the host preserves trace level and metadata", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const sessionId = "sess_cli_resume_trace";
    const runId = "run_cli_resume_trace";
    const runDir = join(
      workspace,
      ".sparkwright",
      "sessions",
      sessionId,
      "agents",
      "main",
      "runs",
      runId,
    );
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "checkpoint.json"),
      checkpointJson({ runId, goal: "resume checkpoint" }),
      "utf8",
    );

    const output = createOutputCapture();
    const resumed = await runCli(
      [
        "run",
        "resume",
        runId,
        "--session",
        sessionId,
        "--workspace",
        workspace,
        "--model",
        "deterministic",
        "--trace-level",
        "minimal",
      ],
      {
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(resumed.exitCode).toBe(0);
    expect(resumed.sessionId).toBe(sessionId);
    expect(resumed.tracePath).toBe(
      join(workspace, ".sparkwright", "sessions", sessionId, "trace.jsonl"),
    );
    const runJson = JSON.parse(
      await readFile(join(runDir, "run.json"), "utf8"),
    ) as { metadata?: Record<string, unknown> };
    expect(runJson.metadata).toMatchObject({
      source: "cli",
      shouldWrite: false,
      traceLevel: "minimal",
      resumedFromRunId: runId,
    });

    const traceEvents = (await readFile(resumed.tracePath!, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; payload?: unknown });
    const modelCompleted = traceEvents.find(
      (event) => event.type === "model.completed",
    );
    expect(modelCompleted?.payload).toMatchObject({
      hasMessage: true,
    });
    expect(
      (modelCompleted?.payload as Record<string, unknown> | undefined)
        ?.toolCallCount,
    ).toEqual(expect.any(Number));
    expect(
      (modelCompleted?.payload as Record<string, unknown> | undefined)?.message,
    ).toBeUndefined();
    expect(
      (modelCompleted?.payload as Record<string, unknown> | undefined)
        ?.toolCalls,
    ).toBeUndefined();
  });

  it("run resume --from-trace reconstructs a checkpoint and rejects terminal runs", async () => {
    const workspace = await createWorkspace("# Demo\n");
    // Seed a completed run via the normal CLI golden path so a run.json +
    // trace.jsonl exist under .sparkwright/sessions/<sid>/agents/main/runs/<rid>/
    const seedOutput = createOutputCapture();
    const seed = await runCli(
      [
        "run",
        "--direct-core",
        "inspect",
        "--workspace",
        workspace,
        "--trace-level",
        "minimal",
      ],
      {
        io: {
          stdout: seedOutput.stdout,
          stderr: seedOutput.stderr,
          stdinIsTTY: false,
        },
      },
    );
    expect(seed.exitCode).toBe(0);

    // Extract the run id by listing the runs directory.
    const { readdir } = await import("node:fs/promises");
    const runsDir = join(
      workspace,
      ".sparkwright",
      "sessions",
      seed.sessionId!,
      "agents",
      "main",
      "runs",
    );
    const runIds = await readdir(runsDir);
    expect(runIds.length).toBeGreaterThan(0);
    const runId = runIds[0]!;

    // Without --from-trace: refuses because no checkpoint.json exists.
    const noFallbackOutput = createOutputCapture();
    const noFallback = await runCli(
      ["run", "resume", runId, "--workspace", workspace],
      {
        io: {
          stdout: noFallbackOutput.stdout,
          stderr: noFallbackOutput.stderr,
          stdinIsTTY: false,
        },
      },
    );
    expect(noFallback.exitCode).toBe(1);
    expect(noFallbackOutput.stderrText()).toContain("No checkpoint.json");

    // With --from-trace: reconstructs, then refuses because the run is terminal.
    const fallbackOutput = createOutputCapture();
    const fallback = await runCli(
      [
        "run",
        "resume",
        runId,
        "--workspace",
        workspace,
        "--from-trace",
        "--force",
      ],
      {
        io: {
          stdout: fallbackOutput.stdout,
          stderr: fallbackOutput.stderr,
          stdinIsTTY: false,
        },
      },
    );
    // resumeRunFromCheckpoint throws — runCli surfaces this as exit 1.
    expect(fallback.exitCode).toBe(1);
  });

  it("rejects unsafe CLI session ids before building paths", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const output = createOutputCapture();

    const run = await runCli(
      [
        "run",
        "--direct-core",
        "inspect",
        "--workspace",
        workspace,
        "--session-id",
        "../escape",
      ],
      {
        io: { stdout: output.stdout, stderr: output.stderr },
      },
    );
    expect(run.exitCode).toBe(1);
    expect(output.stderrText()).toContain("session id");

    const session = await runCli(
      ["session", "summary", "../escape", "--workspace", workspace],
      {
        io: { stdout: output.stdout, stderr: output.stderr },
      },
    );
    expect(session.exitCode).toBe(1);
  });

  it("runs a configured external command delegate directly", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const commandPath = join(workspace, "delegate-fixture.mjs");
    await writeFile(
      commandPath,
      [
        "const chunks = [];",
        'process.stdin.on("data", (chunk) => chunks.push(chunk));',
        'process.stdin.on("end", () => {',
        "  process.stdout.write(JSON.stringify({",
        "    argv: process.argv.slice(2),",
        '    stdin: Buffer.concat(chunks).toString("utf8")',
        "  }));",
        "});",
        "process.stdin.resume();",
        "",
      ].join("\n"),
      "utf8",
    );
    await mkdir(join(workspace, ".sparkwright"), { recursive: true });
    await writeFile(
      join(workspace, ".sparkwright", "config.json"),
      JSON.stringify(
        {
          capabilities: {
            agents: {
              profiles: [
                {
                  id: "external_cli_fixture",
                  metadata: {
                    externalCommand: {
                      command: process.execPath,
                      args: [commandPath, "--goal", "{{goal}}"],
                      input: "none",
                    },
                  },
                },
              ],
              delegateTools: [
                {
                  profileId: "external_cli_fixture",
                  toolName: "delegate_external_cli_fixture",
                },
              ],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const output = createOutputCapture();

    const result = await runCli(
      [
        "delegates",
        "run",
        "delegate_external_cli_fixture",
        "--goal",
        "inspect readme",
        "--workspace",
        workspace,
        "--yes",
        "--session-id",
        "delegate-session-test",
        "--trace-level",
        "debug",
        "--format",
        "json",
      ],
      {
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("delegate-session-test");
    expect(result.tracePath).toBe(
      join(
        workspace,
        ".sparkwright",
        "sessions",
        "delegate-session-test",
        "trace.jsonl",
      ),
    );
    expect(output.stderrText()).toContain("Approval auto-approved");
    const parsed = JSON.parse(output.stdoutText()) as {
      ok: boolean;
      protocol: string;
      sessionId: string;
      runId: string;
      tracePath: string;
      output: { exitCode: number; stdout: string };
    };
    expect(parsed).toMatchObject({
      ok: true,
      protocol: "external_command",
      sessionId: "delegate-session-test",
      output: { exitCode: 0 },
    });
    expect(JSON.parse(parsed.output.stdout)).toMatchObject({
      argv: ["--goal", "inspect readme"],
      stdin: "",
    });
    const trace = await readFile(parsed.tracePath, "utf8");
    expect(trace).toContain('"type":"approval.requested"');
    expect(trace).toContain('"type":"subagent.completed"');
  });

  async function createWorkspace(readme: string): Promise<string> {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-cli-"));
    tempDirs.push(workspace);
    await writeFile(join(workspace, "README.md"), readme, "utf8");
    return workspace;
  }
});

function createOutputCapture() {
  let stdout = "";
  let stderr = "";

  return {
    stdout: {
      write(chunk: string | Uint8Array) {
        stdout += String(chunk);
        return true;
      },
    },
    stderr: {
      write(chunk: string | Uint8Array) {
        stderr += String(chunk);
        return true;
      },
    },
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

async function readTrace(path: string | undefined): Promise<
  Array<{
    type: string;
    runId?: string;
    payload?: Record<string, unknown>;
  }>
> {
  if (!path) throw new Error("Missing trace path.");
  const content = await readFile(path, "utf8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          type: string;
          runId?: string;
          payload?: Record<string, unknown>;
        },
    );
}

async function createProviderMock(): Promise<{
  baseURL: string;
  requests: Array<{
    method: string | undefined;
    url: string | undefined;
    authorization: string;
  }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{
    method: string | undefined;
    url: string | undefined;
    authorization: string;
  }> = [];
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        authorization:
          typeof req.headers.authorization === "string"
            ? req.headers.authorization
            : "",
      });
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "mock provider rejected request",
            type: "invalid_request_error",
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function checkpointJson(input: { runId: string; goal: string }) {
  return JSON.stringify(
    {
      schemaVersion: "run-checkpoint.v1",
      run: {
        id: input.runId,
        goal: input.goal,
        state: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:30.000Z",
        metadata: { source: "seed" },
      },
      loop: {
        step: 1,
        turnCount: 0,
        context: [],
        repeatedToolCallCount: 0,
        transition: { reason: "next_turn" },
      },
      model: { activeIndex: 0, fallbackCount: 0 },
      recovery: { outputRecoveriesUsed: 0, maxOutputRecoveries: 3 },
      budget: {
        usage: {
          elapsedMs: 0,
          modelCalls: 0,
          toolCalls: 0,
          tokens: 0,
          costUsd: 0,
        },
      },
      queues: {
        commandCount: 0,
        pendingPrefetch: false,
        pendingSummary: false,
      },
      resumability: { complete: true, reasons: [] },
      createdAt: "2026-01-01T00:00:30.500Z",
      metadata: { snapshotReason: "test" },
    },
    null,
    2,
  );
}
