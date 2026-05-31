import { describe, expect, it } from "vitest";
import {
  AnchoredEditError,
  applyAnchoredEdits,
  createAnchoredText,
} from "../src/anchored-edit.js";

describe("anchored edits", () => {
  it("creates stable line anchors for model-facing reads", () => {
    const anchored = createAnchoredText(
      "src/example.ts",
      ["function hello() {", '  return "world";', "}"].join("\n"),
    );

    expect(anchored.lineCount).toBe(3);
    expect(anchored.content).toContain("1#");
    expect(anchored.content).toContain("| function hello()");
    expect(anchored.lines[1]).toMatchObject({
      line: 2,
      content: '  return "world";',
    });
    expect(anchored.lines[1]?.anchor).toMatch(/2#[A-Z0-9]{4}/);
  });

  it("applies replace, prepend, append, and delete operations", () => {
    const content = ["alpha", "beta", "gamma", "delta"].join("\n");
    const anchored = createAnchoredText("letters.txt", content);

    const result = applyAnchoredEdits({
      path: "letters.txt",
      content,
      edits: [
        {
          op: "prepend",
          anchor: anchored.lines[0]!.anchor,
          lines: ["zero"],
        },
        {
          op: "replace",
          anchor: anchored.lines[1]!.anchor,
          lines: ["BETA"],
        },
        {
          op: "append",
          anchor: anchored.lines[2]!.anchor,
          lines: ["after-gamma"],
        },
        {
          op: "delete",
          anchor: anchored.lines[3]!.anchor,
        },
      ],
    });

    expect(result.content).toBe(
      ["zero", "alpha", "BETA", "gamma", "after-gamma"].join("\n"),
    );
    expect(result.anchors).toHaveLength(4);
  });

  it("rejects stale anchors before changing content", () => {
    const anchored = createAnchoredText("config.txt", "port=3000\n");

    expect(() =>
      applyAnchoredEdits({
        path: "config.txt",
        content: "port=8080\n",
        edits: [
          {
            op: "replace",
            anchor: anchored.lines[0]!.anchor,
            lines: ["port=9000"],
          },
        ],
      }),
    ).toThrow(AnchoredEditError);

    try {
      applyAnchoredEdits({
        path: "config.txt",
        content: "port=8080\n",
        edits: [
          {
            op: "replace",
            anchor: anchored.lines[0]!.anchor,
            lines: ["port=9000"],
          },
        ],
      });
    } catch (error) {
      expect(error).toMatchObject({
        code: "ANCHOR_HASH_MISMATCH",
        metadata: {
          path: "config.txt",
        },
      });
    }
  });

  it("preserves CRLF and literal hashline-like content", () => {
    const content = "anchor: old\r\ntail\r\n";
    const anchored = createAnchoredText("hashline-content.txt", content);

    const result = applyAnchoredEdits({
      path: "hashline-content.txt",
      content,
      edits: [
        {
          op: "replace",
          anchor: anchored.lines[0]!.anchor,
          lines: ["anchor: 1#AB format is used"],
        },
      ],
    });

    expect(result.content).toBe("anchor: 1#AB format is used\r\ntail\r\n");
  });
});
