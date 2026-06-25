import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createHostCapabilityInspectRequest,
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
        allowWorkspaceWriteApproval: true,
        traceLevel: "debug",
        modelName: "deterministic",
      }),
    ).toEqual({
      source: "tui",
      sessionId: "session_1",
      workspaceRoot: "/repo",
      permissionMode: "default",
      shouldWrite: false,
      allowWorkspaceWriteApproval: true,
      traceLevel: "debug",
      model: "deterministic",
    });
  });

  it("builds start and resume payloads with shared field rules", () => {
    const metadata = { source: "cli", shouldWrite: true, traceLevel: "debug" };
    const input = {
      parts: [
        {
          type: "image" as const,
          data: "iVBORw0KGgo=",
          mediaType: "image/png",
        },
      ],
    };

    expect(
      createHostStartRunRequest({
        goal: "inspect",
        input,
        sessionId: "session_1",
        modelName: "openai/configured",
        modelNameSource: "config",
        permissionMode: "accept_edits",
        traceLevel: "debug",
        targetPath: "README.md",
        confidentialPaths: ["secret*"],
        shouldWrite: true,
        allowWorkspaceWriteApproval: false,
        metadata,
      }),
    ).toEqual({
      goal: "inspect",
      input,
      sessionId: "session_1",
      model: undefined,
      permissionMode: "accept_edits",
      traceLevel: "debug",
      targetPath: "README.md",
      confidentialPaths: ["secret*"],
      shouldWrite: true,
      allowWorkspaceWriteApproval: false,
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
        allowWorkspaceWriteApproval: true,
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
      allowWorkspaceWriteApproval: true,
      metadata,
    });
  });

  it("builds capability inspect payloads with the active request model", () => {
    expect(
      createHostCapabilityInspectRequest({
        sessionId: "session_1",
        modelName: "openai/configured",
        modelNameSource: "config",
      }),
    ).toEqual({
      sessionId: "session_1",
      model: undefined,
    });

    expect(
      createHostCapabilityInspectRequest({
        sessionId: "session_1",
        modelName: "openai/requested",
        modelNameSource: "request",
      }),
    ).toEqual({
      sessionId: "session_1",
      model: "openai/requested",
    });
  });

  it("derives session trace paths", () => {
    expect(
      tracePathForSession({
        sessionRootDir: "/repo/.sparkwright/sessions",
        sessionId: "session_1",
      }),
    ).toBe(join("/repo/.sparkwright/sessions", "session_1", "trace.jsonl"));
    expect(
      tracePathForSession({ sessionRootDir: "/repo/.sparkwright/sessions" }),
    ).toBeUndefined();
  });
});
