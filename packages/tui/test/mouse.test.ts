import { describe, expect, it } from "vitest";
import { MouseManager, type MouseEvent } from "../src/lib/mouse.js";

/**
 * Fake TTY streams. stdin exposes a `read()` backed by a queue — this mirrors
 * how Ink pulls input (paused mode + `stdin.read()`), which is exactly what
 * MouseManager wraps. stdout records writes so we can assert mode toggling.
 */
function makeStreams() {
  const queue: string[] = [];
  const stdin = {
    read: () => (queue.length ? queue.shift()! : null),
  } as unknown as NodeJS.ReadStream;
  const push = (s: string) => queue.push(s);
  const writes: string[] = [];
  const stdout = {
    isTTY: true,
    write: (s: string) => {
      writes.push(s);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stdin, stdout, writes, push };
}

/** Drain stdin the way Ink's readable handler does. */
function drain(stdin: NodeJS.ReadStream): string {
  let out = "";
  let chunk: string | Buffer | null;
  while (
    (chunk = (stdin as unknown as { read: () => string | null }).read()) !==
    null
  ) {
    out += chunk;
  }
  return out;
}

describe("MouseManager", () => {
  it("enables/disables SGR mouse mode and restores read()", () => {
    const { stdin, stdout, writes } = makeStreams();
    const before = (stdin as unknown as { read: unknown }).read;
    const m = new MouseManager({ stdin, stdout });
    m.enable();
    expect(writes.join("")).toContain("\x1b[?1006h");
    expect((stdin as unknown as { read: unknown }).read).not.toBe(before);
    m.disable();
    expect(writes.join("")).toContain("\x1b[?1006l");
    expect((stdin as unknown as { read: unknown }).read).toBe(before);
  });

  it("decodes wheel up/down and strips them from input", () => {
    const { stdin, stdout, push } = makeStreams();
    const m = new MouseManager({ stdin, stdout });
    const events: MouseEvent[] = [];
    m.enable();
    m.onEvent((e) => events.push(e));
    push("\x1b[<64;10;5M");
    push("\x1b[<65;10;5M");
    expect(drain(stdin)).toBe("");
    expect(events.map((e) => e.kind)).toEqual(["wheel-up", "wheel-down"]);
    expect(events[0]).toMatchObject({ x: 10, y: 5 });
  });

  it("decodes left click on press only", () => {
    const { stdin, stdout, push } = makeStreams();
    const m = new MouseManager({ stdin, stdout });
    const events: MouseEvent[] = [];
    m.enable();
    m.onEvent((e) => events.push(e));
    push("\x1b[<0;3;7M"); // press
    push("\x1b[<0;3;7m"); // release
    drain(stdin);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "click", x: 3, y: 7 });
  });

  it("passes non-mouse input through untouched", () => {
    const { stdin, stdout, push } = makeStreams();
    const m = new MouseManager({ stdin, stdout });
    const events: MouseEvent[] = [];
    m.enable();
    m.onEvent((e) => events.push(e));
    push("hello world");
    expect(drain(stdin)).toBe("hello world");
    expect(events).toHaveLength(0);
  });

  it("keeps real keys when a chunk mixes keys and a mouse report", () => {
    const { stdin, stdout, push } = makeStreams();
    const m = new MouseManager({ stdin, stdout });
    const events: MouseEvent[] = [];
    m.enable();
    m.onEvent((e) => events.push(e));
    // Esc key + a wheel report arriving in the same read.
    push("\x1b\x1b[<64;1;1M");
    expect(drain(stdin)).toBe("\x1b");
    expect(events.map((e) => e.kind)).toEqual(["wheel-up"]);
  });

  it("buffers a mouse report split across reads", () => {
    const { stdin, stdout, push } = makeStreams();
    const m = new MouseManager({ stdin, stdout });
    const events: MouseEvent[] = [];
    m.enable();
    m.onEvent((e) => events.push(e));
    push("\x1b[<64;10"); // partial — must not leak as text
    push(";5M"); // completes the report
    let out = drain(stdin);
    // Second drain after the completing chunk is queued.
    out += drain(stdin);
    expect(out).toBe("");
    expect(events.map((e) => e.kind)).toEqual(["wheel-up"]);
  });
});
