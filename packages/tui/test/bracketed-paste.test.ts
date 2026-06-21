import { describe, expect, it } from "vitest";
import {
  normalizeBracketedPasteChunk,
  stripBracketedPaste,
} from "../src/components/input-box.js";

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

describe("normalizeBracketedPasteChunk", () => {
  it("keeps multi-event pasted newlines in the draft instead of submitting", () => {
    let inPaste = false;
    let text = "";
    for (const [input, isReturn] of [
      ["[200~只要触碰跨入口、跨运行路径、跨包的共享语义。", false],
      ["\r", true],
      ["\r", true],
      ["如果只是某个入口自己的交互细节。", false],
      ["这样能避免过度抽象。[201~", false],
    ] as const) {
      const chunk = normalizeBracketedPasteChunk(input, isReturn, inPaste);
      expect(chunk.handled).toBe(true);
      text += chunk.text;
      inPaste = chunk.inPaste;
    }

    expect(inPaste).toBe(false);
    expect(text).toBe(
      "只要触碰跨入口、跨运行路径、跨包的共享语义。\n\n如果只是某个入口自己的交互细节。这样能避免过度抽象。",
    );
  });

  it("drops a lone paste end marker without leaking it into input", () => {
    expect(normalizeBracketedPasteChunk("tail[201~", false, false)).toEqual({
      handled: true,
      text: "tail",
      inPaste: false,
    });
  });

  it("normalizes carriage returns inside paste chunks", () => {
    expect(
      normalizeBracketedPasteChunk("[200~a\rb\r\nc[201~", false, false),
    ).toEqual({
      handled: true,
      text: "a\nb\nc",
      inPaste: false,
    });
  });

  it("leaves ordinary typing for the normal editor path", () => {
    expect(normalizeBracketedPasteChunk("hello", false, false)).toEqual({
      handled: false,
      text: "hello",
      inPaste: false,
    });
  });
});
