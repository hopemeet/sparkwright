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

  it("renders the user goal from run.created when run.started omits it", () => {
    const events: RunEvent[] = [
      {
        type: "run.created",
        sequence: 1,
        payload: {
          runId: "r1",
          goal: "Inspect README.md and answer in one short sentence.",
        },
      },
      {
        type: "run.started",
        sequence: 2,
        payload: { runId: "r1", resolvedModel: "deterministic" },
      },
      {
        type: "model.requested",
        sequence: 3,
        payload: {
          runId: "r1",
          goal: "Inspect README.md and answer in one short sentence.",
        },
      },
    ];

    const md = renderTranscript(
      {
        sessionId: "s1",
        workspaceRoot: "/tmp/x",
        exportedAt: new Date("2026-01-01T00:00:00Z"),
      },
      events,
    );

    expect(md).toContain("Inspect README.md and answer in one short sentence.");
    expect(md).not.toContain("_(no goal text)_");
    expect(md.match(/## User/g)).toHaveLength(1);
  });

  it("renders tool call args and result as concise tool display text", () => {
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
    expect(md).toContain("_Args:_ foo.ts");
    expect(md).toContain("contents here");
  });

  it("renders trace-shaped tool arguments and names completed results by call id", () => {
    const events: RunEvent[] = [
      {
        type: "tool.requested",
        sequence: 1,
        payload: {
          id: "call_1",
          toolName: "read_file",
          arguments: { path: "foo.ts", offset: 1, limit: 20 },
        },
      },
      {
        type: "tool.completed",
        sequence: 2,
        payload: {
          toolCallId: "call_1",
          status: "completed",
          output: { path: "foo.ts", bytes: 12 },
        },
      },
    ];
    const md = renderTranscript(
      { sessionId: "s", workspaceRoot: "/x" },
      events,
    );

    expect(md).toContain("### Tool: `read_file`");
    expect(md).toContain("_Args:_ foo.ts:1 +20");
    expect(md).toContain("_Result of `read_file`:_");
    expect(md).toContain('"bytes":12');
    expect(md).not.toContain("_Result of `?`:_");
  });

  it("uses tool-owned request previews in exported transcripts", () => {
    const events: RunEvent[] = [
      {
        type: "tool.requested",
        sequence: 1,
        payload: {
          id: "call_1",
          toolName: "spawn_agent",
          preview: "reviewer: inspect auth flow",
          arguments: {
            role: "reviewer",
            goal: "inspect auth flow",
            prompt: "Read the implementation and report risks.",
          },
        },
      },
    ];
    const md = renderTranscript(
      { sessionId: "s", workspaceRoot: "/x" },
      events,
    );

    expect(md).toContain("_Args:_ reviewer: inspect auth flow");
    expect(md).not.toContain('"prompt"');
  });

  it("summarizes structured tool results without raw JSON envelopes", () => {
    const events: RunEvent[] = [
      {
        type: "tool.completed",
        sequence: 1,
        payload: {
          toolName: "list_dir",
          output: {
            path: ".",
            entries: [
              { path: "src", name: "src", type: "directory" },
              { path: "package.json", name: "package.json", type: "file" },
            ],
          },
        },
      },
      {
        type: "tool.completed",
        sequence: 2,
        payload: {
          toolName: "read_file",
          output: {
            path: "README.md",
            content: "# Demo\nbody",
            totalLines: 2,
            bytes: 11,
          },
        },
      },
    ];

    const md = renderTranscript(
      { sessionId: "s", workspaceRoot: "/x" },
      events,
    );

    expect(md).toContain("list_dir . → 2 entries");
    expect(md).toContain("src/ · package.json");
    expect(md).toContain("read README.md");
    expect(md).toContain("2 lines");
    expect(md).toContain("11 bytes");
    expect(md).not.toContain('"entries"');
    expect(md).not.toContain('"content"');
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

  it("does not collect internal run machinery into the raw list", () => {
    const events: RunEvent[] = [
      { type: "run.budget.checked", sequence: 1, payload: { x: 1 } },
      { type: "run.budget.exceeded", sequence: 2, payload: { x: 1 } },
      {
        type: "workflow_hook.started",
        sequence: 3,
        payload: { hookName: "h" },
      },
      { type: "usage.updated", sequence: 4, payload: { tokens: 1 } },
    ];
    const md = renderTranscript(
      { sessionId: "s", workspaceRoot: "/x" },
      events,
    );
    expect(md).not.toContain("Raw events");
    expect(md).not.toContain("run.budget.checked");
    expect(md).not.toContain("run.budget.exceeded");
    expect(md).not.toContain("workflow_hook.started");
    expect(md).not.toContain("usage.updated");
  });
});
