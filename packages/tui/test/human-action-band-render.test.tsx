import React from "react";
import { render } from "ink";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { SkillProposalCompletionCard } from "../src/components/skill-proposal-completion-card.js";

async function renderToText(
  inputs: string[] = [],
  onApply: (proposalId: string) => Promise<boolean> = async () => true,
): Promise<string> {
  const writes: string[] = [];
  const stdout = {
    columns: 100,
    rows: 24,
    write(value: string) {
      writes.push(value);
      return true;
    },
    on() {},
    off() {},
    removeListener() {},
  } as unknown as NodeJS.WriteStream;
  const stdin = new PassThrough() as NodeJS.ReadStream & {
    isTTY: boolean;
    setRawMode: () => void;
    ref: () => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const view = render(
    <SkillProposalCompletionCard
      active
      action={{
        kind: "skill_proposal_review",
        proposalId: "skillprop_abc123",
        reviewCommand: "/skill-review skillprop_abc123",
        eligibility: "quick_apply",
        validationStatus: "passed",
        contentMode: "authored",
        guardSeverity: "none",
        recommendedAction: "apply",
      }}
      onReview={() => {}}
      onApply={onApply}
      onDismiss={() => {}}
    />,
    { stdout, stdin, patchConsole: false },
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  for (const input of inputs) {
    stdin.write(input);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  view.unmount();
  stdin.destroy();
  // eslint-disable-next-line no-control-regex
  return writes.join("").replace(/\x1b\[[0-9;?]*[a-zA-Z]/gu, "");
}

describe("SkillProposalCompletionCard", () => {
  it("renders the quick apply and review affordances", async () => {
    const text = await renderToText();
    expect(text).toContain("Skill proposal ready for review");
    expect(text).toContain("Stored in the Skill inbox");
    expect(text).toContain("a apply · r review diff · esc dismiss");
  });

  it("renders a separate enter confirmation state", async () => {
    const text = await renderToText(["a"]);
    expect(text).toContain("Apply this prepared proposal?");
    expect(text).toContain("enter confirm apply · esc cancel");
  });

  it("renders an applying state that replaces key hints", async () => {
    const onApply = vi.fn(() => new Promise<boolean>(() => {}));
    const text = await renderToText(["a", "\r"], onApply);
    expect(text).toContain("applying proposal…");
    expect(text.lastIndexOf("applying proposal…")).toBeGreaterThan(
      text.lastIndexOf("a apply"),
    );
    expect(onApply).toHaveBeenCalledWith("skillprop_abc123");
  });
});
