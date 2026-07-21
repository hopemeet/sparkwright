import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

interface Message {
  envelope: "response" | "event";
  id: string;
  kind?: string;
  ok?: boolean;
  result?: Record<string, unknown>;
  payload?: Record<string, unknown>;
}

const children: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

describe("approval queue Host test adapter", () => {
  it("hangs two approval waiters before either one is resolved", async () => {
    const adapter = fileURLToPath(
      new URL("./fixtures/approval-queue-host.mjs", import.meta.url),
    );
    const child = spawn(process.execPath, [adapter, "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    const messages: Message[] = [];
    const listeners = new Set<() => void>();
    createInterface({ input: child.stdout }).on("line", (line) => {
      messages.push(JSON.parse(line) as Message);
      for (const listener of listeners) listener();
    });

    const send = (message: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const waitFor = async (predicate: (message: Message) => boolean) => {
      const existing = messages.find(predicate);
      if (existing) return existing;
      return await new Promise<Message>((resolve, reject) => {
        const timeout = setTimeout(() => {
          listeners.delete(check);
          reject(
            new Error(
              `timed out waiting for adapter message: ${JSON.stringify(messages)}`,
            ),
          );
        }, 2_000);
        const check = (): void => {
          const match = messages.find(predicate);
          if (!match) return;
          clearTimeout(timeout);
          listeners.delete(check);
          resolve(match);
        };
        listeners.add(check);
      });
    };

    send({
      envelope: "request",
      id: "handshake",
      kind: "handshake",
      timestamp: new Date().toISOString(),
      payload: {
        protocolVersion: "2.0",
        client: { name: "approval-queue-test", version: "0.0.0" },
      },
    });
    await waitFor(
      (message) =>
        message.envelope === "response" && message.id === "handshake",
    );

    send({
      envelope: "request",
      id: "workflow_list",
      kind: "workflow.list",
      timestamp: new Date().toISOString(),
      payload: { limit: 100 },
    });
    await expect(
      waitFor(
        (message) =>
          message.envelope === "response" && message.id === "workflow_list",
      ),
    ).resolves.toMatchObject({ ok: true, result: { workflows: [] } });

    send({
      envelope: "request",
      id: "start",
      kind: "run.start",
      timestamp: new Date().toISOString(),
      payload: {
        goal: "verify two concurrent approval waiters",
        sessionId: "session_approval_queue_test",
        accessMode: "ask",
      },
    });
    await waitFor(
      (message) => message.envelope === "response" && message.id === "start",
    );
    await waitFor(
      () =>
        messages.filter(
          (message) =>
            message.envelope === "event" &&
            message.kind === "approval.requested",
        ).length === 2,
    );
    const approvals = messages.filter(
      (message) =>
        message.envelope === "event" && message.kind === "approval.requested",
    );
    expect(approvals).toHaveLength(2);
    expect(approvals.map((message) => message.payload?.action)).toEqual([
      "tool.execute",
      "workspace.write",
    ]);
    expect(
      messages.some(
        (message) =>
          message.envelope === "event" && message.kind === "run.completed",
      ),
    ).toBe(false);

    const approvalIds = approvals.map((message) =>
      String(message.payload?.approvalId),
    );
    send(resolveRequest("resolve_first", approvalIds[0]!));
    await waitFor(
      (message) =>
        message.envelope === "response" && message.id === "resolve_first",
    );
    expect(
      messages.some(
        (message) =>
          message.envelope === "event" && message.kind === "run.completed",
      ),
    ).toBe(false);

    send(resolveRequest("resolve_second", approvalIds[1]!));
    await waitFor(
      (message) =>
        message.envelope === "event" && message.kind === "run.completed",
    );
  });
});

function resolveRequest(id: string, approvalId: string) {
  return {
    envelope: "request",
    id,
    kind: "approval.resolve",
    timestamp: new Date().toISOString(),
    payload: { approvalId, decision: "denied" },
  };
}
