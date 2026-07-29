import type { Key } from "ink";
import { describe, expect, it } from "vitest";
import { transcriptBrowseIntent } from "../src/components/transcript-browse-footer.js";

const key = (value: Partial<Key>): Key =>
  ({
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...value,
  }) as Key;

describe("transcript browse mode", () => {
  it("owns plain directional keys and Escape", () => {
    expect(transcriptBrowseIntent("", key({ upArrow: true }))).toBe("line-up");
    expect(transcriptBrowseIntent("", key({ downArrow: true }))).toBe(
      "line-down",
    );
    expect(transcriptBrowseIntent("", key({ escape: true }))).toBe("close");
    expect(transcriptBrowseIntent("", key({ escape: true, meta: true }))).toBe(
      "close",
    );
  });

  it("leaves modified and unrelated keys to global routing", () => {
    expect(
      transcriptBrowseIntent("", key({ ctrl: true, upArrow: true })),
    ).toBeNull();
    expect(transcriptBrowseIntent("t", key({ ctrl: true }))).toBeNull();
    expect(transcriptBrowseIntent("x", key({}))).toBeNull();
  });
});
