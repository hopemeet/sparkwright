import { describe, expect, it } from "vitest";
import { inputFooterLines } from "../src/app.js";
import { DEFAULTS } from "../src/lib/keybindings.js";

describe("inputFooterLines", () => {
  it("wraps on item boundaries for narrow terminals", () => {
    const lines = inputFooterLines(DEFAULTS, 58);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.length <= 58)).toBe(true);
    expect(lines.join("\n")).toContain("shift+tab mode");
    expect(lines.join("\n")).toContain("ctrl+r search");
    expect(lines.join("\n")).toContain("ctrl+o inspector");
  });

  it("keeps a single line when there is enough room", () => {
    const lines = inputFooterLines(DEFAULTS, 140);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("enter run");
    expect(lines[0]).toContain("shift+tab mode");
    expect(lines[0]).toContain("ctrl+c quit x2");
  });
});
