import { describe, expect, it } from "vitest";
import type { RunEvent } from "../src/lib/event-type.js";
import {
  type EventDetailFilter,
  eventMatchesFilter,
  eventMatchesSearch,
  summarizeRunInspectorFacts,
} from "../src/lib/event-inspector.js";
import type { FormattedEvent } from "../src/lib/format-event.js";

function event(type: string, payload?: unknown): RunEvent {
  return { type, sequence: 1, payload };
}

function matches(type: string, filter: EventDetailFilter): boolean {
  return eventMatchesFilter(event(type), filter);
}

describe("event detail filters", () => {
  it("keeps all events in the all filter", () => {
    expect(matches("model.completed", "all")).toBe(true);
    expect(matches("tool.failed", "all")).toBe(true);
  });

  it("groups failures, denials, rejections, and timeouts as errors", () => {
    expect(matches("run.failed", "errors")).toBe(true);
    expect(
      eventMatchesFilter(event("run.completed", { state: "failed" }), "errors"),
    ).toBe(true);
    expect(matches("tool.failed", "errors")).toBe(true);
    expect(matches("workspace.write.denied", "errors")).toBe(true);
    expect(matches("approval.rejected", "errors")).toBe(true);
    expect(matches("model.stream.timeout", "errors")).toBe(true);
    expect(matches("tool.completed", "errors")).toBe(false);
  });

  it("groups approval events", () => {
    expect(matches("approval.requested", "approvals")).toBe(true);
    expect(matches("approval.resolved", "approvals")).toBe(true);
    expect(matches("tool.requested", "approvals")).toBe(false);
  });

  it("groups tool, mcp, and subagent activity", () => {
    expect(matches("tool.requested", "tools")).toBe(true);
    expect(matches("tool.completed", "tools")).toBe(true);
    expect(matches("mcp.server.prepared", "tools")).toBe(true);
    expect(matches("subagent.started", "tools")).toBe(true);
    expect(matches("workspace.write.completed", "tools")).toBe(false);
  });

  it("groups write-related events", () => {
    expect(matches("workspace.write.requested", "writes")).toBe(true);
    expect(matches("workspace.write.completed", "writes")).toBe(true);
    expect(matches("workspace.write.denied", "writes")).toBe(true);
    expect(matches("capability.mutation.completed", "writes")).toBe(true);
    expect(matches("model.completed", "writes")).toBe(false);
  });

  it("groups model and usage events", () => {
    expect(matches("model.requested", "model")).toBe(true);
    expect(matches("model.stream.chunk", "model")).toBe(true);
    expect(matches("model.completed", "model")).toBe(true);
    expect(matches("usage.updated", "model")).toBe(true);
    expect(matches("tool.completed", "model")).toBe(false);
  });
});

describe("event detail search", () => {
  const formatted: FormattedEvent = {
    color: "cyan",
    label: "tool.completed",
    detail: "npm test",
  };

  it("matches type, formatted detail, and sequence", () => {
    const ev = event("tool.completed", { result: "passed" });

    expect(eventMatchesSearch(ev, formatted, "tool.completed")).toBe(true);
    expect(eventMatchesSearch(ev, formatted, "npm test")).toBe(true);
    expect(eventMatchesSearch(ev, formatted, "1")).toBe(true);
  });

  it("matches payload text without requiring expanded detail", () => {
    const ev = event("approval.requested", {
      summary: "Run shell command",
      command: "npm run lint",
    });

    expect(eventMatchesSearch(ev, formatted, "lint")).toBe(true);
    expect(eventMatchesSearch(ev, formatted, "missing-token")).toBe(false);
  });

  it("treats blank search as a match", () => {
    expect(eventMatchesSearch(event("run.completed"), formatted, "   ")).toBe(
      true,
    );
  });

  it("handles circular payloads conservatively", () => {
    const payload: Record<string, unknown> = { name: "cycle" };
    payload.self = payload;

    expect(
      eventMatchesSearch(event("tool.completed", payload), formatted, "cycle"),
    ).toBe(true);
  });
});

describe("run inspector facts", () => {
  it("summarizes run activity from events", () => {
    const facts = summarizeRunInspectorFacts([
      event("run.started"),
      event("model.completed"),
      event("tool.requested", {
        toolName: "bash",
        arguments: { command: "npm test" },
      }),
      event("approval.requested"),
      event("approval.resolved", { decision: "approved" }),
      event("workspace.write.completed", { path: "src/app.ts" }),
      event("run.completed"),
    ]);

    expect(facts).toMatchObject({
      eventCount: 7,
      runStarted: 1,
      runCompleted: 1,
      runFailed: 0,
      modelCalls: 1,
      toolCalls: 1,
      approvalsRequested: 1,
      approvalsApproved: 1,
      approvalsDenied: 0,
      errorCount: 0,
      lastCommand: "npm test",
    });
    expect(facts.changedFiles).toEqual(["src/app.ts"]);
  });

  it("records failures and denied approvals", () => {
    const facts = summarizeRunInspectorFacts([
      event("approval.requested"),
      event("approval.resolved", { decision: "denied" }),
      event("tool.failed", { error: { message: "boom" } }),
      event("run.failed", { reason: "stopped" }),
    ]);

    expect(facts.approvalsDenied).toBe(1);
    expect(facts.errorCount).toBe(2);
    expect(facts.lastError).toBe("stopped");
    expect(facts.runFailed).toBe(1);
  });

  it("records failed run.completed events with the canonical failure message", () => {
    const facts = summarizeRunInspectorFacts([
      event("run.completed", {
        state: "failed",
        stopReason: "model_auth_failed",
        failure: {
          category: "model",
          code: "MODEL_COMPLETION_FAILED",
          message: "invalid API key",
        },
      }),
    ]);

    expect(facts.errorCount).toBe(1);
    expect(facts.lastError).toBe("invalid API key");
    expect(facts.runCompleted).toBe(1);
  });
});
