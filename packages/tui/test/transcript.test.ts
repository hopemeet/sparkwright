import { describe, expect, it } from "vitest";
import { renderTranscript } from "../src/lib/transcript.js";
import type { RunEvent } from "../src/lib/event-type.js";

describe("renderTranscript", () => {
  it("emits a header and User/Assistant sections", () => {
    const events: RunEvent[] = [
      {
        type: "run.started",
        sequence: 1,
        payload: { runId: "r1", goal: "do the thing" },
      },
      { type: "model.stream.started", sequence: 2, payload: { runId: "r1" } },
      {
        type: "model.stream.chunk",
        sequence: 3,
        payload: { runId: "r1", type: "text_delta", text: "Hello" },
      },
      {
        type: "model.stream.chunk",
        sequence: 4,
        payload: { runId: "r1", type: "text_delta", text: ", world." },
      },
      {
        type: "model.stream.completed",
        sequence: 5,
        payload: { runId: "r1" },
      },
      {
        type: "run.completed",
        sequence: 6,
        payload: { runId: "r1", stopReason: "natural" },
      },
    ];
    const md = renderTranscript(
      {
        sessionId: "s1",
        workspaceRoot: "/tmp/x",
        model: "openai/gpt-x",
        exportedAt: new Date("2026-01-01T00:00:00Z"),
      },
      events,
    );
    expect(md).toContain("# Sparkwright session s1");
    expect(md).toContain("## User");
    expect(md).toContain("do the thing");
    expect(md).toContain("## Assistant");
    expect(md).toContain("Hello, world.");
    expect(md).toContain("_Run completed: **natural**_");
  });

  it("renders tool call args and result as fenced code", () => {
    const events: RunEvent[] = [
      {
        type: "tool.requested",
        sequence: 1,
        payload: { toolName: "read_file", input: { path: "foo.ts" } },
      },
      {
        type: "tool.completed",
        sequence: 2,
        payload: { toolName: "read_file", result: "contents here" },
      },
    ];
    const md = renderTranscript(
      { sessionId: "s", workspaceRoot: "/x" },
      events,
    );
    expect(md).toContain("### Tool: `read_file`");
    expect(md).toContain("```json");
    expect(md).toContain('"path": "foo.ts"');
    expect(md).toContain("contents here");
  });

  it("renders workspace.write with a diff fence", () => {
    const events: RunEvent[] = [
      {
        type: "workspace.write.applied",
        sequence: 1,
        payload: {
          path: "foo.ts",
          diff: "--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new",
        },
      },
    ];
    const md = renderTranscript(
      { sessionId: "s", workspaceRoot: "/x" },
      events,
    );
    expect(md).toContain("### Write: `foo.ts`");
    expect(md).toContain("```diff");
    expect(md).toContain("+new");
  });

  it("wraps batched tool calls in a Batch heading and delimiter", () => {
    const events: RunEvent[] = [
      {
        type: "tool.batch.requested",
        sequence: 1,
        payload: { mode: "concurrent", toolCallCount: 2 },
      },
      {
        type: "tool.requested",
        sequence: 2,
        payload: { toolName: "read_file", input: { path: "a.ts" } },
      },
      {
        type: "tool.requested",
        sequence: 3,
        payload: { toolName: "read_file", input: { path: "b.ts" } },
      },
      { type: "tool.batch.completed", sequence: 4, payload: {} },
    ];
    const md = renderTranscript(
      { sessionId: "s", workspaceRoot: "/x" },
      events,
    );
    expect(md).toContain("### Batch · 2 tools (concurrent)");
    expect(md).toContain("_End of batch._");
    // Children render as normal tool sections, not dumped into the raw tail.
    expect(md).toContain("### Tool: `read_file`");
    expect(md).not.toContain("Raw events");
  });

  it("collects unknown events into a raw list", () => {
    const events: RunEvent[] = [
      { type: "weird.event", sequence: 1, payload: { x: 1 } },
    ];
    const md = renderTranscript(
      { sessionId: "s", workspaceRoot: "/x" },
      events,
    );
    expect(md).toContain("<details><summary>Raw events (1)</summary>");
    expect(md).toContain("[1] weird.event");
  });
});
