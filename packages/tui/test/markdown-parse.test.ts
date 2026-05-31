import { describe, expect, it } from "vitest";
import { parseMarkdown, parseInline } from "../src/lib/markdown-parse.js";

describe("parseInline", () => {
  it("returns a single plain span for plain text", () => {
    expect(parseInline("hello world")).toEqual([{ text: "hello world" }]);
  });

  it("parses bold and italic", () => {
    expect(parseInline("**bold** and *italic*")).toEqual([
      { text: "bold", bold: true },
      { text: " and " },
      { text: "italic", italic: true },
    ]);
  });

  it("treats inline code verbatim (no emphasis inside)", () => {
    expect(parseInline("run `npm **test**`")).toEqual([
      { text: "run " },
      { text: "npm **test**", code: true },
    ]);
  });

  it("renders links as their label only", () => {
    expect(parseInline("see [the docs](http://x)")).toEqual([
      { text: "see " },
      { text: "the docs", link: true },
    ]);
  });

  it("leaves space-flanked asterisks literal (no style leak)", () => {
    expect(parseInline("a * b * c")).toEqual([{ text: "a * b * c" }]);
  });

  it("leaves intra-word and dunder underscores literal", () => {
    expect(parseInline("my_var_name and __main__")).toEqual([
      { text: "my_var_name and __main__" },
    ]);
  });

  it("still emphasizes single-word asterisk spans", () => {
    expect(parseInline("*x* and **y**")).toEqual([
      { text: "x", italic: true },
      { text: " and " },
      { text: "y", bold: true },
    ]);
  });

  it("honors underscore emphasis around a phrase", () => {
    expect(parseInline("_two words_")).toEqual([
      { text: "two words", italic: true },
    ]);
  });
});

describe("parseMarkdown", () => {
  it("parses a heading", () => {
    expect(parseMarkdown("## Title")).toEqual([
      { type: "heading", level: 2, spans: [{ text: "Title" }] },
    ]);
  });

  it("captures fenced code verbatim with language", () => {
    const blocks = parseMarkdown("```ts\nconst x = 1;\n```");
    expect(blocks).toEqual([
      { type: "code", lang: "ts", lines: ["const x = 1;"] },
    ]);
  });

  it("does not treat markdown inside a fence as blocks", () => {
    const blocks = parseMarkdown("```\n# not a heading\n- not a list\n```");
    expect(blocks).toEqual([
      {
        type: "code",
        lang: undefined,
        lines: ["# not a heading", "- not a list"],
      },
    ]);
  });

  it("groups consecutive list items", () => {
    const blocks = parseMarkdown("- one\n- two\n- three");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "list", ordered: false });
    expect((blocks[0] as { items: unknown[] }).items).toHaveLength(3);
  });

  it("detects ordered lists", () => {
    const blocks = parseMarkdown("1. a\n2. b");
    expect(blocks[0]).toMatchObject({ type: "list", ordered: true });
  });

  it("assigns nesting depth from indentation", () => {
    const blocks = parseMarkdown("- a\n  - a1\n  - a2\n- b\n    - b1");
    expect(blocks).toHaveLength(1);
    const items = (blocks[0] as { items: { depth: number }[] }).items;
    expect(items.map((it) => it.depth)).toEqual([0, 1, 1, 0, 1]);
  });

  it("keeps a loose ordered list with nested bullets as one block", () => {
    const blocks = parseMarkdown(
      "1. step one\n  - a\n  - b\n\n2. step two\n  - c\n  - d",
    );
    expect(blocks).toHaveLength(1);
    const items = (
      blocks[0] as { items: { depth: number; ordered: boolean }[] }
    ).items;
    expect(items.map((it) => it.ordered)).toEqual([
      true,
      false,
      false,
      true,
      false,
      false,
    ]);
    expect(items.map((it) => it.depth)).toEqual([0, 1, 1, 0, 1, 1]);
  });

  it("folds a lazy continuation line into the current item (numbering intact)", () => {
    const blocks = parseMarkdown("1. first\ncontinued\n2. second");
    expect(blocks).toHaveLength(1);
    const items = (
      blocks[0] as { items: { spans: { text: string }[]; ordered: boolean }[] }
    ).items;
    expect(items).toHaveLength(2);
    expect(items.every((it) => it.ordered)).toBe(true);
    expect(items[0].spans.map((s) => s.text).join("")).toBe("first continued");
  });

  it("parses a GFM table into header + rows, dropping the delimiter", () => {
    const blocks = parseMarkdown("| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |");
    expect(blocks).toHaveLength(1);
    const t = blocks[0] as {
      type: string;
      header: { text: string }[][];
      rows: { text: string }[][][];
    };
    expect(t.type).toBe("table");
    expect(t.header.map((c) => c[0].text)).toEqual(["A", "B"]);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[1].map((c) => c[0].text)).toEqual(["3", "4"]);
  });

  it("does not treat a plain pipe line as a table without a delimiter row", () => {
    const blocks = parseMarkdown("a | b | c");
    expect(blocks[0]).toMatchObject({ type: "paragraph" });
  });

  it("joins a multi-line paragraph and separates blocks on blank lines", () => {
    const blocks = parseMarkdown("line one\nline two\n\nsecond para");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: "paragraph" });
    expect((blocks[0] as { spans: { text: string }[] }).spans[0].text).toBe(
      "line one line two",
    );
  });

  it("honors a hard line break (trailing two spaces) within a paragraph", () => {
    const blocks = parseMarkdown("line one  \nline two");
    expect(blocks).toHaveLength(1);
    const spans = (blocks[0] as { spans: { text: string }[] }).spans;
    expect(spans.map((s) => s.text).join("")).toBe("line one\nline two");
  });

  it("soft-wraps lines without a hard break using a space", () => {
    const blocks = parseMarkdown("line one\nline two");
    const spans = (blocks[0] as { spans: { text: string }[] }).spans;
    expect(spans.map((s) => s.text).join("")).toBe("line one line two");
  });

  it("parses block quotes and horizontal rules", () => {
    const blocks = parseMarkdown("> quoted\n\n---");
    expect(blocks[0]).toMatchObject({ type: "quote" });
    expect(blocks[1]).toEqual({ type: "rule" });
  });

  it("keeps a multi-line block quote on separate lines, preserving a blank `>` line", () => {
    const blocks = parseMarkdown("> first.  \n>\n> second.");
    expect(blocks).toHaveLength(1);
    const lines = (blocks[0] as { type: string; lines: { text: string }[][] })
      .lines;
    expect(lines.map((l) => l.map((s) => s.text).join(""))).toEqual([
      "first.",
      "",
      "second.",
    ]);
  });

  it("soft-wraps consecutive block-quote lines into one visual line", () => {
    const blocks = parseMarkdown("> one\n> two");
    const lines = (blocks[0] as { lines: { text: string }[][] }).lines;
    expect(lines.map((l) => l.map((s) => s.text).join(""))).toEqual([
      "one two",
    ]);
  });

  it("treats an escaped pipe in a table cell as a literal, not a column break", () => {
    const blocks = parseMarkdown("| A | B |\n|---|---|\n| x | a\\|b |");
    const t = blocks[0] as { type: string; rows: { text: string }[][][] };
    expect(t.type).toBe("table");
    expect(t.rows[0]).toHaveLength(2);
    expect(t.rows[0][1].map((s) => s.text).join("")).toBe("a|b");
  });

  it("handles an unterminated fence by consuming to end of input", () => {
    const blocks = parseMarkdown("```\nunclosed");
    expect(blocks).toEqual([
      { type: "code", lang: undefined, lines: ["unclosed"] },
    ]);
  });
});
