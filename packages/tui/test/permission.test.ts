import { describe, expect, it } from "vitest";
import {
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

  it("projects ask to a write-enabled approval path", () => {
    expect(toCoreRunFields("ask")).toEqual({
      permissionMode: "default",
      shouldWrite: true,
    });
  });
});
