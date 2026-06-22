import { describe, expect, it } from "vitest";
import { oneLine } from "../src/components/event-stream.js";

describe("oneLine", () => {
  // Regression: old terminal failure payloads could leave the renderer holding
  // undefined; JSON.stringify(undefined) is undefined and the old code then
  // called .replace on it, crashing the whole TUI.
  it("returns empty string for undefined/null without throwing", () => {
    expect(oneLine(undefined, 80)).toBe("");
    expect(oneLine(null, 80)).toBe("");
  });

  it("does not throw on a value that stringifies to undefined", () => {
    expect(oneLine(() => 1, 80)).toBe("() => 1");
    expect(oneLine(Symbol("x"), 80)).toBe("Symbol(x)");
  });

  it("compacts objects to one line and folds escaped whitespace", () => {
    expect(oneLine({ a: "x\ny" }, 80)).toBe('{"a":"x y"}');
  });

  it("truncates with an ellipsis past max", () => {
    expect(oneLine("abcdef", 4)).toBe("abc…");
  });
});
