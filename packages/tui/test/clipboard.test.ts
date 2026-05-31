import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildOsc52, copyToClipboard } from "../src/lib/clipboard.js";

const ESC = "\x1b";
const BEL = "\x07";

describe("buildOsc52", () => {
  const savedTmux = process.env.TMUX;
  const savedSty = process.env.STY;
  beforeEach(() => {
    delete process.env.TMUX;
    delete process.env.STY;
  });
  afterEach(() => {
    if (savedTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = savedTmux;
    if (savedSty === undefined) delete process.env.STY;
    else process.env.STY = savedSty;
  });

  it("base64-encodes the payload into an OSC 52 set-clipboard sequence", () => {
    const seq = buildOsc52("hello");
    const b64 = Buffer.from("hello", "utf8").toString("base64");
    expect(seq).toBe(`${ESC}]52;c;${b64}${BEL}`);
  });

  it("round-trips utf-8 (emoji/CJK) through base64", () => {
    const text = "你好 🚀";
    const seq = buildOsc52(text);
    const b64 = seq.slice(`${ESC}]52;c;`.length, -1);
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(text);
  });

  it("wraps the sequence in tmux passthrough, doubling every ESC", () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1,0";
    const seq = buildOsc52("x");
    expect(seq.startsWith(`${ESC}Ptmux;`)).toBe(true);
    expect(seq.endsWith(`${ESC}\\`)).toBe(true);
    // The inner OSC's ESC is doubled by the tmux envelope.
    expect(seq).toContain(`${ESC}${ESC}]52;c;`);
  });

  it("wraps in a screen DCS passthrough under $STY", () => {
    process.env.STY = "1234.pts-0.host";
    const seq = buildOsc52("x");
    expect(seq.startsWith(`${ESC}P`)).toBe(true);
    expect(seq.startsWith(`${ESC}Ptmux;`)).toBe(false);
    expect(seq.endsWith(`${ESC}\\`)).toBe(true);
  });
});

describe("copyToClipboard", () => {
  it("writes the sequence when stdout is a TTY", () => {
    let written = "";
    const fake = {
      isTTY: true,
      write: (s: string) => {
        written += s;
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    expect(copyToClipboard("hi", fake)).toBe(true);
    expect(written).toBe(buildOsc52("hi"));
  });

  it("is a no-op (returns false) when stdout is not a TTY", () => {
    let written = "";
    const fake = {
      isTTY: false,
      write: (s: string) => {
        written += s;
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    expect(copyToClipboard("hi", fake)).toBe(false);
    expect(written).toBe("");
  });
});
