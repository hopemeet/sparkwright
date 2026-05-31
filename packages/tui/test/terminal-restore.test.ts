import { afterEach, describe, expect, it } from "vitest";
import {
  TERMINAL_RESTORE_SEQUENCE,
  buildTerminalRestoreSequence,
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
