/**
 * Mouse reporting via SGR extended mode. We enable button + wheel tracking
 * (1000) with SGR encoding (1006) so we get precise coordinates and wheel
 * events on terminals beyond the 223-column legacy limit.
 *
 * We only consume what we can act on usefully in a text TUI: the scroll wheel
 * (to scroll the event log) and left clicks (coordinates exposed for future
 * hit-testing — not wired to anything yet). Drag/move are intentionally NOT
 * enabled (1002/1003) so the terminal's own text selection still works when
 * the user holds the button.
 *
 * SGR sequence: ESC [ < b ; x ; y (M|m)
 *   b: button code; wheel up = 64, wheel down = 65; left = 0.
 *   trailing M = press, m = release.
 *
 * IMPORTANT: Ink reads stdin in paused mode via the 'readable' event and
 * `stdin.read()`. Attaching our own 'data' listener would flip the stream to
 * flowing mode and race Ink's reader — keys get dropped (Esc stops working)
 * and the raw SGR sequences leak into Ink's keypress parser (garbage in the
 * input box). So instead of listening separately, we wrap `stdin.read` to pull
 * out mouse sequences and hand Ink only the cleaned, mouse-free input.
 */

export type MouseEventKind = "wheel-up" | "wheel-down" | "click";

export interface MouseEvent {
  kind: MouseEventKind;
  x: number;
  y: number;
}

type Listener = (event: MouseEvent) => void;

const ENABLE = "\x1b[?1000h\x1b[?1006h";
const DISABLE = "\x1b[?1006l\x1b[?1000l";
// Complete SGR mouse report.
// eslint-disable-next-line no-control-regex
const SGR_RE = new RegExp("\\x1b\\[<(\\d+);(\\d+);(\\d+)([Mm])", "g");
// A trailing, not-yet-terminated SGR report (split across reads). We hold it
// back so a partial sequence never leaks into Ink as text.
// eslint-disable-next-line no-control-regex
const SGR_PARTIAL_RE = new RegExp("\\x1b\\[<[\\d;]*$");

type ReadFn = (size?: number) => string | Buffer | null;

export class MouseManager {
  private listeners = new Set<Listener>();
  private stdin: NodeJS.ReadStream;
  private stdout: NodeJS.WriteStream;
  private originalRead: ReadFn | null = null;
  private carry = "";
  private enabled = false;

  constructor(opts?: {
    stdin?: NodeJS.ReadStream;
    stdout?: NodeJS.WriteStream;
  }) {
    this.stdin = opts?.stdin ?? process.stdin;
    this.stdout = opts?.stdout ?? process.stdout;
  }

  enable(): void {
    if (this.enabled || !this.stdout.isTTY) return;
    this.enabled = true;
    this.stdout.write(ENABLE);

    const stdin = this.stdin as unknown as { read: ReadFn };
    const original = stdin.read as ReadFn;
    this.originalRead = original;
    stdin.read = (size?: number) => {
      const chunk = original.call(this.stdin, size);
      if (chunk === null) return null;
      const s = this.carry + chunk.toString("utf8");
      this.carry = "";
      if (!s.includes("\x1b[<")) return s;
      return this.extract(s);
    };
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.stdout.write(DISABLE);
    if (this.originalRead) {
      (this.stdin as unknown as { read: ReadFn }).read = this.originalRead;
      this.originalRead = null;
    }
    this.carry = "";
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Pull mouse reports out of `s`, dispatch them, and return the rest. */
  private extract(s: string): string {
    SGR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SGR_RE.exec(s)) !== null) {
      const button = Number(m[1]);
      const x = Number(m[2]);
      const y = Number(m[3]);
      const press = m[4] === "M";
      const event = decode(button, x, y, press);
      if (event) for (const l of this.listeners) l(event);
    }
    let rest = s.replace(SGR_RE, "");
    // Hold back a trailing partial report for the next read so it can't leak.
    const partial = SGR_PARTIAL_RE.exec(rest);
    if (partial) {
      this.carry = partial[0];
      rest = rest.slice(0, partial.index);
    }
    return rest;
  }
}

function decode(
  button: number,
  x: number,
  y: number,
  press: boolean,
): MouseEvent | null {
  // Wheel events are reported with the 64 bit set.
  if (button === 64) return { kind: "wheel-up", x, y };
  if (button === 65) return { kind: "wheel-down", x, y };
  // Left button press (button code 0, low 2 bits). Only fire on press, not
  // release, to avoid double events.
  if (press && (button & 0b11) === 0 && button < 64) {
    return { kind: "click", x, y };
  }
  return null;
}
