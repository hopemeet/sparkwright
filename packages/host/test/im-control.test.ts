import { describe, expect, it } from "vitest";
import type { HostEvent } from "@sparkwright/protocol";
import {
  associateHostImRuntime,
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
      sessionId: "session_im_approval",
    });
    if (!bound.ok) throw new Error("expected binding");
    const runtime = fakeRuntime("execution_im", "session_im_approval");
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

  it("filters actionable approval payloads from inspect-only subscribers", () => {
    const state = createHostImControlState({ allowSelfBinding: true });
    const owner = bindHostImSession(state, principal, {
      subject,
      permissions: ["message", "inspect", "approve"],
      sessionId: "session_im_filtered",
    });
    const observerPrincipal = {
      id: "gateway:observer",
      clientName: "sparkwright-im-gateway",
    };
    const observerSubject = { ...subject, userId: "observer" };
    const observer = bindHostImSession(state, observerPrincipal, {
      subject: observerSubject,
      permissions: ["inspect"],
      sessionId: "session_im_filtered",
    });
    if (!owner.ok || !observer.ok) throw new Error("expected bindings");
    const runtime = fakeRuntime("execution_filtered", "session_im_filtered");
    associateHostImRuntime(state, runtime, owner.binding);
    recordHostImEvent(state, runtime, approvalEvent("approval_filtered"));

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
      sessionId: "session_im_outbox",
    });
    if (!bound.ok) throw new Error("expected binding");
    const runtime = fakeRuntime("execution_outbox", "session_im_outbox");
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
