import { describe, expect, it, vi } from "vitest";
import type { Key } from "ink";
import { InteractionRouter } from "../src/lib/interaction-router.js";
import { parseChord } from "../src/lib/keybindings.js";

const NO_MODIFIERS: Key = {
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
};

describe("InteractionRouter", () => {
  it("consumes exactly the first enabled matching action", () => {
    const router = new InteractionRouter();
    const first = vi.fn();
    const second = vi.fn();
    const result = router.route("?", NO_MODIFIERS, "", [
      {
        id: "help.open",
        scope: "global",
        chords: [parseChord("?")!],
        enabled: true,
        run: first,
      },
      {
        id: "other",
        scope: "global",
        chords: [parseChord("?")!],
        enabled: true,
        run: second,
      },
    ]);
    expect(result).toEqual({
      handled: true,
      scope: "global",
    });
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });

  it("bubbles printable shortcuts to a non-empty composer draft", () => {
    const router = new InteractionRouter();
    const run = vi.fn();
    const result = router.route("?", NO_MODIFIERS, "what", [
      {
        id: "help.open",
        scope: "global",
        chords: [parseChord("?")!],
        enabled: true,
        run,
      },
    ]);
    expect(result).toEqual({ handled: false });
    expect(run).not.toHaveBeenCalled();
  });
});
