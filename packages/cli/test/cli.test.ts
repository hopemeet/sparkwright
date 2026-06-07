import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

describe("runCli", () => {
  let tempDirs: string[] = [];
  let prevXdg: string | undefined;

  beforeEach(async () => {
    tempDirs = [];
    // Isolate the shared config loader from any real ~/.config/sparkwright so
    // tests that rely on process.env can't pick up the developer's own config.
    prevXdg = process.env.XDG_CONFIG_HOME;
    const xdg = await mkdtemp(join(tmpdir(), "sparkwright-xdg-"));
    tempDirs.push(xdg);
    process.env.XDG_CONFIG_HOME = xdg;
  });

  afterEach(async () => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
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

    const skillPath = join(workspace, "skills", "code-reviewer", "SKILL.md");
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

  it("reports skill validation errors", async () => {
    const workspace = await createWorkspace("# Demo\n");
    await mkdir(join(workspace, "skills", "bad"), { recursive: true });
    await writeFile(
      join(workspace, "skills", "bad", "SKILL.md"),
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

async function readTrace(
  path: string | undefined,
): Promise<Array<{ type: string; runId?: string }>> {
  if (!path) throw new Error("Missing trace path.");
  const content = await readFile(path, "utf8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; runId?: string });
}
