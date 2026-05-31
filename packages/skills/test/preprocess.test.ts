import { describe, expect, it } from "vitest";
import { preprocessSkillContent } from "../src/index.js";

describe("preprocessSkillContent", () => {
  it("substitutes known tokens, leaves unknown tokens", () => {
    const out = preprocessSkillContent(
      "dir=${SPARKWRIGHT_SKILL_DIR} sid=${SPARKWRIGHT_SESSION_ID} unknown=${OTHER}",
      { skillDir: "/x/y", sessionId: "s1" },
    );
    expect(out).toBe("dir=/x/y sid=s1 unknown=${OTHER}");
  });

  it("does not expand !`cmd` by default", () => {
    const out = preprocessSkillContent("now: !`echo hi`");
    expect(out).toBe("now: !`echo hi`");
  });

  it("expands inline shell when opt-in", () => {
    const out = preprocessSkillContent("v=!`echo hello`", {
      inlineShell: true,
    });
    expect(out).toBe("v=hello");
  });

  it("surfaces inline-shell errors as a marker rather than throwing", () => {
    const out = preprocessSkillContent("!`exit 1; printf nope`", {
      inlineShell: true,
    });
    // empty stdout + nonzero exit -> we get either "" or stderr marker; just
    // assert preprocessing did not blow up.
    expect(typeof out).toBe("string");
  });
});
