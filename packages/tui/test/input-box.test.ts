import { describe, expect, it } from "vitest";
import {
  inputBoxWidth,
  suggestionWindow,
} from "../src/components/input-box.js";

describe("inputBoxWidth", () => {
  it("fits inside the terminal with a small margin", () => {
    expect(inputBoxWidth(60)).toBe(58);
    expect(inputBoxWidth(120)).toBe(118);
  });

  it("keeps a minimum usable width", () => {
    expect(inputBoxWidth(10)).toBe(20);
  });
});

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
