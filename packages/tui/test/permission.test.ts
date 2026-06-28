import { describe, expect, it } from "vitest";
import {
  nextAllowedTuiPermissionMode,
  nextTuiPermissionMode,
  toCoreRunFields,
} from "../src/lib/permission.js";

describe("TUI permission modes", () => {
  it("cycles in the runtime hotkey order", () => {
    expect(nextTuiPermissionMode("read-only")).toBe("ask");
    expect(nextTuiPermissionMode("ask")).toBe("accept-edits");
    expect(nextTuiPermissionMode("accept-edits")).toBe("bypass");
    expect(nextTuiPermissionMode("bypass")).toBe("read-only");
  });

  it("cycles only through modes allowed by a project ceiling", () => {
    expect(nextAllowedTuiPermissionMode("ask", "ask")).toBe("read-only");
    expect(nextAllowedTuiPermissionMode("read-only", "ask")).toBe("ask");
    expect(nextAllowedTuiPermissionMode("bypass", "ask")).toBe("read-only");
  });

  it("projects ask to a write-enabled approval path", () => {
    expect(toCoreRunFields("ask")).toEqual({
      permissionMode: "default",
      shouldWrite: true,
    });
  });
});
