import { createRunId, EventLog } from "@sparkwright/core";
import { describe, expect, it } from "vitest";
import { prepareAgentInvocation } from "../src/agents/invocation.js";
import { createAgentSupervisor } from "../src/agents/supervisor.js";

function createHarness() {
  const events = new EventLog(createRunId());
  const invocation = prepareAgentInvocation({
    goal: "Review",
    protocol: "external_command",
    parentRunId: "run_parent",
    childRunId: "run_child",
    spanId: "span_child",
    childAgentId: "reviewer",
    subagentDepth: 1,
    entrypoint: "external_command",
    governance: { workspaceAccess: "none" },
  });
  return {
    events,
    supervisor: createAgentSupervisor({ invocation, emitter: events }),
  };
}

describe("AgentSupervisor", () => {
  it("emits one admitted lifecycle with terminal parity", () => {
    const { events, supervisor } = createHarness();

    expect(supervisor.requested()).toBe(true);
    expect(supervisor.admit()).toBe(true);
    expect(supervisor.started()).toBe(true);
    expect(supervisor.completed({ stopReason: "completed" })).toBe(true);

    expect(events.all().map((event) => event.type)).toEqual([
      "subagent.requested",
      "subagent.started",
      "subagent.completed",
    ]);
    expect(events.all().at(-1)?.payload).toMatchObject({
      childRunId: "run_child",
      parentRunId: "run_parent",
      terminalState: "completed",
      finality: "complete",
    });
    expect(events.all().at(-1)?.metadata).toMatchObject({
      childAgentId: "reviewer",
      protocol: "external_command",
      workspaceAccess: "none",
    });
    expect(supervisor.state).toBe("terminal");
  });

  it("fails admission without emitting started", () => {
    const { events, supervisor } = createHarness();

    supervisor.requested();
    expect(supervisor.failed({ errorCode: "ACCESS_DENIED" })).toBe(true);

    expect(events.all().map((event) => event.type)).toEqual([
      "subagent.requested",
      "subagent.failed",
    ]);
    expect(events.all().at(-1)?.payload).toMatchObject({
      terminalState: "failed",
      finality: "partial",
      errorCode: "ACCESS_DENIED",
    });
  });

  it("rejects started before admission", () => {
    const { supervisor } = createHarness();
    supervisor.requested();
    expect(() => supervisor.started()).toThrow("before invocation admission");
    expect(() => supervisor.completed()).toThrow("before invocation started");
  });

  it("makes repeated phases and terminal completion idempotent", () => {
    const { events, supervisor } = createHarness();
    expect(supervisor.requested()).toBe(true);
    expect(supervisor.requested()).toBe(false);
    expect(supervisor.admit()).toBe(true);
    expect(supervisor.admit()).toBe(false);
    expect(supervisor.started()).toBe(true);
    expect(supervisor.started()).toBe(false);
    expect(supervisor.failed()).toBe(true);
    expect(supervisor.completed()).toBe(false);
    expect(supervisor.failed()).toBe(false);

    expect(
      events
        .all()
        .filter(
          (event) =>
            event.type === "subagent.completed" ||
            event.type === "subagent.failed",
        ),
    ).toHaveLength(1);
  });
});
