import React from "react";
import { render } from "ink";
import { describe, expect, it } from "vitest";
import { SkillProposalCompletionCard } from "../src/components/skill-proposal-completion-card.js";

async function renderToText(
  confirmingApply: boolean,
  applying = false,
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
  const stdin = {
    isTTY: true,
    setRawMode() {},
    setEncoding() {},
    on() {},
    off() {},
    removeListener() {},
    read() {
      return null;
    },
    ref() {},
    unref() {},
    resume() {},
    pause() {},
  } as unknown as NodeJS.ReadStream;
  const view = render(
    <SkillProposalCompletionCard
      confirmingApply={confirmingApply}
      applying={applying}
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
    />,
    { stdout, stdin, patchConsole: false },
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  view.unmount();
  // eslint-disable-next-line no-control-regex
  return writes.join("").replace(/\x1b\[[0-9;?]*[a-zA-Z]/gu, "");
}

describe("SkillProposalCompletionCard", () => {
  it("renders the quick apply and review affordances", async () => {
    const text = await renderToText(false);
    expect(text).toContain("Skill proposal ready for review");
    expect(text).toContain("Stored in the Skill inbox");
    expect(text).toContain("a apply · r review diff · esc dismiss");
  });

  it("renders a separate enter confirmation state", async () => {
    const text = await renderToText(true);
    expect(text).toContain("confirm apply · enter confirm · esc cancel");
  });

  it("renders an applying state that replaces key hints", async () => {
    const text = await renderToText(false, true);
    expect(text).toContain("applying proposal…");
    expect(text).not.toContain("a apply");
  });
});
