import { describe, expect, it } from "vitest";
import {
  ACCESS_MODES,
  ACCESS_MODE_RANK,
  isRunAccessMode,
  compileRunAccessMode,
  clampAccessMode,
} from "../src/access-mode.js";

describe("run access mode", () => {
  it("compiles each access mode to the documented permissionMode + shouldWrite", () => {
    expect(compileRunAccessMode("read-only")).toEqual({
      permissionMode: "plan",
      shouldWrite: false,
    });
    expect(compileRunAccessMode("ask")).toEqual({
      permissionMode: "default",
      shouldWrite: true,
    });
    expect(compileRunAccessMode("accept-edits")).toEqual({
      permissionMode: "accept_edits",
      shouldWrite: true,
    });
    expect(compileRunAccessMode("bypass")).toEqual({
      permissionMode: "bypass_permissions",
      shouldWrite: true,
    });
  });

  it("only read-only is non-writing", () => {
    for (const mode of ACCESS_MODES) {
      const compiled = compileRunAccessMode(mode);
      expect(compiled.shouldWrite).toBe(mode !== "read-only");
    }
  });

  it("ranks autonomy read-only < ask < accept-edits < bypass", () => {
    expect(ACCESS_MODE_RANK["read-only"]).toBeLessThan(ACCESS_MODE_RANK.ask);
    expect(ACCESS_MODE_RANK.ask).toBeLessThan(ACCESS_MODE_RANK["accept-edits"]);
    expect(ACCESS_MODE_RANK["accept-edits"]).toBeLessThan(
      ACCESS_MODE_RANK.bypass,
    );
  });

  it("clamps a requested mode down to the ceiling but allows tightening", () => {
    // request exceeds ceiling -> clamped to ceiling
    expect(clampAccessMode("ask", "bypass")).toBe("ask");
    expect(clampAccessMode("accept-edits", "bypass")).toBe("accept-edits");
    // request within ceiling (more restrictive) -> request honored
    expect(clampAccessMode("bypass", "read-only")).toBe("read-only");
    expect(clampAccessMode("accept-edits", "ask")).toBe("ask");
    // equal -> requested
    expect(clampAccessMode("ask", "ask")).toBe("ask");
    // undefined fall-throughs
    expect(clampAccessMode(undefined, "bypass")).toBe("bypass");
    expect(clampAccessMode("ask", undefined)).toBe("ask");
    expect(clampAccessMode(undefined, undefined)).toBeUndefined();
  });

  it("recognizes only valid access mode strings", () => {
    expect(isRunAccessMode("ask")).toBe(true);
    expect(isRunAccessMode("read-only")).toBe(true);
    expect(isRunAccessMode("dont_ask")).toBe(false);
    expect(isRunAccessMode("plan")).toBe(false);
    expect(isRunAccessMode(undefined)).toBe(false);
  });
});
