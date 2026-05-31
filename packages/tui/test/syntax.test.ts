import { describe, expect, it } from "vitest";
import { highlightLine, highlightLines } from "../src/lib/syntax.js";

const kinds = (
  toks: { text: string; kind: string }[],
): Record<string, string> =>
  Object.fromEntries(toks.map((t) => [t.text, t.kind]));

describe("highlightLine", () => {
  it("classifies keywords, identifiers, strings and numbers", () => {
    expect(highlightLine('const x = "hi";')).toEqual([
      { text: "const", kind: "keyword" },
      { text: " x = ", kind: "plain" },
      { text: '"hi"', kind: "string" },
      { text: ";", kind: "plain" },
    ]);
  });

  it("treats // as a line comment to end of line", () => {
    const out = highlightLine("return 1; // done");
    expect(out).toEqual([
      { text: "return", kind: "keyword" },
      { text: " ", kind: "plain" },
      { text: "1", kind: "number" },
      { text: "; ", kind: "plain" },
      { text: "// done", kind: "comment" },
    ]);
  });

  it("uses # comments for hash languages", () => {
    const out = highlightLine("x = 1  # set", "python");
    expect(out[out.length - 1]).toEqual({ text: "# set", kind: "comment" });
  });

  it("does not treat # as a comment in c-like languages", () => {
    const out = highlightLine("a # b", "ts");
    expect(out.some((t) => t.kind === "comment")).toBe(false);
  });

  it("handles escaped quotes inside strings", () => {
    const out = highlightLine('"a\\"b"');
    expect(out).toEqual([{ text: '"a\\"b"', kind: "string" }]);
  });

  it("uses -- comments for sql", () => {
    const out = highlightLine("SELECT 1 -- note", "sql");
    expect(out[out.length - 1]).toEqual({ text: "-- note", kind: "comment" });
  });

  it("does not treat Python builtins as keywords", () => {
    for (const word of ["map", "type", "string", "id"]) {
      const out = highlightLine(`${word} = 1`, "python");
      expect(out.some((t) => t.kind === "keyword")).toBe(false);
    }
  });

  it("highlights Python decorators", () => {
    expect(highlightLine("@dataclass", "python")).toEqual([
      { text: "@dataclass", kind: "decorator" },
    ]);
    expect(highlightLine("@app.route", "python")[0]).toEqual({
      text: "@app.route",
      kind: "decorator",
    });
  });

  it("splits f-string interpolation from the literal", () => {
    const out = highlightLine('return f"Hello {self.name}"', "python");
    expect(kinds(out)).toMatchObject({
      return: "keyword",
      'f"Hello ': "string",
      "{self.name}": "interp",
    });
  });

  it("splits template-literal interpolation in JS", () => {
    const out = highlightLine("`hi ${x}`", "ts");
    expect(out.find((t) => t.kind === "interp")).toEqual({
      text: "${x}",
      kind: "interp",
    });
  });
});

describe("highlightLines (cross-line state)", () => {
  it("colours a multi-line Python docstring uniformly as a string", () => {
    const block = ['"""', "line one", 'has "if x: return" text', '"""'];
    const out = highlightLines(block, "python");
    // Every line is entirely string — no stray keyword/plain leaking through.
    for (const toks of out) {
      expect(toks.every((t) => t.kind === "string")).toBe(true);
    }
  });

  it("resumes normal lexing after a docstring closes", () => {
    const out = highlightLines(
      ['"""doc', 'still doc"""', "return x"],
      "python",
    );
    expect(out[0]).toEqual([{ text: '"""doc', kind: "string" }]);
    expect(out[2]?.[0]).toEqual({ text: "return", kind: "keyword" });
  });

  it("carries an unterminated backtick template across lines", () => {
    const out = highlightLines(["const s = `a", "b`;"], "ts");
    expect(out[0]).toContainEqual({ text: "`a", kind: "string" });
    expect(out[1]).toContainEqual({ text: "b`", kind: "string" });
  });
});
