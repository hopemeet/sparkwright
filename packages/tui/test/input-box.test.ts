import { describe, expect, it } from "vitest";
import { suggestionWindow } from "../src/components/input-box.js";

describe("suggestionWindow", () => {
  it("keeps the selected item visible after moving past the first page", () => {
    const items = Array.from({ length: 12 }, (_, i) => `cmd-${i + 1}`);

    const page = suggestionWindow(items, 6, 6);

    expect(page.start).toBe(3);
    expect(page.visible).toEqual([
      "cmd-4",
      "cmd-5",
      "cmd-6",
      "cmd-7",
      "cmd-8",
      "cmd-9",
    ]);
  });

  it("clamps the window near the end of the list", () => {
    const items = Array.from({ length: 12 }, (_, i) => `cmd-${i + 1}`);

    const page = suggestionWindow(items, 11, 6);

    expect(page.start).toBe(6);
    expect(page.visible).toEqual([
      "cmd-7",
      "cmd-8",
      "cmd-9",
      "cmd-10",
      "cmd-11",
      "cmd-12",
    ]);
  });
});
