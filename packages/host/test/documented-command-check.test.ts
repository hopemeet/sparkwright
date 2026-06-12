import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkDocumentedCommands,
  createDocumentedCommandStopHook,
} from "../src/documented-command-check.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("documented command check", () => {
  it("detects stale README command paths", () => {
    const workspace = mkdtempSync(join(tmpdir(), "sparkwright-host-doc-cmd-"));
    tempDirs.push(workspace);
    writeFileSync(
      join(workspace, "README.md"),
      [
        "# Demo",
        "",
        "```bash",
        "cargo test --manifest-path rust-utils/Cargo.toml",
        "cd missing-app && npm test",
        "npm --prefix missing-package test",
        "python scripts/release.py",
        "```",
        "",
      ].join("\n"),
    );

    expect(checkDocumentedCommands(workspace).map((issue) => issue.message))
      .toEqual([
        "cargo --manifest-path points to missing file: rust-utils/Cargo.toml",
        "cd target points to missing directory: missing-app",
        "package-manager --prefix points to missing directory: missing-package",
        "python script path points to missing file: scripts/release.py",
      ]);
  });

  it("provides a Stop hook that blocks finalization until stale commands are fixed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "sparkwright-host-doc-cmd-"));
    tempDirs.push(workspace);
    writeFileSync(
      join(workspace, "README.md"),
      [
        "# Demo",
        "",
        "```bash",
        "cargo test --manifest-path rust-utils/Cargo.toml",
        "```",
        "",
      ].join("\n"),
    );

    const [hook] = createDocumentedCommandStopHook({
      workspaceRoot: workspace,
      goal: "Prepare this repo for handoff and make documented commands pass",
      shouldWrite: true,
    });
    if (!hook) throw new Error("expected documented command hook");

    const result = await hook.handle({
      hook: "Stop",
      run: {
        id: "run_test" as never,
        goal: "Prepare this repo for handoff and make documented commands pass",
        state: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      payload: { message: "done" },
      metadata: {},
    });

    expect(result).toMatchObject({
      status: "block",
      findings: [
        {
          code: "STALE_DOCUMENTED_COMMAND",
          severity: "error",
          message:
            "README.md: cargo --manifest-path points to missing file: rust-utils/Cargo.toml",
        },
      ],
    });

    expect(
      await hook.handle({
        hook: "Stop",
        run: {
          id: "run_test" as never,
          goal: "Prepare this repo for handoff and make documented commands pass",
          state: "running",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        payload: { message: "done again" },
        metadata: {},
      }),
    ).toBeUndefined();

    mkdirSync(join(workspace, "rust-utils"), { recursive: true });
    writeFileSync(join(workspace, "rust-utils", "Cargo.toml"), "[package]\n");
    expect(
      await hook.handle({
        hook: "Stop",
        run: {
          id: "run_test" as never,
          goal: "Prepare this repo for handoff and make documented commands pass",
          state: "running",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        payload: { message: "done" },
        metadata: {},
      }),
    ).toBeUndefined();
  });
});
