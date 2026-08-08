/**
 * Explicit terminal lifecycle for the full-screen TUI.
 *
 * SIGINT is intentionally not handled here: App owns the first-Ctrl+C
 * cancel/second-Ctrl+C exit contract. A real exit, hard signal, or crash still
 * restores every private terminal mode exactly once.
 */

const ESC = "\x1b";

export const TERMINAL_ENTER_ALTERNATE_SCREEN_SEQUENCE =
  `${ESC}[?1049h` + `${ESC}[H`;

export const TERMINAL_RESTORE_SEQUENCE =
  `${ESC}[?2004l` + // bracketed paste off
  `${ESC}[?1004l` + // focus reporting off
  `${ESC}[?1006l` + // SGR mouse off
  `${ESC}[?1000l` + // normal mouse off
  `${ESC}[?25h`; // show cursor

export function buildTerminalRestoreSequence(alternateScreen = false): string {
  return (
    TERMINAL_RESTORE_SEQUENCE +
    (alternateScreen ? `${ESC}[?1049l${ESC}[?25h` : "")
  );
}

interface ProcessLifecycle {
  once(event: "exit", listener: (code?: number) => void): unknown;
  once(event: "SIGTERM" | "SIGHUP", listener: () => void): unknown;
  once(event: "uncaughtException", listener: (error: unknown) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  exit(code?: number): never;
}

export interface TerminalSession {
  readonly alternateScreen: boolean;
  restore(): void;
  dispose(): void;
}

export interface EnterTerminalSessionOptions {
  stdout?: NodeJS.WriteStream;
  alternateScreen: boolean;
  process?: ProcessLifecycle;
  reportError?: (error: unknown) => void;
}

let activeSession: TerminalSession | null = null;

export function enterTerminalSession(
  options: EnterTerminalSessionOptions,
): TerminalSession {
  if (activeSession) return activeSession;
  const stdout = options.stdout ?? process.stdout;
  const lifecycle = options.process ?? (process as unknown as ProcessLifecycle);
  const alternateScreen = Boolean(options.alternateScreen && stdout.isTTY);
  let restored = false;
  let disposed = false;

  const safeWrite = (value: string): void => {
    try {
      if (stdout.isTTY) stdout.write(value);
    } catch {
      // The stream may already be gone during process teardown.
    }
  };
  if (alternateScreen) safeWrite(TERMINAL_ENTER_ALTERNATE_SCREEN_SEQUENCE);

  const restore = (): void => {
    if (restored) return;
    restored = true;
    safeWrite(buildTerminalRestoreSequence(alternateScreen));
  };
  const onExit = (): void => restore();
  const onSignal = (code: number) => (): void => {
    restore();
    lifecycle.exit(code);
  };
  const onUncaught = (error: unknown): void => {
    restore();
    (options.reportError ?? console.error)(error);
    lifecycle.exit(1);
  };
  const sigterm = onSignal(143);
  const sighup = onSignal(129);

  lifecycle.once("exit", onExit);
  lifecycle.once("SIGTERM", sigterm);
  lifecycle.once("SIGHUP", sighup);
  lifecycle.once("uncaughtException", onUncaught);

  const session: TerminalSession = {
    alternateScreen,
    restore,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      lifecycle.off("exit", asLifecycleListener(onExit));
      lifecycle.off("SIGTERM", asLifecycleListener(sigterm));
      lifecycle.off("SIGHUP", asLifecycleListener(sighup));
      lifecycle.off("uncaughtException", asLifecycleListener(onUncaught));
      if (activeSession === session) activeSession = null;
    },
  };
  activeSession = session;
  return session;
}

/**
 * Compatibility wrapper for callers that only need crash restoration without
 * entering the alternate screen.
 */
export function installTerminalRestore(
  stdout: NodeJS.WriteStream = process.stdout,
): () => void {
  return enterTerminalSession({
    stdout,
    alternateScreen: false,
  }).dispose;
}

function asLifecycleListener(
  listener: (...args: never[]) => void,
): (...args: unknown[]) => void {
  return listener as (...args: unknown[]) => void;
}
