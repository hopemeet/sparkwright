/**
 * Crash-safe terminal mode restoration.
 *
 * The TUI opts terminals into several private modes that the terminal keeps
 * set until explicitly cleared: bracketed paste (?2004h, input-box), focus
 * reporting (?1004h, attention), and mouse reporting (?1000h/?1006h, when a
 * future feature enables it). React effect cleanups restore these on a normal
 * unmount — but a hard exit (SIGINT/SIGTERM/SIGHUP from `kill`, or an uncaught
 * exception) skips effect cleanup, leaving the user's shell in a broken state:
 * pastes wrapped in `[200~…`, stray `[I`/`[O` on focus changes, a hidden
 * cursor.
 *
 * This installs process-level handlers that write the "restore everything"
 * sequence exactly once, on any exit path. It's a belt-and-suspenders safety
 * net: double-clearing a mode that an effect already cleared is a harmless
 * no-op, and clearing a mode that was never set is equally harmless.
 */

const ESC = "\x1b";

/**
 * Reset, in order: bracketed paste off, focus reporting off, mouse tracking
 * off (SGR + normal), show cursor. Writing a disable for a mode that isn't
 * active is ignored by the terminal, so we can unconditionally send the lot.
 */
export const TERMINAL_RESTORE_SEQUENCE =
  `${ESC}[?2004l` + // bracketed paste off
  `${ESC}[?1004l` + // focus reporting off
  `${ESC}[?1006l` + // SGR mouse off
  `${ESC}[?1000l` + // normal mouse off
  `${ESC}[?25h`; // show cursor

/** Build the restore sequence (exposed for tests / explicit callers). */
export function buildTerminalRestoreSequence(): string {
  return TERMINAL_RESTORE_SEQUENCE;
}

let installed = false;

/**
 * Register exit/signal handlers that restore terminal modes once. Returns a
 * disposer that removes the handlers (used by tests; the app keeps them for
 * its whole lifetime). Safe to call multiple times — only the first install
 * takes effect.
 */
export function installTerminalRestore(
  stdout: NodeJS.WriteStream = process.stdout,
): () => void {
  if (installed) return () => {};
  installed = true;

  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    try {
      if (stdout.isTTY) stdout.write(TERMINAL_RESTORE_SEQUENCE);
    } catch {
      // Nothing we can do if the stream is already gone; never throw from a
      // signal/exit handler.
    }
  };

  const onExit = (): void => restore();
  // For signals, restore then re-exit with the conventional 128+signal code so
  // the parent sees we died from that signal. We don't try to unmount Ink here
  // — this is the last-resort path; the normal quit flow goes through the app.
  const onSignal = (code: number) => (): void => {
    restore();
    process.exit(code);
  };
  const onUncaught = (err: unknown): void => {
    restore();
    // Surface the error after restoring so it isn't swallowed.
    console.error(err);
    process.exit(1);
  };

  const sigint = onSignal(130);
  const sigterm = onSignal(143);
  const sighup = onSignal(129);

  process.once("exit", onExit);
  process.once("SIGINT", sigint);
  process.once("SIGTERM", sigterm);
  process.once("SIGHUP", sighup);
  process.once("uncaughtException", onUncaught);

  return () => {
    process.off("exit", onExit);
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
    process.off("SIGHUP", sighup);
    process.off("uncaughtException", onUncaught);
    installed = false;
  };
}
