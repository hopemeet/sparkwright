import { describe, expect, it } from "vitest";
import { sessionPreviewFromTranscriptLine } from "../src/runtime.js";

/**
 * Regression for the /sessions browser showing raw event JSON instead of the
 * user goal. The opening transcript line is a `prompt` event whose `messages`
 * hold an `<env>` preamble and the goal as `User request:\n<goal>`.
 */
describe("sessionPreviewFromTranscriptLine", () => {
  const promptLine = JSON.stringify({
    type: "prompt",
    sessionId: "session_tui_abc",
    messages: [
      {
        role: "user",
        content: "<env>\ncwd: /repo\ndate: 2026-06-14\n</env>",
      },
      { role: "user", content: "User request:\n检查这个仓库" },
    ],
  });

  it("surfaces the goal, not the raw JSON", () => {
    const preview = sessionPreviewFromTranscriptLine(promptLine);
    expect(preview).toBe("检查这个仓库");
  });

  it("does not leak the <env> block or the label", () => {
    const preview = sessionPreviewFromTranscriptLine(promptLine);
    expect(preview).not.toContain("<env>");
    expect(preview).not.toContain("User request");
    expect(preview).not.toContain("cwd:");
    expect(preview.startsWith("{")).toBe(false);
  });

  it("collapses a multi-line goal into one line", () => {
    const line = JSON.stringify({
      type: "prompt",
      messages: [
        { role: "user", content: "<env>\ncwd: /repo\n</env>" },
        {
          role: "user",
          content: "User request:\nfix the parser\nand add tests",
        },
      ],
    });
    expect(sessionPreviewFromTranscriptLine(line)).toBe(
      "fix the parser and add tests",
    );
  });

  it("falls back to a top-level content string (legacy shape)", () => {
    const line = JSON.stringify({ content: "legacy goal text" });
    expect(sessionPreviewFromTranscriptLine(line)).toBe("legacy goal text");
  });

  it("returns the raw line when it is not JSON", () => {
    expect(sessionPreviewFromTranscriptLine("not json at all")).toBe(
      "not json at all",
    );
  });

  it("returns the raw line when no usable goal is present", () => {
    const line = JSON.stringify({
      type: "prompt",
      messages: [{ role: "user", content: "<env>\ncwd: /repo\n</env>" }],
    });
    // env-only message yields no goal -> raw line fallback (better than nothing).
    expect(sessionPreviewFromTranscriptLine(line)).toBe(line);
  });
});
