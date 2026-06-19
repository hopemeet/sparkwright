import { describe, expect, it } from "vitest";
import { createRunId, EventLog } from "@sparkwright/core";
import { createSkillInlineShellRunner } from "../src/index.js";

describe("createSkillInlineShellRunner", () => {
  it("runs inline shell through the traced extension process lifecycle", async () => {
    const runId = createRunId();
    const events = new EventLog(runId);
    const runner = createSkillInlineShellRunner({ emitter: events, runId });

    const output = await runner({
      command: "printf hello",
      cwd: process.cwd(),
      timeoutMs: 1_000,
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

    expect(output).toContain("[inline-shell timeout after 25ms:");
    expect(
      events.all().find((event) => event.type === "extension.process.failed"),
    ).toMatchObject({
      payload: expect.objectContaining({ errorCode: "PROCESS_TIMEOUT" }),
    });
  });
});
