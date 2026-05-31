import { describe, expect, it } from "vitest";
import {
  allocateColumnWidths,
  sliceByWidth,
  wrapSpans,
} from "../src/components/markdown.js";
import type { Span } from "../src/lib/markdown-parse.js";

const plain = (text: string): Span[] => [{ text }];
const join = (lines: Span[][]): string[] =>
  lines.map((l) => l.map((s) => s.text).join(""));

describe("sliceByWidth", () => {
  it("splits ascii by column count", () => {
    expect(sliceByWidth("abcdef", 3)).toEqual(["abc", "def"]);
  });
  it("counts CJK as two columns and never splits a wide glyph", () => {
    // "项" is 2 cols; budget 3 fits only one wide glyph.
    expect(sliceByWidth("项目a", 3)).toEqual(["项", "目a"]);
  });
});

describe("allocateColumnWidths", () => {
  it("keeps natural widths when they already fit", () => {
    expect(allocateColumnWidths([5, 5], [3, 3], 20)).toEqual([5, 5]);
  });
  it("shrinks the widest column first, respecting minimums", () => {
    const out = allocateColumnWidths([10, 4], [3, 3], 10);
    expect(out[0]! + out[1]!).toBe(10);
    expect(out[0]!).toBeGreaterThanOrEqual(3);
    expect(out[1]!).toBeGreaterThanOrEqual(3);
    // The big column absorbs the shrink rather than the small one.
    expect(out[0]!).toBeGreaterThan(out[1]!);
  });
  it("never shrinks a column below its minimum", () => {
    const out = allocateColumnWidths([8, 8], [6, 6], 4);
    expect(out).toEqual([6, 6]);
  });
});

describe("wrapSpans", () => {
  it("returns a single line when it fits", () => {
    expect(join(wrapSpans(plain("a b c"), 10))).toEqual(["a b c"]);
  });
  it("word-wraps at the width boundary", () => {
    expect(join(wrapSpans(plain("alpha beta gamma"), 11))).toEqual([
      "alpha beta",
      "gamma",
    ]);
  });
  it("hard-breaks a word longer than the column", () => {
    expect(join(wrapSpans(plain("abcdefghij"), 4))).toEqual([
      "abcd",
      "efgh",
      "ij",
    ]);
  });
  it("preserves inline styling on wrapped fragments", () => {
    const lines = wrapSpans([{ text: "bold here", bold: true }], 4);
    expect(lines.every((l) => l.every((s) => s.text === " " || s.bold))).toBe(
      true,
    );
  });
});
