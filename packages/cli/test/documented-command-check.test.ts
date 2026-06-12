import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkDocumentedCommands,
  shouldCheckDocumentedCommands,
  summarizeDocumentedCommandIssues,
} from "../src/documented-command-check.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("documented command check", () => {
  it("flags cargo manifest paths in README command blocks that do not exist", () => {
    const workspace = mkdtempSync(join(tmpdir(), "sparkwright-doc-cmd-"));
    tempDirs.push(workspace);
    writeFileSync(
      join(workspace, "README.md"),
      [
        "# Demo",
        "",
        "```bash",
        "python -m pytest",
        "cargo test --manifest-path rust-utils/Cargo.toml",
        "```",
        "",
      ].join("\n"),
    );

    const issues = checkDocumentedCommands(workspace);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      file: "README.md",
      message:
        "cargo --manifest-path points to missing file: rust-utils/Cargo.toml",
    });
    expect(summarizeDocumentedCommandIssues(issues)).toContain(
      "stale documented command",
    );
  });

  it("passes cargo manifest paths that exist", () => {
    const workspace = mkdtempSync(join(tmpdir(), "sparkwright-doc-cmd-"));
    tempDirs.push(workspace);
    mkdirSync(join(workspace, "rust-helper"), { recursive: true });
    writeFileSync(join(workspace, "rust-helper", "Cargo.toml"), "[package]\n");
    writeFileSync(
      join(workspace, "README.md"),
      [
        "# Demo",
        "",
        "```bash",
        "cargo test --manifest-path rust-helper/Cargo.toml",
        "```",
        "",
      ].join("\n"),
    );

    expect(checkDocumentedCommands(workspace)).toEqual([]);
  });

  it("flags common documented command paths that do not exist", () => {
    const workspace = mkdtempSync(join(tmpdir(), "sparkwright-doc-cmd-"));
    tempDirs.push(workspace);
    writeFileSync(
      join(workspace, "README.md"),
      [
        "# Demo",
        "",
        "```bash",
        "cd missing-app && npm test",
        "npm --prefix missing-package test",
        "python scripts/release.py",
        "```",
        "",
      ].join("\n"),
    );

    expect(
      checkDocumentedCommands(workspace).map((issue) => issue.message),
    ).toEqual([
      "cd target points to missing directory: missing-app",
      "package-manager --prefix points to missing directory: missing-package",
      "python script path points to missing file: scripts/release.py",
    ]);
  });

  it("only enables the check for write-enabled verification-style goals", () => {
    expect(
      shouldCheckDocumentedCommands({
        goal: "Inspect this project and identify likely failures",
        shouldWrite: false,
      }),
    ).toBe(false);
    expect(
      shouldCheckDocumentedCommands({
        goal: "Prepare this repo for handoff and make documented commands pass",
        shouldWrite: true,
      }),
    ).toBe(true);
  });
});
