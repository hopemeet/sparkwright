/**
 * A small, self-contained vim engine for the input box. Kept pure (no React, no
 * Ink) so the modal logic is unit-testable in isolation — the InputBox just
 * feeds it keys when `input.vim` is enabled and renders the returned state.
 *
 * Scope: NORMAL and INSERT modes over a (possibly multi-line) string with a
 * code-unit cursor. Supported in normal mode:
 *   motions:   h l 0 ^ $ w b e j k
 *   inserts:   i a I A o O
 *   edits:     x D C   and operators  dd cc dw cw d$ c$
 * Counts, registers, visual mode, and search are intentionally omitted; this is
 * a convenience layer, not a vim clone.
 */

export type VimMode = "normal" | "insert";

export interface VimState {
  mode: VimMode;
  value: string;
  cursor: number;
  /** A pending operator ("d" or "c") awaiting its motion, else null. */
  pending: "d" | "c" | null;
}

export interface VimKey {
  return?: boolean;
  escape?: boolean;
  backspace?: boolean;
  delete?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
}

export function initialVimState(value = "", cursor = 0): VimState {
  return { mode: "normal", value, cursor, pending: null };
}

/** Start/end (code-unit) of the line containing `pos`. */
function lineBounds(
  value: string,
  pos: number,
): { start: number; end: number } {
  const start = value.lastIndexOf("\n", pos - 1) + 1;
  let end = value.indexOf("\n", pos);
  if (end === -1) end = value.length;
  return { start, end };
}

const WORD = /[A-Za-z0-9_]/;
function classOf(ch: string): "word" | "space" | "punct" {
  if (/\s/.test(ch)) return "space";
  return WORD.test(ch) ? "word" : "punct";
}

function nextWord(value: string, pos: number): number {
  const n = value.length;
  if (pos >= n) return n;
  const startClass = classOf(value[pos]);
  let i = pos;
  // skip the current run (unless on space)
  if (startClass !== "space") {
    while (i < n && classOf(value[i]) === startClass) i++;
  }
  while (i < n && classOf(value[i]) === "space") i++;
  return i;
}

function prevWord(value: string, pos: number): number {
  let i = pos - 1;
  while (i > 0 && classOf(value[i]) === "space") i--;
  if (i <= 0) return 0;
  const cls = classOf(value[i]);
  while (i > 0 && classOf(value[i - 1]) === cls) i--;
  return i;
}

function wordEnd(value: string, pos: number): number {
  const n = value.length;
  let i = pos + 1;
  while (i < n && classOf(value[i]) === "space") i++;
  if (i >= n) return n - 1 < 0 ? 0 : n - 1;
  const cls = classOf(value[i]);
  while (i + 1 < n && classOf(value[i + 1]) === cls) i++;
  return i;
}

/** Clamp the cursor to a valid normal-mode column (can't sit past last char). */
function clampNormal(value: string, cursor: number): number {
  const { start, end } = lineBounds(value, cursor);
  const last = Math.max(start, end - 1);
  return Math.min(Math.max(cursor, start), end === start ? start : last);
}

function deleteRange(state: VimState, from: number, to: number): VimState {
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(state.value.length, Math.max(from, to));
  const value = state.value.slice(0, lo) + state.value.slice(hi);
  return { ...state, value, cursor: lo, pending: null };
}

/** Apply one key. `input` is the printable char ("" for special keys). */
export function vimKey(state: VimState, input: string, key: VimKey): VimState {
  if (state.mode === "insert") {
    if (key.escape) {
      // Leaving insert nudges the cursor left, vim-style.
      const { start } = lineBounds(state.value, state.cursor);
      return {
        ...state,
        mode: "normal",
        cursor: Math.max(start, state.cursor - 1),
        pending: null,
      };
    }
    return state; // InputBox handles actual text entry in insert mode
  }

  // ---- NORMAL mode ----
  const v = state.value;
  const cur = state.cursor;
  const { start, end } = lineBounds(v, cur);

  // Pending operator (d/c) consuming a motion.
  if (state.pending) {
    const op = state.pending;
    const enterInsert = op === "c";
    // doubled operator (dd / cc) = whole line
    if ((op === "d" && input === "d") || (op === "c" && input === "c")) {
      const lineStart = start;
      const lineEnd = end < v.length ? end + 1 : end; // include trailing \n
      const next = deleteRange(state, lineStart, lineEnd);
      return enterInsert ? { ...next, mode: "insert" } : next;
    }
    let target = cur;
    if (input === "w") target = nextWord(v, cur);
    else if (input === "$") target = end;
    else if (input === "0") target = start;
    else if (input === "b") target = prevWord(v, cur);
    else {
      return { ...state, pending: null }; // unknown motion cancels
    }
    const next = deleteRange(state, cur, target);
    return enterInsert
      ? { ...next, mode: "insert" }
      : { ...next, cursor: clampNormal(next.value, next.cursor) };
  }

  if (key.escape) return { ...state, pending: null };

  // Arrow keys mirror hjkl so they aren't dead in normal mode.
  if (key.leftArrow) return vimKey(state, "h", {});
  if (key.rightArrow) return vimKey(state, "l", {});
  if (key.upArrow) return vimKey(state, "k", {});
  if (key.downArrow) return vimKey(state, "j", {});

  switch (input) {
    case "i":
      return { ...state, mode: "insert" };
    case "a":
      return { ...state, mode: "insert", cursor: Math.min(end, cur + 1) };
    case "I":
      return { ...state, mode: "insert", cursor: start };
    case "A":
      return { ...state, mode: "insert", cursor: end };
    case "o": {
      const value = v.slice(0, end) + "\n" + v.slice(end);
      return { ...state, mode: "insert", value, cursor: end + 1 };
    }
    case "O": {
      const value = v.slice(0, start) + "\n" + v.slice(start);
      return { ...state, mode: "insert", value, cursor: start };
    }
    case "h":
      return { ...state, cursor: Math.max(start, cur - 1) };
    case "l":
      return { ...state, cursor: Math.min(Math.max(start, end - 1), cur + 1) };
    case "0":
      return { ...state, cursor: start };
    case "$":
      return { ...state, cursor: Math.max(start, end - 1) };
    case "^": {
      let i = start;
      while (i < end && /\s/.test(v[i])) i++;
      return { ...state, cursor: i };
    }
    case "w":
      return { ...state, cursor: nextWord(v, cur) };
    case "b":
      return { ...state, cursor: prevWord(v, cur) };
    case "e":
      return { ...state, cursor: wordEnd(v, cur) };
    case "j": {
      const below = lineBounds(v, end < v.length ? end + 1 : cur);
      if (end >= v.length) return state;
      const col = cur - start;
      return { ...state, cursor: Math.min(below.start + col, below.end) };
    }
    case "k": {
      if (start === 0) return state;
      const above = lineBounds(v, start - 1);
      const col = cur - start;
      return { ...state, cursor: Math.min(above.start + col, above.end) };
    }
    case "x": {
      if (start === end) return state;
      const next = deleteRange(state, cur, cur + 1);
      return { ...next, cursor: clampNormal(next.value, next.cursor) };
    }
    case "D":
      return deleteRange(state, cur, end);
    case "C":
      return { ...deleteRange(state, cur, end), mode: "insert" };
    case "d":
      return { ...state, pending: "d" };
    case "c":
      return { ...state, pending: "c" };
    default:
      return state;
  }
}
