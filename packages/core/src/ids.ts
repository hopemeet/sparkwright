export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type SessionId = Brand<string, "SessionId">;
export type RunId = Brand<string, "RunId">;
export type EventId = Brand<string, "EventId">;
export type ToolCallId = Brand<string, "ToolCallId">;
export type ApprovalId = Brand<string, "ApprovalId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type ContextItemId = Brand<string, "ContextItemId">;
export type WorkspaceWriteId = Brand<string, "WorkspaceWriteId">;
export type PlanId = Brand<string, "PlanId">;
export type PlanStepId = Brand<string, "PlanStepId">;
export type SpanId = Brand<string, "SpanId">;
export type TraceId = Brand<string, "TraceId">;

export function createId<T extends string>(prefix: T): Brand<string, T> {
  const random = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${prefix}_${time}${random}` as Brand<string, T>;
}

export function createSessionId(): SessionId {
  return createId("session") as unknown as SessionId;
}

/**
 * Adapt a host- or gateway-supplied string into the typed `SessionId`
 * surface. The brand is a compile-time guardrail; this helper adds the
 * intake-edge runtime check so a `null`, `undefined`, empty, or
 * whitespace-only value cannot silently flow into store paths and event
 * payloads (where it would surface much later as `.../sessions/null/...`
 * or as a corrupt session record).
 */
export function asSessionId(id: string): SessionId {
  if (typeof id !== "string") {
    throw new TypeError(
      `asSessionId expected a string, received ${id === null ? "null" : typeof id}`,
    );
  }
  if (id.trim() === "") {
    throw new TypeError("asSessionId expected a non-empty session id");
  }
  assertSafePathSegment(id, "session id");
  return id as SessionId;
}

/**
 * Validate identifiers that are used as a single filesystem path segment.
 * This is intentionally broader than generated Sparkwright ids so embedders
 * can keep existing stable ids, but it rejects path traversal and control
 * characters before ids reach file-backed stores.
 */
export function assertSafePathSegment(value: string, label: string): void {
  if (value !== value.trim()) {
    throw new TypeError(`${label} must not contain leading or trailing space`);
  }
  if (value === "." || value === "..") {
    throw new TypeError(`${label} must be a safe path segment`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw new TypeError(
      `${label} must contain only letters, numbers, dot, underscore, or hyphen`,
    );
  }
}

export function createRunId(): RunId {
  return createId("run") as unknown as RunId;
}

export function createEventId(): EventId {
  return createId("evt") as unknown as EventId;
}

export function createToolCallId(): ToolCallId {
  return createId("call") as unknown as ToolCallId;
}

export function createApprovalId(): ApprovalId {
  return createId("approval") as unknown as ApprovalId;
}

export function createArtifactId(): ArtifactId {
  return createId("artifact") as unknown as ArtifactId;
}

export function createContextItemId(): ContextItemId {
  return createId("ctx") as unknown as ContextItemId;
}

export function createWorkspaceWriteId(): WorkspaceWriteId {
  return createId("write") as unknown as WorkspaceWriteId;
}

export function createPlanId(): PlanId {
  return createId("plan") as unknown as PlanId;
}

export function createPlanStepId(): PlanStepId {
  return createId("step") as unknown as PlanStepId;
}

export function createSpanId(): SpanId {
  return createId("spn") as unknown as SpanId;
}

export function createTraceId(): TraceId {
  return createId("trc") as unknown as TraceId;
}
