import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatWorkspaceDisplayPath,
  middleEllipsisPath,
} from "../src/index.js";

describe("path display", () => {
  it("leaves short paths unchanged when only ellipsizing", () => {
    expect(middleEllipsisPath("/tmp/project", 80)).toBe("/tmp/project");
  });

  it("middle-ellipsizes long paths while preserving the basename", () => {
    expect(
      middleEllipsisPath(
        "/Users/someone/workspaces/very/deep/nested/project-name",
        28,
      ),
    ).toBe("/Users/someone…/project-name");
  });

  it("preserves the basename tail when the basename alone is too wide", () => {
    expect(middleEllipsisPath("/tmp/extremely-long-project-name", 12)).toBe(
      "…roject-name",
    );
  });

  it("formats workspace paths as relative display paths", () => {
    const workspace = join("/tmp", "sparkwright-workspace");
    expect(
      formatWorkspaceDisplayPath(
        join(workspace, ".sparkwright", "skills", "demo"),
        { workspaceRoot: workspace },
      ),
    ).toBe(".sparkwright/skills/demo");
  });

  it("compacts absolute paths outside the workspace to a non-host locator", () => {
    expect(
      formatWorkspaceDisplayPath("/Users/alice/.codex/skills/demo/SKILL.md", {
        workspaceRoot: "/tmp/project",
      }),
    ).toBe("…/demo/SKILL.md");
  });

  it("applies max columns after workspace-relative projection", () => {
    const workspace = join("/tmp", "sparkwright-workspace");
    expect(
      formatWorkspaceDisplayPath(
        join(
          workspace,
          ".sparkwright",
          "skill-evolution",
          "proposals",
          "skillprop_123",
        ),
        { workspaceRoot: workspace, maxCols: 24 },
      ),
    ).toBe(".sparkwri…/skillprop_123");
  });
});
