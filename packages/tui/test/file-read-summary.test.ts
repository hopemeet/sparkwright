import { describe, expect, it } from "vitest";
import { isFileReadResult } from "../src/lib/tool-result-summary.js";

describe("isFileReadResult", () => {
  it("recognises a read result envelope", () => {
    expect(
      isFileReadResult({
        path: "README.md",
        content: "a\nb\nc",
        totalLines: 381,
        bytes: 29491,
        startLine: 1,
        endLine: 381,
        hasMore: false,
      }),
    ).toBe(true);
  });

  it("returns false for non-file-read values", () => {
    expect(isFileReadResult(undefined)).toBe(false);
    expect(isFileReadResult(null)).toBe(false);
    expect(isFileReadResult("just a string")).toBe(false);
    expect(isFileReadResult(["a", "b"])).toBe(false);
    // Missing the numeric fields → not a file read.
    expect(isFileReadResult({ path: "x", content: "y" })).toBe(false);
    // Shell-style result with stdout, not a file read.
    expect(isFileReadResult({ stdout: "ok", exitCode: 0 })).toBe(false);
  });
});
