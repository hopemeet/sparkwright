import { describe, expect, it } from "vitest";
import type { TranscriptDocument } from "../src/lib/transcript-document.js";
import {
  layoutTranscriptDocument,
  physicalRowsWidth,
  projectTranscriptRows,
  wrapTextWithOffsets,
} from "../src/lib/transcript-layout.js";

function doc(text: string): TranscriptDocument {
  return {
    epoch: "e1",
    blocks: [
      {
        key: "agent:one",
        kind: "agent",
        level: "primary",
        ordinal: 0,
        summary: [
          { key: "agent:one:summary", text, tone: "success", bold: true },
        ],
        details: [
          {
            key: "agent:one:result",
            label: "result",
            tone: "normal",
            rows: Array.from({ length: 10_000 }, (_, index) => ({
              key: `agent:one:result:${index}`,
              text: `输出 ${index}`,
              tone: "normal" as const,
            })),
          },
        ],
        visibility: "always",
      },
    ],
  };
}

describe("transcript layout", () => {
  it("wraps CJK by display width without splitting graphemes", () => {
    const rows = wrapTextWithOffsets("中文名称abcdef", 6);
    expect(rows.map((row) => row.text)).toEqual(["中文名", "称abcd", "ef"]);
    expect(rows.map((row) => row.offset)).toEqual([0, 3, 8]);
  });

  it("keeps combining and joined emoji graphemes intact", () => {
    const combining = wrapTextWithOffsets("e\u0301x", 1);
    expect(combining.map((row) => row.text)).toEqual(["e\u0301", "x"]);
    expect(combining.map((row) => row.offset)).toEqual([0, 2]);

    const family = wrapTextWithOffsets("👨‍👩‍👧x", 2);
    expect(family.map((row) => row.text)).toEqual(["👨‍👩‍👧", "x"]);
    expect(family.map((row) => row.offset)).toEqual([0, 8]);
  });

  it("shares summary rows between compact and detailed projections", () => {
    const document = doc("Agent · worker completed");
    const compact = projectTranscriptRows(document, "compact");
    const detailed = projectTranscriptRows(document, "detailed");
    expect(detailed[0]).toEqual(compact[0]);
    expect(detailed.some((row) => row.text.includes("result"))).toBe(true);
  });

  it("carries markdown and syntax styles into wrapped physical rows", () => {
    const document: TranscriptDocument = {
      epoch: "styled",
      blocks: [
        {
          key: "assistant",
          kind: "assistant",
          level: "primary",
          ordinal: 0,
          summary: [
            {
              key: "assistant:body",
              text: "**bold** and `code`\n\n```ts\nconst value = 1;\n```",
              tone: "normal",
              format: "markdown",
            },
          ],
          details: [],
          visibility: "always",
        },
      ],
    };

    const logical = projectTranscriptRows(document, "detailed");
    expect(
      logical.some((row) =>
        row.spans?.some((span) => span.text === "bold" && span.bold),
      ),
    ).toBe(true);
    expect(
      logical.some((row) =>
        row.spans?.some(
          (span) => span.text === "const" && span.color === "accent2",
        ),
      ),
    ).toBe(true);

    const physical = layoutTranscriptDocument(document, "detailed", 8).rows;
    expect(
      physical.every(
        (row) =>
          !row.spans ||
          row.spans.map((span) => span.text).join("") === row.text,
      ),
    ).toBe(true);
    expect(physical.every((row) => row.sourceEnd >= row.sourceOffset)).toBe(
      true,
    );
  });

  it("caps only materialized layout rows and preserves the document", () => {
    const document = doc("Agent · worker completed");
    const layout = layoutTranscriptDocument(document, "detailed", 80, {
      maxMaterializedRows: 2_000,
    });
    expect(layout.rows).toHaveLength(2_000);
    expect(layout.omittedRows).toBeGreaterThan(0);
    expect(layout.rows[0]?.text).toContain("omitted");
    expect(document.blocks[0]?.details[0]?.rows).toHaveLength(10_000);
    expect(physicalRowsWidth(layout.rows)).toBeLessThanOrEqual(80);
  });

  it.each([80, 100, 120])(
    "keeps CJK detailed rows within %i terminal columns",
    (columns) => {
      const layout = layoutTranscriptDocument(
        doc("Agent · 中文名称 completed · 50s"),
        "detailed",
        columns,
      );
      expect(physicalRowsWidth(layout.rows)).toBeLessThanOrEqual(columns);
    },
  );
});
