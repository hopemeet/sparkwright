import { describe, expect, it } from "vitest";
import {
  ACCESS_MODES as CORE_ACCESS_MODES,
  BACKGROUND_TASK_POLICIES as CORE_BACKGROUND_TASK_POLICIES,
} from "@sparkwright/core";
import {
  ACCESS_MODES as PROTOCOL_ACCESS_MODES,
  BACKGROUND_TASK_POLICIES as PROTOCOL_BACKGROUND_TASK_POLICIES,
  isRunAccessMode,
} from "@sparkwright/protocol";
import {
  buildAccessMetadata,
  resolveRunAccessFields,
} from "../src/run-access.js";

describe("run access resolution", () => {
  it("keeps the protocol wire mirror in sync with core", () => {
    expect([...PROTOCOL_ACCESS_MODES]).toEqual([...CORE_ACCESS_MODES]);
    expect([...PROTOCOL_BACKGROUND_TASK_POLICIES]).toEqual([
      ...CORE_BACKGROUND_TASK_POLICIES,
    ]);
    for (const mode of CORE_ACCESS_MODES)
      expect(isRunAccessMode(mode)).toBe(true);
  });

  it("defaults omitted access to read-only", () => {
    expect(resolveRunAccessFields({}, {})).toEqual({
      accessMode: "read-only",
      permissionMode: "plan",
      shouldWrite: false,
      backgroundTasks: "enabled",
    });
  });

  it("compiles the canonical accessMode into the internal execution plan", () => {
    expect(resolveRunAccessFields({ accessMode: "accept-edits" }, {})).toEqual({
      accessMode: "accept-edits",
      permissionMode: "accept_edits",
      shouldWrite: true,
      backgroundTasks: "enabled",
    });
  });

  it("clamps a requested accessMode to the configured ceiling", () => {
    const resolved = resolveRunAccessFields(
      { accessMode: "bypass" },
      { accessModeCeiling: "ask" },
    );
    expect(resolved).toEqual({
      accessMode: "ask",
      permissionMode: "default",
      shouldWrite: true,
      backgroundTasks: "enabled",
      requestedAccessMode: "bypass",
      accessModeCeiling: "ask",
    });
    expect(buildAccessMetadata(resolved)).toEqual({
      accessMode: "ask",
      requestedAccessMode: "bypass",
      accessModeCeiling: "ask",
    });
  });

  it("resolves and records background task policy clamps", () => {
    const resolved = resolveRunAccessFields(
      { accessMode: "ask", backgroundTasks: "enabled" },
      { backgroundTasksCeiling: "foreground-only" },
    );
    expect(resolved).toEqual({
      accessMode: "ask",
      permissionMode: "default",
      shouldWrite: true,
      backgroundTasks: "foreground-only",
      requestedBackgroundTasks: "enabled",
      backgroundTasksCeiling: "foreground-only",
    });
    expect(buildAccessMetadata(resolved)).toEqual({
      accessMode: "ask",
      backgroundTasks: "foreground-only",
      requestedBackgroundTasks: "enabled",
      backgroundTasksCeiling: "foreground-only",
    });
  });
});
