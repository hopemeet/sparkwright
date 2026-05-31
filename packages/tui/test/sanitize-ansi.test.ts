import { describe, expect, it } from "vitest";
import { sanitizeAnsiForRender } from "../src/lib/text.js";

describe("sanitizeAnsiForRender", () => {
  it("passes plain text through unchanged", () => {
    expect(sanitizeAnsiForRender("hello world")).toBe("hello world");
  });

  it("keeps SGR colour/style sequences", () => {
    const sgr = "\x1b[1mbold\x1b[0m";
    expect(sanitizeAnsiForRender(sgr)).toBe(sgr);
  });

  it("strips cursor-move and erase CSIs but keeps the text", () => {
    expect(sanitizeAnsiForRender("a\x1b[2Jb\x1b[Hc")).toBe("abc");
  });

  it("strips an OSC hyperlink/title set (BEL- and ST-terminated)", () => {
    expect(sanitizeAnsiForRender("x\x1b]0;title\x07y")).toBe("xy");
    expect(sanitizeAnsiForRender("x\x1b]8;;http://a\x1b\\y")).toBe("xy");
  });

  it("drops an incomplete CSI fragment (no final byte)", () => {
    expect(sanitizeAnsiForRender("abc\x1b[")).toBe("abc");
    expect(sanitizeAnsiForRender("a\x1b[31")).toBe("a");
  });

  it("drops a complete non-SGR CSI including its final byte", () => {
    // ESC[31b — 'b' (REP) is a valid CSI final byte, so the whole sequence
    // goes; only the surrounding text remains.
    expect(sanitizeAnsiForRender("a\x1b[31bc")).toBe("ac");
  });

  it("removes control chars but preserves newline and tab", () => {
    expect(sanitizeAnsiForRender("a\x00b\x07c\td\ne")).toBe("abc\td\ne");
  });

  it("does not corrupt multibyte (CJK/emoji) text", () => {
    expect(sanitizeAnsiForRender("项目😀")).toBe("项目😀");
  });
});
