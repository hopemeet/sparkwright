import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FileTaskStore, createTaskId } from "@sparkwright/agent-runtime";
import type { RunId } from "@sparkwright/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { createConfiguredCliTools } from "../src/runners/direct-core-runner.js";

describe("runCli", () => {
  let tempDirs: string[] = [];
  let prevXdg: string | undefined;
  let prevHostSource: string | undefined;
  let prevDirectCore: string | undefined;

  beforeEach(async () => {
    tempDirs = [];
    // Isolate the shared config loader from any real ~/.config/sparkwright so
    // tests that rely on process.env can't pick up the developer's own config.
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevHostSource = process.env.SPARKWRIGHT_HOST_SOURCE;
    prevDirectCore = process.env.SPARKWRIGHT_ENABLE_DIRECT_CORE;
    const xdg = await mkdtemp(join(tmpdir(), "sparkwright-xdg-"));
    tempDirs.push(xdg);
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.SPARKWRIGHT_HOST_SOURCE = "1";
    process.env.SPARKWRIGHT_ENABLE_DIRECT_CORE = "1";
  });

  afterEach(async () => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevHostSource === undefined)
      delete process.env.SPARKWRIGHT_HOST_SOURCE;
    else process.env.SPARKWRIGHT_HOST_SOURCE = prevHostSource;
    if (prevDirectCore === undefined)
      delete process.env.SPARKWRIGHT_ENABLE_DIRECT_CORE;
    else process.env.SPARKWRIGHT_ENABLE_DIRECT_CORE = prevDirectCore;
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
    expect(output.stdoutText()).toContain(
      "sparkwright cron list|status|run|tick",
    );
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

  it("keeps direct-core behind an internal diagnostics switch", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const output = createOutputCapture();

    const result = await runCli(
      ["run", "--direct-core", "inspect", "--workspace", workspace],
      {
        env: {
          ...process.env,
          NODE_ENV: undefined,
          SPARKWRIGHT_ENABLE_DIRECT_CORE: undefined,
        },
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(output.stderrText()).toContain("SPARKWRIGHT_ENABLE_DIRECT_CORE=1");
    expect(output.stdoutText()).not.toContain("run.started");
  });

  it("prints cron status for a stored job", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-cron-cli-"));
    tempDirs.push(root);
    const createOutput = createOutputCapture();
    const created = await runCli(
      [
        "cron",
        "create",
        "--root-dir",
        root,
        "--schedule",
        "every 1d",
        "--prompt",
        "summarize README.md",
        "--name",
        "readme-daily",
      ],
      {
        io: {
          stdout: createOutput.stdout,
          stderr: createOutput.stderr,
          stdinIsTTY: false,
        },
      },
    );
    expect(created.exitCode).toBe(0);

    const statusOutput = createOutputCapture();
    const status = await runCli(
      ["cron", "status", "readme-daily", "--root-dir", root],
      {
        io: {
          stdout: statusOutput.stdout,
          stderr: statusOutput.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(status.exitCode).toBe(0);
    const parsed = JSON.parse(statusOutput.stdoutText()) as {
      name: string;
      state: string;
      schedule: string;
      lastTracePath: string | null;
    };
    expect(parsed).toMatchObject({
      name: "readme-daily",
      state: "scheduled",
      schedule: "every 1d",
      lastTracePath: null,
    });
  });

  it("inspects durable background tasks without starting tasks", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-task-cli-"));
    tempDirs.push(root);
    const store = new FileTaskStore({ rootDir: root });
    const taskId = createTaskId();
    const record = store.create({
      id: taskId,
      parentRunId: "run_task_cli" as RunId,
      kind: "maintenance-check",
      title: "README maintenance",
      metadata: { source: "test" },
    });
    store.update(taskId, {
      status: "completed",
      startedAt: "2026-06-09T00:00:00.000Z",
      completedAt: "2026-06-09T00:00:01.000Z",
      result: { summary: "ok" },
    });
    store.appendOutput(taskId, {
      taskId,
      timestamp: "2026-06-09T00:00:00.500Z",
      channel: "stdout",
      data: "summary: ok\n",
    });

    const listOutput = createOutputCapture();
    const listed = await runCli(
      [
        "tasks",
        "list",
        "--root-dir",
        root,
        "--status",
        "completed",
        "--kind",
        "maintenance-check",
      ],
      {
        io: {
          stdout: listOutput.stdout,
          stderr: listOutput.stderr,
          stdinIsTTY: false,
        },
      },
    );
    expect(listed.exitCode).toBe(0);
    const list = JSON.parse(listOutput.stdoutText()) as {
      rootDir: string;
      tasks: Array<{ id: string; status: string; kind: string }>;
    };
    expect(list.rootDir).toBe(root);
    expect(list.tasks).toEqual([
      expect.objectContaining({
        id: record.id,
        status: "completed",
        kind: "maintenance-check",
      }),
    ]);

    const getOutput = createOutputCapture();
    const got = await runCli(["tasks", "get", taskId, "--root-dir", root], {
      io: {
        stdout: getOutput.stdout,
        stderr: getOutput.stderr,
        stdinIsTTY: false,
      },
    });
    expect(got.exitCode).toBe(0);
    expect(JSON.parse(getOutput.stdoutText())).toMatchObject({
      id: taskId,
      result: { summary: "ok" },
    });

    const outputCapture = createOutputCapture();
    const output = await runCli(
      ["tasks", "output", taskId, "--root-dir", root, "--from-sequence", "0"],
      {
        io: {
          stdout: outputCapture.stdout,
          stderr: outputCapture.stderr,
          stdinIsTTY: false,
        },
      },
    );
    expect(output.exitCode).toBe(0);
    expect(JSON.parse(outputCapture.stdoutText())).toMatchObject({
      taskId,
      chunks: [
        expect.objectContaining({
          sequence: 0,
          channel: "stdout",
          data: "summary: ok\n",
        }),
      ],
      complete: true,
      status: "completed",
    });
  });

  it("does not create the default task root during empty task inspection", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const output = createOutputCapture();

    const result = await runCli(
      ["tasks", "list", "--workspace", workspace, "--format", "text"],
      {
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(output.stdoutText()).toContain("tasks: (none)");
    await expect(
      stat(join(workspace, ".sparkwright", "tasks")),
    ).rejects.toThrow();
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

  it("rejects a missing workspace before starting a run", async () => {
    const missingWorkspace = join(
      tmpdir(),
      `sparkwright-missing-${Date.now()}`,
    );
    const output = createOutputCapture();

    const result = await runCli(
      [
        "run",
        "--direct-core",
        "inspect missing workspace",
        "--workspace",
        missingWorkspace,
      ],
      {
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(output.stderrText()).toContain("Workspace does not exist");
    expect(result.tracePath).toBeUndefined();
    expect(output.stdoutText()).not.toContain("run.started");
    expect(output.stdoutText()).not.toContain("Validation trace written to");
  });

  it("surfaces in-process delegate tools in capabilities inspect", async () => {
    const workspace = await createWorkspace("# Demo\n");
    await mkdir(join(workspace, ".sparkwright"), { recursive: true });
    await writeFile(
      join(workspace, ".sparkwright", "config.json"),
      JSON.stringify({
        capabilities: {
          agents: {
            profiles: [
              { id: "primary", name: "Primary", mode: "primary" },
              {
                id: "reviewer",
                name: "Reviewer",
                mode: "child",
                prompt: "Review files.",
                allowedTools: ["read_file"],
                maxSteps: 3,
              },
            ],
            delegateTools: [
              { profileId: "reviewer", toolName: "delegate_reviewer" },
            ],
          },
        },
      }),
      "utf8",
    );
    const output = createOutputCapture();

    const result = await runCli(
      ["capabilities", "inspect", "--workspace", workspace, "--format", "json"],
      {
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(output.stdoutText());
    const tool = (report.tools?.available ?? []).find(
      (t: { name: string }) => t.name === "delegate_reviewer",
    );
    // A real run materializes this in-process child-agent delegate as a tool,
    // so the inventory must list it (regression: it was dropped because only
    // external ACP/command delegates had a descriptor).
    expect(tool).toBeTruthy();
    expect(tool.source).toBe("delegate");
    expect(tool.origin).toBe("in_process:reviewer");
  });

  it("rejects an invalid skill name with a clear, specific message", async () => {
    const output = createOutputCapture();
    const result = await runCli(
      ["skills", "create", "my_skill", "--description", "Test. Use when X."],
      {
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );
    expect(result.exitCode).toBe(1);
    // Regression: an underscore name used to return the generic usage string,
    // which looked like the syntax was fine. Name format must be called out.
    expect(output.stderrText()).toContain('Invalid skill name "my_skill"');
    expect(output.stderrText()).toContain("kebab-case");
  });

  it("rejects an explicit missing target before starting a run", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const output = createOutputCapture();

    const result = await runCli(
      [
        "run",
        "--direct-core",
        "inspect missing target",
        "--workspace",
        workspace,
        "--target",
        "NO_SUCH_TARGET.md",
      ],
      {
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(output.stderrText()).toContain(
      "Target does not exist: NO_SUCH_TARGET.md",
    );
    expect(result.tracePath).toBeDefined();
    expect(output.stdoutText()).not.toContain("run.started");
    expect(output.stdoutText()).toContain("Validation trace written to");

    const events = await readTrace(result.tracePath);
    expect(events.map((event) => event.type)).toEqual([
      "run.created",
      "validation.failed",
      "run.failed",
    ]);
  });

  it("marks validation-only session checks as ok with warnings", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const runOutput = createOutputCapture();

    const result = await runCli(
      [
        "run",
        "--direct-core",
        "inspect outside target",
        "--workspace",
        workspace,
        "--target",
        "../outside.txt",
      ],
      {
        io: {
          stdout: runOutput.stdout,
          stderr: runOutput.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.sessionId).toBeTruthy();

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
    expect(checkOutput.stdoutText()).toContain("status: ok_with_warnings");
    expect(checkOutput.stdoutText()).toContain("SESSION_EVENTS_MISSING");
  });

  it("returns a failed exit code and clear final answer for unhandled tool failures", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-cli-"));
    tempDirs.push(workspace);
    const output = createOutputCapture();

    const result = await runCli(
      [
        "run",
        "--direct-core",
        "inspect default target",
        "--workspace",
        workspace,
        "--model",
        "deterministic",
      ],
      {
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.runState).toBe("completed");
    expect(output.stderrText()).toContain("unhandled tool failure");
    expect(output.stdoutText()).toContain("run.completed final_answer");

    const events = await readTrace(result.tracePath);
    expect(events.map((event) => event.type)).toContain("tool.failed");
    const completed = events.find((event) => event.type === "run.completed");
    expect(completed?.payload?.message).toContain("Could not read README.md");
    expect(completed?.payload?.message).not.toContain("Read README.md.");
    expect(completed?.payload?.outcome).toMatchObject({
      kind: "completed_with_tool_failures",
      toolFailures: { count: 1, codes: ["ENOENT"] },
    });
  });

  it("clarifies that --yes without --write still applies to risky non-write approvals", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const output = createOutputCapture();

    const result = await runCli(
      [
        "run",
        "--direct-core",
        "inspect temp",
        "--workspace",
        workspace,
        "--yes",
        "--model",
        "deterministic",
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
    expect(output.stderrText()).toContain(
      "Warning: --yes does not enable workspace writes without --write; it can still approve other risky actions.",
    );
    expect(output.stdoutText()).toContain("run.completed final_answer");
  });

  it("does not warn that --yes-shell-safe is ineffective without --write", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const output = createOutputCapture();

    const result = await runCli(
      [
        "run",
        "--direct-core",
        "inspect temp",
        "--workspace",
        workspace,
        "--yes-shell-safe",
        "--model",
        "deterministic",
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
    expect(output.stderrText()).not.toContain("has no effect without --write");
    expect(output.stdoutText()).toContain("run.completed final_answer");
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
        "standard",
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

  it("writes host run sessions under --session-root", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const sessionRoot = await mkdtemp(join(tmpdir(), "sparkwright-sessions-"));
    tempDirs.push(sessionRoot);
    const output = createOutputCapture();

    const result = await runCli(
      [
        "run",
        "inspect temp",
        "--workspace",
        workspace,
        "--session-root",
        sessionRoot,
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
    expect(result.sessionId).toBeTruthy();
    expect(result.tracePath).toBe(
      join(sessionRoot, result.sessionId!, "trace.jsonl"),
    );
    await expect(
      readFile(join(sessionRoot, result.sessionId!, "session.json"), "utf8"),
    ).resolves.toContain(result.sessionId!);
    await expect(
      stat(join(workspace, ".sparkwright", "sessions")),
    ).rejects.toThrow();
  });

  it("denies non-interactive writes and leaves the workspace unchanged", async () => {
    const workspace = await createWorkspace("# Demo\n");
    await enableWorkspaceTools(workspace, ["read_file", "edit_anchored_text"]);
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
    expect(output.stderrText()).toContain(
      "Run completed with 1 denied workspace write; requested mutation was not applied.",
    );
    // A denied workspace write is expected-by-policy, not a failure: the label
    // matches the (0) exit code and the denial is surfaced via the stderr
    // advisory above (see PR #22 / run-outcome-consistency.test.ts).
    expect(output.stdoutText()).toContain("Run completed (");
    expect(output.stdoutText()).not.toContain("Run completed_with_issues");

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
    await enableWorkspaceTools(workspace, ["read_file", "edit_anchored_text"]);
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
    await enableWorkspaceTools(workspace, ["read_file", "edit_anchored_text"]);
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
    await enableWorkspaceTools(workspace, ["read_file", "edit_anchored_text"]);
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
        env: {
          XDG_CONFIG_HOME: workspace,
          SPARKWRIGHT_ENABLE_DIRECT_CORE: "1",
        },
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
        env: {
          XDG_CONFIG_HOME: workspace,
          OPENAI_API_KEY: "sk-x",
          SPARKWRIGHT_ENABLE_DIRECT_CORE: "1",
        },
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
      identity?: {
        model?: string;
        providers?: Record<string, { apiKey?: string }>;
      };
    };
    expect(parsed.identity?.model).toBe("openai/gpt-5.4-mini");
    expect(parsed.identity?.providers?.openai?.apiKey).toBe(
      "REPLACE_WITH_YOUR_API_KEY",
    );
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
      policy?: { permissionMode?: string; write?: { maxFiles?: number } };
      tools?: { disabled?: string[]; defer?: string[]; enabled?: string[] };
      capabilities?: {
        tools?: { disabled?: string[]; defer?: string[]; enabled?: string[] };
        skills?: {
          roots?: string[];
          includeLoaderTool?: boolean;
          loadSelectedSkills?: boolean;
          resourceFileLimit?: number;
        };
        mcp?: {
          servers?: unknown[];
          startup?: string;
          toolSchemaLoad?: string;
        };
      };
    };
    expect(parsed.policy?.permissionMode).toBe("default");
    expect(parsed.policy?.write?.maxFiles).toBe(1);
    expect(parsed.tools?.disabled).toBeUndefined();
    expect(parsed.tools?.defer).toEqual([
      "todo_write",
      "read_anchored_text",
      "edit_anchored_text",
      "create_skill",
      "create_agent",
      "cron",
    ]);
    expect(parsed.tools?.enabled).toBeUndefined();
    expect(parsed.capabilities?.tools).toBeUndefined();
    expect(parsed.capabilities?.skills?.includeLoaderTool).toBe(true);
    expect(parsed.capabilities?.skills?.loadSelectedSkills).toBe(false);
    expect(parsed.capabilities?.skills?.resourceFileLimit).toBe(8);
    expect(parsed.capabilities?.skills?.roots).toBeUndefined();
    expect(parsed.capabilities?.mcp?.servers).toEqual([]);
    expect(parsed.capabilities?.mcp?.startup).toBe("lazy");
    expect(parsed.capabilities?.mcp?.toolSchemaLoad).toBe("defer");
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

  it("config validate reports loader errors and exits non-zero", async () => {
    const workspace = await createWorkspace("# Demo\n");
    await mkdir(join(workspace, ".sparkwright"), { recursive: true });
    await writeFile(
      join(workspace, ".sparkwright", "config.json"),
      JSON.stringify({ policy: { permissionMode: "nope" } }),
      "utf8",
    );

    const bad = createOutputCapture();
    const badResult = await runCli(
      ["config", "validate", "--workspace", workspace, "--format", "text"],
      { io: { stdout: bad.stdout, stderr: bad.stderr } },
    );
    expect(badResult.exitCode).toBe(1);
    expect(bad.stdoutText()).toContain("permissionMode");

    await writeFile(
      join(workspace, ".sparkwright", "config.json"),
      JSON.stringify({ policy: { permissionMode: "plan" } }),
      "utf8",
    );
    const good = createOutputCapture();
    const goodResult = await runCli(
      ["config", "validate", "--workspace", workspace, "--format", "text"],
      { io: { stdout: good.stdout, stderr: good.stderr } },
    );
    expect(goodResult.exitCode).toBe(0);
    expect(good.stdoutText()).toContain("Config OK");
  });

  it("config inspect and explain report effective config without leaking secrets", async () => {
    const workspace = await createWorkspace("# Demo\n");
    await mkdir(join(workspace, ".sparkwright"), { recursive: true });
    await writeFile(
      join(workspace, ".sparkwright", "config.json"),
      JSON.stringify({
        identity: {
          model: "openai/gpt-5.4-mini",
          providers: {
            openai: {
              apiKey: "sk-secret",
              models: { "gpt-5.4-mini": {} },
            },
          },
        },
        tools: { defer: ["todo_write"] },
      }),
      "utf8",
    );

    const inspect = createOutputCapture();
    const inspectResult = await runCli(
      ["config", "inspect", "--workspace", workspace, "--format", "json"],
      { io: { stdout: inspect.stdout, stderr: inspect.stderr } },
    );
    expect(inspectResult.exitCode).toBe(0);
    expect(inspect.stdoutText()).not.toContain("sk-secret");
    const report = JSON.parse(inspect.stdoutText()) as {
      ok: boolean;
      config: { providers?: { openai?: { apiKey?: string } } };
      sources: { model?: string; tools?: string };
    };
    expect(report.ok).toBe(true);
    expect(report.config.providers?.openai?.apiKey).toBe("<redacted>");
    expect(report.sources.model).toContain(join(".sparkwright", "config.json"));
    expect(report.sources.tools).toContain(join(".sparkwright", "config.json"));

    const explain = createOutputCapture();
    const explainResult = await runCli(
      ["config", "explain", "--workspace", workspace, "--format", "text"],
      { io: { stdout: explain.stdout, stderr: explain.stderr } },
    );
    expect(explainResult.exitCode).toBe(0);
    expect(explain.stdoutText()).toContain("model:");
    expect(explain.stdoutText()).toContain("tools:");
    expect(explain.stdoutText()).not.toContain("sk-secret");
  });

  it("prints a first-run config hint for interactive runs", async () => {
    const workspace = await createWorkspace("");
    const output = createOutputCapture();

    const result = await runCli(["run", "hello", "--workspace", workspace], {
      io: {
        stdout: output.stdout,
        stderr: output.stderr,
        stdinIsTTY: true,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(output.stderrText()).toContain("No Sparkwright config found yet");
    expect(output.stderrText()).toContain("sparkwright init");
  });

  it("config example prints a paste-ready grouped snippet", async () => {
    const out = createOutputCapture();
    const result = await runCli(["config", "example", "write"], {
      io: { stdout: out.stdout, stderr: out.stderr },
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdoutText()) as {
      policy?: { write?: { maxFiles?: number } };
    };
    expect(parsed.policy?.write?.maxFiles).toBe(1);
  });

  it("rejects removed tools list command", async () => {
    const output = createOutputCapture();

    const result = await runCli(["tools", "list", "--format", "text"], {
      io: { stdout: output.stdout, stderr: output.stderr },
    });

    expect(result.exitCode).toBe(1);
    expect(output.stderrText()).toContain(
      "Usage: sparkwright tools <disable|defer>",
    );
    expect(output.stdoutText()).toBe("");
  });

  it("exposes catalog-backed diagnostic tools in direct-core CLI runs", async () => {
    const workspace = await createWorkspace("# Demo\n");

    const tools = await createConfiguredCliTools(workspace, process.env);

    expect(tools.map((tool) => tool.name)).toEqual([
      "read_file",
      "glob",
      "grep",
      "list_dir",
      "read_anchored_text",
      "edit_anchored_text",
      "apply_patch",
      "tool_search",
    ]);
  });

  it("applies tool config to direct-core diagnostic tools", async () => {
    const workspace = await createWorkspace("# Demo\n");
    await mkdir(join(workspace, ".sparkwright"), { recursive: true });
    await writeFile(
      join(workspace, ".sparkwright", "config.json"),
      JSON.stringify({
        tools: { disabled: ["grep"] },
      }),
      "utf8",
    );

    const tools = await createConfiguredCliTools(workspace, process.env);

    expect(tools.map((tool) => tool.name)).toEqual([
      "read_file",
      "glob",
      "list_dir",
      "read_anchored_text",
      "edit_anchored_text",
      "apply_patch",
      "tool_search",
    ]);
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
        tools: { disabled: ["shell"], defer: ["read_anchored_text"] },
        capabilities: {
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
      "tools: disabled=shell; defer=read_anchored_text",
    );
    expect(textOutput.stdoutText()).toContain(
      "shell sandbox: mode=warn; effective=",
    );
    expect(textOutput.stdoutText()).toContain("network=deny");
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
      tools: {
        disabled?: string[];
        defer?: string[];
        available: Array<{ name: string; origin?: string }>;
      };
      shell: {
        sandbox: {
          mode: string;
          runtimeId: string;
          available: boolean;
          networkMode: string;
          filesystemIsolation: string;
          effective: string;
        };
      };
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
    expect(report.shell.sandbox).toMatchObject({
      mode: "warn",
      runtimeId: expect.any(String),
      available: expect.any(Boolean),
      networkMode: "deny",
      filesystemIsolation: expect.stringMatching(
        /^(bind-allowlist|deny-list-guard|unsupported)$/,
      ),
      effective: expect.stringMatching(/^(on|fallback)$/),
    });
    expect(report.tools.disabled).toEqual(["shell"]);
    expect(report.tools.defer).toEqual(["read_anchored_text"]);
    expect(report.tools.available.map((tool) => tool.name)).not.toContain(
      "shell",
    );
    expect(
      report.tools.available.find((tool) => tool.name === "read_file"),
    ).toMatchObject({
      origin: "local:@sparkwright/coding-tools",
    });
    expect(report.tools.available.map((tool) => tool.name)).not.toContain(
      "append_file",
    );
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
      {
        name: "docs",
        type: "http",
        enabled: true,
        startup: "lazy",
        toolSchemaLoad: "defer",
      },
    ]);
    expect(report.cron.stateRoot).toBe(join(stateHome, "sparkwright", "cron"));
    expect(report.command.dirs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ layer: "project", exists: true }),
      ]),
    );
  });

  it("shows the default tool set in capability inspect", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const output = createOutputCapture();

    const result = await runCli(
      ["capabilities", "inspect", "--workspace", workspace, "--format", "text"],
      {
        io: { stdout: output.stdout, stderr: output.stderr },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(output.stdoutText()).toContain(
      "tools: disabled=(none); defer=(none)",
    );
    expect(output.stdoutText()).toContain("runtime tools:");
    expect(output.stdoutText()).toContain("tool: list_dir");
    expect(output.stdoutText()).toContain("diagnostic tools:");
    expect(output.stdoutText()).toContain("tool: shell");
    expect(output.stdoutText()).toContain("tool: read_file");
    expect(output.stdoutText()).toContain("tool: list_skills");
    // append_file was retired in favor of edit_anchored_text / apply_patch.
    expect(output.stdoutText()).not.toContain("tool: append_file");
  });

  it("resolves MCP tools during capability inspect only when requested", async () => {
    const workspace = await createWorkspace("# Demo\n");
    await mkdir(join(workspace, ".sparkwright"), { recursive: true });
    await writeFile(
      join(workspace, ".sparkwright", "config.json"),
      JSON.stringify({
        capabilities: {
          mcp: {
            namePrefix: "mcp",
            servers: [mcpEchoServerConfig("qa")],
            defaultPolicy: { risk: "safe", requiresApproval: false },
          },
        },
      }),
      "utf8",
    );

    const staticOutput = createOutputCapture();
    const staticInspect = await runCli(
      ["capabilities", "inspect", "--workspace", workspace, "--format", "json"],
      {
        io: { stdout: staticOutput.stdout, stderr: staticOutput.stderr },
      },
    );

    expect(staticInspect.exitCode).toBe(0);
    const staticReport = JSON.parse(staticOutput.stdoutText()) as {
      tools: {
        available: Array<{
          name: string;
          source: string;
          risk?: string;
          origin?: string;
        }>;
      };
      mcp: { servers: Array<{ status?: string; tools?: unknown[] }> };
    };
    expect(staticReport.tools.available).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "shell", risk: "risky" }),
        expect.objectContaining({ name: "spawn_agent", risk: "safe" }),
        expect.objectContaining({ name: "todo_write", risk: "safe" }),
        expect.objectContaining({ name: "read_anchored_text", risk: "safe" }),
        expect.objectContaining({ name: "edit_anchored_text", risk: "safe" }),
      ]),
    );
    expect(staticReport.mcp.servers[0]?.status).toBeUndefined();
    expect(staticReport.mcp.servers[0]?.tools).toBeUndefined();

    const resolvedOutput = createOutputCapture();
    const resolvedInspect = await runCli(
      [
        "capabilities",
        "inspect",
        "--workspace",
        workspace,
        "--resolve-mcp",
        "--format",
        "json",
      ],
      {
        io: { stdout: resolvedOutput.stdout, stderr: resolvedOutput.stderr },
      },
    );

    expect(resolvedInspect.exitCode).toBe(0);
    const resolvedReport = JSON.parse(resolvedOutput.stdoutText()) as {
      mcp: {
        resolved?: boolean;
        servers: Array<{
          status?: string;
          toolCount?: number;
          tools?: Array<{ toolName: string; mcpToolName: string }>;
        }>;
      };
    };
    expect(resolvedReport.mcp.resolved).toBe(true);
    expect(resolvedReport.mcp.servers[0]).toMatchObject({
      status: "connected",
      toolCount: 1,
      tools: [{ toolName: "mcp_qa_echo", mcpToolName: "echo" }],
    });
  });

  it("capabilities inspect rejects an invalid workspace", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const missingWorkspace = join(workspace, "missing");
    const output = createOutputCapture();

    const result = await runCli(
      ["capabilities", "inspect", "--workspace", missingWorkspace],
      {
        io: { stdout: output.stdout, stderr: output.stderr, stdinIsTTY: false },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(output.stderrText()).toContain(
      "Workspace does not exist or is not accessible",
    );
    expect(output.stdoutText()).toBe("");
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
        },
        tools: { disabled: ["shell"] },
      }),
      "utf8",
    );

    for (const argv of [
      ["tools", "disable", "read_file"],
      ["tools", "defer", "todo_write"],
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
      };
      tools?: {
        disabled?: string[];
        defer?: string[];
      };
    };
    expect(parsed.model).toBe("deterministic/demo");
    expect(parsed.capabilities?.skills?.roots).toEqual(["./skills"]);
    expect(parsed.tools).toEqual({
      disabled: ["shell", "read_file"],
      defer: ["todo_write"],
    });
    if (process.platform !== "win32") {
      const mode = (await stat(configPath)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("updates workspace tool config when --workspace is explicit", async () => {
    const xdg = process.env.XDG_CONFIG_HOME as string;
    const workspace = await createWorkspace("# Demo\n");
    const userConfigPath = join(xdg, "sparkwright", "config.json");
    const projectConfigPath = join(workspace, ".sparkwright", "config.json");

    await mkdir(join(workspace, ".sparkwright"), { recursive: true });
    await writeFile(
      projectConfigPath,
      JSON.stringify({
        capabilities: {
          skills: { roots: ["skills"] },
        },
        tools: { disabled: ["shell"] },
      }),
      "utf8",
    );

    const output = createOutputCapture();
    const result = await runCli(
      [
        "tools",
        "defer",
        "todo_write",
        "--workspace",
        workspace,
        "--format",
        "text",
      ],
      {
        io: { stdout: output.stdout, stderr: output.stderr },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(output.stdoutText()).toContain(projectConfigPath);
    await expect(stat(userConfigPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const parsed = JSON.parse(await readFile(projectConfigPath, "utf8")) as {
      capabilities?: {
        skills?: { roots?: string[] };
      };
      tools?: { disabled?: string[]; defer?: string[] };
    };
    expect(parsed.capabilities?.skills?.roots).toEqual(["skills"]);
    expect(parsed.tools).toEqual({
      disabled: ["shell"],
      defer: ["todo_write"],
    });
  });

  it("rejects wildcard defer patterns in new tool config commands", async () => {
    const output = createOutputCapture();

    const result = await runCli(["tools", "defer", "mcp_*"], {
      io: { stdout: output.stdout, stderr: output.stderr },
    });

    expect(result.exitCode).toBe(1);
    expect(output.stderrText()).toContain(
      "configure MCP schema loading with capabilities.mcp.toolSchemaLoad",
    );
    expect(output.stdoutText()).toBe("");
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

  it("reports read-only skill stats from recent session traces", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const skillDir = join(workspace, ".sparkwright", "skills", "code-reviewer");
    await mkdir(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    await writeFile(
      skillPath,
      [
        "---",
        "name: code-reviewer",
        "description: Reviews code changes.",
        "---",
        "Use this skill for code review.",
        "",
      ].join("\n"),
      "utf8",
    );

    const sessionRoot = join(workspace, ".sparkwright", "sessions");
    const sessionId = "session_skill_stats";
    const runId = "run_skill_stats";
    const sessionDir = join(sessionRoot, sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "session.json"),
      JSON.stringify(
        {
          id: sessionId,
          createdAt: "2026-06-13T00:00:00.000Z",
          updatedAt: "2026-06-13T00:00:02.000Z",
          runIds: [runId],
          eventCount: 0,
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(join(sessionDir, "events.jsonl"), "", "utf8");
    await writeFile(
      join(sessionDir, "trace.jsonl"),
      [
        traceEvent(
          1,
          runId,
          "skill.indexed",
          { count: 1 },
          {
            skills: [
              {
                name: "code-reviewer",
                sourcePath: skillPath,
                contentHash: "sha256:indexed",
              },
            ],
          },
        ),
        traceEvent(
          2,
          runId,
          "skill.loaded",
          { name: "code-reviewer" },
          { mode: "on_demand_tool", contentHash: "sha256:loaded" },
        ),
        traceEvent(3, runId, "tool.failed", {
          toolName: "read_file",
          error: { code: "ENOENT", message: "missing" },
        }),
        traceEvent(4, runId, "run.completed", {
          status: "completed",
          toolOutcome: {
            unresolved: { total: 1, byCode: { ENOENT: 1 } },
            recovered: { total: 0, byCode: {} },
          },
        }),
      ].join(""),
      "utf8",
    );

    const output = createOutputCapture();
    const result = await runCli(
      [
        "skills",
        "stats",
        "--workspace",
        workspace,
        "--session-root",
        sessionRoot,
        "--last",
        "5",
        "--format",
        "json",
      ],
      {
        io: { stdout: output.stdout, stderr: output.stderr },
      },
    );

    expect(result.exitCode).toBe(0);
    const stats = JSON.parse(output.stdoutText()) as {
      sessionsScanned: number;
      tracesScanned: number;
      skills: Array<{
        name: string;
        layer?: string;
        indexedCount: number;
        loadedCount: number;
        explicitLoadCount: number;
        runIds: string[];
        sessionIds: string[];
        associatedRuns: { completed: number };
        associatedToolFailures: {
          total: number;
          unresolved: number;
          byTool: Record<string, number>;
        };
      }>;
    };
    expect(stats.sessionsScanned).toBe(1);
    expect(stats.tracesScanned).toBe(1);
    expect(stats.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "code-reviewer",
          layer: "project",
          indexedCount: 1,
          loadedCount: 1,
          explicitLoadCount: 1,
          runIds: [runId],
          sessionIds: [sessionId],
          associatedRuns: expect.objectContaining({ completed: 1 }),
          associatedToolFailures: {
            total: 1,
            unresolved: 1,
            byTool: { read_file: 1 },
          },
        }),
      ]),
    );

    const textOutput = createOutputCapture();
    const text = await runCli(
      [
        "skills",
        "stats",
        "--workspace",
        workspace,
        "--session-root",
        sessionRoot,
        "--skill",
        "code-reviewer",
        "--format",
        "text",
      ],
      {
        io: { stdout: textOutput.stdout, stderr: textOutput.stderr },
      },
    );
    expect(text.exitCode).toBe(0);
    expect(textOutput.stdoutText()).toContain("- code-reviewer (project)");
    expect(textOutput.stdoutText()).toContain("failed tools: read_file=1");
    expect(textOutput.stdoutText()).toContain("not causal claims");
  });

  it("doctors skills with package hashes and deterministic blockers", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const skillDir = join(workspace, ".sparkwright", "skills", "code-reviewer");
    await mkdir(join(skillDir, "references"), { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: code-reviewer",
        "description: Reviews code changes.",
        "---",
        "Review carefully.",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(skillDir, "references", "guide.md"), "guide\n");

    const output = createOutputCapture();
    const result = await runCli(
      ["skills", "doctor", "--workspace", workspace, "--format", "json"],
      {
        io: { stdout: output.stdout, stderr: output.stderr },
      },
    );

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(output.stdoutText()) as {
      status: string;
      blockerCount: number;
      skills: Array<{ name: string; packageHash?: string }>;
    };
    expect(report.status).toBe("ok");
    expect(report.blockerCount).toBe(0);
    expect(report.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "code-reviewer",
          packageHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        }),
      ]),
    );

    const badWorkspace = await createWorkspace("# Demo\n");
    const badSkillDir = join(badWorkspace, ".sparkwright", "skills", "bad");
    await mkdir(badSkillDir, { recursive: true });
    await writeFile(
      join(badSkillDir, "SKILL.md"),
      ["---", "name: bad", "description: Bad skill.", "---", "Bad.", ""].join(
        "\n",
      ),
      "utf8",
    );
    await writeFile(join(badSkillDir, "references"), "not a directory\n");

    const badOutput = createOutputCapture();
    const bad = await runCli(
      ["skills", "doctor", "--workspace", badWorkspace, "--format", "text"],
      {
        io: { stdout: badOutput.stdout, stderr: badOutput.stderr },
      },
    );

    expect(bad.exitCode).toBe(1);
    expect(badOutput.stdoutText()).toContain("status: blocked");
    expect(badOutput.stdoutText()).toContain("SKILL_PACKAGE_INVALID");
    expect(badOutput.stdoutText()).toContain(
      "Skill package entry must be a directory: references",
    );
  });

  it("creates, lists, shows, and applies skill proposals", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const createOutput = createOutputCapture();

    const created = await runCli(
      [
        "skills",
        "proposals",
        "create",
        "code-reviewer",
        "--description",
        "Reviews code changes for risk.",
        "--workspace",
        workspace,
        "--format",
        "json",
      ],
      {
        io: { stdout: createOutput.stdout, stderr: createOutput.stderr },
      },
    );

    expect(created.exitCode).toBe(0);
    const proposal = JSON.parse(createOutput.stdoutText()) as {
      id: string;
      state: string;
      kind: string;
      skillName: string;
      path: string;
      afterPackageHash: string;
    };
    expect(proposal).toMatchObject({
      state: "draft",
      kind: "create",
      skillName: "code-reviewer",
    });
    expect(proposal.id).toMatch(/^skillprop_/);
    expect(proposal.afterPackageHash).toMatch(/^sha256:[a-f0-9]{64}$/);

    await expect(
      access(
        join(workspace, ".sparkwright", "skills", "code-reviewer", "SKILL.md"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(
        join(proposal.path, "after", "code-reviewer", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toContain("name: code-reviewer");

    const listOutput = createOutputCapture();
    const listed = await runCli(
      [
        "skills",
        "proposals",
        "list",
        "--workspace",
        workspace,
        "--format",
        "json",
      ],
      {
        io: { stdout: listOutput.stdout, stderr: listOutput.stderr },
      },
    );
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listOutput.stdoutText())).toEqual([
      expect.objectContaining({
        id: proposal.id,
        kind: "create",
        state: "draft",
        skillName: "code-reviewer",
      }),
    ]);

    const showOutput = createOutputCapture();
    const shown = await runCli(
      [
        "skills",
        "proposals",
        "show",
        proposal.id,
        "--workspace",
        workspace,
        "--format",
        "text",
      ],
      {
        io: { stdout: showOutput.stdout, stderr: showOutput.stderr },
      },
    );
    expect(shown.exitCode).toBe(0);
    expect(showOutput.stdoutText()).toContain(`id: ${proposal.id}`);
    expect(showOutput.stdoutText()).toContain("Skill: code-reviewer");
    expect(showOutput.stdoutText()).toContain("patch:");

    const applyOutput = createOutputCapture();
    const applied = await runCli(
      [
        "skills",
        "proposals",
        "apply",
        proposal.id,
        "--workspace",
        workspace,
        "--format",
        "json",
      ],
      {
        io: { stdout: applyOutput.stdout, stderr: applyOutput.stderr },
      },
    );
    expect(applied.exitCode).toBe(0);
    const applyResult = JSON.parse(applyOutput.stdoutText()) as {
      proposal: { id: string; state: string };
      history: { id: string; proposalId: string; afterPackageHash: string };
      doctor: { status: string };
    };
    expect(applyResult.proposal).toMatchObject({
      id: proposal.id,
      state: "applied",
    });
    expect(applyResult.history).toMatchObject({
      proposalId: proposal.id,
      afterPackageHash: proposal.afterPackageHash,
    });
    expect(applyResult.doctor.status).toBe("ok");
    await expect(
      readFile(
        join(workspace, ".sparkwright", "skills", "code-reviewer", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toContain("name: code-reviewer");

    const historyOutput = createOutputCapture();
    const history = await runCli(
      [
        "skills",
        "history",
        "code-reviewer",
        "--workspace",
        workspace,
        "--format",
        "json",
      ],
      {
        io: { stdout: historyOutput.stdout, stderr: historyOutput.stderr },
      },
    );
    expect(history.exitCode).toBe(0);
    expect(JSON.parse(historyOutput.stdoutText())).toEqual([
      expect.objectContaining({
        id: applyResult.history.id,
        proposalId: proposal.id,
        skillName: "code-reviewer",
      }),
    ]);

    const historyShowOutput = createOutputCapture();
    const historyShown = await runCli(
      [
        "skills",
        "history",
        "show",
        "code-reviewer",
        applyResult.history.id,
        "--workspace",
        workspace,
        "--format",
        "json",
      ],
      {
        io: {
          stdout: historyShowOutput.stdout,
          stderr: historyShowOutput.stderr,
        },
      },
    );
    expect(historyShown.exitCode).toBe(0);
    expect(JSON.parse(historyShowOutput.stdoutText())).toMatchObject({
      id: applyResult.history.id,
      proposalId: proposal.id,
      skillName: "code-reviewer",
      patchDiff: expect.stringContaining("+name: code-reviewer"),
    });

    const historyDiffOutput = createOutputCapture();
    const historyDiffed = await runCli(
      [
        "skills",
        "history",
        "diff",
        "code-reviewer",
        applyResult.history.id,
        "--workspace",
        workspace,
        "--format",
        "text",
      ],
      {
        io: {
          stdout: historyDiffOutput.stdout,
          stderr: historyDiffOutput.stderr,
        },
      },
    );
    expect(historyDiffed.exitCode).toBe(0);
    expect(historyDiffOutput.stdoutText()).toContain("diff --git");
    expect(historyDiffOutput.stdoutText()).toContain("+name: code-reviewer");

    const reappliedOutput = createOutputCapture();
    const reapplied = await runCli(
      ["skills", "proposals", "apply", proposal.id, "--workspace", workspace],
      {
        io: { stdout: reappliedOutput.stdout, stderr: reappliedOutput.stderr },
      },
    );
    expect(reapplied.exitCode).toBe(1);
    expect(reappliedOutput.stderrText()).toContain("not draft");
  });

  it("rejects and supersedes skill proposals without applying them", async () => {
    const workspace = await createWorkspace("# Demo\n");

    const rejectedCreateOutput = createOutputCapture();
    const rejectedCreated = await runCli(
      [
        "skills",
        "proposals",
        "create",
        "quick-note",
        "--description",
        "capture short project notes",
        "--workspace",
        workspace,
        "--format",
        "json",
      ],
      {
        io: {
          stdout: rejectedCreateOutput.stdout,
          stderr: rejectedCreateOutput.stderr,
        },
      },
    );
    expect(rejectedCreated.exitCode).toBe(0);
    const rejectedProposal = JSON.parse(rejectedCreateOutput.stdoutText()) as {
      id: string;
    };

    const rejectOutput = createOutputCapture();
    const rejected = await runCli(
      [
        "skills",
        "proposals",
        "reject",
        rejectedProposal.id,
        "--reason",
        "Too broad.",
        "--workspace",
        workspace,
        "--format",
        "json",
      ],
      {
        io: { stdout: rejectOutput.stdout, stderr: rejectOutput.stderr },
      },
    );
    expect(rejected.exitCode).toBe(0);
    expect(JSON.parse(rejectOutput.stdoutText())).toMatchObject({
      id: rejectedProposal.id,
      state: "rejected",
      statusReason: "Too broad.",
    });

    const rejectedApplyOutput = createOutputCapture();
    const rejectedApply = await runCli(
      [
        "skills",
        "proposals",
        "apply",
        rejectedProposal.id,
        "--workspace",
        workspace,
      ],
      {
        io: {
          stdout: rejectedApplyOutput.stdout,
          stderr: rejectedApplyOutput.stderr,
        },
      },
    );
    expect(rejectedApply.exitCode).toBe(1);
    expect(rejectedApplyOutput.stderrText()).toContain("not draft");
    await expect(
      access(join(workspace, ".sparkwright", "skills", "quick-note")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const firstOutput = createOutputCapture();
    const firstCreated = await runCli(
      [
        "skills",
        "proposals",
        "create",
        "daily-review",
        "--description",
        "review daily work",
        "--workspace",
        workspace,
        "--format",
        "json",
      ],
      {
        io: { stdout: firstOutput.stdout, stderr: firstOutput.stderr },
      },
    );
    expect(firstCreated.exitCode).toBe(0);
    const first = JSON.parse(firstOutput.stdoutText()) as { id: string };

    const secondOutput = createOutputCapture();
    const secondCreated = await runCli(
      [
        "skills",
        "proposals",
        "create",
        "daily-review",
        "--description",
        "review daily work with clearer next actions",
        "--workspace",
        workspace,
        "--format",
        "json",
      ],
      {
        io: { stdout: secondOutput.stdout, stderr: secondOutput.stderr },
      },
    );
    expect(secondCreated.exitCode).toBe(0);
    const second = JSON.parse(secondOutput.stdoutText()) as { id: string };

    const supersedeOutput = createOutputCapture();
    const superseded = await runCli(
      [
        "skills",
        "proposals",
        "supersede",
        first.id,
        "--by",
        second.id,
        "--reason",
        "Replaced with clearer wording.",
        "--workspace",
        workspace,
        "--format",
        "json",
      ],
      {
        io: { stdout: supersedeOutput.stdout, stderr: supersedeOutput.stderr },
      },
    );
    expect(superseded.exitCode).toBe(0);
    expect(JSON.parse(supersedeOutput.stdoutText())).toMatchObject({
      id: first.id,
      state: "superseded",
      supersededBy: second.id,
      statusReason: "Replaced with clearer wording.",
    });

    const listOutput = createOutputCapture();
    const listed = await runCli(
      [
        "skills",
        "proposals",
        "list",
        "--workspace",
        workspace,
        "--format",
        "json",
      ],
      {
        io: { stdout: listOutput.stdout, stderr: listOutput.stderr },
      },
    );
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listOutput.stdoutText())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.id,
          state: "superseded",
          supersededBy: second.id,
        }),
        expect.objectContaining({
          id: second.id,
          state: "draft",
        }),
      ]),
    );
  });

  it("prunes closed skill proposals only when applied", async () => {
    const workspace = await createWorkspace("# Demo\n");

    async function createProposal(name: string, description: string) {
      const output = createOutputCapture();
      const result = await runCli(
        [
          "skills",
          "proposals",
          "create",
          name,
          "--description",
          description,
          "--workspace",
          workspace,
          "--format",
          "json",
        ],
        {
          io: { stdout: output.stdout, stderr: output.stderr },
        },
      );
      expect(result.exitCode).toBe(0);
      return JSON.parse(output.stdoutText()) as { id: string; path: string };
    }

    const rejected = await createProposal("cleanup-note", "capture notes");
    const superseded = await createProposal("cleanup-review", "review work");
    const replacement = await createProposal(
      "cleanup-review",
      "review work with sharper actions",
    );

    const rejectOutput = createOutputCapture();
    expect(
      (
        await runCli(
          [
            "skills",
            "proposals",
            "reject",
            rejected.id,
            "--reason",
            "No longer needed.",
            "--workspace",
            workspace,
            "--format",
            "json",
          ],
          {
            io: { stdout: rejectOutput.stdout, stderr: rejectOutput.stderr },
          },
        )
      ).exitCode,
    ).toBe(0);

    const supersedeOutput = createOutputCapture();
    expect(
      (
        await runCli(
          [
            "skills",
            "proposals",
            "supersede",
            superseded.id,
            "--by",
            replacement.id,
            "--workspace",
            workspace,
            "--format",
            "json",
          ],
          {
            io: {
              stdout: supersedeOutput.stdout,
              stderr: supersedeOutput.stderr,
            },
          },
        )
      ).exitCode,
    ).toBe(0);

    const dryRunOutput = createOutputCapture();
    const dryRun = await runCli(
      [
        "skills",
        "proposals",
        "prune",
        "--state",
        "rejected,superseded",
        "--dry-run",
        "--workspace",
        workspace,
        "--format",
        "json",
      ],
      {
        io: { stdout: dryRunOutput.stdout, stderr: dryRunOutput.stderr },
      },
    );
    expect(dryRun.exitCode).toBe(0);
    expect(JSON.parse(dryRunOutput.stdoutText())).toMatchObject({
      applied: false,
      candidates: expect.arrayContaining([
        expect.objectContaining({ id: rejected.id, state: "rejected" }),
        expect.objectContaining({ id: superseded.id, state: "superseded" }),
      ]),
      deleted: [],
    });
    await expect(access(rejected.path)).resolves.toBeUndefined();
    await expect(access(superseded.path)).resolves.toBeUndefined();

    const appliedOutput = createOutputCapture();
    const applied = await runCli(
      [
        "skills",
        "proposals",
        "prune",
        "--state",
        "rejected,superseded",
        "--apply",
        "--workspace",
        workspace,
        "--format",
        "json",
      ],
      {
        io: { stdout: appliedOutput.stdout, stderr: appliedOutput.stderr },
      },
    );
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(appliedOutput.stdoutText())).toMatchObject({
      applied: true,
      deleted: expect.arrayContaining([
        expect.objectContaining({ id: rejected.id }),
        expect.objectContaining({ id: superseded.id }),
      ]),
    });
    await expect(access(rejected.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(superseded.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(replacement.path)).resolves.toBeUndefined();
  });

  it("updates project skills through hash-gated proposals", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const skillDir = join(workspace, ".sparkwright", "skills", "reviewer");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: reviewer",
        "description: Reviews code.",
        "---",
        "Use this skill to review code.",
        "",
      ].join("\n"),
      "utf8",
    );

    const createOutput = createOutputCapture();
    const created = await runCli(
      [
        "skills",
        "proposals",
        "update",
        "reviewer",
        "--description",
        "Prefer concise findings with tests.",
        "--workspace",
        workspace,
        "--format",
        "json",
      ],
      {
        io: { stdout: createOutput.stdout, stderr: createOutput.stderr },
      },
    );
    expect(created.exitCode).toBe(0);
    const proposal = JSON.parse(createOutput.stdoutText()) as {
      id: string;
      kind: string;
      sourceLayer: string;
      basePackageHash: string;
      afterPackageHash: string;
      path: string;
    };
    expect(proposal).toMatchObject({
      kind: "update",
      sourceLayer: "project",
    });
    expect(proposal.basePackageHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(proposal.afterPackageHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    await expect(
      readFile(join(proposal.path, "before", "reviewer", "SKILL.md"), "utf8"),
    ).resolves.toContain("Use this skill to review code.");
    await expect(
      readFile(join(proposal.path, "after", "reviewer", "SKILL.md"), "utf8"),
    ).resolves.toContain("Prefer concise findings with tests.");

    const applyOutput = createOutputCapture();
    const applied = await runCli(
      [
        "skills",
        "proposals",
        "apply",
        proposal.id,
        "--workspace",
        workspace,
        "--format",
        "json",
      ],
      {
        io: { stdout: applyOutput.stdout, stderr: applyOutput.stderr },
      },
    );
    expect(applied.exitCode).toBe(0);
    const applyResult = JSON.parse(applyOutput.stdoutText()) as {
      proposal: { state: string };
      history: { beforePackageHash: string; afterPackageHash: string };
    };
    expect(applyResult.proposal.state).toBe("applied");
    expect(applyResult.history.beforePackageHash).toBe(
      proposal.basePackageHash,
    );
    expect(applyResult.history.afterPackageHash).toBe(
      proposal.afterPackageHash,
    );
    await expect(
      readFile(join(skillDir, "SKILL.md"), "utf8"),
    ).resolves.toContain("Prefer concise findings with tests.");
  });

  it("restores project skills from history with dry-run by default", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const skillPath = join(
      workspace,
      ".sparkwright",
      "skills",
      "restorable",
      "SKILL.md",
    );

    const createOutput = createOutputCapture();
    const created = await runCli(
      [
        "skills",
        "proposals",
        "create",
        "restorable",
        "--description",
        "preserve the first version",
        "--workspace",
        workspace,
        "--format",
        "json",
      ],
      {
        io: { stdout: createOutput.stdout, stderr: createOutput.stderr },
      },
    );
    expect(created.exitCode).toBe(0);
    const createProposal = JSON.parse(createOutput.stdoutText()) as {
      id: string;
    };

    const createApplyOutput = createOutputCapture();
    const createApplied = await runCli(
      [
        "skills",
        "proposals",
        "apply",
        createProposal.id,
        "--workspace",
        workspace,
        "--format",
        "json",
      ],
      {
        io: {
          stdout: createApplyOutput.stdout,
          stderr: createApplyOutput.stderr,
        },
      },
    );
    expect(createApplied.exitCode).toBe(0);
    const initialApply = JSON.parse(createApplyOutput.stdoutText()) as {
      history: { id: string };
    };

    const updateOutput = createOutputCapture();
    const updated = await runCli(
      [
        "skills",
        "proposals",
        "update",
        "restorable",
        "--description",
        "second version marker",
        "--workspace",
        workspace,
        "--format",
        "json",
      ],
      {
        io: { stdout: updateOutput.stdout, stderr: updateOutput.stderr },
      },
    );
    expect(updated.exitCode).toBe(0);
    const updateProposal = JSON.parse(updateOutput.stdoutText()) as {
      id: string;
    };

    const updateApplyOutput = createOutputCapture();
    const updateApplied = await runCli(
      [
        "skills",
        "proposals",
        "apply",
        updateProposal.id,
        "--workspace",
        workspace,
        "--format",
        "json",
      ],
      {
        io: {
          stdout: updateApplyOutput.stdout,
          stderr: updateApplyOutput.stderr,
        },
      },
    );
    expect(updateApplied.exitCode).toBe(0);
    await expect(readFile(skillPath, "utf8")).resolves.toContain(
      "second version marker",
    );

    const dryRunOutput = createOutputCapture();
    const dryRun = await runCli(
      [
        "skills",
        "restore",
        "restorable",
        "--version",
        initialApply.history.id,
        "--dry-run",
        "--workspace",
        workspace,
        "--format",
        "json",
      ],
      {
        io: { stdout: dryRunOutput.stdout, stderr: dryRunOutput.stderr },
      },
    );
    expect(dryRun.exitCode).toBe(0);
    expect(JSON.parse(dryRunOutput.stdoutText())).toMatchObject({
      applied: false,
      skillName: "restorable",
      sourceHistory: { id: initialApply.history.id },
    });
    await expect(readFile(skillPath, "utf8")).resolves.toContain(
      "second version marker",
    );

    const restoreOutput = createOutputCapture();
    const restored = await runCli(
      [
        "skills",
        "restore",
        "restorable",
        "--version",
        initialApply.history.id,
        "--apply",
        "--workspace",
        workspace,
        "--format",
        "json",
      ],
      {
        io: { stdout: restoreOutput.stdout, stderr: restoreOutput.stderr },
      },
    );
    expect(restored.exitCode).toBe(0);
    const restoreResult = JSON.parse(restoreOutput.stdoutText()) as {
      applied: boolean;
      restoreHistory: { id: string; kind: string; sourceHistoryId: string };
      doctor: { status: string };
    };
    expect(restoreResult).toMatchObject({
      applied: true,
      restoreHistory: {
        kind: "restore",
        sourceHistoryId: initialApply.history.id,
      },
      doctor: { status: "ok" },
    });
    await expect(readFile(skillPath, "utf8")).resolves.not.toContain(
      "second version marker",
    );

    const historyOutput = createOutputCapture();
    const history = await runCli(
      [
        "skills",
        "history",
        "restorable",
        "--workspace",
        workspace,
        "--format",
        "json",
      ],
      {
        io: { stdout: historyOutput.stdout, stderr: historyOutput.stderr },
      },
    );
    expect(history.exitCode).toBe(0);
    expect(JSON.parse(historyOutput.stdoutText())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: restoreResult.restoreHistory.id,
          kind: "restore",
          sourceHistoryId: initialApply.history.id,
        }),
      ]),
    );
  });

  it("reports a friendly error when restoring an unknown history version", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const skillDir = join(workspace, ".sparkwright", "skills", "restorable");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: restorable",
        "description: Restorable skill.",
        "---",
        "Body.",
        "",
      ].join("\n"),
      "utf8",
    );

    const output = createOutputCapture();
    const result = await runCli(
      [
        "skills",
        "restore",
        "restorable",
        "--version",
        "skillver_doesnotexist",
        "--dry-run",
        "--workspace",
        workspace,
        "--format",
        "text",
      ],
      { io: { stdout: output.stdout, stderr: output.stderr } },
    );
    expect(result.exitCode).toBe(1);
    expect(output.stderrText()).toContain(
      "Skill history version not found: restorable:skillver_doesnotexist",
    );
    // the raw filesystem path must not leak in the message
    expect(output.stderrText()).not.toContain("metadata.json");
  });

  it("marks stale update proposals when the base skill changes", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const skillDir = join(workspace, ".sparkwright", "skills", "reviewer");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: reviewer",
        "description: Reviews code.",
        "---",
        "Use this skill to review code.",
        "",
      ].join("\n"),
      "utf8",
    );

    const createOutput = createOutputCapture();
    const created = await runCli(
      [
        "skills",
        "proposals",
        "update",
        "reviewer",
        "--description",
        "Prefer concise findings.",
        "--workspace",
        workspace,
        "--format",
        "json",
      ],
      {
        io: { stdout: createOutput.stdout, stderr: createOutput.stderr },
      },
    );
    expect(created.exitCode).toBe(0);
    const proposal = JSON.parse(createOutput.stdoutText()) as { id: string };

    await writeFile(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: reviewer",
        "description: Reviews code after drift.",
        "---",
        "Use this changed skill to review code.",
        "",
      ].join("\n"),
      "utf8",
    );

    const applyOutput = createOutputCapture();
    const applied = await runCli(
      ["skills", "proposals", "apply", proposal.id, "--workspace", workspace],
      {
        io: { stdout: applyOutput.stdout, stderr: applyOutput.stderr },
      },
    );
    expect(applied.exitCode).toBe(1);
    expect(applyOutput.stderrText()).toContain(
      "Project Skill changed since proposal",
    );

    const showOutput = createOutputCapture();
    const shown = await runCli(
      [
        "skills",
        "proposals",
        "show",
        proposal.id,
        "--workspace",
        workspace,
        "--format",
        "json",
      ],
      {
        io: { stdout: showOutput.stdout, stderr: showOutput.stderr },
      },
    );
    expect(shown.exitCode).toBe(0);
    expect(JSON.parse(showOutput.stdoutText())).toMatchObject({
      id: proposal.id,
      state: "stale",
    });
    await expect(
      readFile(join(skillDir, "SKILL.md"), "utf8"),
    ).resolves.toContain("Use this changed skill");
  });

  it("forks non-project skills into project update proposals", async () => {
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

    const createOutput = createOutputCapture();
    const created = await runCli(
      [
        "skills",
        "proposals",
        "update",
        "reviewer",
        "--description",
        "Project-specific review style.",
        "--workspace",
        workspace,
        "--format",
        "json",
      ],
      {
        io: { stdout: createOutput.stdout, stderr: createOutput.stderr },
      },
    );
    expect(created.exitCode).toBe(0);
    const proposal = JSON.parse(createOutput.stdoutText()) as {
      id: string;
      kind: string;
      sourceLayer: string;
      targetPath: string;
    };
    expect(proposal).toMatchObject({
      kind: "update",
      sourceLayer: "user",
      targetPath: projectSkillDir,
    });
    await expect(
      access(join(projectSkillDir, "SKILL.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const applyOutput = createOutputCapture();
    const applied = await runCli(
      [
        "skills",
        "proposals",
        "apply",
        proposal.id,
        "--workspace",
        workspace,
        "--format",
        "json",
      ],
      {
        io: { stdout: applyOutput.stdout, stderr: applyOutput.stderr },
      },
    );
    expect(applied.exitCode).toBe(0);
    await expect(
      readFile(join(projectSkillDir, "SKILL.md"), "utf8"),
    ).resolves.toContain("Project-specific review style.");
    await expect(
      readFile(join(userSkillDir, "SKILL.md"), "utf8"),
    ).resolves.toContain("Use user reviewer.");
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

  it("reports skill errors in capability inspect", async () => {
    const workspace = await createWorkspace("# Demo\n");
    await mkdir(join(workspace, ".sparkwright", "skills", "bad"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, ".sparkwright", "skills", "bad", "SKILL.md"),
      ["---", "name: bad", "---", "Missing description.", ""].join("\n"),
      "utf8",
    );
    const output = createOutputCapture();

    const result = await runCli(
      ["capabilities", "inspect", "--workspace", workspace, "--format", "json"],
      {
        io: { stdout: output.stdout, stderr: output.stderr },
      },
    );

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(output.stdoutText()) as {
      skills: { errors: Array<{ source: string; message: string }> };
    };
    expect(report.skills.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: join(workspace, ".sparkwright", "skills", "bad", "SKILL.md"),
          message: expect.stringContaining("description"),
        }),
      ]),
    );
  });

  it("reports configured missing skill roots in capability inspect", async () => {
    const workspace = await createWorkspace("# Demo\n");
    await mkdir(join(workspace, ".sparkwright"), { recursive: true });
    await writeFile(
      join(workspace, ".sparkwright", "config.json"),
      JSON.stringify({
        capabilities: { skills: { roots: ["missing-skills"] } },
      }),
      "utf8",
    );
    const output = createOutputCapture();

    const result = await runCli(
      ["capabilities", "inspect", "--workspace", workspace, "--format", "json"],
      {
        io: { stdout: output.stdout, stderr: output.stderr },
      },
    );

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(output.stdoutText()) as {
      skills: { errors: Array<{ source: string; message: string }> };
    };
    expect(report.skills.errors).toEqual([
      {
        source: join(workspace, ".sparkwright", "missing-skills"),
        message: "skill root does not exist",
      },
    ]);
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
        "glob",
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
        allowedTools: ["read_file", "glob"],
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
        env: {
          XDG_CONFIG_HOME: xdg,
          SPARKWRIGHT_ENABLE_DIRECT_CORE: "1",
        },
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

  it("writes a startup failure trace when host startup fails before the run starts", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const output = createOutputCapture();
    const missingHostCommand = join(workspace, "missing-host-command");

    const result = await runCli(
      ["run", "inspect temp", "--workspace", workspace],
      {
        env: {
          XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
          SPARKWRIGHT_HOST_COMMAND: missingHostCommand,
        },
        io: { stdout: output.stdout, stderr: output.stderr, stdinIsTTY: false },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(output.stderrText()).toContain(missingHostCommand);
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

  it("records skill load failures without aborting host startup", async () => {
    const workspace = await createWorkspace("# Demo\n");
    await mkdir(join(workspace, ".sparkwright", "skills", "bad"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, ".sparkwright", "skills", "bad", "SKILL.md"),
      ["---", "name: bad", "---", "Missing description.", ""].join("\n"),
      "utf8",
    );
    const output = createOutputCapture();

    const result = await runCli(
      [
        "run",
        "say hello",
        "--workspace",
        workspace,
        "--model",
        "deterministic",
      ],
      {
        io: { stdout: output.stdout, stderr: output.stderr, stdinIsTTY: false },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(output.stderrText()).toBe("");
    const events = await readTrace(result.tracePath);
    expect(events.map((event) => event.type)).toContain("skill.failed");
    expect(events.map((event) => event.type)).toContain("run.completed");
    expect(events.map((event) => event.type)).not.toContain(
      "capability.index.failed",
    );
    expect(
      events.find((event) => event.type === "skill.failed")?.payload,
    ).toMatchObject({
      source: join(workspace, ".sparkwright", "skills", "bad", "SKILL.md"),
    });
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
      expect(output.stderrText()).toContain("Model failed:");
      expect(output.stderrText()).toContain("status=401");
      expect(output.stderrText()).not.toContain("APICallError");
      expect(output.stderrText()).not.toContain("@ai-sdk");
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
      toolFailures: { total: number; byCode: Record<string, number> };
      workspaceReads: {
        total: number;
        uniquePaths: number;
        duplicatePaths: Record<string, number>;
      };
    };
    expect(summary.eventCount).toBeGreaterThan(0);
    expect(summary.runIds).toHaveLength(1);
    expect(summary.byType["run.completed"]).toBe(1);
    expect(summary.toolFailures.total).toBe(0);
    expect(summary.workspaceReads.total).toBeGreaterThan(0);
    expect(summary.workspaceReads.uniquePaths).toBeGreaterThan(0);

    const textOutput = createOutputCapture();
    const text = await runCli(
      ["trace", "summary", run.tracePath!, "--format", "text"],
      {
        io: { stdout: textOutput.stdout, stderr: textOutput.stderr },
      },
    );
    expect(text.exitCode).toBe(0);
    expect(textOutput.stdoutText()).toContain("events:");
    expect(textOutput.stdoutText()).toContain(
      "cost: unavailable (not reported)",
    );
    expect(textOutput.stdoutText()).toContain("tool calls:");
    expect(textOutput.stdoutText()).toContain("tool failures: 0 total");
    expect(textOutput.stdoutText()).toContain("workspace reads:");
  });

  it("prints unavailable cost reasons in text trace summaries", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const tracePath = join(workspace, "cost-unavailable.trace.jsonl");
    await writeFile(
      tracePath,
      JSON.stringify({
        id: "evt_usage",
        runId: "run_cost",
        type: "model.completed",
        timestamp: "2026-01-01T00:00:00.000Z",
        sequence: 1,
        payload: {
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            totalTokens: 12,
            costStatus: "unavailable",
            costUnavailableReason: "missing_pricing",
          },
        },
      }) + "\n",
      "utf8",
    );
    const output = createOutputCapture();

    const result = await runCli(
      ["trace", "summary", tracePath, "--format", "text"],
      {
        io: { stdout: output.stdout, stderr: output.stderr },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(output.stdoutText()).toContain(
      "cost: unavailable (missing_pricing:1)",
    );
  });

  it("prints a human trace report", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const tracePath = join(workspace, "noisy.trace.jsonl");
    const lines = [
      {
        id: "evt_1",
        runId: "run_report",
        type: "run.created",
        timestamp: "2026-01-01T00:00:00.000Z",
        sequence: 1,
        payload: { goal: "inspect" },
      },
      ...Array.from({ length: 85 }, (_, index) => ({
        id: `evt_tool_${index}`,
        runId: "run_report",
        type: "tool.requested",
        timestamp: "2026-01-01T00:00:01.000Z",
        sequence: index + 2,
        payload: {
          id: `call_${index}`,
          toolName: index % 2 === 0 ? "read_file" : "grep",
          arguments: { path: "README.md" },
        },
      })),
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `evt_read_${index}`,
        runId: "run_report",
        type: "workspace.read",
        timestamp: "2026-01-01T00:00:02.000Z",
        sequence: index + 87,
        payload: { path: "README.md" },
      })),
      {
        id: "evt_done",
        runId: "run_report",
        type: "run.completed",
        timestamp: "2026-01-01T00:00:03.000Z",
        sequence: 107,
        payload: { state: "completed" },
      },
    ];
    await writeFile(
      tracePath,
      lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
      "utf8",
    );

    const textOutput = createOutputCapture();
    const text = await runCli(
      ["trace", "report", tracePath, "--format", "text"],
      {
        io: { stdout: textOutput.stdout, stderr: textOutput.stderr },
      },
    );

    expect(text.exitCode).toBe(0);
    expect(textOutput.stdoutText()).toContain("verdict: passed_with_issues");
    expect(textOutput.stdoutText()).toContain("EXCESSIVE_TOOL_CALLS");
    expect(textOutput.stdoutText()).toContain("DUPLICATE_WORKSPACE_READS");

    const jsonOutput = createOutputCapture();
    const json = await runCli(["trace", "report", tracePath], {
      io: { stdout: jsonOutput.stdout, stderr: jsonOutput.stderr },
    });
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(jsonOutput.stdoutText())).toMatchObject({
      verdict: "passed_with_issues",
      summary: { toolCalls: 85 },
    });
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

  it("verifies trace integrity", async () => {
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
      ["trace", "verify", run.tracePath!, "--format", "text"],
      {
        io: { stdout: output.stdout, stderr: output.stderr },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(output.stdoutText()).toContain("status: ok");

    const brokenTrace = join(workspace, "broken.trace.jsonl");
    const trace = await readFile(run.tracePath!, "utf8");
    await writeFile(brokenTrace, trace.trimEnd(), "utf8");
    const brokenOutput = createOutputCapture();
    const broken = await runCli(["trace", "verify", brokenTrace], {
      io: { stdout: brokenOutput.stdout, stderr: brokenOutput.stderr },
    });

    expect(broken.exitCode).toBe(1);
    expect(JSON.parse(brokenOutput.stdoutText())).toMatchObject({
      ok: false,
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "TRACE_FINAL_NEWLINE_MISSING" }),
      ]),
    });
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
        "standard",
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
      traceLevel: "standard",
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
      message: expect.any(String),
      toolCalls: expect.any(Array),
      trace: expect.objectContaining({
        toolCallCount: expect.any(Number),
      }),
    });
  });

  it("does not start configured MCP servers in lazy startup mode", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const markerPath = join(workspace, "mcp-started.txt");
    await mkdir(join(workspace, ".sparkwright"), { recursive: true });
    await writeFile(
      join(workspace, ".sparkwright", "config.json"),
      JSON.stringify({
        capabilities: {
          mcp: {
            namePrefix: "mcp",
            servers: [
              mcpEchoServerConfig("qa", {
                prelude: [
                  "import { writeFileSync } from 'node:fs';",
                  `writeFileSync(${JSON.stringify(markerPath)}, "started", "utf8");`,
                ].join("\n"),
              }),
            ],
            defaultPolicy: { risk: "safe", requiresApproval: false },
          },
        },
      }),
      "utf8",
    );
    const output = createOutputCapture();

    const run = await runCli(
      [
        "run",
        "answer without using MCP",
        "--workspace",
        workspace,
        "--model",
        "scripted",
        "--trace-level",
        "debug",
      ],
      {
        env: {
          ...process.env,
          SPARKWRIGHT_SCRIPTED_MODEL_JSON: JSON.stringify([
            { message: "no mcp used" },
          ]),
        },
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(run.exitCode).toBe(0);
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const traceEvents = (await readFile(run.tracePath!, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string });
    expect(
      traceEvents.some((event) => event.type === "mcp.server.prepared"),
    ).toBe(false);
  });

  it("runs scripted model deferred MCP concrete-tool calls through the host", async () => {
    const workspace = await createWorkspace("# Demo\n");
    await mkdir(join(workspace, ".sparkwright"), { recursive: true });
    await writeFile(
      join(workspace, ".sparkwright", "config.json"),
      JSON.stringify({
        capabilities: {
          mcp: {
            namePrefix: "mcp",
            startup: "prepare",
            servers: [mcpEchoServerConfig("qa")],
            defaultPolicy: { risk: "safe", requiresApproval: false },
          },
        },
      }),
      "utf8",
    );
    const output = createOutputCapture();

    const run = await runCli(
      [
        "run",
        "use MCP echo",
        "--workspace",
        workspace,
        "--model",
        "scripted",
        "--trace-level",
        "debug",
      ],
      {
        env: {
          ...process.env,
          SPARKWRIGHT_SCRIPTED_MODEL_JSON: JSON.stringify([
            {
              toolCalls: [
                {
                  toolName: "tool_search",
                  arguments: { query: "select:mcp_qa_echo" },
                },
              ],
            },
            {
              toolCalls: [
                {
                  toolName: "mcp_qa_echo",
                  arguments: { text: "sparkwright cli host model smoke" },
                },
              ],
            },
            {
              message: "sparkwright cli host model smoke\nsucceeded: true",
            },
          ]),
        },
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(run.exitCode).toBe(0);
    const traceEvents = (await readFile(run.tracePath!, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; payload?: unknown });
    expect(
      traceEvents.find(
        (event) =>
          event.type === "tool.completed" &&
          (
            event.payload as {
              toolName?: string;
              output?: { matches?: unknown[] };
            }
          ).toolName === "tool_search" &&
          (event.payload as { output?: { matches?: unknown[] } }).output
            ?.matches?.length === 1,
      ),
    ).toBeTruthy();
    expect(
      traceEvents.find(
        (event) =>
          event.type === "tool.completed" &&
          (event.payload as { output?: { content?: Array<{ text?: string }> } })
            .output?.content?.[0]?.text === "sparkwright cli host model smoke",
      ),
    ).toBeTruthy();
  });

  it("applies configured workflow hooks in host runs", async () => {
    const workspace = await createWorkspace("# Demo\n");
    await mkdir(join(workspace, ".sparkwright"), { recursive: true });
    await writeFile(
      join(workspace, ".sparkwright", "config.json"),
      JSON.stringify({
        capabilities: {
          hooks: {
            workflow: [
              {
                name: "block-readme-edit",
                hook: "PreToolUse",
                matcher: {
                  toolName: "apply_patch",
                  pathGlob: "README.md",
                },
                action: {
                  type: "block",
                  reason: "README edits are locked by workflow hook.",
                },
              },
            ],
          },
        },
      }),
      "utf8",
    );
    const output = createOutputCapture();

    const run = await runCli(
      [
        "run",
        "Try to edit README.",
        "--workspace",
        workspace,
        "--model",
        "scripted",
        "--write",
        "--yes",
        "--trace-level",
        "debug",
      ],
      {
        env: {
          ...process.env,
          SPARKWRIGHT_SCRIPTED_MODEL_JSON: JSON.stringify([
            {
              toolCalls: [
                {
                  toolName: "apply_patch",
                  arguments: {
                    path: "README.md",
                    patch:
                      "@@ -1,1 +1,2 @@\n # Demo\n+This should not be applied.\n",
                  },
                },
              ],
            },
            { message: "blocked by hook" },
          ]),
        },
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(run.exitCode).toBe(0);
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
      "# Demo\n",
    );
    const traceEvents = await readTrace(run.tracePath);
    expect(
      traceEvents.find((event) => event.type === "workflow_hook.blocked"),
    ).toBeTruthy();
    expect(
      traceEvents.find(
        (event) =>
          event.type === "tool.failed" &&
          (event.payload?.error as { code?: string } | undefined)?.code ===
            "TOOL_BLOCKED_BY_WORKFLOW_HOOK",
      ),
    ).toBeTruthy();
  });

  it("prints configured verification profile results in host runs", async () => {
    const workspace = await createWorkspace("# Demo\n");
    await mkdir(join(workspace, ".sparkwright"), { recursive: true });
    await writeFile(
      join(workspace, ".sparkwright", "config.json"),
      JSON.stringify({
        capabilities: {
          verification: {
            mode: "require",
            defaultProfile: "fast",
            profiles: {
              fast: [
                {
                  id: "unit",
                  kind: "custom",
                  command: process.execPath,
                  args: ["-e", "process.exit(0)"],
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
      }),
      "utf8",
    );
    const output = createOutputCapture();

    const run = await runCli(
      [
        "run",
        "write and verify README",
        "--workspace",
        workspace,
        "--model",
        "scripted",
        "--write",
        "--permission-mode",
        "accept_edits",
        "--trace-level",
        "debug",
      ],
      {
        env: {
          ...process.env,
          SPARKWRIGHT_SCRIPTED_MODEL_JSON: JSON.stringify([
            {
              toolCalls: [
                {
                  toolName: "apply_patch",
                  arguments: {
                    path: "README.md",
                    reason: "Add verified section",
                    patch: [
                      "--- a/README.md",
                      "+++ b/README.md",
                      "@@ -1 +1,5 @@",
                      " # Demo",
                      "+",
                      "+## Verified Write",
                      "+",
                      "+Verified from CLI.",
                      "",
                    ].join("\n"),
                  },
                },
              ],
            },
            { message: "verified" },
          ]),
        },
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(run.exitCode).toBe(0);
    expect(output.stdoutText()).toContain("Verification: 1 passed (unit).");
    expect(await readFile(join(workspace, "README.md"), "utf8")).toContain(
      "## Verified Write",
    );
    const traceEvents = await readTrace(run.tracePath);
    expect(
      traceEvents.find(
        (event) =>
          event.type === "workflow_hook.completed" &&
          (event.payload?.hookName as string | undefined) ===
            "verification:fast:unit",
      ),
    ).toBeTruthy();
  });

  it("normalizes relative --workspace before host tools resolve absolute paths", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const output = createOutputCapture();

    const run = await runCli(
      [
        "run",
        "read README via absolute path",
        "--workspace",
        ".",
        "--model",
        "scripted",
        "--trace-level",
        "debug",
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          SPARKWRIGHT_SCRIPTED_MODEL_JSON: JSON.stringify([
            {
              toolCalls: [
                {
                  toolName: "read_file",
                  arguments: { path: join(workspace, "README.md") },
                },
              ],
            },
            {
              message: "absolute read succeeded",
            },
          ]),
        },
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(run.exitCode).toBe(0);
    const traceEvents = await readTrace(run.tracePath);
    expect(
      traceEvents.find(
        (event) =>
          event.type === "tool.completed" &&
          (event.payload as { output?: { path?: string } }).output?.path ===
            "README.md",
      ),
    ).toBeTruthy();
  });

  it("denies scripted host writes when --write is not enabled", async () => {
    const workspace = await createWorkspace("# Demo\n");
    await enableWorkspaceTools(workspace, ["apply_patch"]);
    const output = createOutputCapture();

    const run = await runCli(
      [
        "run",
        "Make one minimal README improvement and apply it.",
        "--workspace",
        workspace,
        "--model",
        "scripted",
        "--yes",
        "--trace-level",
        "debug",
      ],
      {
        env: {
          ...process.env,
          SPARKWRIGHT_SCRIPTED_MODEL_JSON: JSON.stringify([
            {
              message: "attempt write without write flag",
              toolCalls: [
                {
                  toolName: "apply_patch",
                  arguments: {
                    path: "README.md",
                    patch: "@@ -1,1 +1,2 @@\n # Demo\n+No write flag.\n",
                  },
                },
              ],
            },
            { message: "done" },
          ]),
        },
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(run.exitCode).toBe(0);
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
      "# Demo\n",
    );
    const traceEvents = await readTrace(run.tracePath);
    expect(
      traceEvents.find((event) => event.type === "workspace.write.completed"),
    ).toBeUndefined();
    expect(
      traceEvents.find(
        (event) =>
          event.type === "tool.failed" &&
          (event.payload?.error as { code?: string } | undefined)?.code ===
            "TOOL_DENIED",
      ),
    ).toBeTruthy();
  });

  it("rejects scripted model tool calls with invalid args before execution or approval", async () => {
    const workspace = await createWorkspace("# Demo\n");
    await enableWorkspaceTools(workspace, ["read_file", "apply_patch"]);
    const output = createOutputCapture();

    const run = await runCli(
      [
        "run",
        "Exercise invalid tool args.",
        "--workspace",
        workspace,
        "--model",
        "scripted",
        "--yes",
        "--trace-level",
        "debug",
      ],
      {
        env: {
          ...process.env,
          SPARKWRIGHT_SCRIPTED_MODEL_JSON: JSON.stringify([
            {
              message: "invalid tool args",
              toolCalls: [
                {
                  toolName: "read_file",
                  arguments: { path: { nested: "README.md" } },
                },
                {
                  toolName: "read_file",
                  arguments: {},
                },
                {
                  toolName: "apply_patch",
                  arguments: {
                    path: "README.md",
                  },
                },
              ],
            },
            { message: "saw invalid args" },
          ]),
        },
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(run.exitCode).toBe(1);
    expect(output.stdoutText()).toContain("tool.failed read_file");
    expect(output.stdoutText()).toContain("tool.failed apply_patch");
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
      "# Demo\n",
    );
    const traceEvents = await readTrace(run.tracePath);
    const invalidFailures = traceEvents.filter(
      (event) =>
        event.type === "tool.failed" &&
        (event.payload?.error as { code?: string } | undefined)?.code ===
          "TOOL_ARGUMENTS_INVALID",
    );
    expect(invalidFailures).toHaveLength(3);
    expect(traceEvents.map((event) => event.type)).not.toContain(
      "tool.started",
    );
    expect(traceEvents.map((event) => event.type)).not.toContain(
      "approval.requested",
    );
    expect(traceEvents.map((event) => event.type)).not.toContain(
      "workspace.write.completed",
    );
    expect(
      invalidFailures.map((event) => event.payload?.toolName).sort(),
    ).toEqual(["apply_patch", "read_file", "read_file"]);
    expect(
      invalidFailures.map(
        (event) =>
          (
            event.payload?.error as
              | { metadata?: { toolName?: string } }
              | undefined
          )?.metadata?.toolName,
      ),
    ).toEqual(["read_file", "read_file", "apply_patch"]);
    expect(
      invalidFailures.map(
        (event) => (event.payload?.error as { message?: string }).message,
      ),
    ).toEqual([
      "$.path: expected string.",
      "$.path: required property is missing.",
      "$.patch: required property is missing.",
    ]);
  });

  it("treats recovered tool argument failures as a completed run warning", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const output = createOutputCapture();

    const run = await runCli(
      [
        "run",
        "Recover from invalid read args.",
        "--workspace",
        workspace,
        "--model",
        "scripted",
        "--trace-level",
        "debug",
      ],
      {
        env: {
          ...process.env,
          SPARKWRIGHT_SCRIPTED_MODEL_JSON: JSON.stringify([
            {
              message: "invalid read args first",
              toolCalls: [
                {
                  toolName: "read_file",
                  arguments: { path: { nested: "README.md" } },
                },
              ],
            },
            {
              message: "recover with valid read",
              toolCalls: [
                {
                  toolName: "read_file",
                  arguments: { path: "README.md" },
                },
              ],
            },
            { message: "recovered" },
          ]),
        },
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(run.exitCode).toBe(0);
    expect(output.stderrText()).not.toContain("unhandled tool failure");

    const traceEvents = await readTrace(run.tracePath);
    expect(
      traceEvents.find((event) => event.type === "tool.failed"),
    ).toBeTruthy();
    expect(
      traceEvents.find((event) => event.type === "tool.completed"),
    ).toBeTruthy();
    const completed = traceEvents.find(
      (event) => event.type === "run.completed",
    );
    expect(completed?.payload?.outcome).toMatchObject({
      kind: "completed_with_recovered_tool_failures",
      toolFailures: { count: 1, codes: ["TOOL_ARGUMENTS_INVALID"] },
    });
  });

  it("treats skipped repeated calls after a successful result as recovered", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const output = createOutputCapture();

    const run = await runCli(
      [
        "run",
        "Avoid repeating completed reads.",
        "--workspace",
        workspace,
        "--model",
        "scripted",
        "--trace-level",
        "debug",
      ],
      {
        env: {
          ...process.env,
          SPARKWRIGHT_SCRIPTED_MODEL_JSON: JSON.stringify([
            {
              message: "read once",
              toolCalls: [
                {
                  toolName: "read_file",
                  arguments: { path: "README.md" },
                },
              ],
            },
            {
              message: "repeat the same read",
              toolCalls: [
                {
                  toolName: "read_file",
                  arguments: { path: "README.md" },
                },
              ],
            },
            { message: "answered from the first read" },
          ]),
        },
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(run.exitCode).toBe(0);
    expect(output.stderrText()).not.toContain("unhandled tool failure");

    const traceEvents = await readTrace(run.tracePath);
    expect(
      traceEvents.find(
        (event) =>
          event.type === "tool.failed" &&
          (event.payload as { error?: { code?: string } } | undefined)?.error
            ?.code === "REPEATED_TOOL_CALL_SKIPPED",
      ),
    ).toBeTruthy();
    const completed = traceEvents.find(
      (event) => event.type === "run.completed",
    );
    expect(completed?.payload?.outcome).toMatchObject({
      kind: "completed_with_recovered_tool_failures",
      toolFailures: { count: 1, codes: ["REPEATED_TOOL_CALL_SKIPPED"] },
    });

    const summaryOutput = createOutputCapture();
    const summary = await runCli(
      ["trace", "summary", run.tracePath!, "--format", "json"],
      {
        io: { stdout: summaryOutput.stdout, stderr: summaryOutput.stderr },
      },
    );
    expect(summary.exitCode).toBe(0);
    const parsedSummary = JSON.parse(summaryOutput.stdoutText()) as {
      errorCount: number;
      toolFailures: {
        unresolved: { total: number };
        recovered: { total: number; byCode: Record<string, number> };
      };
    };
    expect(parsedSummary.errorCount).toBe(0);
    expect(parsedSummary.toolFailures.unresolved.total).toBe(0);
    expect(parsedSummary.toolFailures.recovered).toMatchObject({
      total: 1,
      byCode: { REPEATED_TOOL_CALL_SKIPPED: 1 },
    });

    const textSummaryOutput = createOutputCapture();
    const textSummary = await runCli(
      ["trace", "summary", run.tracePath!, "--format", "text"],
      {
        io: {
          stdout: textSummaryOutput.stdout,
          stderr: textSummaryOutput.stderr,
        },
      },
    );
    expect(textSummary.exitCode).toBe(0);
    expect(textSummaryOutput.stdoutText()).toContain("errors: 0");
    expect(textSummaryOutput.stdoutText()).toContain(
      "unresolved tool failures: 0 total",
    );
    expect(textSummaryOutput.stdoutText()).toContain(
      "recovered tool failures: 1 total (REPEATED_TOOL_CALL_SKIPPED:1)",
    );
  });

  it("denies destructive shell deletion before it mutates the workspace", async () => {
    const workspace = await createWorkspace("# Demo\n");
    await writeFile(join(workspace, "package.json"), '{"name":"demo"}\n');
    const output = createOutputCapture();

    const run = await runCli(
      [
        "run",
        "Delete every file in this workspace.",
        "--workspace",
        workspace,
        "--model",
        "scripted",
        "--write",
        "--yes",
        "--trace-level",
        "debug",
      ],
      {
        env: {
          ...process.env,
          SPARKWRIGHT_SCRIPTED_MODEL_JSON: JSON.stringify([
            {
              message: "attempt deletion",
              toolCalls: [
                {
                  toolName: "shell",
                  arguments: { command: "rm -rf ./*" },
                },
              ],
            },
            { message: "done" },
          ]),
        },
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(run.exitCode).toBe(0);
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
      "# Demo\n",
    );
    expect(await readFile(join(workspace, "package.json"), "utf8")).toBe(
      '{"name":"demo"}\n',
    );
    const traceEvents = await readTrace(run.tracePath);
    expect(
      traceEvents.find(
        (event) =>
          event.type === "tool.failed" &&
          (event.payload?.error as { code?: string } | undefined)?.code ===
            "shell_safety_denied",
      ),
    ).toBeTruthy();
  });

  it("allows simple read-only shell commands in read-only host runs", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const output = createOutputCapture();

    const run = await runCli(
      [
        "run",
        "Print the current working directory.",
        "--workspace",
        workspace,
        "--model",
        "scripted",
        "--trace-level",
        "debug",
      ],
      {
        env: {
          ...process.env,
          SPARKWRIGHT_SCRIPTED_MODEL_JSON: JSON.stringify([
            {
              message: "inspect cwd",
              toolCalls: [
                {
                  toolName: "shell",
                  arguments: { command: "pwd" },
                },
              ],
            },
            { message: "done" },
          ]),
        },
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(run.exitCode).toBe(0);
    const traceEvents = await readTrace(run.tracePath);
    expect(
      traceEvents.some(
        (event) =>
          event.type === "tool.completed" &&
          event.payload?.toolName === "shell",
      ),
    ).toBe(true);
    expect(
      traceEvents.some((event) => event.type === "approval.requested"),
    ).toBe(false);
    expect(
      traceEvents.some(
        (event) =>
          event.type === "tool.failed" && event.payload?.toolName === "shell",
      ),
    ).toBe(false);
  });

  it("denies host writes outside the requested target scope", async () => {
    const workspace = await createWorkspace("# Demo\n");
    await enableWorkspaceTools(workspace, ["apply_patch"]);
    await writeFile(join(workspace, "package.json"), '{"name":"demo"}\n');
    const output = createOutputCapture();

    const run = await runCli(
      [
        "run",
        "Rewrite README.md and package.json.",
        "--workspace",
        workspace,
        "--target",
        "README.md",
        "--model",
        "scripted",
        "--write",
        "--yes",
        "--trace-level",
        "debug",
      ],
      {
        env: {
          ...process.env,
          SPARKWRIGHT_SCRIPTED_MODEL_JSON: JSON.stringify([
            {
              message: "attempt out of scope write",
              toolCalls: [
                {
                  toolName: "apply_patch",
                  arguments: {
                    path: "package.json",
                    patch: [
                      "--- a/package.json",
                      "+++ b/package.json",
                      "@@ -1 +1,2 @@",
                      ' {"name":"demo"}',
                      "+out of scope",
                      "",
                    ].join("\n"),
                  },
                },
              ],
            },
            { message: "done" },
          ]),
        },
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(run.exitCode).toBe(0);
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
      "# Demo\n",
    );
    expect(await readFile(join(workspace, "package.json"), "utf8")).toBe(
      '{"name":"demo"}\n',
    );
    const traceEvents = await readTrace(run.tracePath);
    expect(
      traceEvents.find(
        (event) =>
          event.type === "workspace.write.denied" &&
          String(event.payload?.reason).includes("allowed target scope"),
      ),
    ).toBeTruthy();
  });

  it("does not scope host writes to README.md unless --target is explicit", async () => {
    const workspace = await createWorkspace("# Demo\n");
    await enableWorkspaceTools(workspace, ["apply_patch"]);
    await writeFile(join(workspace, "package.json"), '{"name":"demo"}\n');
    const output = createOutputCapture();

    const run = await runCli(
      [
        "run",
        "Update package.json.",
        "--workspace",
        workspace,
        "--model",
        "scripted",
        "--write",
        "--yes",
        "--trace-level",
        "debug",
      ],
      {
        env: {
          ...process.env,
          SPARKWRIGHT_SCRIPTED_MODEL_JSON: JSON.stringify([
            {
              message: "attempt package write",
              toolCalls: [
                {
                  toolName: "apply_patch",
                  arguments: {
                    path: "package.json",
                    patch: [
                      "--- a/package.json",
                      "+++ b/package.json",
                      "@@ -1 +1,2 @@",
                      ' {"name":"demo"}',
                      "+write without explicit target",
                      "",
                    ].join("\n"),
                  },
                },
              ],
            },
            { message: "done" },
          ]),
        },
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(run.exitCode).toBe(0);
    expect(await readFile(join(workspace, "package.json"), "utf8")).toContain(
      "write without explicit target",
    );
    const traceEvents = await readTrace(run.tracePath);
    expect(
      traceEvents.find(
        (event) =>
          event.type === "workspace.write.completed" &&
          event.payload?.path === "package.json",
      ),
    ).toBeTruthy();
  });

  it("allows a small multi-file write budget when no target is explicit", async () => {
    const workspace = await createWorkspace("# Demo\n");
    await enableWorkspaceTools(workspace, ["apply_patch"]);
    await writeFile(join(workspace, "test.js"), "console.log('test')\n");
    const output = createOutputCapture();

    const run = await runCli(
      [
        "run",
        "Update implementation and test.",
        "--workspace",
        workspace,
        "--model",
        "scripted",
        "--write",
        "--yes",
        "--trace-level",
        "debug",
      ],
      {
        env: {
          ...process.env,
          SPARKWRIGHT_SCRIPTED_MODEL_JSON: JSON.stringify([
            {
              message: "attempt two writes",
              toolCalls: [
                {
                  toolName: "apply_patch",
                  arguments: {
                    path: "README.md",
                    patch: [
                      "--- a/README.md",
                      "+++ b/README.md",
                      "@@ -1 +1,2 @@",
                      " # Demo",
                      "+implementation update",
                      "",
                    ].join("\n"),
                  },
                },
                {
                  toolName: "apply_patch",
                  arguments: {
                    path: "test.js",
                    patch: [
                      "--- a/test.js",
                      "+++ b/test.js",
                      "@@ -1 +1,2 @@",
                      " console.log('test')",
                      "+regression coverage",
                      "",
                    ].join("\n"),
                  },
                },
              ],
            },
            { message: "done" },
          ]),
        },
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(run.exitCode).toBe(0);
    expect(await readFile(join(workspace, "README.md"), "utf8")).toContain(
      "implementation update",
    );
    expect(await readFile(join(workspace, "test.js"), "utf8")).toContain(
      "regression coverage",
    );
    const traceEvents = await readTrace(run.tracePath);
    expect(
      traceEvents.filter((event) => event.type === "workspace.write.completed"),
    ).toHaveLength(2);
  });

  it("rolls back shell mutations that bypass workspace.write", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const output = createOutputCapture();

    const run = await runCli(
      [
        "run",
        "Modify README.md through shell.",
        "--workspace",
        workspace,
        "--model",
        "scripted",
        "--write",
        "--yes",
        "--trace-level",
        "debug",
      ],
      {
        env: {
          ...process.env,
          SPARKWRIGHT_SCRIPTED_MODEL_JSON: JSON.stringify([
            {
              message: "attempt shell write",
              toolCalls: [
                {
                  toolName: "shell",
                  arguments: {
                    command:
                      "node -e \"require('fs').writeFileSync('README.md','hacked\\\\n')\"",
                  },
                },
              ],
            },
            { message: "done" },
          ]),
        },
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(run.exitCode).toBe(0);
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
      "# Demo\n",
    );
    const traceEvents = await readTrace(run.tracePath);
    expect(
      traceEvents.find(
        (event) =>
          event.type === "tool.failed" &&
          (event.payload?.error as { code?: string } | undefined)?.code ===
            "UNTRACKED_WORKSPACE_MUTATION",
      ),
    ).toBeTruthy();
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
        "standard",
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

  it("run resume --from-trace requires --force for reconstructed non-terminal checkpoints", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const sessionId = "session_trace_force_test";
    const runId = "run_trace_force_test";
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
      join(runDir, "run.json"),
      JSON.stringify(
        {
          id: runId,
          goal: "resume from reconstructed trace",
          state: "running",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
          metadata: {},
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      join(workspace, ".sparkwright", "sessions", sessionId, "trace.jsonl"),
      `${JSON.stringify({
        id: "evt_trace_force_1",
        runId,
        sequence: 1,
        type: "model.completed",
        timestamp: "2026-01-01T00:00:01.000Z",
        payload: { step: 1 },
      })}\n`,
      "utf8",
    );

    const output = createOutputCapture();
    const result = await runCli(
      [
        "run",
        "resume",
        runId,
        "--workspace",
        workspace,
        "--session",
        sessionId,
        "--from-trace",
      ],
      {
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(output.stderrText()).toContain("Checkpoint is not fully resumable");
    expect(output.stderrText()).toContain("--force");
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

  it("requires --write before a direct delegate can receive read-write workspace access", async () => {
    const workspace = await createWorkspace("# Demo\n");
    const commandPath = join(workspace, "delegate-fixture.mjs");
    await writeFile(
      commandPath,
      [
        "process.stdout.write(JSON.stringify({",
        "  argv: process.argv.slice(2),",
        "  cwd: process.cwd()",
        "}));",
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
                      args: [commandPath, "--workspace", "{{workspaceRoot}}"],
                      input: "none",
                      workspaceAccess: "read_write",
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

    const deniedOutput = createOutputCapture();
    const denied = await runCli(
      [
        "delegates",
        "run",
        "delegate_external_cli_fixture",
        "--goal",
        "inspect readme",
        "--workspace",
        workspace,
        "--yes",
        "--format",
        "text",
      ],
      {
        io: {
          stdout: deniedOutput.stdout,
          stderr: deniedOutput.stderr,
          stdinIsTTY: false,
        },
      },
    );
    expect(denied.exitCode).toBe(1);
    expect(deniedOutput.stderrText()).toContain(
      "parent run has not enabled workspace writes",
    );

    const approvedOutput = createOutputCapture();
    const approved = await runCli(
      [
        "delegates",
        "run",
        "delegate_external_cli_fixture",
        "--goal",
        "inspect readme",
        "--workspace",
        workspace,
        "--write",
        "--yes",
        "--format",
        "json",
      ],
      {
        io: {
          stdout: approvedOutput.stdout,
          stderr: approvedOutput.stderr,
          stdinIsTTY: false,
        },
      },
    );
    expect(approved.exitCode).toBe(0);
    const parsed = JSON.parse(approvedOutput.stdoutText()) as {
      output: { stdout: string };
    };
    const delegateInvocation = JSON.parse(parsed.output.stdout) as {
      argv: string[];
      cwd: string;
    };
    expect(delegateInvocation.argv).toEqual(["--workspace", workspace]);
    // Windows reports the temp dir in 8.3 short form (RUNNER~1) where realpath
    // canonicalizes to the long name; normalize both sides before comparing.
    expect(await realpath(delegateInvocation.cwd)).toBe(
      await realpath(workspace),
    );
  });

  function mcpEchoServerConfig(
    name: string,
    options: { prelude?: string } = {},
  ) {
    const repoRoot = findRepoRoot(process.cwd());
    const mcpPath = resolve(
      repoRoot,
      "node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js",
    );
    const transportPath = resolve(
      repoRoot,
      "node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js",
    );
    const zodPath = resolve(repoRoot, "node_modules/zod/v4/index.js");
    // ESM `import` of an absolute path must be a file:// URL on Windows
    // (a bare `C:\...` specifier is rejected); POSIX tolerates a bare path but
    // file:// works there too, so always convert.
    const script = [
      options.prelude ?? "",
      `import { McpServer } from ${JSON.stringify(pathToFileURL(mcpPath).href)};`,
      `import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(transportPath).href)};`,
      `import { z } from ${JSON.stringify(pathToFileURL(zodPath).href)};`,
      "const server = new McpServer({ name: 'cli-test-mcp', version: '0.0.1' });",
      "server.registerTool('echo', { description: 'Echo text.', inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text }] }));",
      "await server.connect(new StdioServerTransport());",
    ].join("\n");
    return {
      type: "stdio",
      name,
      command: process.execPath,
      args: ["--input-type=module", "-e", script],
      enabled: true,
      // Generous ceiling so a cold node + ESM SDK load on the slow Windows CI
      // runner has room to connect (not a delay on fast machines).
      timeoutMs: 15000,
    };
  }

  function findRepoRoot(start: string): string {
    let current = resolve(start);
    while (true) {
      if (
        existsSync(join(current, "packages", "cli", "test", "cli.test.ts")) &&
        existsSync(join(current, "tools", "demo-mcp.mjs"))
      ) {
        return current;
      }
      const parent = resolve(current, "..");
      if (parent === current) return resolve(start);
      current = parent;
    }
  }

  async function createWorkspace(readme: string): Promise<string> {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-cli-"));
    tempDirs.push(workspace);
    await writeFile(join(workspace, "README.md"), readme, "utf8");
    return workspace;
  }

  // Read/write tools are available by default, so the write smokes no longer
  // need to opt tools in. Kept as a no-op so call sites stay declarative about
  // which tools the scenario exercises.
  async function enableWorkspaceTools(
    _workspace: string,
    _tools: string[],
  ): Promise<void> {}
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

function traceEvent(
  sequence: number,
  runId: string,
  type: string,
  payload: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): string {
  return `${JSON.stringify({
    id: `evt_${sequence}`,
    runId,
    type,
    timestamp: `2026-06-13T00:00:0${sequence}.000Z`,
    sequence,
    payload,
    metadata,
  })}\n`;
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
