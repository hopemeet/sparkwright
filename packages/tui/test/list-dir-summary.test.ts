import { describe, expect, it } from "vitest";
import {
  classifyToolResult,
  isListDirResult,
  isFileReadResult,
  summarizeListDir,
} from "../src/lib/tool-result-summary.js";

/**
 * Regression: a `list_dir` tool result was dumped as truncated raw JSON in the
 * transcript instead of a compact directory summary (read/skill_load got
 * clean summaries; list_dir fell through to oneLine).
 */
const sample = {
  path: ".",
  entries: [
    { path: "dist", name: "dist", type: "directory" },
    {
      path: "golden-path.ts",
      name: "golden-path.ts",
      type: "file",
      size: 1726,
    },
    { path: "package.json", name: "package.json", type: "file", size: 410 },
    { path: "tsconfig.json", name: "tsconfig.json", type: "file", size: 212 },
  ],
};

describe("isListDirResult", () => {
  it("recognises a list_dir envelope", () => {
    expect(isListDirResult(sample)).toBe(true);
    expect(classifyToolResult(sample)).toBe("list_dir");
  });

  it("does not mistake a read envelope for list_dir", () => {
    const read = {
      path: "README.md",
      content: "a\nb",
      totalLines: 2,
      bytes: 3,
    };
    expect(isListDirResult(read)).toBe(false);
    // and the read recogniser must not claim the list_dir envelope
    expect(isFileReadResult(sample)).toBe(false);
  });

  it("rejects non-objects and malformed entries", () => {
    expect(isListDirResult(null)).toBe(false);
    expect(isListDirResult("x")).toBe(false);
    expect(isListDirResult({ path: ".", entries: [{ name: "a" }] })).toBe(
      false,
    );
  });
});

describe("summarizeListDir", () => {
  it("counts entries and suffixes directories with /", () => {
    const { head, detail } = summarizeListDir(sample);
    expect(head).toBe("list_dir . → 4 entries");
    expect(detail).toBe(
      "dist/ · golden-path.ts · package.json · tsconfig.json",
    );
  });

  it("uses singular for one entry", () => {
    const { head } = summarizeListDir({
      path: "src",
      entries: [{ name: "index.ts", type: "file" }],
    });
    expect(head).toBe("list_dir src → 1 entry");
  });

  it("caps names and reports the remainder", () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({
      name: `f${i}.ts`,
      type: "file",
    }));
    const { head, detail } = summarizeListDir({ path: ".", entries }, 8);
    expect(head).toBe("list_dir . → 12 entries");
    expect(detail.endsWith("· +4 more")).toBe(true);
  });

  it("never emits raw JSON braces", () => {
    const { head, detail } = summarizeListDir(sample);
    expect(head + detail).not.toContain("{");
    expect(head + detail).not.toContain('"type"');
  });
});
