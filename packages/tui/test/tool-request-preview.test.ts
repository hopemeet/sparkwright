import { describe, expect, it } from "vitest";
import {
  formatToolRequestPreview,
  oneLine,
} from "../src/lib/tool-request-preview.js";

describe("formatToolRequestPreview", () => {
  it("renders common read and search tool args without raw JSON", () => {
    expect(
      formatToolRequestPreview("list_dir", {
        path: ".",
        recursive: true,
        includeHidden: false,
      }),
    ).toBe(". recursive");
    expect(
      formatToolRequestPreview("read_file", {
        path: "README.md",
        offset: 1,
        limit: 20,
      }),
    ).toBe("README.md:1 +20");
    expect(
      formatToolRequestPreview("glob", {
        patterns: ["package.json", "pnpm-lock.yaml"],
      }),
    ).toBe("package.json, pnpm-lock.yaml");
    expect(
      formatToolRequestPreview("grep", {
        pattern: "TODO",
        path: "src",
      }),
    ).toBe("TODO in src");
  });

  it("keeps shell and skill mutations concise", () => {
    expect(
      formatToolRequestPreview("shell", {
        command: "npm test",
        timeoutMs: 120000,
      }),
    ).toBe("$ npm test");
    expect(
      formatToolRequestPreview("create_skill", {
        action: "create",
        name: "repo-reviewer",
        force: true,
      }),
    ).toBe("create repo-reviewer · force");
  });

  it("sanitizes fallback previews", () => {
    expect(oneLine({ value: "\u001b[2Jhello\nworld" }, 80)).toBe(
      '{"value":"hello world"}',
    );
  });
});
