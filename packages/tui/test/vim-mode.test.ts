import { describe, expect, it } from "vitest";
import { initialVimState, vimKey, type VimState } from "../src/lib/vim-mode.js";

const K = {}; // no special key flags
function press(state: VimState, keys: string): VimState {
  let s = state;
  for (const ch of keys) s = vimKey(s, ch, K);
  return s;
}

describe("vim-mode normal motions", () => {
  const base = () => ({ ...initialVimState("hello world", 0) });

  it("h/l move within the line and clamp", () => {
    let s = base();
    s = press(s, "lll"); // 0 -> 3
    expect(s.cursor).toBe(3);
    s = press(s, "hh"); // 3 -> 1
    expect(s.cursor).toBe(1);
    s = press(s, "hhhh"); // clamp at 0
    expect(s.cursor).toBe(0);
  });

  it("0 and $ jump to line ends", () => {
    let s = press(base(), "$");
    expect(s.cursor).toBe("hello world".length - 1);
    s = press(s, "0");
    expect(s.cursor).toBe(0);
  });

  it("w and b move by word", () => {
    let s = press(base(), "w"); // -> start of "world" (index 6)
    expect(s.cursor).toBe(6);
    s = press(s, "b"); // back to start of "hello"
    expect(s.cursor).toBe(0);
  });

  it("arrow keys mirror hjkl in normal mode", () => {
    let s = initialVimState("hello", 0);
    s = vimKey(s, "", { rightArrow: true });
    expect(s.cursor).toBe(1);
    s = vimKey(s, "", { leftArrow: true });
    expect(s.cursor).toBe(0);
  });

  it("j/k move between lines keeping column", () => {
    let s = initialVimState("abcd\nefgh", 2); // on 'c'
    s = vimKey(s, "j", {});
    expect(s.cursor).toBe(7); // 'g' on line 2
    s = vimKey(s, "k", {});
    expect(s.cursor).toBe(2);
  });
});

describe("vim-mode insert transitions", () => {
  it("i/a/A/I enter insert at the right spot", () => {
    expect(vimKey(initialVimState("abc", 1), "i", {}).mode).toBe("insert");
    expect(vimKey(initialVimState("abc", 1), "a", {}).cursor).toBe(2);
    expect(vimKey(initialVimState("abc", 1), "A", {}).cursor).toBe(3);
    expect(vimKey(initialVimState("abc", 1), "I", {}).cursor).toBe(0);
  });

  it("o/O open a line and enter insert", () => {
    const o = vimKey(initialVimState("abc", 1), "o", {});
    expect(o.value).toBe("abc\n");
    expect(o.mode).toBe("insert");
    const O = vimKey(initialVimState("abc", 1), "O", {});
    expect(O.value).toBe("\nabc");
    expect(O.cursor).toBe(0);
  });

  it("esc leaves insert and nudges left", () => {
    const s = vimKey(
      { mode: "insert", value: "abc", cursor: 3, pending: null },
      "",
      { escape: true },
    );
    expect(s.mode).toBe("normal");
    expect(s.cursor).toBe(2);
  });
});

describe("vim-mode edits and operators", () => {
  it("x deletes the char under the cursor", () => {
    const s = vimKey(initialVimState("abc", 1), "x", {});
    expect(s.value).toBe("ac");
    expect(s.cursor).toBe(1);
  });

  it("D deletes to end of line", () => {
    const s = vimKey(initialVimState("hello world", 6), "D", {});
    expect(s.value).toBe("hello ");
  });

  it("dd deletes the whole line", () => {
    const s = press(initialVimState("line1\nline2", 2), "dd");
    expect(s.value).toBe("line2");
  });

  it("dw deletes a word", () => {
    const s = press(initialVimState("foo bar", 0), "dw");
    expect(s.value).toBe("bar");
  });

  it("cw deletes a word and enters insert", () => {
    const s = press(initialVimState("foo bar", 0), "cw");
    expect(s.value).toBe("bar");
    expect(s.mode).toBe("insert");
  });

  it("C changes to end of line (delete + insert)", () => {
    const s = vimKey(initialVimState("hello world", 6), "C", {});
    expect(s.value).toBe("hello ");
    expect(s.mode).toBe("insert");
  });
});
