import { Buffer } from "node:buffer";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_RUN_IMAGE_INPUT_BYTES,
  buildImageRunInputPart,
  createRunInputPayloadFromParts,
  imageMediaTypeForPath,
  runInputMetadataRecord,
} from "../src/client-input.js";
import {
  clampHostClientAccessMode,
  createHostCapabilityInspectRequest,
  createHostClientRunMetadata,
  createHostResumeRunRequest,
  createHostStartRunRequest,
  createHostWorkflowResumeRequest,
  nextHostClientAccessMode,
  resolveHostClientRunAccess,
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
        confidentialDefaults: false,
        shouldWrite: true,
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
      confidentialDefaults: false,
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
        confidentialPaths: ["secret*"],
        confidentialDefaults: false,
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
      confidentialPaths: ["secret*"],
      confidentialDefaults: false,
      shouldWrite: false,
      metadata,
    });

    expect(
      createHostWorkflowResumeRequest({
        workflowRunId: "workflow_1",
        sessionId: "session_1",
        modelName: "openai/requested",
        modelNameSource: "request",
        traceLevel: "standard",
        confidentialPaths: ["secret*"],
        confidentialDefaults: false,
        shouldWrite: false,
        metadata,
      }),
    ).toEqual({
      workflowRunId: "workflow_1",
      sessionId: "session_1",
      model: "openai/requested",
      permissionMode: undefined,
      traceLevel: "standard",
      targetPath: undefined,
      confidentialPaths: ["secret*"],
      confidentialDefaults: false,
      shouldWrite: false,
      metadata,
    });
  });

  it("prefers accessMode over legacy permissionMode in new client payloads", () => {
    const metadata = createHostClientRunMetadata({
      source: "cli",
      accessMode: "accept-edits",
      permissionMode: "bypass_permissions",
      shouldWrite: true,
      traceLevel: "standard",
    });

    expect(metadata).toMatchObject({
      source: "cli",
      accessMode: "accept-edits",
      shouldWrite: true,
    });
    expect(metadata).not.toHaveProperty("permissionMode");
    expect(
      createHostStartRunRequest({
        goal: "inspect",
        accessMode: "accept-edits",
        permissionMode: "bypass_permissions",
        traceLevel: "standard",
        shouldWrite: true,
        metadata,
      }),
    ).toMatchObject({
      goal: "inspect",
      accessMode: "accept-edits",
      permissionMode: undefined,
      shouldWrite: true,
    });
  });

  it("resolves client run access fields with metadata for request builders", () => {
    const access = resolveHostClientRunAccess({
      accessMode: "bypass",
      accessModeCeiling: "ask",
      backgroundTasks: "enabled",
      backgroundTasksCeiling: "foreground-only",
      permissionMode: "bypass_permissions",
      shouldWrite: true,
    });

    expect(access).toEqual({
      permissionMode: "default",
      shouldWrite: true,
      backgroundTasks: "foreground-only",
      requestedBackgroundTasks: "enabled",
      backgroundTasksCeiling: "foreground-only",
      accessMode: "ask",
      requestedAccessMode: "bypass",
      accessModeCeiling: "ask",
      overriddenLegacyFields: ["permissionMode"],
      metadata: {
        accessMode: "ask",
        requestedAccessMode: "bypass",
        accessModeCeiling: "ask",
        accessModeOverrodeLegacyFields: ["permissionMode"],
        backgroundTasks: "foreground-only",
        requestedBackgroundTasks: "enabled",
        backgroundTasksCeiling: "foreground-only",
      },
    });
  });

  it("cycles access modes using the shared host-client access order", () => {
    expect(nextHostClientAccessMode("read-only")).toBe("ask");
    expect(nextHostClientAccessMode("ask")).toBe("accept-edits");
    expect(nextHostClientAccessMode("accept-edits")).toBe("bypass");
    expect(nextHostClientAccessMode("bypass")).toBe("read-only");

    expect(clampHostClientAccessMode("ask", "bypass")).toBe("ask");
    expect(nextHostClientAccessMode("ask", "ask")).toBe("read-only");
    expect(nextHostClientAccessMode("read-only", "ask")).toBe("ask");
    expect(nextHostClientAccessMode("bypass", "ask")).toBe("read-only");
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
        accessMode: "ask",
        backgroundTasks: "foreground-only",
        shouldWrite: true,
      }),
    ).toEqual({
      sessionId: "session_1",
      model: "openai/requested",
      accessMode: "ask",
      backgroundTasks: "foreground-only",
      shouldWrite: true,
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

describe("host client input helpers", () => {
  it("builds image input parts with shared metadata", () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const result = buildImageRunInputPart({
      sourcePath: "assets/photo.PNG",
      resolvedPath: "/workspace/assets/photo.PNG",
      bytes,
    });

    expect(result).toEqual({
      ok: true,
      part: {
        type: "image",
        data: bytes.toString("base64"),
        mediaType: "image/png",
        name: "photo.PNG",
        metadata: {
          sourcePath: "assets/photo.PNG",
          byteLength: bytes.byteLength,
        },
      },
    });
  });

  it("summarizes input parts for run payloads and metadata", () => {
    const image = buildImageRunInputPart({
      sourcePath: "diagram.webp",
      bytes: Buffer.from("demo"),
    });
    expect(image.ok).toBe(true);
    if (!image.ok) return;

    const payload = createRunInputPayloadFromParts([
      image.part,
      { type: "text", text: "caption" },
    ]);

    expect(payload).toEqual({
      parts: [image.part, { type: "text", text: "caption" }],
      metadata: { attachmentCount: 2, imageCount: 1 },
    });
    expect(runInputMetadataRecord(payload)).toEqual({
      input: { attachmentCount: 2, imageCount: 1 },
    });
    expect(createRunInputPayloadFromParts([])).toBeUndefined();
    expect(runInputMetadataRecord(undefined)).toEqual({});
  });

  it("reports unsupported and oversized image input", () => {
    expect(imageMediaTypeForPath("cover.jpeg")).toBe("image/jpeg");
    expect(imageMediaTypeForPath("notes.txt")).toBeUndefined();
    expect(
      buildImageRunInputPart({
        sourcePath: "notes.txt",
        bytes: Buffer.from("not an image"),
      }),
    ).toEqual({ ok: false, reason: "unsupported_type" });
    expect(
      buildImageRunInputPart({
        sourcePath: "huge.png",
        bytes: Buffer.alloc(2),
        maxBytes: 1,
      }),
    ).toEqual({
      ok: false,
      reason: "too_large",
      byteLength: 2,
      maxBytes: 1,
    });
    expect(MAX_RUN_IMAGE_INPUT_BYTES).toBe(20 * 1024 * 1024);
  });
});
