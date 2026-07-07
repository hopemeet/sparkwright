import type {
  HostEvent,
  HostMessage,
  HostRequest,
  HostResponse,
  ProtocolError,
} from "@sparkwright/protocol";
import {
  ACCESS_MODES,
  BACKGROUND_TASK_POLICIES,
  PERMISSION_MODES,
  PROTOCOL_VERSION,
  TASK_STATUSES,
  TRACE_LEVELS,
  isRequest,
} from "@sparkwright/protocol";
import type { Connection } from "./connection.js";
import { nextMessageId, nowIso } from "./connection.js";
import { HostRuntime, type RuntimeOptions } from "./runtime.js";

export interface ServeConnectionOptions {
  workspaceRoot: string;
  sessionRootDir?: string;
  defaultModel?: string;
  defaultAccessMode?: RuntimeOptions["defaultAccessMode"];
  accessModeCeiling?: RuntimeOptions["accessModeCeiling"];
  defaultBackgroundTasks?: RuntimeOptions["defaultBackgroundTasks"];
  backgroundTasksCeiling?: RuntimeOptions["backgroundTasksCeiling"];
  defaultPermissionMode?: RuntimeOptions["defaultPermissionMode"];
  defaultTraceLevel?: RuntimeOptions["defaultTraceLevel"];
  defaultShouldWrite?: RuntimeOptions["defaultShouldWrite"];
  hostName?: string;
  hostVersion?: string;
}

/**
 * Bind a Connection to a fresh HostRuntime and start dispatching messages.
 *
 * One connection has one runtime. When the connection closes, runtime
 * cleanup() cancels any active run and denies pending approvals.
 */
export function serveConnection(
  conn: Connection,
  opts: ServeConnectionOptions,
): void {
  let handshakeDone = false;
  const runtime = new HostRuntime({
    workspaceRoot: opts.workspaceRoot,
    sessionRootDir: opts.sessionRootDir,
    defaultModel: opts.defaultModel,
    defaultAccessMode: opts.defaultAccessMode,
    accessModeCeiling: opts.accessModeCeiling,
    defaultBackgroundTasks: opts.defaultBackgroundTasks,
    backgroundTasksCeiling: opts.backgroundTasksCeiling,
    defaultPermissionMode: opts.defaultPermissionMode,
    defaultTraceLevel: opts.defaultTraceLevel,
    defaultShouldWrite: opts.defaultShouldWrite,
    emit: (event: HostEvent) => {
      try {
        conn.send(event);
      } catch {
        // socket may have closed mid-flight; ignore
      }
    },
  });

  conn.onClose(() => {
    runtime.cleanup();
  });

  conn.onMessage((message: HostMessage) => {
    if (!isRequest(message)) {
      // Clients SHOULD NOT send responses or events; ignore silently.
      return;
    }
    // Gate everything behind a successful handshake.
    if (!handshakeDone && message.kind !== "handshake") {
      respondError(conn, message.id, {
        code: "protocol_version_mismatch",
        message:
          "handshake required before any other request — see docs/HOST_PROTOCOL.md",
      });
      conn.close("no handshake");
      return;
    }

    handleRequest(conn, runtime, message, opts)
      .then((didHandshake) => {
        if (didHandshake) handshakeDone = true;
      })
      .catch((error: unknown) => {
        respondError(conn, message.id, {
          code: "internal_error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  });
}

async function handleRequest(
  conn: Connection,
  runtime: HostRuntime,
  req: HostRequest,
  opts: ServeConnectionOptions,
): Promise<boolean> {
  const payloadError = validateRequestPayload(req);
  if (payloadError) {
    respondError(conn, req.id, {
      code: "invalid_payload",
      message: payloadError,
    });
    return false;
  }

  switch (req.kind) {
    case "handshake": {
      const major = req.payload.protocolVersion.split(".")[0];
      const ourMajor = PROTOCOL_VERSION.split(".")[0];
      if (major !== ourMajor) {
        respondError(conn, req.id, {
          code: "protocol_version_mismatch",
          message: `client speaks v${req.payload.protocolVersion}; host speaks v${PROTOCOL_VERSION}`,
        });
        conn.close("version mismatch");
        return false;
      }
      respondOk(conn, req.id, {});
      conn.send({
        envelope: "event",
        id: nextMessageId("evt"),
        kind: "host.ready",
        timestamp: nowIso(),
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          host: {
            name: opts.hostName ?? "sparkwright-host",
            version: opts.hostVersion ?? "0.1.0",
          },
          capabilities: [
            "streaming",
            "approvals",
            "sessions",
            "session.inspect",
            "session.compact",
            "task.list",
            "task.get",
            "task.output",
            "task.stop",
            "task.join",
            "task.promote",
            "workflow.list",
            "workflow.resume",
            "capability.inspect",
            "run.resume",
            "run.inject_message",
          ],
        },
      });
      return true;
    }
    case "run.start": {
      const r = await runtime.startRun(req.payload);
      if (r.ok) respondOk(conn, req.id, { runId: r.runId });
      else respondError(conn, req.id, r.error);
      return false;
    }
    case "run.resume": {
      const r = await runtime.resumeRun(req.payload);
      if (r.ok) {
        respondOk(conn, req.id, {
          runId: r.runId,
          resumedFromRunId: r.resumedFromRunId,
          ...(r.sessionId ? { sessionId: r.sessionId } : {}),
        });
      } else {
        respondError(conn, req.id, r.error);
      }
      return false;
    }
    case "run.inject_message": {
      const r = runtime.injectRunMessage(req.payload.runId, {
        content: req.payload.content,
        parts: req.payload.input?.parts,
        metadata: {
          ...(req.payload.input?.metadata ?? {}),
          ...(req.payload.metadata ?? {}),
        },
      });
      if (r.ok) respondOk(conn, req.id, {});
      else respondError(conn, req.id, r.error);
      return false;
    }
    case "run.cancel": {
      const r = runtime.cancelRun(req.payload.runId, req.payload.reason);
      if (r.ok) respondOk(conn, req.id, {});
      else respondError(conn, req.id, r.error);
      return false;
    }
    case "approval.resolve": {
      const r = runtime.resolveApproval(
        req.payload.approvalId,
        req.payload.decision,
        req.payload.message,
        req.payload.autoApproved,
      );
      if (r.ok) respondOk(conn, req.id, {});
      else respondError(conn, req.id, r.error);
      return false;
    }
    case "session.list": {
      const sessions = await runtime.listSessions(req.payload.limit ?? 20);
      respondOk(conn, req.id, { sessions });
      return false;
    }
    case "session.inspect": {
      const r = await runtime.inspectSession(req.payload.sessionId, {
        compaction: req.payload.compaction === true,
      });
      if (r.ok) {
        respondOk(conn, req.id, {
          sessionId: r.sessionId,
          summary: r.summary,
          consistency: r.consistency,
          timeline: r.timeline,
          ...(r.compaction ? { compaction: r.compaction } : {}),
        });
      } else {
        respondError(conn, req.id, r.error);
      }
      return false;
    }
    case "session.fork": {
      const r = await runtime.forkSession(
        req.payload.sourceSessionId,
        req.payload.forkAtSequence,
      );
      if (r.ok) {
        respondOk(conn, req.id, {
          forkedSessionId: r.forkedSessionId,
          copiedEventCount: r.copiedEventCount,
          truncatedAtSequence: r.truncatedAtSequence,
        });
      } else {
        respondError(conn, req.id, r.error);
      }
      return false;
    }
    case "session.compact": {
      const r = await runtime.compactSession(
        req.payload.sessionId,
        req.payload.reason,
        { llm: req.payload.llm },
      );
      if (r.ok) {
        respondOk(conn, req.id, {
          sessionId: r.sessionId,
          compactedRunCount: r.compactedRunCount,
          throughRunId: r.throughRunId,
          originalCharCount: r.originalCharCount,
          summaryCharCount: r.summaryCharCount,
          freedChars: r.freedChars,
          measurement: r.measurement,
          skippedReason: r.skippedReason,
          warnings: r.warnings,
          artifactPath: r.artifactPath,
        });
      } else {
        respondError(conn, req.id, r.error);
      }
      return false;
    }
    case "task.list": {
      const r = runtime.listTasks(req.payload);
      respondOk(conn, req.id, { tasks: r.tasks });
      return false;
    }
    case "task.get": {
      const r = runtime.getTask(req.payload.taskId);
      if (r.ok)
        respondOk(conn, req.id, r.task as unknown as Record<string, unknown>);
      else respondError(conn, req.id, r.error);
      return false;
    }
    case "task.output": {
      const r = await runtime.readTaskOutput(req.payload);
      if (r.ok) {
        respondOk(conn, req.id, {
          taskId: r.taskId,
          chunks: r.chunks,
          nextSequence: r.nextSequence,
          complete: r.complete,
          status: r.status,
          ...(r.error ? { error: r.error } : {}),
          ...(r.lastOutputAt ? { lastOutputAt: r.lastOutputAt } : {}),
          stalled: r.stalled,
        });
      } else {
        respondError(conn, req.id, r.error);
      }
      return false;
    }
    case "task.stop": {
      const r = await runtime.stopTask(req.payload.taskId);
      if (r.ok) {
        respondOk(conn, req.id, {
          cancelled: r.cancelled,
          ...(r.status ? { status: r.status } : {}),
        });
      } else {
        respondError(conn, req.id, r.error);
      }
      return false;
    }
    case "task.join": {
      const r = await runtime.joinTask(req.payload.taskId);
      if (r.ok) {
        respondOk(conn, req.id, {
          taskId: r.taskId,
          awaited: r.awaited,
          status: r.status,
        });
      } else {
        respondError(conn, req.id, r.error);
      }
      return false;
    }
    case "task.promote": {
      const r = await runtime.promoteTask(req.payload.taskId);
      if (r.ok) {
        respondOk(conn, req.id, {
          taskId: r.taskId,
          promoted: r.promoted,
          awaited: r.awaited,
          status: r.status,
        });
      } else {
        respondError(conn, req.id, r.error);
      }
      return false;
    }
    case "workflow.list": {
      const r = await runtime.listWorkflowRuns(req.payload);
      if (r.ok) {
        respondOk(conn, req.id, {
          workflows: r.workflows,
          ...(r.invalidEntries ? { invalidEntries: r.invalidEntries } : {}),
        });
      } else {
        respondError(conn, req.id, r.error);
      }
      return false;
    }
    case "workflow.resume": {
      const r = await runtime.resumeWorkflowRun(req.payload);
      if (r.ok) {
        respondOk(conn, req.id, {
          runId: r.runId,
          workflowRunId: r.workflowRunId,
          ...(r.sessionId ? { sessionId: r.sessionId } : {}),
        });
      } else {
        respondError(conn, req.id, r.error);
      }
      return false;
    }
    case "capability.inspect": {
      const r = await runtime.inspectCapabilities({
        modelRef: req.payload.model,
      });
      if (r.ok)
        respondOk(
          conn,
          req.id,
          r.snapshot as unknown as Record<string, unknown>,
        );
      else respondError(conn, req.id, r.error);
      return false;
    }
    default: {
      // exhaustiveness guard — unknown kinds should never typecheck
      const _exhaustive: never = req;
      void _exhaustive;
      respondError(conn, (req as HostRequest).id, {
        code: "unknown_kind",
        message: `unknown request kind`,
      });
      return false;
    }
  }
}

function validateRequestPayload(req: HostRequest): string | undefined {
  if (!isRecord(req.payload)) return `${req.kind} payload must be an object`;

  switch (req.kind) {
    case "handshake":
      return (
        requireOnly(req.payload, [
          "protocolVersion",
          "client",
          "capabilities",
        ]) ??
        requireString(req.payload, "protocolVersion") ??
        requireRecord(req.payload, "client") ??
        validateClientInfo(req.payload.client) ??
        optionalStringArray(req.payload, "capabilities")
      );
    case "run.start":
      return (
        requireOnly(req.payload, [
          "goal",
          "sessionId",
          "targetPath",
          "confidentialPaths",
          "confidentialDefaults",
          "shouldWrite",
          "model",
          "accessMode",
          "backgroundTasks",
          "permissionMode",
          "traceLevel",
          "workflow",
          "metadata",
        ]) ??
        requireString(req.payload, "goal") ??
        optionalString(req.payload, "sessionId") ??
        optionalString(req.payload, "targetPath") ??
        optionalStringArray(req.payload, "confidentialPaths") ??
        optionalBoolean(req.payload, "confidentialDefaults") ??
        optionalBoolean(req.payload, "shouldWrite") ??
        optionalString(req.payload, "model") ??
        optionalEnum(req.payload, "accessMode", [...ACCESS_MODES]) ??
        optionalEnum(req.payload, "backgroundTasks", [
          ...BACKGROUND_TASK_POLICIES,
        ]) ??
        optionalEnum(req.payload, "permissionMode", [...PERMISSION_MODES]) ??
        optionalEnum(req.payload, "traceLevel", [...TRACE_LEVELS]) ??
        optionalString(req.payload, "workflow") ??
        optionalRecord(req.payload, "metadata")
      );
    case "run.resume":
      return (
        requireOnly(req.payload, [
          "runId",
          "sessionId",
          "targetPath",
          "confidentialPaths",
          "confidentialDefaults",
          "shouldWrite",
          "fromTrace",
          "force",
          "model",
          "accessMode",
          "backgroundTasks",
          "permissionMode",
          "traceLevel",
          "metadata",
        ]) ??
        requireString(req.payload, "runId") ??
        optionalString(req.payload, "sessionId") ??
        optionalString(req.payload, "targetPath") ??
        optionalStringArray(req.payload, "confidentialPaths") ??
        optionalBoolean(req.payload, "confidentialDefaults") ??
        optionalBoolean(req.payload, "shouldWrite") ??
        optionalBoolean(req.payload, "fromTrace") ??
        optionalBoolean(req.payload, "force") ??
        optionalString(req.payload, "model") ??
        optionalEnum(req.payload, "accessMode", [...ACCESS_MODES]) ??
        optionalEnum(req.payload, "backgroundTasks", [
          ...BACKGROUND_TASK_POLICIES,
        ]) ??
        optionalEnum(req.payload, "permissionMode", [...PERMISSION_MODES]) ??
        optionalEnum(req.payload, "traceLevel", [...TRACE_LEVELS]) ??
        optionalRecord(req.payload, "metadata")
      );
    case "run.inject_message":
      return (
        requireOnly(req.payload, ["runId", "content", "metadata"]) ??
        requireString(req.payload, "runId") ??
        requireString(req.payload, "content") ??
        optionalRecord(req.payload, "metadata")
      );
    case "run.cancel":
      return (
        requireOnly(req.payload, ["runId", "reason"]) ??
        requireString(req.payload, "runId") ??
        optionalString(req.payload, "reason")
      );
    case "approval.resolve":
      return (
        requireOnly(req.payload, [
          "approvalId",
          "decision",
          "message",
          "autoApproved",
        ]) ??
        requireString(req.payload, "approvalId") ??
        optionalEnum(req.payload, "decision", ["approved", "denied"]) ??
        requireString(req.payload, "decision") ??
        optionalString(req.payload, "message") ??
        optionalBoolean(req.payload, "autoApproved")
      );
    case "session.list":
      return (
        requireOnly(req.payload, ["limit"]) ??
        optionalPositiveInteger(req.payload, "limit", 200)
      );
    case "session.inspect":
      return (
        requireOnly(req.payload, ["sessionId", "compaction"]) ??
        requireString(req.payload, "sessionId") ??
        optionalBoolean(req.payload, "compaction")
      );
    case "session.fork":
      return (
        requireOnly(req.payload, ["sourceSessionId", "forkAtSequence"]) ??
        requireString(req.payload, "sourceSessionId") ??
        optionalPositiveInteger(
          req.payload,
          "forkAtSequence",
          Number.MAX_SAFE_INTEGER,
        )
      );
    case "session.compact":
      return (
        requireOnly(req.payload, ["sessionId", "reason", "llm"]) ??
        requireString(req.payload, "sessionId") ??
        optionalString(req.payload, "reason") ??
        optionalBoolean(req.payload, "llm")
      );
    case "task.list":
      return (
        requireOnly(req.payload, ["status", "kind", "parentRunId", "limit"]) ??
        optionalEnum(req.payload, "status", [...TASK_STATUSES]) ??
        optionalString(req.payload, "kind") ??
        optionalString(req.payload, "parentRunId") ??
        optionalPositiveInteger(req.payload, "limit", 200)
      );
    case "task.get":
      return (
        requireOnly(req.payload, ["taskId"]) ??
        requireString(req.payload, "taskId")
      );
    case "task.output":
      return (
        requireOnly(req.payload, ["taskId", "fromSequence", "maxChunks"]) ??
        requireString(req.payload, "taskId") ??
        optionalNonNegativeInteger(
          req.payload,
          "fromSequence",
          Number.MAX_SAFE_INTEGER,
        ) ??
        optionalPositiveInteger(req.payload, "maxChunks", 1000)
      );
    case "task.stop":
    case "task.join":
    case "task.promote":
      return (
        requireOnly(req.payload, ["taskId"]) ??
        requireString(req.payload, "taskId")
      );
    case "workflow.list":
      return (
        requireOnly(req.payload, ["sessionId", "status", "limit"]) ??
        optionalString(req.payload, "sessionId") ??
        optionalEnum(req.payload, "status", [
          "running",
          "waiting",
          "completed",
          "failed",
          "cancelled",
        ]) ??
        optionalPositiveInteger(req.payload, "limit", 200)
      );
    case "workflow.resume":
      return (
        requireOnly(req.payload, [
          "workflowRunId",
          "sessionId",
          "targetPath",
          "confidentialPaths",
          "confidentialDefaults",
          "shouldWrite",
          "model",
          "accessMode",
          "backgroundTasks",
          "permissionMode",
          "traceLevel",
          "metadata",
        ]) ??
        requireString(req.payload, "workflowRunId") ??
        optionalString(req.payload, "sessionId") ??
        optionalString(req.payload, "targetPath") ??
        optionalStringArray(req.payload, "confidentialPaths") ??
        optionalBoolean(req.payload, "confidentialDefaults") ??
        optionalBoolean(req.payload, "shouldWrite") ??
        optionalString(req.payload, "model") ??
        optionalEnum(req.payload, "accessMode", [...ACCESS_MODES]) ??
        optionalEnum(req.payload, "backgroundTasks", [
          ...BACKGROUND_TASK_POLICIES,
        ]) ??
        optionalEnum(req.payload, "permissionMode", [...PERMISSION_MODES]) ??
        optionalEnum(req.payload, "traceLevel", [...TRACE_LEVELS]) ??
        optionalRecord(req.payload, "metadata")
      );
    case "capability.inspect":
      return (
        requireOnly(req.payload, ["sessionId", "model"]) ??
        optionalString(req.payload, "sessionId") ??
        optionalString(req.payload, "model")
      );
  }
}

function validateClientInfo(value: unknown): string | undefined {
  if (!isRecord(value)) return "handshake client must be an object";
  return (
    requireOnly(value, ["name", "version"]) ??
    requireString(value, "name") ??
    requireString(value, "version")
  );
}

function requireOnly(
  record: Record<string, unknown>,
  allowed: readonly string[],
): string | undefined {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(record).filter((key) => !allowedSet.has(key));
  return extra.length > 0
    ? `unexpected payload field(s): ${extra.join(", ")}`
    : undefined;
}

function requireString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    return `${key} must be a non-empty string`;
  }
  return undefined;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return typeof value === "string" && value.trim() !== ""
    ? undefined
    : `${key} must be a non-empty string`;
}

function requireRecord(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  return isRecord(record[key]) ? undefined : `${key} must be an object`;
}

function optionalRecord(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return isRecord(value) ? undefined : `${key} must be an object`;
}

function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return typeof value === "boolean" ? undefined : `${key} must be a boolean`;
}

function optionalEnum(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return typeof value === "string" && allowed.includes(value)
    ? undefined
    : `${key} must be one of: ${allowed.join(", ")}`;
}

function optionalStringArray(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? undefined
    : `${key} must be an array of strings`;
}

function optionalPositiveInteger(
  record: Record<string, unknown>,
  key: string,
  max: number,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= max
    ? undefined
    : `${key} must be an integer between 1 and ${max}`;
}

function optionalNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
  max: number,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= max
    ? undefined
    : `${key} must be an integer between 0 and ${max}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function respondOk(
  conn: Connection,
  id: string,
  result: Record<string, unknown>,
): void {
  const resp: HostResponse = {
    envelope: "response",
    id,
    ok: true,
    timestamp: nowIso(),
    result,
  };
  conn.send(resp);
}

function respondError(
  conn: Connection,
  id: string,
  error: ProtocolError,
): void {
  const resp: HostResponse = {
    envelope: "response",
    id,
    ok: false,
    timestamp: nowIso(),
    error,
  };
  conn.send(resp);
}
