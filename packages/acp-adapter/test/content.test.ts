import { describe, expect, it } from "vitest";
import { contentBlocksToText } from "../src/content.js";

describe("ACP content conversion", () => {
  it("turns text and resources into a SparkWright goal", () => {
    expect(
      contentBlocksToText([
        { type: "text", text: "Fix the bug." },
        {
          type: "resource_link",
          name: "README",
          uri: "file:///tmp/project/README.md",
        },
        {
          type: "resource",
          resource: {
            uri: "file:///tmp/project/error.log",
            mimeType: "text/plain",
            text: "boom",
          },
        },
      ]),
    ).toBe(
      [
        "Fix the bug.",
        "Resource: README <file:///tmp/project/README.md>",
        "Resource: file:///tmp/project/error.log\nboom",
      ].join("\n\n"),
    );
  });
});
