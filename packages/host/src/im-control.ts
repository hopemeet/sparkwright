import { createId, createSessionId } from "@sparkwright/core";
import type {
  HostEvent,
  ImDelivery,
  ImSessionPermission,
  ImSubjectClaims,
  ProtocolError,
} from "@sparkwright/protocol";
import type { HostExecutionIdentityView } from "./runtime/contracts.js";

export interface HostImPrincipal {
  readonly id: string;
  readonly kind: "host_client" | "gateway";
  readonly authenticated: boolean;
  readonly authenticatedBy: string;
  clientName: string;
}

export interface HostImControlPolicy {
  allowSelfBinding: boolean;
  allowedClientNames: readonly string[];
  permissionCeiling: readonly ImSessionPermission[];
  bindingTtlMs: number;
  maxOutboxEntries: number;
}

export interface HostImBinding {
  bindingId: string;
  principalId: string;
  sessionId: string;
  laneKey: string;
  subject: ImSubjectClaims;
  permissions: ImSessionPermission[];
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
  subscribed: boolean;
}

interface RuntimeAssociation {
  bindingId: string;
  principalId: string;
}

interface ApprovalRoute {
  executionId: string;
  sessionId: string;
  initiatingPrincipalId: string;
  resolved: boolean;
}

export interface HostImControlState {
  policy: HostImControlPolicy;
  bindings: Map<string, HostImBinding>;
  bindingsBySubject: Map<string, string>;
  runtimeAssociations: Map<HostExecutionIdentityView, RuntimeAssociation>;
  approvals: Map<string, ApprovalRoute>;
  outboxes: Map<string, ImDelivery[]>;
  acknowledgedDeliveries: Map<string, Set<string>>;
  deliverySequence: Map<string, number>;
}

const DEFAULT_POLICY: HostImControlPolicy = {
  allowSelfBinding: false,
  allowedClientNames: ["sparkwright-im-gateway"],
  permissionCeiling: [
    "message",
    "inspect",
    "approve",
    "cancel_execution",
    "cancel_lane",
  ],
  bindingTtlMs: 24 * 60 * 60 * 1_000,
  maxOutboxEntries: 256,
};

export function createHostImControlState(
  policy: Partial<HostImControlPolicy> = {},
): HostImControlState {
  return {
    policy: { ...DEFAULT_POLICY, ...policy },
    bindings: new Map(),
    bindingsBySubject: new Map(),
    runtimeAssociations: new Map(),
    approvals: new Map(),
    outboxes: new Map(),
    acknowledgedDeliveries: new Map(),
    deliverySequence: new Map(),
  };
}

export function bindHostImSession(
  state: HostImControlState,
  principal: HostImPrincipal,
  input: {
    subject: ImSubjectClaims;
    permissions: ImSessionPermission[];
    sessionId?: string;
    expiresAt?: string;
  },
  laneKeyForSession: (sessionId: string) => string = (sessionId) => sessionId,
): { ok: true; binding: HostImBinding } | { ok: false; error: ProtocolError } {
  if (!state.policy.allowSelfBinding) {
    return denied("IM self-binding is disabled by Host policy.");
  }
  if (!principal.authenticated) {
    return denied("Authenticated transport is required for IM self-binding.");
  }
  if (!state.policy.allowedClientNames.includes(principal.clientName)) {
    return denied("Authenticated client is not allowed to create IM bindings.");
  }
  const now = Date.now();
  const requestedExpiry = input.expiresAt
    ? Date.parse(input.expiresAt)
    : now + state.policy.bindingTtlMs;
  if (
    !Number.isFinite(requestedExpiry) ||
    requestedExpiry <= now ||
    requestedExpiry > now + state.policy.bindingTtlMs
  ) {
    return invalid("binding expiry must be in the future and within Host TTL");
  }
  const permissions = [...new Set(input.permissions)];
  if (
    permissions.length === 0 ||
    permissions.some(
      (permission) => !state.policy.permissionCeiling.includes(permission),
    )
  ) {
    return denied("Requested IM permissions exceed the Host ceiling.");
  }
  const subjectKey = bindingSubjectKey(principal.id, input.subject);
  const existingId = state.bindingsBySubject.get(subjectKey);
  const existing = existingId ? state.bindings.get(existingId) : undefined;
  if (existing && bindingIsLive(existing)) {
    if (
      input.sessionId !== undefined &&
      input.sessionId !== existing.sessionId
    ) {
      return denied(
        "Requested session does not match the existing exact IM binding.",
      );
    }
    return { ok: true, binding: existing };
  }
  if (input.sessionId !== undefined) {
    return denied("New IM self-bindings must use a Host-assigned session.");
  }
  const sessionId = createSessionId();
  const binding: HostImBinding = {
    bindingId: createId("binding") as string,
    principalId: principal.id,
    sessionId,
    laneKey: laneKeyForSession(sessionId),
    subject: { ...input.subject },
    permissions,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(requestedExpiry).toISOString(),
    revoked: false,
    subscribed: false,
  };
  state.bindings.set(binding.bindingId, binding);
  state.bindingsBySubject.set(subjectKey, binding.bindingId);
  return { ok: true, binding };
}

export function authorizeHostImBinding(
  state: HostImControlState,
  principal: HostImPrincipal,
  input: {
    bindingId: string;
    subject: ImSubjectClaims;
    permission: ImSessionPermission;
  },
): { ok: true; binding: HostImBinding } | { ok: false; error: ProtocolError } {
  const binding = state.bindings.get(input.bindingId);
  if (!binding || !bindingIsLive(binding)) {
    return denied("IM binding is missing, expired, or revoked.");
  }
  if (
    binding.principalId !== principal.id ||
    subjectIdentity(binding.subject) !== subjectIdentity(input.subject)
  ) {
    return denied(
      "IM binding subject does not match the authenticated caller.",
    );
  }
  if (!binding.permissions.includes(input.permission)) {
    return denied(`IM binding does not grant ${input.permission}.`);
  }
  return { ok: true, binding };
}

export function subscribeHostImSession(
  state: HostImControlState,
  principal: HostImPrincipal,
  input: { bindingId: string; subject: ImSubjectClaims; limit?: number },
):
  | { ok: true; binding: HostImBinding; deliveries: ImDelivery[] }
  | { ok: false; error: ProtocolError } {
  const authorized = authorizeHostImBinding(state, principal, {
    ...input,
    permission: "inspect",
  });
  if (!authorized.ok) return authorized;
  authorized.binding.subscribed = true;
  const acknowledged = state.acknowledgedDeliveries.get(input.bindingId);
  return {
    ok: true,
    binding: authorized.binding,
    deliveries: (state.outboxes.get(authorized.binding.sessionId) ?? [])
      .filter(
        (delivery) =>
          !acknowledged?.has(delivery.deliveryKey) &&
          deliveryVisibleToBinding(state, authorized.binding, delivery),
      )
      .slice(0, input.limit ?? 100),
  };
}

export function acknowledgeHostImDeliveries(
  state: HostImControlState,
  principal: HostImPrincipal,
  input: {
    bindingId: string;
    subject: ImSubjectClaims;
    deliveryKeys: string[];
  },
): { ok: true; acknowledged: number } | { ok: false; error: ProtocolError } {
  const authorized = authorizeHostImBinding(state, principal, {
    ...input,
    permission: "inspect",
  });
  if (!authorized.ok) return authorized;
  const outbox = state.outboxes.get(authorized.binding.sessionId) ?? [];
  const available = new Set(
    outbox
      .filter((delivery) =>
        deliveryVisibleToBinding(state, authorized.binding, delivery),
      )
      .map((delivery) => delivery.deliveryKey),
  );
  const acknowledged =
    state.acknowledgedDeliveries.get(input.bindingId) ?? new Set<string>();
  let count = 0;
  for (const key of input.deliveryKeys) {
    if (!available.has(key) || acknowledged.has(key)) continue;
    acknowledged.add(key);
    count += 1;
  }
  state.acknowledgedDeliveries.set(input.bindingId, acknowledged);
  return { ok: true, acknowledged: count };
}

export function associateHostImRuntime(
  state: HostImControlState,
  runtime: HostExecutionIdentityView,
  binding: HostImBinding,
): void {
  state.runtimeAssociations.set(runtime, {
    bindingId: binding.bindingId,
    principalId: binding.principalId,
  });
}

export function recordHostImEvent(
  state: HostImControlState,
  runtime: HostExecutionIdentityView,
  event: HostEvent,
): void {
  const association = state.runtimeAssociations.get(runtime);
  if (!association) return;
  const binding = state.bindings.get(association.bindingId);
  if (!binding || !bindingIsLive(binding)) return;
  const identity = runtime.executionIdentity();
  if (event.kind === "approval.requested" && identity) {
    state.approvals.set(event.payload.approvalId, {
      executionId: identity.executionId,
      sessionId: binding.sessionId,
      initiatingPrincipalId: association.principalId,
      resolved: false,
    });
  }
  appendDelivery(state, binding.sessionId, event);
}

export function resolveHostImApproval(
  state: HostImControlState,
  principal: HostImPrincipal,
  input: {
    bindingId: string;
    subject: ImSubjectClaims;
    approvalId: string;
  },
): { ok: true; executionId: string } | { ok: false; error: ProtocolError } {
  const route = state.approvals.get(input.approvalId);
  const authorized = authorizeHostImBinding(state, principal, {
    ...input,
    permission:
      route?.initiatingPrincipalId === principal.id ? "message" : "approve",
  });
  if (!authorized.ok) return authorized;
  if (!route || route.sessionId !== authorized.binding.sessionId) {
    return {
      ok: false,
      error: {
        code: "approval_not_found",
        message: "approval route not found",
      },
    };
  }
  if (route.resolved) {
    return {
      ok: false,
      error: { code: "conflict", message: "approval is already resolved" },
    };
  }
  route.resolved = true;
  return { ok: true, executionId: route.executionId };
}

export function reopenHostImApproval(
  state: HostImControlState,
  approvalId: string,
): void {
  const route = state.approvals.get(approvalId);
  if (route) route.resolved = false;
}

export function shouldRetainHostImRuntime(
  state: HostImControlState,
  runtime: HostExecutionIdentityView,
): boolean {
  const association = state.runtimeAssociations.get(runtime);
  if (!association || !runtime.executionIdentity()) return false;
  const binding = state.bindings.get(association.bindingId);
  return Boolean(binding && bindingIsLive(binding) && binding.subscribed);
}

export function revokeHostImBinding(
  state: HostImControlState,
  bindingId: string,
): boolean {
  const binding = state.bindings.get(bindingId);
  if (!binding || binding.revoked) return false;
  binding.revoked = true;
  binding.subscribed = false;
  return true;
}

export function pendingHostImDeliveryCount(
  state: HostImControlState,
  binding: HostImBinding,
): number {
  const acknowledged = state.acknowledgedDeliveries.get(binding.bindingId);
  return (state.outboxes.get(binding.sessionId) ?? []).filter(
    (delivery) =>
      !acknowledged?.has(delivery.deliveryKey) &&
      deliveryVisibleToBinding(state, binding, delivery),
  ).length;
}

function appendDelivery(
  state: HostImControlState,
  sessionId: string,
  event: HostEvent,
): void {
  const outbox = state.outboxes.get(sessionId) ?? [];
  let sequence = (state.deliverySequence.get(sessionId) ?? 0) + 1;
  state.deliverySequence.set(sessionId, sequence);
  outbox.push({
    deliveryKey: `${sessionId}:${sequence}`,
    sessionId,
    event,
  });
  if (outbox.length > state.policy.maxOutboxEntries) {
    outbox.splice(0, outbox.length - state.policy.maxOutboxEntries + 1);
    sequence += 1;
    state.deliverySequence.set(sessionId, sequence);
    outbox.push({
      deliveryKey: `${sessionId}:${sequence}`,
      sessionId,
      event: {
        envelope: "event",
        id: createId("event") as string,
        kind: "host.log",
        timestamp: new Date().toISOString(),
        payload: {
          level: "warn",
          source: "host.im-control",
          line: "IM delivery outbox overflowed; oldest projections were dropped.",
        },
      },
    });
  }
  state.outboxes.set(sessionId, outbox);
}

function bindingIsLive(binding: HostImBinding): boolean {
  return !binding.revoked && Date.parse(binding.expiresAt) > Date.now();
}

function deliveryVisibleToBinding(
  state: HostImControlState,
  binding: HostImBinding,
  delivery: ImDelivery,
): boolean {
  if (delivery.event.kind !== "approval.requested") return true;
  const route = state.approvals.get(delivery.event.payload.approvalId);
  return Boolean(
    route &&
    (route.initiatingPrincipalId === binding.principalId ||
      binding.permissions.includes("approve")),
  );
}

function bindingSubjectKey(
  principalId: string,
  subject: ImSubjectClaims,
): string {
  return `${principalId}\0${subjectIdentity(subject)}`;
}

function subjectIdentity(subject: ImSubjectClaims): string {
  return [
    subject.platform,
    subject.chatId,
    subject.threadId ?? "",
    subject.userId,
  ].join("\0");
}

function denied(message: string): { ok: false; error: ProtocolError } {
  return { ok: false, error: { code: "unauthorized", message } };
}

function invalid(message: string): { ok: false; error: ProtocolError } {
  return { ok: false, error: { code: "invalid_payload", message } };
}
