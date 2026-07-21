import { createRunId } from "@sparkwright/core";
import { EventLog } from "@sparkwright/core/internal";
import { describe, expect, it } from "vitest";
import { formatEvent } from "../src/event-format.js";

describe("CLI event formatting", () => {
  it("prints semantic sub-agent status and blocker codes", () => {
    const log = new EventLog(createRunId());
    const event = log.emit(
      "subagent.completed",
      {
        childRunId: "run_child",
        terminalState: "completed",
        status: "blocked",
        summary: "Execution requires bash",
        blockers: [
          {
            code: "SHELL_REQUIRED",
            kind: "capability",
            owner: "parent",
            message: "A shell-capable path is required.",
            retry: "after_capability_change",
          },
        ],
      },
      { agentName: "runner" },
    );

    expect(formatEvent(event)).toBe(
      `[${event.sequence}] subagent.completed runner status=blocked summary=Execution requires bash blockers=SHELL_REQUIRED`,
    );
  });
});
