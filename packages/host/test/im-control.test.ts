import { describe, expect, it } from "vitest";
import type { HostEvent } from "@sparkwright/protocol";
import {
  acknowledgeHostImDeliveries,
  associateHostImRuntime,
  authorizeHostImBinding,
  bindHostImSession,
  createHostImControlState,
  recordHostImEvent,
  resolveHostImApproval,
  subscribeHostImSession,
  type HostImPrincipal,
} from "../src/im-control.js";
import type { HostRuntime } from "../src/runtime.js";

const subject = {
  platform: "telegram",
  chatId: "chat_1",
  userId: "user_1",
};
const principal: HostImPrincipal = {
  id: "gateway:trusted",
  kind: "gateway",
  authenticated: true,
  authenticatedBy: "test-credential",
  clientName: "sparkwright-im-gateway",
};

describe("Host IM control", () => {
  it("keeps self-binding disabled unless the Host explicitly enables it", () => {
    const denied = bindHostImSession(createHostImControlState(), principal, {
      subject,
      permissions: ["message"],
    });
    expect(denied).toMatchObject({
      ok: false,
      error: { code: "unauthorized" },
    });

    const enabled = bindHostImSession(
      createHostImControlState({ allowSelfBinding: true }),
      principal,
      { subject, permissions: ["message", "inspect"] },
    );
    expect(enabled.ok).toBe(true);
  });

  it("requires an authenticated transport even when self-binding is enabled", () => {
    const unauthenticated: HostImPrincipal = {
      id: "connection:local",
      kind: "host_client",
      authenticated: false,
      authenticatedBy: "ws-no-auth",
      clientName: "sparkwright-im-gateway",
    };
    expect(
      bindHostImSession(
        createHostImControlState({ allowSelfBinding: true }),
        unauthenticated,
        { subject, permissions: ["message"] },
      ),
    ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });

  it("keeps one credential stable across allowed client names and replay", () => {
    const state = createHostImControlState({
      allowSelfBinding: true,
      allowedClientNames: ["gateway-a", "gateway-b"],
    });
    const first: HostImPrincipal = { ...principal, clientName: "gateway-a" };
    const reconnected: HostImPrincipal = {
      ...principal,
      clientName: "gateway-b",
    };
    const bound = bindHostImSession(state, first, {
      subject,
      permissions: ["message", "inspect"],
    });
    if (!bound.ok) throw new Error("expected binding");
    const runtime = fakeRuntime("execution_reconnect", bound.binding.sessionId);
    associateHostImRuntime(state, runtime, bound.binding);
    recordHostImEvent(state, runtime, logEvent("unacknowledged"));

    const rebound = bindHostImSession(state, reconnected, {
      subject,
      permissions: ["message", "inspect"],
      sessionId: bound.binding.sessionId,
    });
    expect(rebound).toMatchObject({
      ok: true,
      binding: { bindingId: bound.binding.bindingId },
    });
    expect(
      bindHostImSession(state, reconnected, {
        subject,
        permissions: ["message", "inspect"],
        sessionId: "different-session",
      }),
    ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    const replay = subscribeHostImSession(state, reconnected, {
      bindingId: bound.binding.bindingId,
      subject,
    });
    expect(replay).toMatchObject({
      ok: true,
      deliveries: [
        expect.objectContaining({ sessionId: bound.binding.sessionId }),
      ],
    });
    if (!replay.ok) throw new Error("expected replay");
    expect(
      acknowledgeHostImDeliveries(state, reconnected, {
        bindingId: bound.binding.bindingId,
        subject,
        deliveryKeys: replay.deliveries.map((entry) => entry.deliveryKey),
      }),
    ).toMatchObject({ ok: true, acknowledged: 1 });
  });

  it("isolates different credentials with the same client name and subject", () => {
    const state = createHostImControlState({ allowSelfBinding: true });
    const other: HostImPrincipal = {
      ...principal,
      id: "gateway:other-credential",
    };
    const first = bindHostImSession(state, principal, {
      subject,
      permissions: ["message", "inspect"],
    });
    if (!first.ok) throw new Error("expected owner binding");
    expect(
      bindHostImSession(state, other, {
        subject,
        permissions: ["message", "inspect"],
        sessionId: first.binding.sessionId,
      }),
    ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    const second = bindHostImSession(state, other, {
      subject,
      permissions: ["message", "inspect"],
    });
    if (!second.ok) throw new Error("expected isolated binding");
    expect(second.binding.bindingId).not.toBe(first.binding.bindingId);
    expect(second.binding.sessionId).not.toBe(first.binding.sessionId);
    expect(
      authorizeHostImBinding(state, other, {
        bindingId: first.binding.bindingId,
        subject,
        permission: "inspect",
      }),
    ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });

  it("does not let a new exact subject select an existing session", () => {
    const state = createHostImControlState({ allowSelfBinding: true });
    const owner = bindHostImSession(state, principal, {
      subject,
      permissions: ["message", "inspect", "approve"],
    });
    if (!owner.ok) throw new Error("expected owner binding");
    expect(
      bindHostImSession(state, principal, {
        subject: { ...subject, userId: "other-user" },
        permissions: ["message", "inspect", "approve"],
        sessionId: owner.binding.sessionId,
      }),
    ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(
      bindHostImSession(state, principal, {
        subject: { ...subject, userId: "fresh-user" },
        permissions: ["message"],
        sessionId: "arbitrary-existing-session",
      }),
    ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });

  it("enforces every scoped permission on an exact binding", () => {
    const state = createHostImControlState({ allowSelfBinding: true });
    const bound = bindHostImSession(state, principal, {
      subject,
      permissions: ["message"],
    });
    if (!bound.ok) throw new Error("expected binding");
    expect(
      subscribeHostImSession(state, principal, {
        bindingId: bound.binding.bindingId,
        subject,
      }),
    ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    for (const permission of [
      "inspect",
      "approve",
      "cancel_execution",
      "cancel_lane",
    ] as const) {
      expect(
        authorizeHostImBinding(state, principal, {
          bindingId: bound.binding.bindingId,
          subject,
          permission,
        }),
      ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    }
  });

  it("rejects subject hijacking and filters unauthorized subscriptions", () => {
    const state = createHostImControlState({ allowSelfBinding: true });
    const bound = bindHostImSession(state, principal, {
      subject,
      permissions: ["message", "inspect"],
    });
    if (!bound.ok) throw new Error("expected binding");
    const hijacked = subscribeHostImSession(state, principal, {
      bindingId: bound.binding.bindingId,
      subject: { ...subject, userId: "attacker" },
    });
    expect(hijacked).toMatchObject({
      ok: false,
      error: { code: "unauthorized" },
    });
  });

  it("gives an approval to the first valid bound principal only", () => {
    const state = createHostImControlState({ allowSelfBinding: true });
    const bound = bindHostImSession(state, principal, {
      subject,
      permissions: ["message", "inspect", "approve"],
    });
    if (!bound.ok) throw new Error("expected binding");
    const runtime = fakeRuntime("execution_im", bound.binding.sessionId);
    associateHostImRuntime(state, runtime, bound.binding);
    recordHostImEvent(state, runtime, approvalEvent("approval_im"));

    expect(
      resolveHostImApproval(state, principal, {
        bindingId: bound.binding.bindingId,
        subject,
        approvalId: "approval_im",
      }),
    ).toMatchObject({ ok: true, executionId: "execution_im" });
    expect(
      resolveHostImApproval(state, principal, {
        bindingId: bound.binding.bindingId,
        subject,
        approvalId: "approval_im",
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("keeps approvals inaccessible to inspect-only subscribers", () => {
    const state = createHostImControlState({ allowSelfBinding: true });
    const owner = bindHostImSession(state, principal, {
      subject,
      permissions: ["message", "inspect", "approve"],
    });
    const observerPrincipal = {
      id: "gateway:observer",
      kind: "gateway" as const,
      authenticated: true,
      authenticatedBy: "test-credential",
      clientName: "sparkwright-im-gateway",
    };
    const observerSubject = { ...subject, userId: "observer" };
    const observer = bindHostImSession(state, observerPrincipal, {
      subject: observerSubject,
      permissions: ["inspect"],
    });
    if (!owner.ok || !observer.ok) throw new Error("expected bindings");
    const runtime = fakeRuntime("execution_filtered", owner.binding.sessionId);
    associateHostImRuntime(state, runtime, owner.binding);
    recordHostImEvent(state, runtime, approvalEvent("approval_filtered"));

    expect(
      resolveHostImApproval(state, observerPrincipal, {
        bindingId: observer.binding.bindingId,
        subject: observerSubject,
        approvalId: "approval_filtered",
      }),
    ).toMatchObject({ ok: false, error: { code: "unauthorized" } });

    const replay = subscribeHostImSession(state, observerPrincipal, {
      bindingId: observer.binding.bindingId,
      subject: observerSubject,
    });
    expect(replay).toMatchObject({ ok: true, deliveries: [] });
  });

  it("bounds replay and emits an explicit overflow diagnostic", () => {
    const state = createHostImControlState({
      allowSelfBinding: true,
      maxOutboxEntries: 2,
    });
    const bound = bindHostImSession(state, principal, {
      subject,
      permissions: ["message", "inspect"],
    });
    if (!bound.ok) throw new Error("expected binding");
    const runtime = fakeRuntime("execution_outbox", bound.binding.sessionId);
    associateHostImRuntime(state, runtime, bound.binding);
    recordHostImEvent(state, runtime, logEvent("one"));
    recordHostImEvent(state, runtime, logEvent("two"));
    recordHostImEvent(state, runtime, logEvent("three"));

    const replay = subscribeHostImSession(state, principal, {
      bindingId: bound.binding.bindingId,
      subject,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.deliveries).toHaveLength(2);
    expect(replay.deliveries.at(-1)?.event).toMatchObject({
      kind: "host.log",
      payload: { line: expect.stringContaining("overflowed") },
    });
  });
});

function fakeRuntime(executionId: string, sessionId: string): HostRuntime {
  return {
    executionIdentity: () => ({
      executionId,
      sessionId,
      currentRunId: "run_im",
      runIds: ["run_im"],
    }),
  } as unknown as HostRuntime;
}

function approvalEvent(approvalId: string): HostEvent {
  return {
    envelope: "event",
    id: `event_${approvalId}`,
    kind: "approval.requested",
    timestamp: new Date().toISOString(),
    payload: {
      runId: "run_im",
      approvalId,
      action: "write",
      summary: "Write file",
    },
  };
}

function logEvent(line: string): HostEvent {
  return {
    envelope: "event",
    id: `event_${line}`,
    kind: "host.log",
    timestamp: new Date().toISOString(),
    payload: { level: "info", line },
  };
}
