import { describe, expect, it } from "vitest";
import {
  formatWorkspaceDisplayPath,
  middleEllipsisPath,
} from "../src/lib/path-display.js";

describe("path display", () => {
  it("leaves short paths unchanged", () => {
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

  it("formats workspace paths through the shared display projection", () => {
    expect(
      formatWorkspaceDisplayPath("/tmp/work/.sparkwright/skills/demo", {
        workspaceRoot: "/tmp/work",
      }),
    ).toBe(".sparkwright/skills/demo");
  });

  it("compacts absolute paths outside the workspace", () => {
    expect(
      formatWorkspaceDisplayPath("/Users/alice/.codex/skills/demo/SKILL.md", {
        workspaceRoot: "/tmp/work",
      }),
    ).toBe("…/demo/SKILL.md");
  });
});
