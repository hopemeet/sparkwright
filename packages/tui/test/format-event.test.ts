import { describe, expect, it } from "vitest";
import { formatEvent } from "../src/lib/format-event.js";
import type { RunEvent } from "../src/lib/event-type.js";

function event(type: string, payload: unknown = {}): RunEvent {
  return { type, sequence: 1, payload };
}

describe("formatEvent", () => {
  it("formats skill lifecycle events", () => {
    expect(formatEvent(event("skill.indexed", { count: 3 }))).toMatchObject({
      color: "blue",
      detail: "3 skills",
    });
    expect(
      formatEvent(event("skill.loaded", { name: "reviewer" })),
    ).toMatchObject({
      color: "blue",
      detail: "reviewer",
    });
    expect(
      formatEvent(event("skill.failed", { source: "/tmp/bad/SKILL.md" })),
    ).toMatchObject({
      color: "red",
      detail: "/tmp/bad/SKILL.md",
    });
  });

  it("formats capability failures", () => {
    expect(
      formatEvent(
        event("capability.index.failed", {
          kind: "skills",
          code: "SKILL_INDEX_FAILED",
          source: "/tmp/bad/SKILL.md",
        }),
      ),
    ).toMatchObject({
      color: "red",
      detail: "skills SKILL_INDEX_FAILED /tmp/bad/SKILL.md",
    });
    expect(
      formatEvent(
        event("capability.index.failed", {
          kind: "agent_profile",
          code: "AGENT_PROFILE_ID_COLLISION",
          severity: "warning",
          profileId: "reviewer",
          source: "/tmp/project/.sparkwright/agents/reviewer.md",
        }),
      ),
    ).toMatchObject({
      color: "yellow",
      detail:
        "warning agent_profile AGENT_PROFILE_ID_COLLISION reviewer /tmp/project/.sparkwright/agents/reviewer.md",
    });
    expect(
      formatEvent(
        event("capability.mutation.completed", {
          action: "write_text",
          path: "/tmp/project/.sparkwright/skill-evolution/proposals/p1/proposal.md",
        }),
      ),
    ).toMatchObject({
      color: "red",
      detail:
        "write_text .sparkwright/skill-evolution/proposals/p1/proposal.md",
    });
  });

  it("formats MCP and agent lifecycle events", () => {
    expect(
      formatEvent(
        event("mcp.server.prepared", { name: "github", status: "connected" }),
      ),
    ).toMatchObject({ color: "cyan", detail: "github connected" });
    expect(
      formatEvent(
        event("mcp.server.prepared", {
          name: "missing",
          status: "failed",
          errorCode: "MCP_SERVER_COMMAND_NOT_FOUND",
        }),
      ),
    ).toMatchObject({
      color: "red",
      detail: "missing failed MCP_SERVER_COMMAND_NOT_FOUND",
    });
    expect(
      formatEvent(
        event("agent.profile.derived", {
          parentAgentId: "planner",
          childAgentId: "reviewer",
        }),
      ),
    ).toMatchObject({ color: "magenta", detail: "planner → reviewer" });
    expect(
      formatEvent(
        event("agent.routing.evaluated", {
          mode: "sort",
          relevantCount: 1,
          lowCount: 2,
        }),
      ),
    ).toMatchObject({
      color: "magenta",
      detail: "sort 1 relevant 2 low",
    });
  });

  it("formats subagent lifecycle events", () => {
    expect(
      formatEvent(event("subagent.started", { goal: "audit docs" })),
    ).toMatchObject({ color: "magenta", detail: "audit docs" });
    expect(
      formatEvent(event("subagent.failed", { goal: "audit docs" })),
    ).toMatchObject({ color: "red", detail: "audit docs" });
  });

  it("formats verification workflow hooks", () => {
    expect(
      formatEvent(
        event("workflow_hook.started", {
          hookName: "verification:fast",
        }),
      ),
    ).toMatchObject({
      color: "gray",
      label: "verification",
      detail: "fast started",
    });
    expect(
      formatEvent(
        event("workflow_hook.completed", {
          hookName: "verification:fast",
          result: {
            status: "continue",
            metadata: {
              verificationSource: "profile",
              profile: "fast",
            },
          },
        }),
      ),
    ).toMatchObject({
      color: "green",
      label: "verification",
      detail: "fast ok",
    });
    expect(
      formatEvent(
        event("workflow_hook.completed", {
          hookName: "workflow:verification_fast",
          result: {
            status: "continue",
            metadata: {
              verificationSource: "profile",
              profile: "fast",
              verifierId: "lint",
              exitCode: 0,
              timedOut: false,
            },
          },
        }),
      ),
    ).toMatchObject({
      color: "green",
      label: "verification",
      detail: "fast lint passed",
    });
    expect(
      formatEvent(
        event("workflow_hook.completed", {
          hookName: "workflow:verification_fast",
          result: {
            status: "continue",
            metadata: {
              verificationSource: "profile",
              profile: "fast",
              verifierId: "typecheck",
              exitCode: 2,
              timedOut: false,
            },
          },
        }),
      ),
    ).toMatchObject({
      color: "red",
      label: "verification",
      detail: "fast typecheck failed exitCode=2",
    });
    expect(
      formatEvent(
        event("workflow_hook.blocked", {
          hookName: "workflow:verification_fast",
          resultMetadata: {
            verificationSource: "profile",
            profile: "fast",
          },
        }),
      ),
    ).toMatchObject({
      color: "red",
      label: "verification",
      detail: "fast blocked",
    });
  });

  it("formats non-verification workflow hooks", () => {
    expect(
      formatEvent(
        event("workflow_hook.started", {
          hookName: "project-operating-rules",
        }),
      ),
    ).toMatchObject({
      color: "gray",
      label: "workflow hook",
      detail: "project-operating-rules started",
    });
    expect(
      formatEvent(
        event("workflow_hook.completed", {
          hookName: "project-operating-rules",
          result: { status: "continue" },
        }),
      ),
    ).toMatchObject({
      color: "green",
      label: "workflow hook",
      detail: "project-operating-rules ok",
    });
  });
});
