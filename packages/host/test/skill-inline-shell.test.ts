import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRunId, EventLog } from "@sparkwright/core";
import {
  resolveShellSandboxConfig,
  type ShellSandboxRuntime,
} from "@sparkwright/shell-sandbox";
import { createSkillInlineShellRunner } from "../src/index.js";

describe("createSkillInlineShellRunner", () => {
  it("runs inline shell through the traced extension process lifecycle", async () => {
    const runId = createRunId();
    const events = new EventLog(runId);
    const runner = createSkillInlineShellRunner({ emitter: events, runId });

    const output = await runner({
      command: "printf hello",
      cwd: process.cwd(),
      timeoutMs: 5_000,
      maxOutputChars: 32,
    });

    expect(output).toBe("hello");
    const processEvents = events
      .all()
      .filter((event) => event.type.startsWith("extension.process."));
    expect(processEvents.map((event) => event.type)).toEqual([
      "extension.process.started",
      "extension.process.completed",
    ]);
    expect(processEvents[0]?.spanId).toBeDefined();
    expect(processEvents[1]).toMatchObject({
      spanId: processEvents[0]?.spanId,
      payload: expect.objectContaining({
        name: "skill-inline-shell",
        kind: "skill_script",
        output: expect.objectContaining({
          stdoutPreview: "hello",
        }),
      }),
    });
  });

  it("keeps inline shell progress correlated with the skill_script process", async () => {
    const runId = createRunId();
    const events = new EventLog(runId);
    const runner = createSkillInlineShellRunner({ emitter: events, runId });

    const output = await runner({
      command: [
        `${process.execPath} -e "`,
        "const token = process.env.SPARKWRIGHT_EVENT_TOKEN;",
        "process.stderr.write(token + ': ' + JSON.stringify({ type: 'progress', message: 'loading skill' }) + '\\n');",
        "process.stdout.write('body');",
        '"',
      ].join(" "),
      cwd: process.cwd(),
      timeoutMs: 5_000,
      maxOutputChars: 64,
    });

    expect(output).toBe("body");
    const started = events
      .all()
      .find((event) => event.type === "extension.process.started");
    const progress = events
      .all()
      .find((event) => event.type === "extension.process.progress");
    const completed = events
      .all()
      .find((event) => event.type === "extension.process.completed");
    expect(started?.payload).toMatchObject({
      name: "skill-inline-shell",
      kind: "skill_script",
    });
    expect(progress).toMatchObject({
      spanId: started?.spanId,
      payload: expect.objectContaining({
        channel: "event",
        message: "loading skill",
      }),
    });
    expect(completed?.payload).toMatchObject({
      kind: "skill_script",
      output: expect.not.objectContaining({
        stderrPreview: expect.stringContaining("SPARKWRIGHT_EVENT"),
      }),
    });
  });

  it("returns the legacy timeout marker on process timeout", async () => {
    const runId = createRunId();
    const events = new EventLog(runId);
    const runner = createSkillInlineShellRunner({ emitter: events, runId });

    const output = await runner({
      command: "while true; do :; done",
      cwd: process.cwd(),
      timeoutMs: 25,
      maxOutputChars: 64,
    });

    expect(output).toBe("[inline-shell timeout after 25ms]");
    expect(
      events.all().find((event) => event.type === "extension.process.failed"),
    ).toMatchObject({
      payload: expect.objectContaining({ errorCode: "PROCESS_TIMEOUT" }),
    });
  });

  it("keeps failing stderr out of the preprocessed skill body", async () => {
    const runId = createRunId();
    const events = new EventLog(runId);
    const runner = createSkillInlineShellRunner({ emitter: events, runId });

    const output = await runner({
      command:
        "node -e \"console.error('SECRET_INLINE_STDERR /tmp/marker'); process.exit(1)\"",
      cwd: process.cwd(),
      timeoutMs: 5_000,
      maxOutputChars: 200,
    });

    expect(output).toBe("[inline-shell error: PROCESS_FAILED exitCode=1]");
    expect(output).not.toContain("SECRET_INLINE_STDERR");
    expect(
      events.all().find((event) => event.type === "extension.process.failed"),
    ).toMatchObject({
      payload: expect.objectContaining({
        output: expect.objectContaining({
          stderrPreview: expect.stringContaining("SECRET_INLINE_STDERR"),
        }),
      }),
    });
  });

  it("fails closed instead of running unsandboxed when the skill sandbox is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-inline-shell-"));
    const marker = join(root, "marker.txt");
    const unavailableRuntime: ShellSandboxRuntime = {
      id: "unavailable-test",
      platform: "unsupported",
      async isAvailable() {
        return false;
      },
      async execute() {
        throw new Error("should not execute unavailable sandbox");
      },
    };

    try {
      const runId = createRunId();
      const events = new EventLog(runId);
      const runner = createSkillInlineShellRunner({
        emitter: events,
        runId,
        workspaceRoot: root,
        sandbox: resolveShellSandboxConfig({
          workspaceRoot: root,
          config: { mode: "off" },
        }),
        sandboxRuntime: unavailableRuntime,
      });

      const output = await runner({
        command: "printf unsafe > marker.txt",
        cwd: root,
        skillName: "unsafe-skill",
        sourcePath: join(
          root,
          ".sparkwright",
          "skills",
          "unsafe-skill",
          "SKILL.md",
        ),
        timeoutMs: 1_000,
        maxOutputChars: 200,
      });

      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(output).toBe("[inline-shell error: PROCESS_SANDBOX_UNAVAILABLE]");
      expect(
        events.all().find((event) => event.type === "extension.process.failed"),
      ).toMatchObject({
        payload: expect.objectContaining({
          kind: "skill_script",
          errorCode: "PROCESS_SANDBOX_UNAVAILABLE",
        }),
      });
      expect(
        events.all().find((event) => event.type === "skill.failed"),
      ).toMatchObject({
        payload: expect.objectContaining({
          name: "unsafe-skill",
          status: "inline_shell_failed",
          errorCode: "PROCESS_SANDBOX_UNAVAILABLE",
        }),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
