import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../src/lib/diff.js";

describe("parseUnifiedDiff", () => {
  it("classifies header/hunk/add/del/ctx lines", () => {
    const diff = [
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,3 +1,4 @@",
      " context line",
      "-removed",
      "+added one",
      "+added two",
      " trailing",
    ].join("\n");
    const result = parseUnifiedDiff(diff);
    expect(result.additions).toBe(2);
    expect(result.deletions).toBe(1);
    expect(result.hunkCount).toBe(1);
    const kinds = result.lines.map((l) => l.kind);
    expect(kinds).toEqual([
      "header",
      "header",
      "hunk",
      "ctx",
      "del",
      "add",
      "add",
      "ctx",
    ]);
  });

  it("handles empty diff", () => {
    const result = parseUnifiedDiff("");
    expect(result.additions).toBe(0);
    expect(result.deletions).toBe(0);
    expect(result.hunkCount).toBe(0);
  });
});
