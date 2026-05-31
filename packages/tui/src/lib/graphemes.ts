/**
 * Grapheme- and word-boundary helpers for the input editor.
 *
 * The editor keeps its cursor as a UTF-16 code-unit index into the value
 * string (so paste-placeholder / @-mention slicing stays simple), but cursor
 * MOVEMENT and the rendered caret must respect grapheme clusters — otherwise
 * an arrow key lands in the middle of an emoji or a combining sequence and the
 * caret renders half a character. `Intl.Segmenter` gives us correct cluster
 * boundaries; we fall back to code points where it's unavailable.
 *
 * All functions are pure and operate on code-unit indices so they can be
 * unit-tested without Ink.
 */

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** Code-unit start index of every grapheme cluster in `s` (plus none for end). */
function graphemeStarts(s: string): number[] {
  const starts: number[] = [];
  if (segmenter) {
    for (const seg of segmenter.segment(s)) starts.push(seg.index);
  } else {
    let i = 0;
    for (const cp of s) {
      starts.push(i);
      i += cp.length;
    }
  }
  return starts;
}

/** Split a string into grapheme clusters. */
export function toGraphemes(s: string): string[] {
  if (!s) return [];
  if (segmenter) return Array.from(segmenter.segment(s), (seg) => seg.segment);
  return Array.from(s);
}

/** True for East-Asian wide / fullwidth code points (two terminal columns). */
export function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** True for code points that terminals render emoji-wide (two columns). */
function isEmojiCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1f000 && cp <= 0x1faff) || // pictographs, emoticons, symbols, flags-region
    (cp >= 0x2600 && cp <= 0x27bf) || // misc symbols + dingbats
    cp === 0x2b50 ||
    cp === 0x2b55 ||
    (cp >= 0x2300 && cp <= 0x23ff) // misc technical (⌚⏰ etc.)
  );
}

/**
 * Display width of one grapheme cluster in terminal columns. Iterating by
 * grapheme (not code point) is what makes this correct: combining marks and
 * ZWJ-joined emoji collapse into their base cluster, so `é` (é) is 1 and
 * `👨‍👩‍👧` is 2 instead of being over-counted per code point. A trailing
 * VS16 (U+FE0F) or a ZWJ forces emoji presentation → 2; a flag (two regional
 * indicators) is a single wide cluster.
 */
export function graphemeWidth(g: string): number {
  if (!g) return 0;
  // VS16 (emoji presentation selector) or ZWJ (joined emoji sequence) → wide.
  if (g.includes("️") || g.includes("‍")) return 2;
  const cp = g.codePointAt(0) ?? 0;
  if (isWideCodePoint(cp) || isEmojiCodePoint(cp)) return 2;
  return 1;
}

/** Grapheme-aware display width (terminal columns) of a string. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const g of toGraphemes(s)) w += graphemeWidth(g);
  return w;
}

/** Largest grapheme boundary strictly before `i` (clamped to 0). */
export function prevGraphemeBoundary(s: string, i: number): number {
  if (i <= 0) return 0;
  let prev = 0;
  for (const start of graphemeStarts(s)) {
    if (start >= i) break;
    prev = start;
  }
  return prev;
}

/** Smallest grapheme boundary strictly after `i` (clamped to s.length). */
export function nextGraphemeBoundary(s: string, i: number): number {
  if (i >= s.length) return s.length;
  for (const start of graphemeStarts(s)) {
    if (start > i) return start;
  }
  return s.length;
}

/** The grapheme cluster beginning at boundary `i` (a single space at the end). */
export function graphemeAt(s: string, i: number): string {
  if (i >= s.length) return " ";
  return s.slice(i, nextGraphemeBoundary(s, i)) || " ";
}

// A "word" char is a letter, number, or underscore. `\p{L}` includes CJK, so
// word-jump treats a run of CJK as one word — coarse but predictable.
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Start of the word at or before `i` (bash-style ctrl/alt+left). */
export function prevWordBoundary(s: string, i: number): number {
  let j = Math.max(0, Math.min(i, s.length));
  while (j > 0 && !WORD_CHAR.test(s[j - 1])) j--;
  while (j > 0 && WORD_CHAR.test(s[j - 1])) j--;
  return j;
}

/** End of the word at or after `i` (bash-style ctrl/alt+right). */
export function nextWordBoundary(s: string, i: number): number {
  let j = Math.max(0, Math.min(i, s.length));
  while (j < s.length && !WORD_CHAR.test(s[j])) j++;
  while (j < s.length && WORD_CHAR.test(s[j])) j++;
  return j;
}
