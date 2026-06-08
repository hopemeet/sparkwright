import { describe, expect, it } from "vitest";
import {
  parseChord,
  parseChords,
  chordMatches,
  ctrlCPressCount,
  formatBinding,
  mergeBindings,
  DEFAULTS,
} from "../src/lib/keybindings.js";

describe("parseChord", () => {
  it("parses simple printable chars", () => {
    expect(parseChord("k")).toEqual({
      ctrl: false,
      shift: false,
      meta: false,
      key: "k",
    });
  });
  it("parses modifiers + key", () => {
    expect(parseChord("ctrl+k")).toEqual({
      ctrl: true,
      shift: false,
      meta: false,
      key: "k",
    });
    expect(parseChord("alt+shift+tab")).toEqual({
      ctrl: false,
      shift: true,
      meta: true,
      key: "tab",
    });
  });
  it("rejects unknown special keys", () => {
    expect(parseChord("wibble")).toBeNull();
  });
  it("rejects two non-modifier parts", () => {
    expect(parseChord("k+q")).toBeNull();
  });
  it("returns null for empty input", () => {
    expect(parseChord("")).toBeNull();
    expect(parseChord("   ")).toBeNull();
  });
});

describe("chordMatches", () => {
  it("matches ctrl+k against Ink useInput", () => {
    const chord = parseChord("ctrl+k")!;
    expect(chordMatches(chord, { ctrl: true }, "k")).toBe(true);
    expect(chordMatches(chord, { ctrl: false }, "k")).toBe(false);
    expect(chordMatches(chord, { ctrl: true }, "j")).toBe(false);
  });
  it("matches ctrl+c when terminals report literal ETX", () => {
    const chord = parseChord("ctrl+c")!;
    expect(chordMatches(chord, {}, "\x03")).toBe(true);
    expect(chordMatches(chord, {}, "\x03\x03")).toBe(true);
    expect(chordMatches(chord, { ctrl: true }, "c")).toBe(true);
  });
  it("matches special keys via Ink flags", () => {
    const esc = parseChord("esc")!;
    expect(chordMatches(esc, { escape: true }, "")).toBe(true);
    expect(chordMatches(esc, { escape: false }, "")).toBe(false);
  });
  it("requires modifier parity", () => {
    const k = parseChord("k")!;
    expect(chordMatches(k, { ctrl: true }, "k")).toBe(false);
    expect(chordMatches(k, {}, "k")).toBe(true);
  });
});

describe("ctrlCPressCount", () => {
  it("counts bundled ETX bytes from a PTY input chunk", () => {
    expect(ctrlCPressCount("")).toBe(0);
    expect(ctrlCPressCount("\x03")).toBe(1);
    expect(ctrlCPressCount("\x03\x03")).toBe(2);
  });
});

describe("mergeBindings", () => {
  it("leaves palette and quick switch unbound by default", () => {
    expect(DEFAULTS["palette.open"]).toEqual([]);
    expect(DEFAULTS["quick.switch"]).toEqual([]);
  });

  it("returns defaults when user is undefined", () => {
    const { bindings, errors } = mergeBindings(undefined);
    expect(errors).toEqual([]);
    expect(bindings["palette.open"]).toEqual(DEFAULTS["palette.open"]);
  });
  it("overrides single binding", () => {
    const { bindings, errors } = mergeBindings({ "palette.open": "ctrl+p" });
    expect(errors).toEqual([]);
    expect(bindings["palette.open"]).toEqual([parseChord("ctrl+p")]);
    expect(bindings["help.open"]).toEqual(DEFAULTS["help.open"]);
  });
  it("clears binding when value is null/empty", () => {
    const a = mergeBindings({ "help.open": null });
    expect(a.bindings["help.open"]).toEqual([]);
    const b = mergeBindings({ "help.open": "" });
    expect(b.bindings["help.open"]).toEqual([]);
    const c = mergeBindings({ "help.open": [] });
    expect(c.bindings["help.open"]).toEqual([]);
  });
  it("accepts array of chords", () => {
    const { bindings } = mergeBindings({
      "palette.open": ["ctrl+k", "ctrl+p"],
    });
    expect(bindings["palette.open"]).toHaveLength(2);
  });
  it("reports unknown binding name", () => {
    const { errors } = mergeBindings({ "nope.open": "k" });
    expect(errors[0].name).toBe("nope.open");
  });
  it("reports unparseable chord", () => {
    const { errors } = mergeBindings({ "palette.open": "ctrl+wibble" });
    expect(errors[0].name).toBe("palette.open");
  });
});

describe("formatBinding", () => {
  it("renders chord lists", () => {
    expect(formatBinding(parseChords(["ctrl+k", "ctrl+p"]))).toBe(
      "ctrl+k, ctrl+p",
    );
  });
});
