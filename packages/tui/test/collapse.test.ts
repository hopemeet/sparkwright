import { describe, expect, it } from "vitest";
import { collapseText, prettyJson } from "../src/lib/collapse.js";

describe("collapseText", () => {
  it("returns full body when within bounds", () => {
    const r = collapseText("short", 10, 100);
    expect(r.overflow).toBe(false);
    expect(r.body).toBe("short");
  });
  it("truncates by line count", () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const r = collapseText(text, 5, 10_000);
    expect(r.overflow).toBe(true);
    expect(r.body.split("\n").length).toBe(5);
    expect(r.droppedLines).toBe(15);
  });
  it("truncates by char count", () => {
    const r = collapseText("a".repeat(100), 10, 30);
    expect(r.overflow).toBe(true);
    expect(r.body.endsWith("…")).toBe(true);
    expect(r.body.length).toBe(30);
  });
  it("handles empty input", () => {
    const r = collapseText("", 10, 100);
    expect(r.body).toBe("");
    expect(r.overflow).toBe(false);
  });
});

describe("prettyJson", () => {
  it("formats a normal object", () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
  it("handles circular refs without throwing", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    const out = prettyJson(a);
    expect(out).toContain("[Circular]");
  });
  it("stringifies bigint", () => {
    expect(prettyJson({ n: BigInt(42) })).toContain('"42n"');
  });
});
