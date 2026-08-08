import type { Key } from "ink";

/** Shared modal Back intent: Esc and Ctrl+C are equivalent inside a layer. */
export function isBackInput(input: string, key: Key): boolean {
  return key.escape || (key.ctrl && input === "c") || input.includes("\x03");
}
