/**
 * Text hygiene for terminal rendering.
 *
 * Model output (and tool results echoed into the transcript) can carry raw
 * escape sequences: OSC title/hyperlink sets, cursor-movement CSIs, incomplete
 * `ESC[` fragments, and stray control bytes. Passed straight into Ink these
 * corrupt layout (Yoga measures with stripped ANSI but the terminal still acts
 * on the bytes) and can leak cursor moves / clear-screen into the transcript.
 *
 * `sanitizeAnsiForRender` removes all of that while keeping SGR (colour/style)
 * sequences — `ESC [ ... m` — and the only whitespace controls a renderer
 * needs, `\n` and `\t`.
 */

const ESC = "\x1b";

/** True for a CSI final byte (0x40–0x7E). */
function isCsiFinal(ch: string): boolean {
  return ch >= "\x40" && ch <= "\x7e";
}

export function sanitizeAnsiForRender(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;

    if (ch === ESC) {
      const next = input[i + 1];

      // OSC: ESC ] ... terminated by BEL (\x07) or ST (ESC \). Always dropped.
      if (next === "]") {
        let j = i + 2;
        while (
          j < input.length &&
          input[j] !== "\x07" &&
          !(input[j] === ESC && input[j + 1] === "\\")
        ) {
          j += 1;
        }
        if (j >= input.length) return out; // unterminated → drop to end
        i = input[j] === "\x07" ? j + 1 : j + 2;
        continue;
      }

      // CSI: ESC [ params/intermediates (0x20–0x3F) then a final byte.
      if (next === "[") {
        let j = i + 2;
        while (j < input.length && input[j]! >= "\x20" && input[j]! <= "\x3f") {
          j += 1;
        }
        const finalByte = input[j];
        if (finalByte !== undefined && isCsiFinal(finalByte)) {
          // Keep colour/style (SGR, final 'm'); drop every other CSI (cursor
          // moves, erases, scroll regions, …).
          if (finalByte === "m") out += input.slice(i, j + 1);
          i = j + 1;
          continue;
        }
        // Incomplete CSI (no valid final byte): drop the consumed prefix.
        i = j;
        continue;
      }

      // Any other escape (ESC X, or a lone trailing ESC): drop the ESC byte.
      i += 1;
      continue;
    }

    // Strip C0 control chars except the newline/tab a renderer needs, and DEL.
    if ((ch < "\x20" && ch !== "\n" && ch !== "\t") || ch === "\x7f") {
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}
