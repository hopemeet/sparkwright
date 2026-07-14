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
  IM_SESSION_PERMISSIONS,
  PERMISSION_MODES,
  PROTOCOL_VERSION,
  TASK_STATUSES,
  TRACE_LEVELS,
  isRequest,
} from "@sparkwright/protocol";
import type { Connection } from "./connection.js";
import {
  authenticatedConnection,
  nextMessageId,
  nowIso,
  unauthenticatedConnection,
  type HostConnectionAuthContext,
} from "./connection.js";
import { HostRuntime } from "./runtime.js";
import type { RuntimeOptions } from "./runtime/contracts.js";
import { createHostService, type HostService } from "./host-service.js";
import type { HostImPrincipal } from "./im-control.js";

export interface ServeConnectionOptions {
  hostService?: HostService;
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
  /** Explicit operator opt-in; false by default. */
  imControlSelfBinding?: boolean;
  /** Stable transport/auth-derived principal id for this connection. */
  principalId?: string;
  /** Verified transport/auth result. Request payloads cannot supply it. */
  authContext?: HostConnectionAuthContext;
  /** Finite live approval timeout override used by bounded surfaces/tests. */
  approvalTimeoutMs?: number;
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
  let handshakeState: "pending" | "processing" | "complete" = "pending";
  const hostService =
    opts.hostService ??
    createHostService({
      imControl: { allowSelfBinding: opts.imControlSelfBinding === true },
    });
  const authContext =
    opts.authContext ??
    (opts.principalId
      ? authenticatedConnection(opts.principalId, "trusted-embedder")
      : unauthenticatedConnection("unspecified-transport"));
  const principal: HostImPrincipal = {
    id:
      authContext.state === "authenticated"
        ? authContext.principalId
        : `connection:${conn.id}`,
    kind:
      authContext.state === "authenticated"
        ? authContext.principalKind
        : "host_client",
    authenticated: authContext.state === "authenticated",
    authenticatedBy: authContext.authenticatedBy,
    clientName: "pending-handshake",
  };
  const runtime = hostService.createRuntime({
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
    approvalTimeoutMs: opts.approvalTimeoutMs,
    emit: (event: HostEvent) => {
      try {
        conn.send(event);
      } catch {
        // socket may have closed mid-flight; ignore
      }
    },
  });

  conn.onClose(() => {
    hostService.releaseRuntime(runtime);
  });

  conn.onMessage((message: HostMessage) => {
    if (!isRequest(message)) {
      // Clients SHOULD NOT send responses or events; ignore silently.
      return;
    }
    if (message.kind === "handshake" && handshakeState !== "pending") {
      respondError(conn, message.id, {
        code: "conflict",
        message: "handshake is already in progress or complete",
      });
      return;
    }
    if (message.kind === "handshake") handshakeState = "processing";

    // Gate everything behind a successful, frozen handshake.
    if (message.kind !== "handshake" && handshakeState !== "complete") {
      respondError(conn, message.id, {
        code: "protocol_version_mismatch",
        message:
          "handshake required before any other request — see docs/HOST_PROTOCOL.md",
      });
      conn.close("no handshake");
      return;
    }

    handleRequest(conn, runtime, hostService, principal, message, opts)
      .then((didHandshake) => {
        if (didHandshake) handshakeState = "complete";
        else if (message.kind === "handshake") handshakeState = "pending";
      })
      .catch((error: unknown) => {
        if (message.kind === "handshake") handshakeState = "pending";
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
  hostService: HostService,
  principal: HostImPrincipal,
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
      principal.clientName = req.payload.client.name;
      Object.freeze(principal);
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
            "workflow.control",
            "workflow.control.process",
            "capability.inspect",
            "run.resume",
            "run.inject_message",
            "im.control",
          ],
        },
      });
      return true;
    }
    case "run.start": {
      const r = await runtime.startRun(req.payload);
      if (r.ok) {
        respondOk(conn, req.id, {
          runId: r.runId,
          ...(r.sessionId ? { sessionId: r.sessionId } : {}),
          ...(r.workflowRunId ? { workflowRunId: r.workflowRunId } : {}),
        });
      } else respondError(conn, req.id, r.error);
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
    case "im.bind": {
      const result = hostService.bindImSession(principal, req.payload, runtime);
      if (!result.ok) respondError(conn, req.id, result.error);
      else {
        respondOk(conn, req.id, {
          bindingId: result.binding.bindingId,
          sessionId: result.binding.sessionId,
          permissions: result.binding.permissions,
          expiresAt: result.binding.expiresAt,
        });
      }
      return false;
    }
    case "im.message": {
      const result = await hostService.dispatchImMessage(
        principal,
        runtime,
        req.payload,
      );
      if (!result.ok) respondError(conn, req.id, result.error);
      else {
        respondOk(conn, req.id, {
          sessionId: result.sessionId,
          status: result.status,
          runId: result.runId,
        });
      }
      return false;
    }
    case "im.subscribe": {
      const result = hostService.subscribeImSession(principal, req.payload);
      if (!result.ok) respondError(conn, req.id, result.error);
      else respondOk(conn, req.id, { deliveries: result.deliveries });
      return false;
    }
    case "im.delivery.ack": {
      const result = hostService.acknowledgeImDeliveries(
        principal,
        req.payload,
      );
      if (!result.ok) respondError(conn, req.id, result.error);
      else respondOk(conn, req.id, { acknowledged: result.acknowledged });
      return false;
    }
    case "im.approval.resolve": {
      const result = hostService.resolveImApproval(principal, req.payload);
      if (!result.ok) respondError(conn, req.id, result.error);
      else respondOk(conn, req.id, {});
      return false;
    }
    case "im.cancel": {
      const result = hostService.cancelImSession(principal, req.payload);
      if (!result.ok) respondError(conn, req.id, result.error);
      else respondOk(conn, req.id, { cancelled: result.cancelled });
      return false;
    }
    case "im.inspect": {
      const result = hostService.inspectImSession(principal, req.payload);
      if (!result.ok) respondError(conn, req.id, result.error);
      else {
        respondOk(conn, req.id, {
          sessionId: result.sessionId,
          active: result.active,
          ...(result.executionId ? { executionId: result.executionId } : {}),
          ...(result.runId ? { runId: result.runId } : {}),
          queuedDeliveries: result.queuedDeliveries,
        });
      }
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
      const r = await runtime.resumeWorkflowRun(
        req.payload,
        workflowControlSource(principal, conn.id),
      );
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
    case "workflow.control": {
      const r = await runtime.controlWorkflow({
        ...req.payload,
        source: {
          ...workflowControlSource(principal, conn.id),
        },
      });
      if (r.ok) {
        respondOk(conn, req.id, {
          status: r.status,
          commandId: r.commandId,
          ...(r.code ? { code: r.code } : {}),
          ...(r.runId ? { runId: r.runId } : {}),
        });
      } else {
        respondError(conn, req.id, r.error);
      }
      return false;
    }
    case "workflow.control.process": {
      const r = await runtime.processWorkflowControlCommand(req.payload);
      if (r.ok) {
        respondOk(conn, req.id, {
          status: r.status,
          commandId: r.commandId,
          ...(r.code ? { code: r.code } : {}),
          ...(r.runId ? { runId: r.runId } : {}),
        });
      } else {
        respondError(conn, req.id, r.error);
      }
      return false;
    }
    case "capability.inspect": {
      const r = await runtime.inspectCapabilities(req.payload);
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
          "controlSessionId",
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
        optionalString(req.payload, "controlSessionId") ??
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
        optionalIdentitySafeMetadata(req.payload, "metadata")
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
        optionalIdentitySafeMetadata(req.payload, "metadata")
      );
    case "run.inject_message":
      return (
        requireOnly(req.payload, ["runId", "content", "metadata"]) ??
        requireString(req.payload, "runId") ??
        requireString(req.payload, "content") ??
        optionalIdentitySafeMetadata(req.payload, "metadata")
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
    case "im.bind":
      return (
        requireOnly(req.payload, [
          "subject",
          "permissions",
          "sessionId",
          "expiresAt",
        ]) ??
        validateImSubject(req.payload.subject) ??
        requireStringArray(req.payload, "permissions") ??
        invalidEnumValues(req.payload.permissions, "permissions", [
          ...IM_SESSION_PERMISSIONS,
        ]) ??
        optionalString(req.payload, "sessionId") ??
        optionalString(req.payload, "expiresAt")
      );
    case "im.message":
      return (
        requireOnly(req.payload, [
          "bindingId",
          "subject",
          "text",
          "messageId",
          "model",
          "metadata",
        ]) ??
        requireString(req.payload, "bindingId") ??
        validateImSubject(req.payload.subject) ??
        requireString(req.payload, "text") ??
        optionalString(req.payload, "messageId") ??
        optionalString(req.payload, "model") ??
        optionalIdentitySafeMetadata(req.payload, "metadata")
      );
    case "im.subscribe":
      return (
        requireOnly(req.payload, ["bindingId", "subject", "limit"]) ??
        requireString(req.payload, "bindingId") ??
        validateImSubject(req.payload.subject) ??
        optionalPositiveInteger(req.payload, "limit", 200)
      );
    case "im.delivery.ack":
      return (
        requireOnly(req.payload, ["bindingId", "subject", "deliveryKeys"]) ??
        requireString(req.payload, "bindingId") ??
        validateImSubject(req.payload.subject) ??
        requireStringArray(req.payload, "deliveryKeys")
      );
    case "im.approval.resolve":
      return (
        requireOnly(req.payload, [
          "bindingId",
          "subject",
          "approvalId",
          "decision",
          "message",
        ]) ??
        requireString(req.payload, "bindingId") ??
        validateImSubject(req.payload.subject) ??
        requireString(req.payload, "approvalId") ??
        optionalEnum(req.payload, "decision", ["approved", "denied"]) ??
        requireString(req.payload, "decision") ??
        optionalString(req.payload, "message")
      );
    case "im.cancel":
      return (
        requireOnly(req.payload, ["bindingId", "subject", "scope", "reason"]) ??
        requireString(req.payload, "bindingId") ??
        validateImSubject(req.payload.subject) ??
        optionalEnum(req.payload, "scope", ["execution", "lane"]) ??
        requireString(req.payload, "scope") ??
        optionalString(req.payload, "reason")
      );
    case "im.inspect":
      return (
        requireOnly(req.payload, ["bindingId", "subject"]) ??
        requireString(req.payload, "bindingId") ??
        validateImSubject(req.payload.subject)
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
        optionalIdentitySafeMetadata(req.payload, "metadata")
      );
    case "workflow.control":
      return (
        requireOnly(req.payload, [
          "workflowRunId",
          "sessionId",
          "commandId",
          "idempotencyKey",
          "expected",
          "command",
        ]) ??
        requireString(req.payload, "workflowRunId") ??
        optionalString(req.payload, "sessionId") ??
        optionalString(req.payload, "commandId") ??
        requireString(req.payload, "idempotencyKey") ??
        optionalRecord(req.payload, "expected") ??
        validateWorkflowControlCommand(req.payload.command)
      );
    case "workflow.control.process":
      return (
        requireOnly(req.payload, ["workflowRunId", "sessionId", "commandId"]) ??
        requireString(req.payload, "workflowRunId") ??
        optionalString(req.payload, "sessionId") ??
        requireString(req.payload, "commandId")
      );
    case "capability.inspect":
      return (
        requireOnly(req.payload, [
          "sessionId",
          "model",
          "shouldWrite",
          "accessMode",
          "backgroundTasks",
          "permissionMode",
        ]) ??
        optionalString(req.payload, "sessionId") ??
        optionalString(req.payload, "model") ??
        optionalBoolean(req.payload, "shouldWrite") ??
        optionalEnum(req.payload, "accessMode", [...ACCESS_MODES]) ??
        optionalEnum(req.payload, "backgroundTasks", [
          ...BACKGROUND_TASK_POLICIES,
        ]) ??
        optionalEnum(req.payload, "permissionMode", [...PERMISSION_MODES])
      );
  }
}

function validateWorkflowControlCommand(value: unknown): string | undefined {
  if (!isRecord(value)) return "workflow control command must be an object";
  const kind = value.kind;
  if (kind === "cancel") return optionalString(value, "reason");
  if (kind === "resume_request") return optionalString(value, "waitId");
  if (kind === "provide_input") {
    return requireString(value, "waitId") ?? requireString(value, "value");
  }
  if (kind === "approval_response") {
    return (
      requireString(value, "approvalId") ??
      (value.decision === "approved" || value.decision === "denied"
        ? undefined
        : "decision must be approved or denied") ??
      optionalString(value, "message")
    );
  }
  return "workflow control command kind is invalid";
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

const RESERVED_IDENTITY_FIELDS = new Set([
  "principalId",
  "authenticatedBy",
  "system",
  "verified",
  "trusted",
]);

function optionalIdentitySafeMetadata(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const recordError = optionalRecord(record, key);
  if (recordError) return recordError;
  const value = record[key];
  if (value === undefined) return undefined;
  const spoofed = Object.keys(value as Record<string, unknown>).filter(
    (field) => RESERVED_IDENTITY_FIELDS.has(field),
  );
  return spoofed.length > 0
    ? `${key} cannot contain identity field(s): ${spoofed.join(", ")}`
    : undefined;
}

function workflowControlSource(
  principal: HostImPrincipal,
  connectionId: string,
) {
  return {
    kind: "api" as const,
    principalId: principal.id,
    authenticatedBy: principal.authenticatedBy,
    connectionId,
  };
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

function requireStringArray(
  payload: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = payload[field];
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? undefined
    : `${field} must be an array of strings`;
}

function invalidEnumValues(
  value: unknown,
  field: string,
  allowed: readonly string[],
): string | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every(
    (entry) => typeof entry === "string" && allowed.includes(entry),
  )
    ? undefined
    : `${field} contains an unsupported value`;
}

function validateImSubject(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "subject must be an object";
  }
  const subject = value as Record<string, unknown>;
  return (
    requireOnly(subject, ["platform", "chatId", "threadId", "userId"]) ??
    requireString(subject, "platform") ??
    requireString(subject, "chatId") ??
    optionalString(subject, "threadId") ??
    requireString(subject, "userId")
  );
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
