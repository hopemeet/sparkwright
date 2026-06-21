import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import React from "react";
import { render } from "ink";
import { SkillReviewDialog } from "../src/components/skill-review-dialog.js";
import type { TuiSkillReviewDetail } from "../src/lib/skill-evolution.js";

async function renderToText(
  element: React.ReactElement,
  inputs: string[] = [],
): Promise<string> {
  const writes: string[] = [];
  const fakeStdout = {
    columns: 120,
    rows: 28,
    write: (s: string) => {
      writes.push(s);
      return true;
    },
    on() {},
    off() {},
    removeListener() {},
  } as unknown as NodeJS.WriteStream;
  const fakeStdin = new PassThrough() as NodeJS.ReadStream & {
    isTTY: boolean;
    setRawMode: () => void;
    ref: () => void;
    unref: () => void;
  };
  fakeStdin.isTTY = true;
  fakeStdin.setRawMode = () => {};
  fakeStdin.ref = () => {};
  fakeStdin.unref = () => {};
  const { unmount } = render(element, {
    stdout: fakeStdout,
    stdin: fakeStdin,
    patchConsole: false,
  });
  await delay(30);
  for (const input of inputs) {
    fakeStdin.write(input);
    await delay(30);
  }
  await delay(60);
  unmount();
  fakeStdin.destroy();
  // eslint-disable-next-line no-control-regex
  return writes.join("").replace(/\[[0-9;?]*[a-zA-Z]/g, "");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("SkillReviewDialog rendering", () => {
  it("renders metadata paths through workspace-relative projection", async () => {
    const review: TuiSkillReviewDetail = {
      total: 1,
      items: [
        {
          id: "skillprop_123",
          kind: "update",
          state: "draft",
          skillName: "demo-skill",
          targetLayer: "project",
          targetPath: "/tmp/work/.sparkwright/skills/demo-skill",
          path: "/tmp/work/.sparkwright/skill-evolution/proposals/skillprop_123",
          createdAt: "2026-06-20T00:00:00.000Z",
          updatedAt: "2026-06-20T00:00:00.000Z",
          basePackageHash: "sha256:before",
          afterPackageHash: "sha256:after",
          summary: "Update demo skill.",
          sourceLayer: "project",
          sourcePath: "/tmp/work/.sparkwright/skills/demo-skill/SKILL.md",
          proposalMarkdown:
            "# Proposal\n\nTarget: .sparkwright/skills/demo-skill",
          patchDiff: "diff --git a/SKILL.md b/SKILL.md\n",
        },
      ],
    };

    const text = await renderToText(
      <SkillReviewDialog
        review={review}
        loading={false}
        workspaceRoot="/tmp/work"
        onApply={() => {}}
        onReject={() => {}}
        onCancel={() => {}}
      />,
      ["l", "l"],
    );

    expect(text).toContain("[metadata]");
    expect(text).toContain('"targetPath": ".sparkwright/skills/demo-skill"');
    expect(text).toContain(
      '"sourcePath": ".sparkwright/skills/demo-skill/SKILL.md"',
    );
    expect(text).not.toContain("/tmp/work/.sparkwright");
  });
});
