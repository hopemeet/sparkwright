import { describe, expect, it } from "vitest";
import { stripBracketedPaste } from "../src/components/input-box.js";

describe("stripBracketedPaste", () => {
  it("strips full CSI markers (ESC present)", () => {
    expect(stripBracketedPaste("\x1b[200~hello\x1b[201~")).toEqual({
      text: "hello",
      wasBracketed: true,
    });
  });

  it("strips bare markers when Ink has eaten the ESC (the leak case)", () => {
    expect(stripBracketedPaste("[200~给我一个列表[201~")).toEqual({
      text: "给我一个列表",
      wasBracketed: true,
    });
  });

  it("handles a start marker without a trailing end marker", () => {
    expect(stripBracketedPaste("[200~partial paste")).toEqual({
      text: "partial paste",
      wasBracketed: true,
    });
  });

  it("drops a lone end marker without treating it as a paste", () => {
    expect(stripBracketedPaste("tail[201~")).toEqual({
      text: "tail",
      wasBracketed: false,
    });
  });

  it("leaves ordinary input untouched", () => {
    expect(stripBracketedPaste("just typing")).toEqual({
      text: "just typing",
      wasBracketed: false,
    });
  });
});
