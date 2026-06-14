import { describe, expect, it } from "vitest";
import {
  searchTranscript,
  collectTranscriptMessages,
} from "../src/lib/transcript.js";
import type { RunEvent } from "../src/lib/event-type.js";

function ev(type: string, payload: unknown): RunEvent {
  return { type, sequence: 0, payload };
}

const events: RunEvent[] = [
  ev("tui.user", { goal: "analyze the parser module" }),
  ev("model.completed", {
    message: "The parser handles tokens and AST nodes.",
  }),
  ev("tui.user", { goal: "now write tests" }),
  ev("model.assistant_text", { message: "Added 5 tests for the tokenizer." }),
  ev("run.started", { goal: "noise" }), // non-message event, ignored
];

describe("collectTranscriptMessages", () => {
  it("collects user goals and assistant answers in order", () => {
    expect(collectTranscriptMessages(events)).toEqual([
      { role: "user", text: "analyze the parser module" },
      { role: "assistant", text: "The parser handles tokens and AST nodes." },
      { role: "user", text: "now write tests" },
      { role: "assistant", text: "Added 5 tests for the tokenizer." },
    ]);
  });
});

describe("searchTranscript", () => {
  it("returns every message for an empty query", () => {
    expect(searchTranscript(events, "")).toHaveLength(4);
  });

  it("matches case-insensitively across roles", () => {
    const hits = searchTranscript(events, "PARSER");
    expect(hits.map((h) => h.role)).toEqual(["user", "assistant"]);
  });

  it("filters out non-matches", () => {
    const hits = searchTranscript(events, "tokenizer");
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toBe("Added 5 tests for the tokenizer.");
  });

  it("carries the full text for copying and a one-line snippet", () => {
    const hits = searchTranscript(events, "tokens");
    expect(hits[0].text).toBe("The parser handles tokens and AST nodes.");
    expect(hits[0].snippet).toContain("tokens");
    expect(hits[0].snippet).not.toContain("\n");
  });

  it("windows a long message with ellipses around the hit", () => {
    const long = "x".repeat(200) + " NEEDLE " + "y".repeat(200);
    const hits = searchTranscript(
      [ev("model.completed", { message: long })],
      "needle",
    );
    expect(hits[0].snippet).toContain("NEEDLE");
    expect(hits[0].snippet.startsWith("…")).toBe(true);
    expect(hits[0].snippet.endsWith("…")).toBe(true);
  });
});
