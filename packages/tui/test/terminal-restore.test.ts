import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import {
  TERMINAL_ENTER_ALTERNATE_SCREEN_SEQUENCE,
  TERMINAL_RESTORE_SEQUENCE,
  buildTerminalRestoreSequence,
  enterTerminalSession,
  installTerminalRestore,
} from "../src/lib/terminal-restore.js";

describe("terminal restore sequence", () => {
  it("disables bracketed paste, focus, mouse and shows the cursor", () => {
    const seq = buildTerminalRestoreSequence();
    expect(seq).toBe(TERMINAL_RESTORE_SEQUENCE);
    expect(seq).toContain("\x1b[?2004l"); // bracketed paste off
    expect(seq).toContain("\x1b[?1004l"); // focus reporting off
    expect(seq).toContain("\x1b[?1006l"); // SGR mouse off
    expect(seq).toContain("\x1b[?1000l"); // normal mouse off
    expect(seq).toContain("\x1b[?25h"); // cursor visible
  });

  it("leaves the alternate screen after restoring private modes", () => {
    const seq = buildTerminalRestoreSequence(true);
    expect(seq).toContain(TERMINAL_RESTORE_SEQUENCE);
    expect(seq).toContain("\x1b[?1049l");
    expect(seq.endsWith("\x1b[?25h")).toBe(true);
  });
});

describe("installTerminalRestore", () => {
  let dispose: (() => void) | null = null;
  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  it("writes the restore sequence once on process 'exit'", () => {
    let written = "";
    const fake = {
      isTTY: true,
      write: (s: string) => {
        written += s;
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    dispose = installTerminalRestore(fake);
    process.emit("exit", 0 as never);
    expect(written).toBe(TERMINAL_RESTORE_SEQUENCE);
  });

  it("does not restore on the first SIGINT owned by App", () => {
    let written = "";
    const fake = {
      isTTY: true,
      write: (s: string) => {
        written += s;
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    dispose = installTerminalRestore(fake);
    process.emit("SIGINT");
    expect(written).toBe("");
  });

  it("is idempotent — a second install does not double-register", () => {
    const fake = {
      isTTY: false,
      write: () => true,
    } as unknown as NodeJS.WriteStream;
    const first = installTerminalRestore(fake);
    const second = installTerminalRestore(fake);
    // Second returns a no-op disposer; calling it must not throw.
    expect(() => second()).not.toThrow();
    dispose = first;
  });
});

describe("enterTerminalSession", () => {
  it("enters alternate screen and restores exactly once", () => {
    let written = "";
    const fake = {
      isTTY: true,
      write: (s: string) => {
        written += s;
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    const session = enterTerminalSession({
      stdout: fake,
      alternateScreen: true,
    });
    expect(written).toBe(TERMINAL_ENTER_ALTERNATE_SCREEN_SEQUENCE);
    session.restore();
    session.restore();
    expect(written).toBe(
      TERMINAL_ENTER_ALTERNATE_SCREEN_SEQUENCE +
        buildTerminalRestoreSequence(true),
    );
    session.dispose();
  });

  it("keeps the same viewport renderer but skips alt-screen escapes when disabled", () => {
    let written = "";
    const fake = {
      isTTY: true,
      write: (s: string) => {
        written += s;
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    const session = enterTerminalSession({
      stdout: fake,
      alternateScreen: false,
    });
    expect(written).toBe("");
    session.restore();
    expect(written).toBe(TERMINAL_RESTORE_SEQUENCE);
    session.dispose();
  });

  it("restores before SIGTERM exits with the signal status", () => {
    let written = "";
    const lifecycle = new FakeLifecycle();
    const session = enterTerminalSession({
      stdout: terminalStream((value) => {
        written += value;
      }),
      alternateScreen: true,
      process: lifecycle,
    });
    expect(() => lifecycle.emit("SIGTERM")).toThrow("exit 143");
    expect(lifecycle.exitCode).toBe(143);
    expect(written).toContain(buildTerminalRestoreSequence(true));
    session.dispose();
  });

  it("restores before SIGHUP exits with the signal status", () => {
    let written = "";
    const lifecycle = new FakeLifecycle();
    const session = enterTerminalSession({
      stdout: terminalStream((value) => {
        written += value;
      }),
      alternateScreen: true,
      process: lifecycle,
    });
    expect(() => lifecycle.emit("SIGHUP")).toThrow("exit 129");
    expect(lifecycle.exitCode).toBe(129);
    expect(written).toContain(buildTerminalRestoreSequence(true));
    session.dispose();
  });

  it("restores before reporting an uncaught render error", () => {
    let written = "";
    const reported: unknown[] = [];
    const lifecycle = new FakeLifecycle();
    const session = enterTerminalSession({
      stdout: terminalStream((value) => {
        written += value;
      }),
      alternateScreen: true,
      process: lifecycle,
      reportError: (error) => reported.push(error),
    });
    const failure = new Error("render exploded");
    expect(() => lifecycle.emit("uncaughtException", failure)).toThrow(
      "exit 1",
    );
    expect(reported).toEqual([failure]);
    expect(written).toContain(buildTerminalRestoreSequence(true));
    session.dispose();
  });
});

class FakeLifecycle extends EventEmitter {
  exitCode: number | undefined;

  exit(code?: number): never {
    this.exitCode = code;
    throw new Error(`exit ${code}`);
  }
}

function terminalStream(write: (value: string) => void): NodeJS.WriteStream {
  return {
    isTTY: true,
    write: (value: string) => {
      write(value);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
}
