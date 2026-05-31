import { describe, expect, it } from "vitest";
import {
  displayWidth,
  graphemeAt,
  graphemeWidth,
  nextGraphemeBoundary,
  nextWordBoundary,
  prevGraphemeBoundary,
  prevWordBoundary,
  toGraphemes,
} from "../src/lib/graphemes.js";

describe("displayWidth", () => {
  it("counts ascii as one column each", () => {
    expect(displayWidth("abc")).toBe(3);
  });
  it("counts CJK as two columns each", () => {
    expect(displayWidth("项目")).toBe(4);
  });
  it("folds a combining mark into its base (no extra column)", () => {
    expect(displayWidth("é")).toBe(1); // e + combining acute → one cluster
  });
  it("treats a ZWJ emoji sequence as a single wide cluster", () => {
    expect(displayWidth("👨‍👩‍👧")).toBe(2);
  });
  it("treats a flag (two regional indicators) as two columns", () => {
    expect(displayWidth("🇨🇳")).toBe(2);
  });
  it("treats a VS16 / emoji symbol as wide", () => {
    expect(graphemeWidth("⭐")).toBe(2);
    expect(displayWidth("a⭐b")).toBe(4);
  });
});

describe("grapheme boundaries", () => {
  it("treats an emoji ZWJ sequence as one cluster", () => {
    const family = "👨‍👩‍👧"; // man + ZWJ + woman + ZWJ + girl
    expect(toGraphemes(family)).toEqual([family]);
    // From the start, the next boundary jumps the whole cluster.
    expect(nextGraphemeBoundary(family, 0)).toBe(family.length);
    // From the end, the previous boundary is the start.
    expect(prevGraphemeBoundary(family, family.length)).toBe(0);
  });

  it("steps over a CJK character (one UTF-16 unit) as a whole", () => {
    const s = "a你b";
    expect(nextGraphemeBoundary(s, 0)).toBe(1); // past 'a'
    expect(nextGraphemeBoundary(s, 1)).toBe(2); // past '你'
    expect(prevGraphemeBoundary(s, 2)).toBe(1);
    expect(graphemeAt(s, 1)).toBe("你");
  });

  it("steps over an astral emoji (surrogate pair) as one grapheme", () => {
    const s = "x🚀y"; // 🚀 is two UTF-16 code units
    expect(nextGraphemeBoundary(s, 1)).toBe(3);
    expect(prevGraphemeBoundary(s, 3)).toBe(1);
    expect(graphemeAt(s, 1)).toBe("🚀");
  });

  it("clamps at the ends", () => {
    expect(prevGraphemeBoundary("abc", 0)).toBe(0);
    expect(nextGraphemeBoundary("abc", 3)).toBe(3);
    expect(graphemeAt("abc", 3)).toBe(" ");
  });
});

describe("word boundaries", () => {
  it("jumps whole words skipping separators", () => {
    const s = "foo  bar.baz";
    expect(nextWordBoundary(s, 0)).toBe(3); // end of "foo"
    expect(nextWordBoundary(s, 3)).toBe(8); // skip spaces, end of "bar"
    expect(prevWordBoundary(s, s.length)).toBe(9); // start of "baz"
    expect(prevWordBoundary(s, 8)).toBe(5); // start of "bar"
  });

  it("treats a CJK run as a single word", () => {
    const s = "hi 你好 ok";
    expect(nextWordBoundary(s, 3)).toBe(5); // past "你好"
    expect(prevWordBoundary(s, 5)).toBe(3);
  });
});
