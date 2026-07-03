import { describe, expect, it } from "vitest";
import {
  ACCESS_MODES as CORE_ACCESS_MODES,
  BACKGROUND_TASK_POLICIES as CORE_BACKGROUND_TASK_POLICIES,
} from "@sparkwright/core";
import {
  ACCESS_MODES as PROTOCOL_ACCESS_MODES,
  BACKGROUND_TASK_POLICIES as PROTOCOL_BACKGROUND_TASK_POLICIES,
  isRunAccessMode,
  type RunStartRequestPayload,
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
    for (const mode of CORE_ACCESS_MODES) {
      expect(isRunAccessMode(mode)).toBe(true);
    }
  });

  it("compiles accessMode and ignores a conflicting legacy permissionMode/shouldWrite", () => {
    const payload: RunStartRequestPayload = {
      goal: "g",
      accessMode: "read-only",
      // Conflicting legacy fields must be overridden, not honored.
      permissionMode: "bypass_permissions",
      shouldWrite: true,
    };
    const resolved = resolveRunAccessFields(payload, {});
    expect(resolved).toEqual({
      permissionMode: "plan",
      shouldWrite: false,
      backgroundTasks: "enabled",
      accessMode: "read-only",
      overriddenLegacyFields: ["permissionMode", "shouldWrite"],
    });
  });

  it("reports no override when legacy fields agree with the access mode", () => {
    const payload: RunStartRequestPayload = {
      goal: "g",
      accessMode: "ask",
      permissionMode: "default",
      shouldWrite: true,
    };
    const resolved = resolveRunAccessFields(payload, {});
    expect(resolved.overriddenLegacyFields).toEqual([]);
    expect(resolved.permissionMode).toBe("default");
    expect(resolved.shouldWrite).toBe(true);
    expect(resolved.backgroundTasks).toBe("enabled");
  });

  it("falls back to legacy permissionMode/shouldWrite resolution when accessMode is absent", () => {
    expect(resolveRunAccessFields({ goal: "g" }, {})).toEqual({
      permissionMode: "default",
      shouldWrite: true,
      backgroundTasks: "enabled",
      overriddenLegacyFields: [],
    });
    // plan with no explicit shouldWrite stays read-only (legacy behavior).
    expect(
      resolveRunAccessFields({ goal: "g", permissionMode: "plan" }, {}),
    ).toEqual({
      permissionMode: "plan",
      shouldWrite: false,
      backgroundTasks: "enabled",
      overriddenLegacyFields: [],
    });
    // host default permission/write still apply.
    expect(
      resolveRunAccessFields(
        { goal: "g" },
        { defaultPermissionMode: "accept_edits", defaultShouldWrite: false },
      ),
    ).toEqual({
      permissionMode: "accept_edits",
      shouldWrite: false,
      backgroundTasks: "enabled",
      overriddenLegacyFields: [],
    });
  });

  it("clamps payload accessMode to a configured ceiling", () => {
    const resolved = resolveRunAccessFields(
      { goal: "g", accessMode: "bypass" },
      { accessModeCeiling: "ask" },
    );

    expect(resolved).toEqual({
      permissionMode: "default",
      shouldWrite: true,
      backgroundTasks: "enabled",
      accessMode: "ask",
      requestedAccessMode: "bypass",
      accessModeCeiling: "ask",
      overriddenLegacyFields: [],
    });
    expect(buildAccessMetadata(resolved)).toEqual({
      accessMode: "ask",
      requestedAccessMode: "bypass",
      accessModeCeiling: "ask",
    });
  });

  it("clamps legacy permissionMode/shouldWrite to a configured ceiling", () => {
    expect(
      resolveRunAccessFields(
        { goal: "g", permissionMode: "bypass_permissions", shouldWrite: true },
        { accessModeCeiling: "read-only" },
      ),
    ).toEqual({
      permissionMode: "plan",
      shouldWrite: false,
      backgroundTasks: "enabled",
      accessMode: "read-only",
      requestedAccessMode: "bypass",
      accessModeCeiling: "read-only",
      overriddenLegacyFields: ["permissionMode", "shouldWrite"],
    });
  });

  it("builds inspectable access metadata only when an access mode is set", () => {
    expect(
      buildAccessMetadata({
        permissionMode: "default",
        shouldWrite: true,
        backgroundTasks: "enabled",
        overriddenLegacyFields: [],
      }),
    ).toEqual({});
    expect(
      buildAccessMetadata({
        permissionMode: "default",
        shouldWrite: true,
        backgroundTasks: "enabled",
        accessMode: "ask",
        overriddenLegacyFields: [],
      }),
    ).toEqual({ accessMode: "ask" });
    expect(
      buildAccessMetadata({
        permissionMode: "plan",
        shouldWrite: false,
        backgroundTasks: "enabled",
        accessMode: "read-only",
        overriddenLegacyFields: ["shouldWrite"],
      }),
    ).toEqual({
      accessMode: "read-only",
      accessModeOverrodeLegacyFields: ["shouldWrite"],
    });
  });

  it("resolves and records background task policy clamps", () => {
    const resolved = resolveRunAccessFields(
      { goal: "g", backgroundTasks: "enabled" },
      { backgroundTasksCeiling: "foreground-only" },
    );

    expect(resolved).toEqual({
      permissionMode: "default",
      shouldWrite: true,
      backgroundTasks: "foreground-only",
      requestedBackgroundTasks: "enabled",
      backgroundTasksCeiling: "foreground-only",
      overriddenLegacyFields: [],
    });
    expect(buildAccessMetadata(resolved)).toEqual({
      backgroundTasks: "foreground-only",
      requestedBackgroundTasks: "enabled",
      backgroundTasksCeiling: "foreground-only",
    });
  });
});
