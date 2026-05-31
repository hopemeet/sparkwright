/**
 * Terminal focus detection + attention signals (bell + OSC 9 notification).
 *
 * We opt into xterm focus reporting (CSI ?1004h). Most modern terminals
 * (iTerm2, Kitty, WezTerm, Alacritty, recent Apple Terminal, GNOME Terminal)
 * support this. The terminal then emits CSI I when focused and CSI O when
 * blurred; we sniff them off stdin without intercepting normal key events.
 *
 * When attention is required and the terminal is blurred, we:
 *  - write a BEL (\x07) — universal audio cue
 *  - write OSC 9 with the message — iTerm2 and a few others surface this as
 *    a native notification; other terminals ignore it
 *
 * Anything fancier (desktop notifications, sounds) would require platform
 * deps; the bell + OSC 9 combo is the most portable thing that just works.
 */

type Listener = (focused: boolean) => void;

const FOCUS_ENABLE = "\x1b[?1004h";
const FOCUS_DISABLE = "\x1b[?1004l";
// eslint-disable-next-line no-control-regex
const FOCUS_IN_RE = new RegExp("\\x1b\\[I", "g");
// eslint-disable-next-line no-control-regex
const FOCUS_OUT_RE = new RegExp("\\x1b\\[O", "g");

export class AttentionManager {
  private focused = true;
  private listeners = new Set<Listener>();
  private stdin: NodeJS.ReadStream;
  private stdout: NodeJS.WriteStream;
  private dataListener: ((chunk: Buffer | string) => void) | null = null;
  private enabled = false;

  constructor(opts?: {
    stdin?: NodeJS.ReadStream;
    stdout?: NodeJS.WriteStream;
  }) {
    this.stdin = opts?.stdin ?? process.stdin;
    this.stdout = opts?.stdout ?? process.stdout;
  }

  /**
   * Enable focus reporting. Safe to call multiple times. No-op if stdout is
   * not a TTY (e.g. piped logs).
   */
  enable(): void {
    if (this.enabled || !this.stdout.isTTY) return;
    this.enabled = true;
    this.stdout.write(FOCUS_ENABLE);
    this.dataListener = (chunk) => {
      const s = chunk.toString("utf8");
      // Last event wins if both appear in the same chunk.
      const hasIn = FOCUS_IN_RE.test(s);
      const hasOut = FOCUS_OUT_RE.test(s);
      FOCUS_IN_RE.lastIndex = 0;
      FOCUS_OUT_RE.lastIndex = 0;
      if (hasOut) this.setFocused(false);
      if (hasIn) this.setFocused(true);
    };
    this.stdin.on("data", this.dataListener);
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.stdout.write(FOCUS_DISABLE);
    if (this.dataListener) this.stdin.off("data", this.dataListener);
    this.dataListener = null;
  }

  isFocused(): boolean {
    return this.focused;
  }

  /** Subscribe to focus changes; returns unsubscribe. */
  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Request user attention if we believe the terminal is blurred. Caller
   * passes a short human-readable reason for the OSC 9 notification body.
   * Returns true if a signal was actually emitted.
   */
  notify(reason: string): boolean {
    if (this.focused || !this.stdout.isTTY) return false;
    // BEL — terminals usually map this to a visible/audible cue per user config.
    this.stdout.write("\x07");
    // OSC 9 notification — iTerm2 and friends surface this as a native banner.
    // Strip control bytes from the reason to keep the sequence well-formed.
    const safe = reason
      // eslint-disable-next-line no-control-regex
      .replace(new RegExp("[\\x00-\\x1f\\x7f]", "g"), " ")
      .slice(0, 200);
    this.stdout.write(`\x1b]9;${safe}\x07`);
    return true;
  }

  private setFocused(next: boolean): void {
    if (this.focused === next) return;
    this.focused = next;
    for (const l of this.listeners) l(next);
  }
}
