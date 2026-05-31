import { describe, expect, it } from "vitest";
import { asSessionId, createSessionId } from "../src/ids.js";

describe("asSessionId", () => {
  it("accepts a non-empty string", () => {
    expect(asSessionId("session_x")).toBe("session_x");
    expect(asSessionId(createSessionId())).toMatch(/^session_/);
  });

  it("rejects null/undefined/empty/whitespace at the intake edge", () => {
    expect(() => asSessionId(null as unknown as string)).toThrow(TypeError);
    expect(() => asSessionId(undefined as unknown as string)).toThrow(
      TypeError,
    );
    expect(() => asSessionId("")).toThrow(TypeError);
    expect(() => asSessionId("   ")).toThrow(TypeError);
    expect(() => asSessionId(42 as unknown as string)).toThrow(TypeError);
  });

  it("rejects path traversal and unsafe filesystem characters", () => {
    expect(() => asSessionId("../escape")).toThrow(TypeError);
    expect(() => asSessionId("nested/session")).toThrow(TypeError);
    expect(() => asSessionId("nested\\session")).toThrow(TypeError);
    expect(() => asSessionId(".")).toThrow(TypeError);
    expect(() => asSessionId("..")).toThrow(TypeError);
    expect(() => asSessionId(" session_x")).toThrow(TypeError);
  });
});
