import { describe, expect, it } from "vitest";
import {
  createHostClientRunMetadata,
  createHostResumeRunRequest,
  createHostStartRunRequest,
  resolveHostRequestModel,
  tracePathForSession,
} from "../src/client-run.js";

describe("host client run request helpers", () => {
  it("omits config-sourced model overrides", () => {
    expect(
      resolveHostRequestModel({
        modelName: "openai/configured",
        modelNameSource: "config",
      }),
    ).toBeUndefined();
    expect(
      resolveHostRequestModel({
        modelName: "openai/requested",
        modelNameSource: "request",
      }),
    ).toBe("openai/requested");
  });

  it("builds stable client metadata", () => {
    expect(
      createHostClientRunMetadata({
        source: "tui",
        sessionId: "session_1",
        workspaceRoot: "/repo",
        permissionMode: "default",
        shouldWrite: false,
        traceLevel: "debug",
        modelName: "deterministic",
      }),
    ).toEqual({
      source: "tui",
      sessionId: "session_1",
      workspaceRoot: "/repo",
      permissionMode: "default",
      shouldWrite: false,
      traceLevel: "debug",
      model: "deterministic",
    });
  });

  it("builds start and resume payloads with shared field rules", () => {
    const metadata = { source: "cli", shouldWrite: true, traceLevel: "debug" };

    expect(
      createHostStartRunRequest({
        goal: "inspect",
        sessionId: "session_1",
        modelName: "openai/configured",
        modelNameSource: "config",
        permissionMode: "accept_edits",
        traceLevel: "debug",
        targetPath: "README.md",
        confidentialPaths: ["secret*"],
        shouldWrite: true,
        metadata,
      }),
    ).toEqual({
      goal: "inspect",
      sessionId: "session_1",
      model: undefined,
      permissionMode: "accept_edits",
      traceLevel: "debug",
      targetPath: "README.md",
      confidentialPaths: ["secret*"],
      shouldWrite: true,
      metadata,
    });

    expect(
      createHostResumeRunRequest({
        runId: "run_1",
        fromTrace: true,
        force: false,
        modelName: "openai/requested",
        modelNameSource: "request",
        traceLevel: "standard",
        shouldWrite: false,
        metadata,
      }),
    ).toEqual({
      runId: "run_1",
      fromTrace: true,
      force: false,
      model: "openai/requested",
      permissionMode: undefined,
      traceLevel: "standard",
      targetPath: undefined,
      shouldWrite: false,
      metadata,
    });
  });

  it("derives session trace paths", () => {
    expect(
      tracePathForSession({
        sessionRootDir: "/repo/.sparkwright/sessions",
        sessionId: "session_1",
      }),
    ).toBe("/repo/.sparkwright/sessions/session_1/trace.jsonl");
    expect(
      tracePathForSession({ sessionRootDir: "/repo/.sparkwright/sessions" }),
    ).toBeUndefined();
  });
});
