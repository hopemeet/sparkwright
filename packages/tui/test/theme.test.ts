import { describe, expect, it } from "vitest";
import { resolveTheme, THEMES, DARK } from "../src/lib/theme.js";

describe("theme", () => {
  it("resolves known ids", () => {
    expect(resolveTheme("mono").id).toBe("mono");
    expect(resolveTheme("light").id).toBe("light");
    expect(resolveTheme("dark").id).toBe("dark");
  });
  it("falls back to dark for unknown/undefined", () => {
    expect(resolveTheme(undefined)).toBe(DARK);
    expect(resolveTheme("nope")).toBe(DARK);
  });
  it("every theme defines all semantic keys", () => {
    const keys = Object.keys(DARK);
    for (const t of Object.values(THEMES)) {
      for (const k of keys) {
        expect(t[k as keyof typeof t], `${t.id}.${k}`).toBeTruthy();
      }
    }
  });
});
