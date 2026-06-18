import { describe, expect, it } from "vitest";
import {
  inputBoxWidth,
  inputLineViewport,
  inputMaxVisibleLines,
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

describe("inputMaxVisibleLines", () => {
  it("caps normal terminals at eight lines", () => {
    expect(inputMaxVisibleLines(40)).toBe(8);
  });

  it("keeps a usable smaller window on short terminals", () => {
    expect(inputMaxVisibleLines(20)).toBe(4);
    expect(inputMaxVisibleLines(12)).toBe(3);
  });
});

describe("inputLineViewport", () => {
  it("shows all lines when content fits", () => {
    expect(inputLineViewport(3, 1, 8)).toEqual({
      start: 0,
      end: 3,
      hiddenBefore: 0,
      hiddenAfter: 0,
    });
  });

  it("centers the window around the caret when content is longer", () => {
    expect(inputLineViewport(20, 10, 8)).toEqual({
      start: 6,
      end: 14,
      hiddenBefore: 6,
      hiddenAfter: 6,
    });
  });

  it("clamps near the beginning and end", () => {
    expect(inputLineViewport(20, 1, 8)).toMatchObject({
      start: 0,
      end: 8,
      hiddenBefore: 0,
      hiddenAfter: 12,
    });
    expect(inputLineViewport(20, 19, 8)).toMatchObject({
      start: 12,
      end: 20,
      hiddenBefore: 12,
      hiddenAfter: 0,
    });
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
