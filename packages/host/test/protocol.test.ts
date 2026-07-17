import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type HostMessage } from "@sparkwright/protocol";
import {
  asSessionId,
  createRun,
  type ContextItem,
  FileSessionStore,
  SESSION_COMPACT_SCHEMA_VERSION,
  type SessionEvent,
  type RunId,
  type SparkwrightEvent,
} from "@sparkwright/core";
import {
  FileTaskStore,
  FileWorkflowControlInbox,
  FileWorkflowStore,
  createTaskId,
  type WorkflowRunId,
} from "@sparkwright/agent-runtime";
import { CronStore, defaultCronRoot } from "@sparkwright/cron";
import { FileSkillUsageRecorder } from "@sparkwright/skills";
import { authenticatedConnection, type Connection } from "../src/connection.js";
import { skillUsagePath } from "../src/index.js";
import { serveConnection } from "../src/server.js";
import { HostRuntime } from "../src/runtime.js";
import { createHostService } from "../src/host-service.js";

/**
 * Tiny in-process Connection pair: two ends sharing two queues. Lets the
 * test play "client" while serveConnection plays "host" without touching
 * stdio or sockets.
 */
function createConnectionPair(): {
  hostSide: Connection;
  clientSend: (msg: HostMessage) => void;
  clientMessages: () => HostMessage[];
  waitFor: (match: (m: HostMessage) => boolean) => Promise<HostMessage>;
  close: () => void;
} {
  const fromClient: ((m: HostMessage) => void)[] = [];
  let onClose: ((reason?: string) => void) | null = null;
  const messages: HostMessage[] = [];
  const watchers: {
    match: (m: HostMessage) => boolean;
    resolve: (m: HostMessage) => void;
  }[] = [];

  const hostSide: Connection = {
    id: `test_host_${++testConnectionSequence}`,
    send(m) {
      messages.push(m);
      // notify watchers
      for (let i = watchers.length - 1; i >= 0; i -= 1) {
        if (watchers[i].match(m)) {
          watchers[i].resolve(m);
          watchers.splice(i, 1);
        }
      }
    },
    onMessage(handler) {
      fromClient.push(handler);
    },
    onClose(handler) {
      onClose = handler;
    },
    close() {
      onClose?.("test close");
    },
  };

  return {
    hostSide,
    clientSend: (msg) => {
      for (const h of fromClient) h(msg);
    },
    clientMessages: () => messages,
    waitFor: (match) =>
      new Promise((resolve) => {
        const found = messages.find(match);
        if (found) return resolve(found);
        watchers.push({ match, resolve });
      }),
    close: () => onClose?.("test close"),
  };
}

let testConnectionSequence = 0;

const TIMESTAMP = "2026-05-24T12:00:00.000Z";

function checkpointJson(input: { runId: string; goal: string }) {
  return JSON.stringify(
    {
      schemaVersion: "run-checkpoint.v1",
      run: {
        id: input.runId,
        goal: input.goal,
        state: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:30.000Z",
        metadata: { tag: "host-resume-test" },
      },
      loop: {
        step: 1,
        turnCount: 0,
        context: [],
        repeatedToolCallCount: 0,
        transition: { reason: "next_turn" },
      },
      model: { activeIndex: 0, fallbackCount: 0 },
      recovery: { outputRecoveriesUsed: 0, maxOutputRecoveries: 3 },
      budget: {
        usage: {
          elapsedMs: 0,
          modelCalls: 0,
          toolCalls: 0,
          tokens: 0,
          costUsd: 0,
        },
      },
      queues: {
        commandCount: 0,
        pendingPrefetch: false,
        pendingSummary: false,
      },
      resumability: { complete: true, reasons: [] },
      createdAt: "2026-01-01T00:00:30.500Z",
      metadata: { snapshotReason: "test" },
    },
    null,
    2,
  );
}

async function rmWhenReady(path: string, attempts = 10): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EPERM" && code !== "EACCES") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function readFileWhenReady(
  path: string,
  contains: string,
  timeoutMs = 12000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const content = await readFile(path, "utf8");
      if (content.includes(contains)) return content;
    } catch {
      // The session run store may still be flushing the child trace.
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${path} to contain "${contains}"`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForAgentTaskTerminal(
  runtime: HostRuntime,
  timeoutMs = 12000,
): Promise<ReturnType<HostRuntime["listTasks"]>["tasks"][number]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const listed = runtime.listTasks({ kind: "agent", limit: 10 });
    const task = listed.tasks.find((candidate) => candidate.kind === "agent");
    if (
      task &&
      (task.status === "completed" ||
        task.status === "failed" ||
        task.status === "cancelled")
    ) {
      return task;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for agent task terminal state`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("host protocol", () => {
  it("isolates Host IM principal identity per authenticated connection", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-im-principal-"),
    );
    const service = createHostService({
      imControl: { allowSelfBinding: true },
    });
    const owner = createConnectionPair();
    const attacker = createConnectionPair();
    const subject = {
      platform: "telegram",
      chatId: "chat_shared",
      userId: "user_shared",
    };
    try {
      for (const [index, pair] of [owner, attacker].entries()) {
        serveConnection(pair.hostSide, {
          hostService: service,
          workspaceRoot: workspace,
          imControlSelfBinding: true,
          authContext: authenticatedConnection(
            `gateway:credential:${index}`,
            "test-credential",
            "gateway",
          ),
        });
        pair.clientSend({
          envelope: "request",
          id: "handshake",
          kind: "handshake",
          timestamp: TIMESTAMP,
          payload: {
            protocolVersion: PROTOCOL_VERSION,
            client: { name: "sparkwright-im-gateway", version: "0.1.0" },
          },
        });
      }
      await Promise.all(
        [owner, attacker].map((pair) =>
          pair.waitFor(
            (message) =>
              message.envelope === "response" && message.id === "handshake",
          ),
        ),
      );

      owner.clientSend({
        envelope: "request",
        id: "bind_owner",
        kind: "im.bind",
        timestamp: TIMESTAMP,
        payload: { subject, permissions: ["message", "inspect"] },
      });
      const bound = await owner.waitFor(
        (message) =>
          message.envelope === "response" && message.id === "bind_owner",
      );
      if (bound.envelope !== "response" || !bound.ok) {
        throw new Error("owner binding was not created");
      }
      const bindingId = String(bound.result.bindingId);
      const sessionId = String(bound.result.sessionId);

      attacker.clientSend({
        envelope: "request",
        id: "bind_owner_session",
        kind: "im.bind",
        timestamp: TIMESTAMP,
        payload: {
          subject,
          permissions: ["message", "inspect", "approve"],
          sessionId,
        },
      });
      expect(
        await attacker.waitFor(
          (message) =>
            message.envelope === "response" &&
            message.id === "bind_owner_session",
        ),
      ).toMatchObject({
        envelope: "response",
        ok: false,
        error: { code: "unauthorized" },
      });

      attacker.clientSend({
        envelope: "request",
        id: "inspect_stolen_binding",
        kind: "im.inspect",
        timestamp: TIMESTAMP,
        payload: { bindingId, subject },
      });
      const inspected = await attacker.waitFor(
        (message) =>
          message.envelope === "response" &&
          message.id === "inspect_stolen_binding",
      );
      expect(inspected).toMatchObject({
        envelope: "response",
        ok: false,
        error: { code: "unauthorized" },
      });
    } finally {
      owner.close();
      attacker.close();
      await service.shutdown();
      await rmWhenReady(workspace);
    }
  });

  it("denies live approvals on timeout so execution capacity can drain", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-approval-timeout-"),
    );
    const pair = createConnectionPair();
    const previousScript = process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
    process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = JSON.stringify([
      {
        toolCalls: [
          {
            toolName: "edit",
            arguments: {
              path: "README.md",
              patch: [
                "--- a/README.md",
                "+++ b/README.md",
                "@@ -1 +1,2 @@",
                " # Demo",
                "+timed out",
                "",
              ].join("\n"),
            },
          },
        ],
      },
      { message: "done" },
    ]);
    try {
      await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "scripted",
        approvalTimeoutMs: 10,
      });
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor(
        (message) => message.envelope === "response" && message.id === "h",
      );
      pair.clientSend({
        envelope: "request",
        id: "start_timeout",
        kind: "run.start",
        timestamp: TIMESTAMP,
        payload: {
          goal: "request a write and time out",
          model: "scripted",
          accessMode: "ask",
        },
      });
      await pair.waitFor(
        (message) =>
          message.envelope === "event" && message.kind === "approval.requested",
      );
      await pair.waitFor(
        (message) =>
          message.envelope === "event" && message.kind === "run.completed",
      );
      expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
        "# Demo\n",
      );
      const resolved = pair
        .clientMessages()
        .filter(
          (message) =>
            message.envelope === "event" && message.kind === "run.event",
        )
        .map((message) => message.payload.event as SparkwrightEvent)
        .find((event) => event.type === "approval.resolved");
      expect(resolved?.payload).toMatchObject({
        decision: "denied",
        message: "Approval timed out.",
      });
    } finally {
      if (previousScript === undefined) {
        delete process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
      } else {
        process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = previousScript;
      }
      pair.close();
      await rmWhenReady(workspace);
    }
  });

  it("derives IM principals in Host and keeps self-binding opt-in", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-im-bind-"),
    );
    const handshake = (pair: ReturnType<typeof createConnectionPair>) => {
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "sparkwright-im-gateway", version: "0.1.0" },
        },
      });
      return pair.waitFor(
        (message) => message.envelope === "response" && message.id === "h",
      );
    };
    const payload = {
      subject: {
        platform: "telegram",
        chatId: "chat_1",
        userId: "user_1",
      },
      permissions: ["message", "inspect", "approve"] as const,
    };
    try {
      const deniedPair = createConnectionPair();
      serveConnection(deniedPair.hostSide, { workspaceRoot: workspace });
      await handshake(deniedPair);
      deniedPair.clientSend({
        envelope: "request",
        id: "bind_denied",
        kind: "im.bind",
        timestamp: TIMESTAMP,
        payload: { ...payload, permissions: [...payload.permissions] },
      });
      expect(
        await deniedPair.waitFor(
          (message) =>
            message.envelope === "response" && message.id === "bind_denied",
        ),
      ).toMatchObject({ ok: false, error: { code: "unauthorized" } });

      const enabledPair = createConnectionPair();
      serveConnection(enabledPair.hostSide, {
        workspaceRoot: workspace,
        imControlSelfBinding: true,
        authContext: authenticatedConnection(
          "gateway:enabled",
          "test-credential",
          "gateway",
        ),
      });
      await handshake(enabledPair);
      enabledPair.clientSend({
        envelope: "request",
        id: "bind_spoofed",
        kind: "im.bind",
        timestamp: TIMESTAMP,
        payload: {
          ...payload,
          permissions: [...payload.permissions],
          subject: { ...payload.subject, verified: true },
        },
      } as unknown as HostMessage);
      expect(
        await enabledPair.waitFor(
          (message) =>
            message.envelope === "response" && message.id === "bind_spoofed",
        ),
      ).toMatchObject({ ok: false, error: { code: "invalid_payload" } });

      enabledPair.clientSend({
        envelope: "request",
        id: "bind_ok",
        kind: "im.bind",
        timestamp: TIMESTAMP,
        payload: { ...payload, permissions: [...payload.permissions] },
      });
      expect(
        await enabledPair.waitFor(
          (message) =>
            message.envelope === "response" && message.id === "bind_ok",
        ),
      ).toMatchObject({
        ok: true,
        result: { sessionId: expect.stringMatching(/^session_/) },
      });
    } finally {
      await rmWhenReady(workspace);
    }
  });

  it("rejects requests before handshake", async () => {
    const pair = createConnectionPair();
    serveConnection(pair.hostSide, {
      workspaceRoot: process.cwd(),
      defaultModel: "deterministic",
    });
    pair.clientSend({
      envelope: "request",
      id: "req_1",
      kind: "run.start",
      timestamp: TIMESTAMP,
      payload: { goal: "early goal" },
    });
    const resp = await pair.waitFor(
      (m) => m.envelope === "response" && m.id === "req_1",
    );
    expect(resp).toMatchObject({
      envelope: "response",
      ok: false,
      error: { code: "protocol_version_mismatch" },
    });
  });

  it("rejects mismatched major version", async () => {
    const pair = createConnectionPair();
    serveConnection(pair.hostSide, {
      workspaceRoot: process.cwd(),
      defaultModel: "deterministic",
    });
    pair.clientSend({
      envelope: "request",
      id: "h",
      kind: "handshake",
      timestamp: TIMESTAMP,
      payload: {
        protocolVersion: "99.0",
        client: { name: "test", version: "0.0.0" },
      },
    });
    const resp = await pair.waitFor(
      (m) => m.envelope === "response" && m.id === "h",
    );
    expect(resp).toMatchObject({
      envelope: "response",
      ok: false,
      error: { code: "protocol_version_mismatch" },
    });
  });

  it("freezes handshake metadata and rejects a duplicate handshake", async () => {
    const pair = createConnectionPair();
    serveConnection(pair.hostSide, {
      workspaceRoot: process.cwd(),
      authContext: authenticatedConnection(
        "gateway:stable",
        "test-credential",
        "gateway",
      ),
    });
    for (const [id, name] of [
      ["first", "sparkwright-im-gateway"],
      ["duplicate", "attacker"],
    ] as const) {
      pair.clientSend({
        envelope: "request",
        id,
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name, version: "0.1.0" },
        },
      });
      await pair.waitFor(
        (message) => message.envelope === "response" && message.id === id,
      );
    }
    expect(
      pair
        .clientMessages()
        .find(
          (message) =>
            message.envelope === "response" && message.id === "duplicate",
        ),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(
      pair
        .clientMessages()
        .filter(
          (message) =>
            message.envelope === "event" && message.kind === "host.ready",
        ),
    ).toHaveLength(1);
  });

  it("rejects reserved identity fields in request metadata", async () => {
    const pair = createConnectionPair();
    serveConnection(pair.hostSide, { workspaceRoot: process.cwd() });
    pair.clientSend({
      envelope: "request",
      id: "h",
      kind: "handshake",
      timestamp: TIMESTAMP,
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        client: { name: "test", version: "0.0.0" },
      },
    });
    await pair.waitFor(
      (message) => message.envelope === "response" && message.id === "h",
    );
    for (const field of [
      "principalId",
      "authenticatedBy",
      "system",
      "verified",
      "trusted",
    ]) {
      const id = `spoof-${field}`;
      pair.clientSend({
        envelope: "request",
        id,
        kind: "run.start",
        timestamp: TIMESTAMP,
        payload: { goal: "spoof", metadata: { [field]: true } },
      } as unknown as HostMessage);
      expect(
        await pair.waitFor(
          (message) => message.envelope === "response" && message.id === id,
        ),
      ).toMatchObject({ ok: false, error: { code: "invalid_payload" } });
    }
  });

  it("rejects request payloads with unexpected fields", async () => {
    const pair = createConnectionPair();
    serveConnection(pair.hostSide, {
      workspaceRoot: process.cwd(),
      defaultModel: "deterministic",
    });
    pair.clientSend({
      envelope: "request",
      id: "h",
      kind: "handshake",
      timestamp: TIMESTAMP,
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        client: { name: "test", version: "0.0.0" },
      },
    });
    await pair.waitFor((m) => m.envelope === "response" && m.id === "h");

    pair.clientSend({
      envelope: "request",
      id: "bad",
      kind: "session.list",
      timestamp: TIMESTAMP,
      payload: { limit: 1, extra: true },
    } as unknown as HostMessage);
    const resp = await pair.waitFor(
      (m) => m.envelope === "response" && m.id === "bad",
    );
    expect(resp).toMatchObject({
      envelope: "response",
      ok: false,
      error: { code: "invalid_payload" },
    });

    pair.clientSend({
      envelope: "request",
      id: "bad-cancel",
      kind: "run.cancel",
      timestamp: TIMESTAMP,
      payload: { runId: "run_cancel_unknown", llm: true },
    } as unknown as HostMessage);
    const cancelResp = await pair.waitFor(
      (m) => m.envelope === "response" && m.id === "bad-cancel",
    );
    expect(cancelResp).toMatchObject({
      envelope: "response",
      ok: false,
      error: { code: "invalid_payload" },
    });

    pair.clientSend({
      envelope: "request",
      id: "bad-workflow-resume",
      kind: "workflow.resume",
      timestamp: TIMESTAMP,
      payload: { workflowRunId: "workflow_bad_force", force: true },
    } as unknown as HostMessage);
    const workflowResumeResp = await pair.waitFor(
      (m) => m.envelope === "response" && m.id === "bad-workflow-resume",
    );
    expect(workflowResumeResp).toMatchObject({
      envelope: "response",
      ok: false,
      error: { code: "invalid_payload" },
    });
  });

  it("rejects an invalid run.start accessMode at the wire boundary", async () => {
    const pair = createConnectionPair();
    serveConnection(pair.hostSide, {
      workspaceRoot: process.cwd(),
      defaultModel: "deterministic",
    });
    pair.clientSend({
      envelope: "request",
      id: "h",
      kind: "handshake",
      timestamp: TIMESTAMP,
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        client: { name: "test", version: "0.0.0" },
      },
    });
    await pair.waitFor((m) => m.envelope === "response" && m.id === "h");

    pair.clientSend({
      envelope: "request",
      id: "bad-access",
      kind: "run.start",
      timestamp: TIMESTAMP,
      payload: { goal: "go", accessMode: "yolo" },
    } as unknown as HostMessage);
    const resp = await pair.waitFor(
      (m) => m.envelope === "response" && m.id === "bad-access",
    );
    expect(resp).toMatchObject({
      envelope: "response",
      ok: false,
      error: { code: "invalid_payload" },
    });
  });

  it("serves durable task list/get/output requests", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-host-tasks-"));
    const pair = createConnectionPair();
    try {
      const taskStore = new FileTaskStore({
        rootDir: join(workspace, ".sparkwright", "tasks"),
      });
      const taskId = createTaskId();
      taskStore.create({
        id: taskId,
        parentRunId: "run_task_parent" as RunId,
        kind: "shell.background",
        title: "background shell",
        metadata: { command: "node bg.js" },
      });
      taskStore.update(taskId, {
        status: "running",
        startedAt: "2026-06-30T00:00:00.000Z",
      });
      taskStore.appendOutput(taskId, {
        taskId,
        timestamp: "2026-06-30T00:00:01.000Z",
        channel: "stdout",
        data: "tick 1\n",
      });

      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "deterministic",
      });
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor((m) => m.envelope === "response" && m.id === "h");
      const ready = await pair.waitFor(
        (m) => m.envelope === "event" && m.kind === "host.ready",
      );
      expect(ready).toMatchObject({
        payload: {
          capabilities: expect.arrayContaining([
            "task.list",
            "task.get",
            "task.output",
            "task.stop",
            "task.join",
            "task.promote",
            "workflow.list",
            "workflow.resume",
          ]),
        },
      });

      pair.clientSend({
        envelope: "request",
        id: "list_tasks",
        kind: "task.list",
        timestamp: TIMESTAMP,
        payload: { status: "running", limit: 10 },
      });
      const listResp = await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "list_tasks",
      );
      expect(listResp).toMatchObject({
        envelope: "response",
        ok: true,
        result: {
          tasks: [
            expect.objectContaining({
              id: taskId,
              kind: "shell.background",
              status: "running",
            }),
          ],
        },
      });

      pair.clientSend({
        envelope: "request",
        id: "get_task",
        kind: "task.get",
        timestamp: TIMESTAMP,
        payload: { taskId },
      });
      const getResp = await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "get_task",
      );
      expect(getResp).toMatchObject({
        envelope: "response",
        ok: true,
        result: {
          id: taskId,
          parentRunId: "run_task_parent",
          metadata: { command: "node bg.js" },
        },
      });

      pair.clientSend({
        envelope: "request",
        id: "output_task",
        kind: "task.output",
        timestamp: TIMESTAMP,
        payload: { taskId, fromSequence: 0, maxChunks: 1 },
      });
      const outputResp = await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "output_task",
      );
      expect(outputResp).toMatchObject({
        envelope: "response",
        ok: true,
        result: {
          taskId,
          chunks: [
            expect.objectContaining({
              sequence: 0,
              channel: "stdout",
              data: "tick 1\n",
            }),
          ],
          nextSequence: 1,
          complete: false,
          status: "running",
        },
      });

      pair.clientSend({
        envelope: "request",
        id: "task_join",
        kind: "task.join",
        timestamp: TIMESTAMP,
        payload: { taskId },
      });
      const joinResp = await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "task_join",
      );
      expect(joinResp).toMatchObject({
        envelope: "response",
        ok: true,
        result: {
          taskId,
          awaited: true,
          status: "running",
        },
      });

      pair.clientSend({
        envelope: "request",
        id: "task_promote",
        kind: "task.promote",
        timestamp: TIMESTAMP,
        payload: { taskId },
      });
      const promoteResp = await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "task_promote",
      );
      expect(promoteResp).toMatchObject({
        envelope: "response",
        ok: true,
        result: {
          taskId,
          promoted: false,
          awaited: true,
          status: "running",
        },
      });

      pair.clientSend({
        envelope: "request",
        id: "task_missing",
        kind: "task.get",
        timestamp: TIMESTAMP,
        payload: { taskId: "task_missing" },
      });
      const missingResp = await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "task_missing",
      );
      expect(missingResp).toMatchObject({
        envelope: "response",
        ok: false,
        error: { code: "task_not_found" },
      });

      pair.clientSend({
        envelope: "request",
        id: "task_bad_output",
        kind: "task.output",
        timestamp: TIMESTAMP,
        payload: { taskId, fromSequence: -1 },
      } as unknown as HostMessage);
      const badOutputResp = await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "task_bad_output",
      );
      expect(badOutputResp).toMatchObject({
        envelope: "response",
        ok: false,
        error: { code: "invalid_payload" },
      });
    } finally {
      pair.close();
      await rmWhenReady(workspace);
    }
  });

  it("serves durable workflow list requests", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-workflows-"),
    );
    const sessionId = "sess_workflow_protocol";
    const workflowRunId = "workflow_protocol_list" as WorkflowRunId;
    const pair = createConnectionPair();
    try {
      const store = new FileWorkflowStore({
        rootDir: join(workspace, ".sparkwright", "workflow-runs"),
      });
      const writer = await store.acquireWriter(workflowRunId, {
        owner: "test-fixture",
      });
      const packageSnapshotRef = `/snapshots/${workflowRunId}`;
      const packageHash = "sha256:workflow-protocol";
      const created = await writer!.create({
        id: workflowRunId,
        sessionId,
        assetName: "bugfix",
        layer: "project",
        packageHash,
        packageHashPolicyVersion: 2,
        packageSnapshotRef,
        definitionSnapshot: {
          assetName: "bugfix",
          sourceDir: packageSnapshotRef,
          layer: "project",
          packageHash,
          packageHashPolicyVersion: 2,
          packageSnapshotRef,
          nodes: [{ id: "main", body: "Protocol fixture." }],
        },
        currentNodeId: "main",
        attempts: { main: 1 },
        authorizationSnapshot: {
          targetPath: "README.md",
          confidentialPaths: [".env"],
          confidentialDefaults: false,
          accessMode: "ask",
          backgroundTasks: "enabled",
        },
      });
      await writer!.mutate({
        expectedRevision: created.recordRevision,
        patch: {
          verdictLog: [
            {
              at: "2026-07-09T00:00:00.000Z",
              nodeId: "main",
              attempt: 1,
              verdict: { status: "passed", reason: "command_passed" },
            },
          ],
        },
        event: {
          at: "2026-07-09T00:00:00.000Z",
          type: "updated",
          workflowRunId,
          status: "running",
        },
      });
      await writer!.release();
      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "deterministic",
      });
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor((m) => m.envelope === "response" && m.id === "h");

      pair.clientSend({
        envelope: "request",
        id: "workflow_list",
        kind: "workflow.list",
        timestamp: TIMESTAMP,
        payload: { sessionId, status: "running" },
      });
      const listResp = await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "workflow_list",
      );

      expect(listResp).toMatchObject({
        envelope: "response",
        ok: true,
        result: {
          workflows: [
            expect.objectContaining({
              id: workflowRunId,
              sessionId,
              assetName: "bugfix",
              status: "running",
              currentNodeId: "main",
              latestVerdict: {
                nodeId: "main",
                attempt: 1,
                verdict: { status: "passed", reason: "command_passed" },
                at: "2026-07-09T00:00:00.000Z",
              },
              authorizationSnapshot: {
                hasTargetPath: true,
                hasConfidentialPaths: true,
                confidentialDefaults: false,
                accessMode: "ask",
                backgroundTasks: "enabled",
              },
            }),
          ],
        },
      });

      pair.clientSend({
        envelope: "request",
        id: "workflow_control",
        kind: "workflow.control",
        timestamp: TIMESTAMP,
        payload: {
          workflowRunId,
          sessionId,
          idempotencyKey: "protocol-cancel-one",
          expected: { status: "running" },
          command: { kind: "cancel", reason: "protocol test" },
        },
      });
      const controlResp = await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "workflow_control",
      );
      expect(controlResp).toMatchObject({
        envelope: "response",
        ok: true,
        result: { status: "applied", code: "applied" },
      });
      expect(
        new FileWorkflowControlInbox({
          rootDir: join(workspace, ".sparkwright", "workflow-runs"),
          createRoot: false,
        }).snapshot(workflowRunId).commands[0]?.source,
      ).toEqual({
        kind: "api",
        principalId: `connection:${pair.hostSide.id}`,
        authenticatedBy: "unspecified-transport",
        connectionId: pair.hostSide.id,
      });
      expect(
        new FileWorkflowStore({
          rootDir: join(workspace, ".sparkwright", "workflow-runs"),
          createRoot: false,
        }).get(workflowRunId),
      ).toMatchObject({ status: "cancelled" });
    } finally {
      pair.close();
      await rmWhenReady(workspace);
    }
  });

  it("accepts run.start accessMode and runs to completion", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-host-access-"));
    const pair = createConnectionPair();
    try {
      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "deterministic",
      });
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor((m) => m.envelope === "response" && m.id === "h");

      pair.clientSend({
        envelope: "request",
        id: "s",
        kind: "run.start",
        timestamp: TIMESTAMP,
        payload: {
          goal: "inspect repo",
          model: "deterministic",
          accessMode: "ask",
        },
      });
      const startResp = await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "s",
      );
      expect(startResp).toMatchObject({ ok: true });

      const terminal = await pair.waitFor(
        (m) =>
          m.envelope === "event" &&
          (m.kind === "run.completed" || m.kind === "run.failed"),
      );
      if (terminal.envelope !== "event") {
        throw new Error("expected a terminal event");
      }
      expect(terminal.kind).toBe("run.completed");
    } finally {
      pair.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("applies workspace confidentialDefaults config to protocol run.start", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-confidential-defaults-"),
    );
    const pair = createConnectionPair();
    const previousScript = process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
    process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = JSON.stringify([
      {
        toolCalls: [{ toolName: "read", arguments: { path: ".env" } }],
      },
      { message: "read completed" },
    ]);

    try {
      await writeFile(join(workspace, ".env"), "TOKEN=allowed\n", "utf8");
      await mkdir(join(workspace, ".sparkwright"), { recursive: true });
      await writeFile(
        join(workspace, ".sparkwright", "config.json"),
        JSON.stringify({ policy: { confidentialDefaults: false } }),
        "utf8",
      );

      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "scripted",
      });
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "h" && m.ok,
      );
      pair.clientSend({
        envelope: "request",
        id: "start",
        kind: "run.start",
        timestamp: TIMESTAMP,
        payload: {
          goal: "read .env",
          model: "scripted",
          sessionId: "session_confidential_defaults",
        },
      });
      await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "start" && m.ok,
      );
      await pair.waitFor(
        (m) => m.envelope === "event" && m.kind === "run.completed",
      );

      const events = pair
        .clientMessages()
        .filter((m) => m.envelope === "event" && m.kind === "run.event")
        .map((m) => m.payload.event as SparkwrightEvent);
      expect(
        events.some(
          (event) =>
            event.type === "workspace.read" &&
            (event.payload as { path?: string }).path === ".env",
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "workspace.read.denied" &&
            (event.payload as { path?: string }).path === ".env",
        ),
      ).toBe(false);
    } finally {
      pair.close();
      if (previousScript === undefined) {
        delete process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
      } else {
        process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = previousScript;
      }
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps configured confidentialPaths when defaults are disabled", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-confidential-paths-"),
    );
    const pair = createConnectionPair();
    const previousScript = process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
    process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = JSON.stringify([
      {
        toolCalls: [
          { toolName: "read", arguments: { path: ".env" } },
          {
            toolName: "read",
            arguments: { path: "secrets/token.txt" },
          },
        ],
      },
      { message: "read completed with denial" },
    ]);

    try {
      await writeFile(join(workspace, ".env"), "TOKEN=allowed\n", "utf8");
      await mkdir(join(workspace, "secrets"), { recursive: true });
      await writeFile(
        join(workspace, "secrets", "token.txt"),
        "TOKEN=denied\n",
        "utf8",
      );
      await mkdir(join(workspace, ".sparkwright"), { recursive: true });
      await writeFile(
        join(workspace, ".sparkwright", "config.json"),
        JSON.stringify({
          policy: {
            confidentialDefaults: false,
            confidentialPaths: ["secrets/**"],
          },
        }),
        "utf8",
      );

      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "scripted",
      });
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "h" && m.ok,
      );
      pair.clientSend({
        envelope: "request",
        id: "start",
        kind: "run.start",
        timestamp: TIMESTAMP,
        payload: {
          goal: "read configured confidential paths",
          model: "scripted",
          sessionId: "session_confidential_paths",
        },
      });
      await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "start" && m.ok,
      );
      await pair.waitFor(
        (m) => m.envelope === "event" && m.kind === "run.completed",
      );

      const events = pair
        .clientMessages()
        .filter((m) => m.envelope === "event" && m.kind === "run.event")
        .map((m) => m.payload.event as SparkwrightEvent);
      expect(
        events.some(
          (event) =>
            event.type === "workspace.read" &&
            (event.payload as { path?: string }).path === ".env",
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "workspace.read.denied" &&
            (event.payload as { path?: string }).path === "secrets/token.txt",
        ),
      ).toBe(true);
      expect(JSON.stringify(events)).not.toContain("TOKEN=denied");
    } finally {
      pair.close();
      if (previousScript === undefined) {
        delete process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
      } else {
        process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = previousScript;
      }
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not resolve a configured delegateModel during parent run preparation", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-lazy-delegate-model-"),
    );
    const pair = createConnectionPair();
    try {
      await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
      await mkdir(join(workspace, ".sparkwright"), { recursive: true });
      await writeFile(
        join(workspace, ".sparkwright", "config.json"),
        JSON.stringify({
          capabilities: {
            agents: {
              delegateModel: "missing/delegate-model",
              profiles: [
                { id: "main", mode: "primary" },
                {
                  id: "reviewer",
                  name: "Reviewer",
                  mode: "child",
                  prompt: "Review files when explicitly delegated.",
                  allowedTools: [],
                  maxSteps: 1,
                },
              ],
              delegateTools: [
                { profileId: "reviewer", toolName: "delegate_reviewer" },
              ],
            },
          },
        }),
        "utf8",
      );

      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "deterministic",
      });
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor((m) => m.envelope === "response" && m.id === "h");

      pair.clientSend({
        envelope: "request",
        id: "s",
        kind: "run.start",
        timestamp: TIMESTAMP,
        payload: {
          goal: "inspect repo without delegating",
          model: "deterministic",
        },
      });
      const startResp = await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "s",
      );
      expect(startResp).toMatchObject({ ok: true });

      const terminal = await pair.waitFor(
        (m) =>
          m.envelope === "event" &&
          (m.kind === "run.completed" || m.kind === "run.failed"),
      );
      expect(terminal).toMatchObject({
        envelope: "event",
        kind: "run.completed",
      });
    } finally {
      pair.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("surfaces markdown agent profile id collisions as run warnings", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-agent-collision-"),
    );
    const pair = createConnectionPair();
    const sessionId = "session_agent_profile_collision";
    try {
      const keptSource = join(
        workspace,
        ".sparkwright",
        "agents",
        "alpha",
        "reviewer.md",
      );
      const droppedSource = join(
        workspace,
        ".sparkwright",
        "agents",
        "beta",
        "reviewer.md",
      );
      await mkdir(join(workspace, ".sparkwright", "agents", "alpha"), {
        recursive: true,
      });
      await mkdir(join(workspace, ".sparkwright", "agents", "beta"), {
        recursive: true,
      });
      await writeFile(
        keptSource,
        "# Reviewer\n\nUse the kept profile.\n",
        "utf8",
      );
      await writeFile(
        droppedSource,
        "# Reviewer\n\nThis duplicate must be dropped.\n",
        "utf8",
      );

      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "deterministic",
      });
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "h" && m.ok,
      );

      pair.clientSend({
        envelope: "request",
        id: "s",
        kind: "run.start",
        timestamp: TIMESTAMP,
        payload: {
          goal: "inspect repo",
          sessionId,
        },
      });
      await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "s" && m.ok,
      );
      await pair.waitFor(
        (m) => m.envelope === "event" && m.kind === "run.completed",
      );

      const streamedEvents = pair
        .clientMessages()
        .filter((m) => m.envelope === "event" && m.kind === "run.event")
        .map((m) => m.payload.event as SparkwrightEvent);
      const streamedWarning = streamedEvents.find((event) => {
        const payload = event.payload as { code?: string };
        return (
          event.type === "capability.index.failed" &&
          payload.code === "AGENT_PROFILE_ID_COLLISION"
        );
      });
      expect(streamedWarning).toMatchObject({
        type: "capability.index.failed",
        payload: {
          kind: "agent_profile",
          source: droppedSource,
          code: "AGENT_PROFILE_ID_COLLISION",
          severity: "warning",
          profileId: "reviewer",
          keptSource,
          droppedSource,
        },
        metadata: {
          source: "host",
          severity: "warning",
          failurePhase: "agent_profile_discovery",
          agentId: "main",
          profileId: "reviewer",
        },
      });
      expect((streamedWarning?.payload as { message?: string }).message).toBe(
        `Agent profile id collision for "reviewer": kept ${keptSource}, dropped ${droppedSource} (fail-closed).`,
      );

      const traceEvents = (
        await readFile(
          join(workspace, ".sparkwright", "sessions", sessionId, "trace.jsonl"),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as SparkwrightEvent);
      expect(
        traceEvents.some((event) => {
          const payload = event.payload as { code?: string };
          return (
            event.type === "capability.index.failed" &&
            payload.code === "AGENT_PROFILE_ID_COLLISION"
          );
        }),
      ).toBe(true);
    } finally {
      pair.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("surfaces delegate tool-name collisions as run warnings", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-delegate-tool-collision-"),
    );
    const pair = createConnectionPair();
    const sessionId = "session_delegate_tool_collision";
    try {
      await mkdir(join(workspace, ".sparkwright"), { recursive: true });
      await writeFile(
        join(workspace, ".sparkwright", "config.json"),
        JSON.stringify({
          capabilities: {
            agents: {
              profiles: [
                { id: "main", mode: "primary" },
                { id: "kept", mode: "child", allowedTools: [] },
                { id: "dropped", mode: "child", allowedTools: [] },
              ],
              delegateTools: [
                { profileId: "kept", toolName: "delegate_same" },
                { profileId: "dropped", toolName: "delegate_same" },
              ],
            },
          },
        }),
        "utf8",
      );

      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "deterministic",
      });
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "h" && m.ok,
      );

      pair.clientSend({
        envelope: "request",
        id: "s",
        kind: "run.start",
        timestamp: TIMESTAMP,
        payload: {
          goal: "inspect repo",
          sessionId,
        },
      });
      await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "s" && m.ok,
      );
      await pair.waitFor(
        (m) => m.envelope === "event" && m.kind === "run.completed",
      );

      const warning = pair
        .clientMessages()
        .filter((m) => m.envelope === "event" && m.kind === "run.event")
        .map((m) => m.payload.event as SparkwrightEvent)
        .find((event) => {
          const payload = event.payload as { code?: string };
          return (
            event.type === "capability.index.failed" &&
            payload.code === "DELEGATE_TOOL_NAME_COLLISION"
          );
        });
      expect(warning).toMatchObject({
        type: "capability.index.failed",
        payload: {
          kind: "delegate_tool",
          source: "config",
          code: "DELEGATE_TOOL_NAME_COLLISION",
          severity: "warning",
          toolName: "delegate_same",
          profileId: "dropped",
          conflictsWith: "kept",
          droppedSource: "config",
          keptSource: "kept",
        },
        metadata: {
          source: "host",
          severity: "warning",
          failurePhase: "delegate_tool_resolution",
          agentId: "main",
          profileId: "dropped",
          toolName: "delegate_same",
        },
      });
      expect((warning?.payload as { message?: string }).message).toBe(
        'Delegate tool name collision for "delegate_same": kept profile kept, dropped profile dropped (config) (fail-closed).',
      );
    } finally {
      pair.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("surfaces delegate routing sort decisions as run events", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-agent-routing-"),
    );
    const pair = createConnectionPair();
    const sessionId = "session_agent_routing";
    try {
      await mkdir(join(workspace, ".sparkwright"), { recursive: true });
      await writeFile(
        join(workspace, ".sparkwright", "config.json"),
        JSON.stringify({
          capabilities: {
            agents: {
              profiles: [
                { id: "main", mode: "primary" },
                {
                  id: "writer",
                  name: "Writer",
                  mode: "child",
                  triggers: ["patch", "write"],
                },
                {
                  id: "reviewer",
                  name: "Reviewer",
                  mode: "child",
                  triggers: ["review", "diff", "risk"],
                },
              ],
              delegateTools: [
                { profileId: "writer", toolName: "delegate_writer" },
                { profileId: "reviewer", toolName: "delegate_reviewer" },
              ],
            },
          },
        }),
        "utf8",
      );

      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "deterministic",
      });
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "h" && m.ok,
      );

      pair.clientSend({
        envelope: "request",
        id: "s",
        kind: "run.start",
        timestamp: TIMESTAMP,
        payload: {
          goal: "review the login diff for auth risks",
          sessionId,
        },
      });
      await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "s" && m.ok,
      );
      await pair.waitFor(
        (m) => m.envelope === "event" && m.kind === "run.completed",
      );

      const streamedEvents = pair
        .clientMessages()
        .filter((m) => m.envelope === "event" && m.kind === "run.event")
        .map((m) => m.payload.event as SparkwrightEvent);
      const routingEvent = streamedEvents.find(
        (event) => event.type === "agent.routing.evaluated",
      );
      expect(routingEvent).toMatchObject({
        type: "agent.routing.evaluated",
        payload: {
          mode: "sort",
          delegateCount: 2,
          relevantCount: 1,
          lowCount: 1,
          delegates: [
            expect.objectContaining({
              toolName: "delegate_reviewer",
              profileId: "reviewer",
              relevance: "relevant",
            }),
            expect.objectContaining({
              toolName: "delegate_writer",
              profileId: "writer",
              relevance: "low",
            }),
          ],
        },
        metadata: {
          source: "host",
          agentId: "main",
          mode: "sort",
        },
      });

      const traceEvents = (
        await readFile(
          join(workspace, ".sparkwright", "sessions", sessionId, "trace.jsonl"),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as SparkwrightEvent);
      expect(
        traceEvents.some((event) => event.type === "agent.routing.evaluated"),
      ).toBe(true);
    } finally {
      pair.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("exposes delegate_parallel only when explicitly enabled", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-delegate-parallel-inspect-"),
    );
    const configPath = join(workspace, ".sparkwright", "config.json");
    try {
      await mkdir(join(workspace, ".sparkwright"), { recursive: true });
      const baseConfig = {
        capabilities: {
          agents: {
            profiles: [
              { id: "main", mode: "primary" },
              {
                id: "reviewer",
                name: "Reviewer",
                mode: "child",
                allowedTools: [],
              },
            ],
            delegateTools: [
              { profileId: "reviewer", toolName: "delegate_reviewer" },
            ],
          },
        },
      };
      await writeFile(configPath, JSON.stringify(baseConfig), "utf8");

      const defaultRuntime = new HostRuntime({
        workspaceRoot: workspace,
        defaultModel: "deterministic",
        emit: () => {},
      });
      const defaultInspect = await defaultRuntime.inspectCapabilities();
      expect(defaultInspect).toMatchObject({ ok: true });
      if (!defaultInspect.ok) throw new Error(defaultInspect.error.message);
      expect(
        defaultInspect.snapshot.tools.some(
          (tool) => tool.name === "delegate_parallel",
        ),
      ).toBe(false);

      await writeFile(
        configPath,
        JSON.stringify({
          capabilities: {
            agents: {
              ...baseConfig.capabilities.agents,
              enableParallelDelegates: true,
            },
          },
        }),
        "utf8",
      );
      const enabledRuntime = new HostRuntime({
        workspaceRoot: workspace,
        defaultModel: "deterministic",
        emit: () => {},
      });
      const enabledInspect = await enabledRuntime.inspectCapabilities();
      expect(enabledInspect).toMatchObject({ ok: true });
      if (!enabledInspect.ok) throw new Error(enabledInspect.error.message);
      expect(
        enabledInspect.snapshot.tools.find(
          (tool) => tool.name === "delegate_parallel",
        ),
      ).toMatchObject({
        name: "delegate_parallel",
        origin: "local:sparkwright",
        risk: "safe",
      });
    } finally {
      await rmWhenReady(workspace);
    }
  });

  it("does not duplicate delegate_parallel when a delegate uses the reserved name", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-delegate-parallel-collision-"),
    );
    const configPath = join(workspace, ".sparkwright", "config.json");
    try {
      await mkdir(join(workspace, ".sparkwright"), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({
          capabilities: {
            agents: {
              exposure: "all",
              enableParallelDelegates: true,
              profiles: [
                { id: "main", mode: "primary" },
                {
                  id: "parallel",
                  name: "Parallel",
                  mode: "child",
                  allowedTools: [],
                },
              ],
              delegateTools: [
                { profileId: "parallel", toolName: "delegate_parallel" },
              ],
            },
          },
        }),
        "utf8",
      );

      const runtime = new HostRuntime({
        workspaceRoot: workspace,
        defaultModel: "deterministic",
        emit: () => {},
      });
      const inspect = await runtime.inspectCapabilities();
      expect(inspect).toMatchObject({ ok: true });
      if (!inspect.ok) throw new Error(inspect.error.message);
      expect(
        inspect.snapshot.tools.filter(
          (tool) => tool.name === "delegate_parallel",
        ),
      ).toHaveLength(1);
      expect(inspect.snapshot.agents.delegateTools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            toolName: "delegate_parallel",
            profileId: "parallel",
          }),
        ]),
      );
    } finally {
      await rmWhenReady(workspace);
    }
  });

  it("includes active workflow rule descriptors in capability inspection", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-active-rules-"),
    );
    try {
      await mkdir(join(workspace, ".sparkwright"), { recursive: true });
      await writeFile(
        join(workspace, ".sparkwright", "config.json"),
        JSON.stringify({
          capabilities: {
            hooks: {
              workflow: [
                {
                  name: "guard-shell",
                  description: "Project shell guard.",
                  hook: "PreToolUse",
                  matcher: { toolName: "bash" },
                  action: { type: "block", reason: "No shell." },
                },
                {
                  name: "disabled-note",
                  hook: "RunStart",
                  enabled: false,
                  action: { type: "context", content: "Disabled note." },
                },
              ],
              events: [
                {
                  name: "event-run-end",
                  trigger: "run.completed",
                  matcher: { eventType: "run.completed" },
                  action: { type: "command", command: "node" },
                },
              ],
            },
            verification: {
              mode: "require",
              profiles: {
                fast: [
                  {
                    id: "test",
                    command: "npm",
                    args: ["test"],
                  },
                ],
              },
            },
          },
        }),
        "utf8",
      );
      const runtime = new HostRuntime({
        workspaceRoot: workspace,
        defaultModel: "deterministic",
        emit: () => {},
      });

      const inspect = await runtime.inspectCapabilities();

      expect(inspect).toMatchObject({ ok: true });
      if (!inspect.ok) throw new Error(inspect.error.message);
      expect(inspect.snapshot.rules?.workflow).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "guard-shell",
            source: "config",
            lifecycle: "PreToolUse",
            matcher: "toolName=bash",
            action: "block: No shell.",
            blockingPotential: true,
            enabled: true,
            active: true,
            status: "active",
          }),
          expect.objectContaining({
            name: "disabled-note",
            source: "config",
            lifecycle: "RunStart",
            enabled: false,
            active: false,
            status: "disabled",
          }),
          expect.objectContaining({
            name: "verification:fast:test",
            source: "verification",
            lifecycle: "Stop",
            matcher: "run-level invariant after workspace writes",
            action: "invariant verifier command: npm test",
            blockingPotential: false,
            enabled: true,
            active: true,
          }),
          expect.objectContaining({
            name: "documented-command-check",
            source: "builtin",
            lifecycle: "Stop",
            blockingPotential: false,
            enabled: true,
            active: false,
            status: "available",
          }),
        ]),
      );
      expect(inspect.snapshot.rules?.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "event-run-end",
            source: "config",
            trigger: "run.completed",
            matcher: "eventType=run.completed",
            action: "command: node; injectOutput=always",
            blockingPotential: false,
            enabled: true,
            active: true,
            status: "active",
          }),
        ]),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("marks the documented-command built-in active for matching write runs", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-documented-command-rule-"),
    );
    let resolveTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    try {
      const runtime = new HostRuntime({
        workspaceRoot: workspace,
        defaultModel: "deterministic",
        emit: (event) => {
          if (event.kind === "run.completed" || event.kind === "run.failed") {
            resolveTerminal();
          }
        },
      });

      const started = await runtime.startRun({
        goal: "prepare handoff and verify documented commands",
        accessMode: "ask",
      });
      expect(started).toMatchObject({ ok: true });
      if (!started.ok) throw new Error(started.error.message);

      const inspect = await runtime.inspectCapabilities();

      expect(inspect).toMatchObject({ ok: true });
      if (!inspect.ok) throw new Error(inspect.error.message);
      expect(inspect.snapshot.rules?.workflow).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "documented-command-check",
            source: "builtin",
            lifecycle: "Stop",
            active: true,
            status: "active",
          }),
        ]),
      );
      await Promise.race([
        terminal,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("run did not finish")), 3000),
        ),
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("warns when delegate_parallel is reserved by an existing delegate", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-delegate-parallel-warning-"),
    );
    const configPath = join(workspace, ".sparkwright", "config.json");
    const pair = createConnectionPair();
    try {
      await mkdir(join(workspace, ".sparkwright"), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({
          capabilities: {
            agents: {
              exposure: "all",
              enableParallelDelegates: true,
              profiles: [
                { id: "main", mode: "primary" },
                {
                  id: "parallel",
                  name: "Parallel",
                  mode: "child",
                  allowedTools: [],
                },
              ],
              delegateTools: [
                { profileId: "parallel", toolName: "delegate_parallel" },
              ],
            },
          },
        }),
        "utf8",
      );
      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "deterministic",
      });
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "h" && m.ok,
      );
      pair.clientSend({
        envelope: "request",
        id: "r",
        kind: "run.start",
        timestamp: TIMESTAMP,
        payload: { goal: "hello", sessionId: "session_delegate_parallel" },
      });
      await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "r" && m.ok,
      );
      await pair.waitFor(
        (m) => m.envelope === "event" && m.kind === "run.completed",
      );

      const warning = pair
        .clientMessages()
        .filter((m) => m.envelope === "event" && m.kind === "run.event")
        .map((m) => m.payload.event as SparkwrightEvent)
        .find((event) => {
          const payload = event.payload as { code?: string };
          return (
            event.type === "capability.index.failed" &&
            payload.code === "DELEGATE_TOOL_NAME_COLLISION"
          );
        });
      expect(warning).toMatchObject({
        type: "capability.index.failed",
        payload: {
          kind: "delegate_tool",
          source: "builtin",
          code: "DELEGATE_TOOL_NAME_COLLISION",
          severity: "warning",
          toolName: "delegate_parallel",
          profileId: "parallel",
          droppedSource: "builtin",
          keptSource: "profile",
        },
        metadata: {
          source: "host",
          severity: "warning",
          failurePhase: "delegate_tool_resolution",
          agentId: "main",
          profileId: "parallel",
          toolName: "delegate_parallel",
        },
      });
    } finally {
      pair.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("forwards completed-with-tool-failures outcome on run.completed", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-outcome-"),
    );
    const pair = createConnectionPair();
    try {
      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "deterministic",
      });
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor((m) => m.envelope === "response" && m.id === "h");

      pair.clientSend({
        envelope: "request",
        id: "run_missing_read",
        kind: "run.start",
        timestamp: TIMESTAMP,
        payload: {
          goal: "inspect missing default target",
          model: "deterministic",
          accessMode: "ask",
        },
      });

      const started = await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "run_missing_read",
      );
      expect(started).toMatchObject({
        envelope: "response",
        ok: true,
      });
      const completed = await pair.waitFor(
        (m) => m.envelope === "event" && m.kind === "run.completed",
      );
      expect(completed).toMatchObject({
        envelope: "event",
        kind: "run.completed",
        payload: {
          state: "completed",
          stopReason: "final_answer",
          outcome: {
            kind: "completed_with_tool_failures",
            toolFailures: { count: 1 },
          },
        },
      });
      const codes = (
        completed as {
          payload?: { outcome?: { toolFailures?: { codes?: unknown[] } } };
        }
      ).payload?.outcome?.toolFailures?.codes;
      expect(codes).toHaveLength(1);
      expect(["TOOL_NOT_FOUND", "ENOENT"]).toContain(codes?.[0]);
    } finally {
      pair.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("forwards structured run failure on failed run.completed", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-terminal-failure-"),
    );
    const pair = createConnectionPair();
    const previousScript = process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
    process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = JSON.stringify([
      {
        error: {
          message: "scripted provider rejected request",
          code: "invalid_api_key",
          status: 401,
        },
      },
    ]);
    try {
      await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "scripted",
      });
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor((m) => m.envelope === "response" && m.id === "h");

      pair.clientSend({
        envelope: "request",
        id: "run_invalid_args",
        kind: "run.start",
        timestamp: TIMESTAMP,
        payload: {
          goal: "exercise invalid tool args",
          model: "scripted",
          accessMode: "ask",
        },
      });
      await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "run_invalid_args",
      );
      const completed = await pair.waitFor(
        (m) => m.envelope === "event" && m.kind === "run.completed",
      );

      expect(completed).toMatchObject({
        envelope: "event",
        kind: "run.completed",
        payload: {
          state: "failed",
          stopReason: "model_auth_failed",
          failure: {
            category: "model",
            code: "MODEL_COMPLETION_FAILED",
            message: "scripted provider rejected request",
            retryable: false,
          },
        },
      });
      expect(JSON.stringify(completed)).toContain('"status":401');
      expect(JSON.stringify(completed)).not.toContain(
        "SPARKWRIGHT_SCRIPTED_MODEL_JSON",
      );
    } finally {
      if (previousScript === undefined)
        delete process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
      else process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = previousScript;
      pair.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("emits canonical failure on host runtime run.failed", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-runtime-failure-"),
    );
    try {
      let resolveFailed!: (message: HostMessage) => void;
      const failed = new Promise<HostMessage>((resolve) => {
        resolveFailed = resolve;
      });
      const runtime = new HostRuntime({
        workspaceRoot: workspace,
        defaultModel: "deterministic",
        emit: (message) => {
          if (message.envelope !== "event") return;
          if (message.kind === "run.failed") {
            resolveFailed(message);
            return;
          }
          if (message.kind === "run.event") {
            throw new Error("event sink failed");
          }
        },
      });

      const started = await runtime.startRun({ goal: "exercise sink failure" });
      expect(started).toMatchObject({
        ok: false,
        error: {
          code: "internal_error",
          message: "event sink failed",
        },
      });
      await expect(failed).resolves.toMatchObject({
        envelope: "event",
        kind: "run.failed",
        payload: {
          failure: {
            category: "runtime",
            code: "internal_error",
            message: "event sink failed",
          },
        },
      });
    } finally {
      await rm(workspace, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  it("accepts the run.resume payload shape and reports missing runs from runtime lookup", async () => {
    const pair = createConnectionPair();
    serveConnection(pair.hostSide, {
      workspaceRoot: process.cwd(),
      defaultModel: "deterministic",
    });
    pair.clientSend({
      envelope: "request",
      id: "h",
      kind: "handshake",
      timestamp: TIMESTAMP,
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        client: { name: "test", version: "0.0.0" },
      },
    });
    await pair.waitFor((m) => m.envelope === "response" && m.id === "h");

    pair.clientSend({
      envelope: "request",
      id: "resume",
      kind: "run.resume",
      timestamp: TIMESTAMP,
      payload: {
        runId: "run_123",
        sessionId: "sess_123",
        fromTrace: true,
        force: false,
        model: "deterministic",
        accessMode: "ask",
        metadata: { source: "test" },
      },
    });
    const resp = await pair.waitFor(
      (m) => m.envelope === "response" && m.id === "resume",
    );
    expect(resp).toMatchObject({
      envelope: "response",
      ok: false,
      error: {
        code: "run_not_found",
        message: expect.stringContaining("run_123"),
      },
    });
  });

  it("resumes a session-scoped checkpoint through the host runtime", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-host-resume-"));
    const sessionId = "sess_resume_test";
    const runId = "run_resume_test";
    const runDir = join(
      workspace,
      ".sparkwright",
      "sessions",
      sessionId,
      "agents",
      "main",
      "runs",
      runId,
    );
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "checkpoint.json"),
      JSON.stringify(
        {
          schemaVersion: "run-checkpoint.v1",
          run: {
            id: runId,
            goal: "resume checkpoint",
            state: "running",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:30.000Z",
            metadata: { tag: "host-resume-test" },
          },
          loop: {
            step: 1,
            turnCount: 0,
            context: [],
            repeatedToolCallCount: 0,
            transition: { reason: "next_turn" },
          },
          model: { activeIndex: 0, fallbackCount: 0 },
          recovery: { outputRecoveriesUsed: 0, maxOutputRecoveries: 3 },
          budget: {
            usage: {
              elapsedMs: 0,
              modelCalls: 0,
              toolCalls: 0,
              tokens: 0,
              costUsd: 0,
            },
          },
          queues: {
            commandCount: 0,
            pendingPrefetch: false,
            pendingSummary: false,
          },
          resumability: { complete: true, reasons: [] },
          createdAt: "2026-01-01T00:00:30.500Z",
          metadata: { snapshotReason: "test" },
        },
        null,
        2,
      ),
      "utf8",
    );

    const pair = createConnectionPair();
    try {
      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "deterministic",
      });
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor((m) => m.envelope === "response" && m.id === "h");

      pair.clientSend({
        envelope: "request",
        id: "resume_ok",
        kind: "run.resume",
        timestamp: TIMESTAMP,
        payload: {
          runId,
          sessionId,
          model: "deterministic",
          accessMode: "ask",
          traceLevel: "standard",
          metadata: { source: "test", traceLevel: "standard", ticket: "T-1" },
        },
      });

      const resp = await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "resume_ok",
      );
      expect(resp).toMatchObject({
        envelope: "response",
        ok: true,
        result: { runId, resumedFromRunId: runId, sessionId },
      });
      await pair.waitFor(
        (m) => m.envelope === "event" && m.kind === "run.completed",
      );
      const runJson = JSON.parse(
        await readFile(join(runDir, "run.json"), "utf8"),
      ) as { metadata?: Record<string, unknown> };
      expect(runJson.metadata).toMatchObject({
        source: "test",
        traceLevel: "standard",
        ticket: "T-1",
        resumedFromRunId: runId,
      });
      const traceEvents = (
        await readFile(
          join(workspace, ".sparkwright", "sessions", sessionId, "trace.jsonl"),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as SparkwrightEvent);
      const modelCompleted = traceEvents.find(
        (event) => event.runId === runId && event.type === "model.completed",
      );
      expect(modelCompleted?.payload).toMatchObject({
        message: expect.any(String),
        toolCalls: expect.any(Array),
        trace: expect.objectContaining({
          toolCallCount: expect.any(Number),
        }),
      });
      expect(
        pair
          .clientMessages()
          .some(
            (m) =>
              m.envelope === "event" &&
              m.kind === "run.event" &&
              (m.payload as { event?: { type?: string } }).event?.type ===
                "run.resumed",
          ),
      ).toBe(true);
    } finally {
      pair.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails orphaned in-process awaited tasks before resuming a run", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-resume-orphan-"),
    );
    const sessionId = "sess_resume_orphan_test";
    const runId = "run_resume_orphan_test";
    const runDir = join(
      workspace,
      ".sparkwright",
      "sessions",
      sessionId,
      "agents",
      "main",
      "runs",
      runId,
    );
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "checkpoint.json"),
      checkpointJson({ runId, goal: "resume with orphaned task" }),
      "utf8",
    );
    const taskRoot = join(workspace, ".sparkwright", "tasks");
    const taskStore = new FileTaskStore({ rootDir: taskRoot });
    const taskId = createTaskId();
    taskStore.create({
      id: taskId,
      parentRunId: runId as RunId,
      kind: "agent",
      title: "orphaned awaited agent",
      awaited: true,
      metadata: { source: "previous-host-process" },
    });
    taskStore.update(taskId, {
      status: "running",
      startedAt: "2026-06-30T00:00:00.000Z",
    });

    const runtime = new HostRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      emit: () => {},
    });
    try {
      const resumed = await runtime.resumeRun({ runId, sessionId });
      expect(resumed).toMatchObject({
        ok: true,
        runId,
        resumedFromRunId: runId,
        sessionId,
      });

      const reopened = new FileTaskStore({ rootDir: taskRoot });
      expect(reopened.get(taskId)).toMatchObject({
        status: "failed",
        error: {
          code: "TASK_ORPHANED_IN_PROCESS",
          message: expect.stringContaining("cannot survive host exit"),
        },
      });
      const traceText = await readFileWhenReady(
        join(workspace, ".sparkwright", "sessions", sessionId, "trace.jsonl"),
        "run.notification.injected",
      );
      const traceEvents = traceText
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as SparkwrightEvent);
      expect(
        traceEvents.some(
          (event) =>
            event.runId === runId && event.type === "run.notification.injected",
        ),
      ).toBe(true);
    } finally {
      runtime.cleanup();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("hands off unfinished todos after a final resumed answer", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-resume-todo-"),
    );
    const sessionId = "sess_resume_todo_test";
    const runId = "run_resume_todo_test";
    const sessionDir = join(workspace, ".sparkwright", "sessions", sessionId);
    const runDir = join(sessionDir, "agents", "main", "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
    await writeFile(
      join(sessionDir, "todo.md"),
      "- [ ] finish resume\n",
      "utf8",
    );
    await writeFile(
      join(runDir, "checkpoint.json"),
      JSON.stringify(
        {
          schemaVersion: "run-checkpoint.v1",
          run: {
            id: runId,
            goal: "resume unfinished todo",
            state: "running",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:30.000Z",
            metadata: { tag: "host-resume-todo-test" },
          },
          loop: {
            step: 1,
            turnCount: 0,
            context: [],
            repeatedToolCallCount: 0,
            transition: { reason: "next_turn" },
          },
          model: { activeIndex: 0, fallbackCount: 0 },
          recovery: { outputRecoveriesUsed: 0, maxOutputRecoveries: 3 },
          budget: {
            usage: {
              elapsedMs: 0,
              modelCalls: 0,
              toolCalls: 0,
              tokens: 0,
              costUsd: 0,
            },
          },
          queues: {
            commandCount: 0,
            pendingPrefetch: false,
            pendingSummary: false,
          },
          resumability: { complete: true, reasons: [] },
          createdAt: "2026-01-01T00:00:30.500Z",
          metadata: { snapshotReason: "test" },
        },
        null,
        2,
      ),
      "utf8",
    );

    const pair = createConnectionPair();
    try {
      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "deterministic",
      });
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor((m) => m.envelope === "response" && m.id === "h");

      pair.clientSend({
        envelope: "request",
        id: "resume_todo",
        kind: "run.resume",
        timestamp: TIMESTAMP,
        payload: {
          runId,
          sessionId,
          model: "deterministic",
          accessMode: "ask",
        },
      });

      await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "resume_todo",
      );
      const completed = await pair.waitFor(
        (m) => m.envelope === "event" && m.kind === "run.completed",
      );
      expect(completed).toMatchObject({
        envelope: "event",
        kind: "run.completed",
        payload: {
          state: "completed",
          todoHandoff: { reason: "non_resumable_stop_reason" },
        },
      });
      expect(
        pair
          .clientMessages()
          .some((m) => m.envelope === "event" && m.kind === "run.continuation"),
      ).toBe(false);
    } finally {
      pair.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("validates run.resume payloads before dispatch", async () => {
    const pair = createConnectionPair();
    serveConnection(pair.hostSide, {
      workspaceRoot: process.cwd(),
      defaultModel: "deterministic",
    });
    pair.clientSend({
      envelope: "request",
      id: "h",
      kind: "handshake",
      timestamp: TIMESTAMP,
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        client: { name: "test", version: "0.0.0" },
      },
    });
    await pair.waitFor((m) => m.envelope === "response" && m.id === "h");

    pair.clientSend({
      envelope: "request",
      id: "bad_resume",
      kind: "run.resume",
      timestamp: TIMESTAMP,
      payload: {
        runId: "run_123",
        fromTrace: "yes",
      },
    } as unknown as HostMessage);
    const resp = await pair.waitFor(
      (m) => m.envelope === "response" && m.id === "bad_resume",
    );
    expect(resp).toMatchObject({
      envelope: "response",
      ok: false,
      error: {
        code: "invalid_payload",
        message: "fromTrace must be a boolean",
      },
    });
  });

  it("prepares configured skills for TUI/host runs", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-host-skill-"));
    const pair = createConnectionPair();
    try {
      await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
      await mkdir(join(workspace, ".sparkwright"), { recursive: true });
      await mkdir(join(workspace, "skills", "reviewer"), {
        recursive: true,
      });
      await writeFile(
        join(workspace, ".sparkwright", "config.json"),
        JSON.stringify({
          capabilities: {
            skills: {
              roots: ["../skills"],
              // This test exercises the auto-resident path (skill.loaded fires
              // for matcher-selected skills). The host now defaults to on-demand
              // loading, so opt back in explicitly.
              loadSelectedSkills: true,
              maxSelectedSkills: 1,
            },
            mcp: {
              startup: "prepare",
              servers: [
                {
                  type: "stdio",
                  name: "disabled",
                  command: "ignored",
                  enabled: false,
                },
                {
                  type: "stdio",
                  name: "missing",
                  command: join(workspace, "missing-mcp-command"),
                  enabled: true,
                  timeoutMs: 100,
                },
              ],
            },
            agents: {
              profiles: [
                {
                  id: "main",
                  mode: "primary",
                  allowedTools: ["read"],
                },
                {
                  id: "reviewer",
                  name: "Reviewer",
                  mode: "child",
                  allowedTools: ["read"],
                },
              ],
              delegateTools: [
                {
                  profileId: "reviewer",
                  toolName: "delegate_reviewer",
                },
              ],
            },
          },
        }),
        "utf8",
      );
      await writeFile(
        join(workspace, "skills", "reviewer", "SKILL.md"),
        [
          "---",
          "name: reviewer",
          "description: Review code and explain risks.",
          "---",
          "# Reviewer",
          "",
          "Always call out concrete risks.",
          "",
        ].join("\n"),
        "utf8",
      );

      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "deterministic",
      });
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "h" && m.ok,
      );
      pair.clientSend({
        envelope: "request",
        id: "r",
        kind: "run.start",
        timestamp: TIMESTAMP,
        payload: { goal: "review code" },
      });
      await pair.waitFor(
        (m) => m.envelope === "event" && m.kind === "run.completed",
      );

      const events = pair
        .clientMessages()
        .filter((m) => m.envelope === "event" && m.kind === "run.event")
        .map((m) => m.payload.event as SparkwrightEvent);
      expect(events.some((event) => event.type === "skill.indexed")).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "skill.loaded" &&
            (event.payload as { name?: string }).name === "reviewer",
        ),
      ).toBe(true);
      expect(events.some((event) => event.type === "mcp.server.prepared")).toBe(
        true,
      );
      expect(
        new FileSkillUsageRecorder({ path: skillUsagePath(workspace) }).get(
          "reviewer",
        ),
      ).toMatchObject({
        useCount: 1,
        residentLoadCount: 1,
      });
      expect(
        events.some(
          (event) =>
            event.type === "agent.profile.derived" &&
            (event.payload as { childAgentId?: string }).childAgentId ===
              "reviewer",
        ),
      ).toBe(true);
    } finally {
      pair.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("records skill load failures for protocol clients", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-bad-skill-"),
    );
    const sessionId = "session_bad_skill";
    const pair = createConnectionPair();
    try {
      await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
      await mkdir(join(workspace, ".sparkwright", "skills", "bad"), {
        recursive: true,
      });
      await writeFile(
        join(workspace, ".sparkwright", "skills", "bad", "SKILL.md"),
        ["---", "name: bad", "---", "Missing description.", ""].join("\n"),
        "utf8",
      );

      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "deterministic",
      });
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "h" && m.ok,
      );
      pair.clientSend({
        envelope: "request",
        id: "r",
        kind: "run.start",
        timestamp: TIMESTAMP,
        payload: { goal: "hello", sessionId },
      });

      const response = await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "r",
      );
      expect(response).toMatchObject({ envelope: "response", ok: true });
      await pair.waitFor(
        (m) => m.envelope === "event" && m.kind === "run.completed",
      );
      const streamedEvents = pair
        .clientMessages()
        .filter((m) => m.envelope === "event" && m.kind === "run.event")
        .map((m) => m.payload.event as SparkwrightEvent);
      expect(streamedEvents.map((event) => event.type)).toContain(
        "skill.failed",
      );
      expect(streamedEvents.map((event) => event.type)).toContain(
        "run.completed",
      );
      expect(streamedEvents.map((event) => event.type)).not.toContain(
        "capability.index.failed",
      );
      expect(
        streamedEvents.find((event) => event.type === "skill.failed")?.payload,
      ).toMatchObject({
        source: join(workspace, ".sparkwright", "skills", "bad", "SKILL.md"),
      });

      const traceEvents = (
        await readFile(
          join(workspace, ".sparkwright", "sessions", sessionId, "trace.jsonl"),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as SparkwrightEvent);
      expect(traceEvents.map((event) => event.type)).toContain("skill.failed");
      expect(traceEvents.map((event) => event.type)).toContain("run.completed");
    } finally {
      pair.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("returns a host-authored capability snapshot", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-capability-"),
    );
    const pair = createConnectionPair();
    try {
      await mkdir(join(workspace, ".sparkwright"), { recursive: true });
      await mkdir(join(workspace, "skills", "reviewer"), {
        recursive: true,
      });
      await writeFile(
        join(workspace, ".sparkwright", "config.json"),
        JSON.stringify({
          tools: {
            disabled: ["bash"],
            defer: ["delegate_reviewer"],
          },
          capabilities: {
            skills: {
              roots: ["../skills"],
            },
            mcp: {
              servers: [
                {
                  type: "stdio",
                  name: "disabled",
                  command: "ignored",
                  enabled: false,
                },
                {
                  type: "stdio",
                  name: "missing",
                  command: join(workspace, "missing-mcp-command"),
                  enabled: true,
                  timeoutMs: 100,
                },
              ],
            },
            agents: {
              profiles: [
                { id: "main", mode: "primary" },
                { id: "reviewer", name: "Reviewer", mode: "child" },
                { id: "auditor", name: "Auditor", mode: "primary" },
              ],
              delegateTools: [
                {
                  profileId: "reviewer",
                  toolName: "delegate_reviewer",
                },
              ],
            },
          },
        }),
        "utf8",
      );
      await writeFile(
        join(workspace, "skills", "reviewer", "SKILL.md"),
        [
          "---",
          "name: reviewer",
          "description: Review code and explain risks.",
          "---",
          "# Reviewer",
          "",
          "Always call out concrete risks.",
          "",
        ].join("\n"),
        "utf8",
      );

      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "deterministic",
      });
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "h" && m.ok,
      );
      pair.clientSend({
        envelope: "request",
        id: "cap",
        kind: "capability.inspect",
        timestamp: TIMESTAMP,
        payload: {},
      });

      const resp = await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "cap",
      );
      expect(resp).toMatchObject({
        envelope: "response",
        ok: true,
        result: {
          shell: {
            sandbox: {
              mode: "warn",
              runtimeId: expect.any(String),
              available: expect.any(Boolean),
              networkMode: "deny",
              filesystemIsolation: expect.stringMatching(
                /^(bind-allowlist|deny-list-guard|unsupported)$/,
              ),
            },
          },
          skills: {
            loaded: [],
          },
          mcp: {
            statuses: [
              { serverName: "disabled", status: "disabled", toolNames: [] },
              {
                serverName: "missing",
                status: "configured",
                toolNames: [],
              },
            ],
          },
          agents: {
            profiles: [
              { id: "main", mode: "primary" },
              { id: "reviewer", name: "Reviewer", mode: "child" },
              { id: "auditor", name: "Auditor", mode: "primary" },
            ],
            delegateTools: [
              {
                toolName: "delegate_reviewer",
                profileId: "reviewer",
                profileName: "Reviewer",
                protocol: "in_process",
                risk: "safe",
                approvalRequiredUnderCurrentRun: false,
                forbidNesting: true,
                sideEffects: ["model", "workspace"],
                workspaceAccess: "read_write",
                shellAccess: false,
                processSpawn: false,
                gatedByRunWrite: true,
              },
            ],
          },
        },
      });
      if (resp.envelope === "response" && resp.ok) {
        const tools = resp.result.tools as Array<{
          name: string;
          origin?: string;
        }>;
        const reviewer = (
          resp.result as {
            skills: {
              indexed: Array<{
                name: string;
                packageHash: string;
                packageHashPolicyVersion: number;
              }>;
            };
          }
        ).skills.indexed.find((skill) => skill.name === "reviewer");
        expect(reviewer).toMatchObject({
          packageHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          packageHashPolicyVersion: 2,
        });
        expect(reviewer).not.toHaveProperty("contentHash");
        expect(tools.find((tool) => tool.name === "read")).toMatchObject({
          origin: "local:@sparkwright/coding-tools",
        });
        expect(tools.some((tool) => tool.name === "read")).toBe(true);
        expect(tools.some((tool) => tool.name === "delegate_agent")).toBe(true);
        expect(tools.some((tool) => tool.name === "delegate_reviewer")).toBe(
          false,
        );
        expect(tools.some((tool) => tool.name === "spawn_agent")).toBe(true);
        expect(tools.some((tool) => tool.name === "create_skill")).toBe(true);
        expect(tools.some((tool) => tool.name === "create_agent")).toBe(true);
        expect(tools.some((tool) => tool.name === "list_skills")).toBe(true);
        expect(tools.some((tool) => tool.name === "list_agents")).toBe(true);
        expect(tools.some((tool) => tool.name.startsWith("mcp_missing_"))).toBe(
          true,
        );
        expect(tools.some((tool) => tool.name === "shell")).toBe(false);
      }

      pair.clientSend({
        envelope: "request",
        id: "cap-write",
        kind: "capability.inspect",
        timestamp: TIMESTAMP,
        payload: {
          accessMode: "bypass",
          backgroundTasks: "disabled",
        },
      });
      const scoped = await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "cap-write",
      );
      expect(scoped).toMatchObject({
        envelope: "response",
        ok: true,
        result: {
          access: {
            accessMode: "bypass",
            backgroundTasks: "disabled",
          },
          shell: {
            promotionAvailable: false,
          },
          agents: {
            delegateTools: [
              expect.objectContaining({
                toolName: "delegate_reviewer",
                gatedByRunWrite: false,
                approvalRunOptions: { shouldWrite: true },
              }),
            ],
          },
        },
      });
    } finally {
      pair.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("includes model pricing warnings in capability inspection", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-model-pricing-"),
    );
    try {
      await mkdir(join(workspace, ".sparkwright"), { recursive: true });
      await writeFile(
        join(workspace, ".sparkwright", "config.json"),
        JSON.stringify({
          identity: {
            model: "openai/gpt-5.4-mini",
            providers: {
              openai: {},
            },
          },
        }),
        "utf8",
      );
      const runtime = new HostRuntime({
        workspaceRoot: workspace,
        emit: () => {},
      });

      const inspected = await runtime.inspectCapabilities();

      expect(inspected).toMatchObject({
        ok: true,
        snapshot: {
          model: {
            modelRef: "openai/gpt-5.4-mini",
            providerKey: "openai",
            modelId: "gpt-5.4-mini",
            adapterId: "openai:gpt-5.4-mini",
            pricing: {
              source: "unavailable",
              costStatus: "unavailable",
              costUnavailableReason: "missing_pricing",
            },
          },
        },
      });
      if (inspected.ok) {
        expect(inspected.snapshot.model?.pricing.warning).toContain(
          "cost estimates will be unavailable",
        );
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses the requested runtime model for capability inspection", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-capability-model-"),
    );
    try {
      await mkdir(join(workspace, ".sparkwright"), { recursive: true });
      await writeFile(
        join(workspace, ".sparkwright", "config.json"),
        JSON.stringify({
          identity: {
            model: "openai/gpt-5.4-nano",
            providers: {
              openai: {},
            },
          },
        }),
        "utf8",
      );
      const runtime = new HostRuntime({
        workspaceRoot: workspace,
        emit: () => {},
      });

      const inspected = await runtime.inspectCapabilities({
        modelRef: "openai/gpt-5.4-mini",
      });

      expect(inspected).toMatchObject({
        ok: true,
        snapshot: {
          model: {
            modelRef: "openai/gpt-5.4-mini",
            providerKey: "openai",
            modelId: "gpt-5.4-mini",
          },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("passes capability inspect model through the host protocol", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-capability-protocol-model-"),
    );
    const pair = createConnectionPair();
    try {
      await mkdir(join(workspace, ".sparkwright"), { recursive: true });
      await writeFile(
        join(workspace, ".sparkwright", "config.json"),
        JSON.stringify({
          identity: {
            model: "openai/gpt-5.4-nano",
            providers: {
              openai: {},
            },
          },
        }),
        "utf8",
      );

      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
      });
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "h" && m.ok,
      );
      pair.clientSend({
        envelope: "request",
        id: "cap",
        kind: "capability.inspect",
        timestamp: TIMESTAMP,
        payload: {
          model: "openai/gpt-5.4-mini",
        },
      });

      const resp = await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "cap",
      );
      expect(resp).toMatchObject({
        envelope: "response",
        ok: true,
        result: {
          model: {
            modelRef: "openai/gpt-5.4-mini",
          },
        },
      });
    } finally {
      pair.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects malformed approval decisions before runtime dispatch", async () => {
    const pair = createConnectionPair();
    serveConnection(pair.hostSide, {
      workspaceRoot: process.cwd(),
      defaultModel: "deterministic",
    });
    pair.clientSend({
      envelope: "request",
      id: "h",
      kind: "handshake",
      timestamp: TIMESTAMP,
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        client: { name: "test", version: "0.0.0" },
      },
    });
    await pair.waitFor((m) => m.envelope === "response" && m.id === "h");

    pair.clientSend({
      envelope: "request",
      id: "approval",
      kind: "approval.resolve",
      timestamp: TIMESTAMP,
      payload: { approvalId: "approval_x", decision: "maybe" },
    } as unknown as HostMessage);
    const resp = await pair.waitFor(
      (m) => m.envelope === "response" && m.id === "approval",
    );
    expect(resp).toMatchObject({
      envelope: "response",
      ok: false,
      error: { code: "invalid_payload" },
    });
  });

  it("preserves approval resolution messages in host-backed traces", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-approval-message-"),
    );
    const pair = createConnectionPair();
    const previousScript = process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
    process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = JSON.stringify([
      {
        toolCalls: [
          {
            toolName: "edit",
            arguments: {
              path: "README.md",
              reason: "exercise approval trace",
              patch: [
                "--- a/README.md",
                "+++ b/README.md",
                "@@ -1 +1,3 @@",
                " # Demo",
                "+",
                "+Approved write.",
                "",
              ].join("\n"),
            },
          },
        ],
      },
      { message: "done" },
    ]);

    try {
      await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "scripted",
      });
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor((m) => m.envelope === "response" && m.id === "h");

      pair.clientSend({
        envelope: "request",
        id: "start",
        kind: "run.start",
        timestamp: TIMESTAMP,
        payload: {
          goal: "write with approval",
          model: "scripted",
          accessMode: "ask",
        },
      });
      await pair.waitFor((m) => m.envelope === "response" && m.id === "start");

      const approval = await pair.waitFor(
        (m) => m.envelope === "event" && m.kind === "approval.requested",
      );
      expect(approval).toMatchObject({
        envelope: "event",
        kind: "approval.requested",
      });
      if (
        approval.envelope !== "event" ||
        approval.kind !== "approval.requested"
      ) {
        throw new Error("approval request was not emitted");
      }
      pair.clientSend({
        envelope: "request",
        id: "approve",
        kind: "approval.resolve",
        timestamp: TIMESTAMP,
        payload: {
          approvalId: approval.payload.approvalId,
          decision: "approved",
          message: "Auto-approved by test.",
          autoApproved: true,
        },
      });
      await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "approve",
      );
      await pair.waitFor(
        (m) => m.envelope === "event" && m.kind === "run.completed",
      );

      const resolved = pair
        .clientMessages()
        .filter((m) => m.envelope === "event" && m.kind === "run.event")
        .map((m) => m.payload.event as SparkwrightEvent)
        .find((event) => event.type === "approval.resolved");
      expect(resolved?.payload).toMatchObject({
        decision: "approved",
        message: "Auto-approved by test.",
        autoApproved: true,
      });
    } finally {
      pair.close();
      if (previousScript === undefined) {
        delete process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
      } else {
        process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = previousScript;
      }
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("lets configured in-process delegates write through the parent approval path", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-delegate-write-"),
    );
    const pair = createConnectionPair();
    const previousScript = process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
    process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = JSON.stringify([
      {
        toolCalls: [
          {
            toolName: "delegate_agent",
            arguments: {
              agentId: "writer",
              goal: "Patch README.md from the writer delegate.",
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            toolName: "edit",
            arguments: {
              path: "README.md",
              reason: "delegate write regression",
              patch: [
                "--- a/README.md",
                "+++ b/README.md",
                "@@ -1 +1,3 @@",
                " # Demo",
                "+",
                "+Written by configured delegate.",
                "",
              ].join("\n"),
            },
          },
        ],
      },
      { message: "child patched README.md" },
      { message: "parent observed delegate result" },
    ]);

    try {
      await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
      await mkdir(join(workspace, ".sparkwright"), { recursive: true });
      await writeFile(
        join(workspace, ".sparkwright", "config.json"),
        JSON.stringify({
          capabilities: {
            agents: {
              profiles: [
                { id: "main", mode: "primary" },
                {
                  id: "writer",
                  name: "Writer",
                  mode: "child",
                  prompt: "Apply the requested workspace patch.",
                  use: ["workspace.write"],
                  allowedTools: ["edit"],
                  maxSteps: 3,
                },
              ],
              delegateTools: [
                {
                  profileId: "writer",
                  toolName: "delegate_writer",
                },
              ],
            },
          },
        }),
        "utf8",
      );

      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "scripted",
      });
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor((m) => m.envelope === "response" && m.id === "h");

      pair.clientSend({
        envelope: "request",
        id: "start",
        kind: "run.start",
        timestamp: TIMESTAMP,
        payload: {
          goal: "delegate a README write",
          model: "scripted",
          accessMode: "ask",
        },
      });
      await pair.waitFor((m) => m.envelope === "response" && m.id === "start");

      const approval = await pair.waitFor(
        (m) => m.envelope === "event" && m.kind === "approval.requested",
      );
      if (
        approval.envelope !== "event" ||
        approval.kind !== "approval.requested"
      ) {
        throw new Error("approval request was not emitted");
      }
      pair.clientSend({
        envelope: "request",
        id: "approve",
        kind: "approval.resolve",
        timestamp: TIMESTAMP,
        payload: {
          approvalId: approval.payload.approvalId,
          decision: "approved",
          message: "Approved delegate write.",
          autoApproved: true,
        },
      });
      await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "approve" && m.ok,
      );
      const terminal = await pair.waitFor(
        (m) => m.envelope === "event" && m.kind === "run.completed",
      );
      expect(terminal).toMatchObject({
        envelope: "event",
        kind: "run.completed",
      });
      await expect(
        readFile(join(workspace, "README.md"), "utf8"),
      ).resolves.toBe("# Demo\n\nWritten by configured delegate.\n");

      const events = pair
        .clientMessages()
        .filter((m) => m.envelope === "event" && m.kind === "run.event")
        .map((m) => m.payload.event as SparkwrightEvent);
      // The delegate's write is surfaced to the parent by rolling up the child
      // run's own `workspace.write.completed` events onto `subagent.completed`,
      // not by a parent-side filesystem snapshot.
      const subagentCompleted = events.find(
        (event) => event.type === "subagent.completed",
      );
      expect(subagentCompleted?.payload).toMatchObject({ workspaceWrites: 1 });
      expect(subagentCompleted?.metadata).toMatchObject({
        agentId: "main",
        childAgentId: "writer",
        agentProfileId: "writer",
        delegateTool: "delegate_writer",
        entrypoint: "delegate_agent",
        subagentDepth: 1,
      });
    } finally {
      pair.close();
      if (previousScript === undefined) {
        delete process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
      } else {
        process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = previousScript;
      }
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("emits subagentDepth metadata for dynamic spawn_agent children", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-dynamic-spawn-"),
    );
    const pair = createConnectionPair();
    const previousScript = process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
    process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = JSON.stringify([
      {
        toolCalls: [
          {
            toolName: "tool_search",
            arguments: { query: "select:spawn_agent" },
          },
        ],
      },
      {
        toolCalls: [
          {
            toolName: "spawn_agent",
            arguments: {
              goal: "Read README.md.",
              role: "reader",
              prompt: "Read only.",
              allowedTools: ["read"],
              maxSteps: 2,
            },
          },
        ],
      },
      { message: "child done" },
      { message: "parent observed child" },
    ]);

    try {
      await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "scripted",
      });
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor((m) => m.envelope === "response" && m.id === "h");

      pair.clientSend({
        envelope: "request",
        id: "start",
        kind: "run.start",
        timestamp: TIMESTAMP,
        payload: {
          goal: "spawn a reader",
          model: "scripted",
          sessionId: "session_dynamic_spawn",
        },
      });
      await pair.waitFor((m) => m.envelope === "response" && m.id === "start");
      await pair.waitFor(
        (m) => m.envelope === "event" && m.kind === "run.completed",
      );

      const events = pair
        .clientMessages()
        .filter((m) => m.envelope === "event" && m.kind === "run.event")
        .map((m) => m.payload.event as SparkwrightEvent);
      const completed = events.find(
        (event) => event.type === "subagent.completed",
      );
      expect(completed?.metadata).toMatchObject({
        agentId: "main",
        childAgentId: "dynamic_reader",
        agentProfileId: "dynamic_reader",
        delegateTool: "spawn_agent",
        entrypoint: "spawn_agent",
        subagentDepth: 1,
      });
      expect(completed?.payload).toMatchObject({
        terminalState: "completed",
      });
    } finally {
      pair.close();
      if (previousScript === undefined) {
        delete process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
      } else {
        process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = previousScript;
      }
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("lets configured in-process delegates run shell through the parent approval path", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-delegate-shell-"),
    );
    const pair = createConnectionPair();
    const previousScript = process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
    process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = JSON.stringify([
      {
        toolCalls: [
          {
            toolName: "delegate_agent",
            arguments: {
              agentId: "runner",
              goal: "Run a tiny shell command.",
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            toolName: "bash",
            arguments: { command: "printf child-shell" },
          },
        ],
      },
      { message: "child ran shell" },
      { message: "parent observed shell delegate" },
    ]);

    try {
      await mkdir(join(workspace, ".sparkwright"), { recursive: true });
      await writeFile(
        join(workspace, ".sparkwright", "config.json"),
        JSON.stringify({
          policy: { sandbox: { mode: "off" } },
          capabilities: {
            agents: {
              profiles: [
                { id: "main", mode: "primary" },
                {
                  id: "runner",
                  name: "Runner",
                  mode: "child",
                  prompt: "Run the requested shell command.",
                  use: ["bash"],
                  allowedTools: ["bash"],
                  maxSteps: 4,
                },
              ],
              delegateTools: [
                {
                  profileId: "runner",
                  toolName: "delegate_runner",
                },
              ],
            },
          },
        }),
        "utf8",
      );

      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "scripted",
      });
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor((m) => m.envelope === "response" && m.id === "h");

      pair.clientSend({
        envelope: "request",
        id: "start",
        kind: "run.start",
        timestamp: TIMESTAMP,
        payload: {
          goal: "delegate a shell command",
          model: "scripted",
          sessionId: "session_delegate_shell",
          accessMode: "ask",
        },
      });
      await pair.waitFor((m) => m.envelope === "response" && m.id === "start");

      const firstApproval = await pair.waitFor(
        (m) => m.envelope === "event" && m.kind === "approval.requested",
      );
      if (
        firstApproval.envelope !== "event" ||
        firstApproval.kind !== "approval.requested"
      ) {
        throw new Error("approval request was not emitted");
      }
      let shellApproval = firstApproval;
      if (firstApproval.payload.details?.toolName === "delegate_agent") {
        pair.clientSend({
          envelope: "request",
          id: "approve_delegate",
          kind: "approval.resolve",
          timestamp: TIMESTAMP,
          payload: {
            approvalId: firstApproval.payload.approvalId,
            decision: "approved",
            message: "Approved delegation.",
          },
        });
        await pair.waitFor(
          (m) =>
            m.envelope === "response" && m.id === "approve_delegate" && m.ok,
        );
        const nextShellApproval = await pair.waitFor(
          (m) =>
            m.envelope === "event" &&
            m.kind === "approval.requested" &&
            m.payload.details?.toolName === "bash",
        );
        if (
          nextShellApproval.envelope !== "event" ||
          nextShellApproval.kind !== "approval.requested"
        ) {
          throw new Error("shell approval request was not emitted");
        }
        shellApproval = nextShellApproval;
      }
      if (
        shellApproval.envelope !== "event" ||
        shellApproval.kind !== "approval.requested"
      ) {
        throw new Error("shell approval request was not emitted");
      }
      expect(shellApproval.payload).toMatchObject({
        details: {
          toolName: "bash",
          arguments: { command: "printf child-shell" },
        },
      });
      pair.clientSend({
        envelope: "request",
        id: "approve",
        kind: "approval.resolve",
        timestamp: TIMESTAMP,
        payload: {
          approvalId: shellApproval.payload.approvalId,
          decision: "approved",
          message: "Approved delegate shell.",
          autoApproved: true,
        },
      });
      await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "approve" && m.ok,
      );
      await pair.waitFor(
        (m) => m.envelope === "event" && m.kind === "run.completed",
      );

      const childTrace = await readFileWhenReady(
        join(
          workspace,
          ".sparkwright",
          "sessions",
          "session_delegate_shell",
          "agents",
          "runner",
          "trace.jsonl",
        ),
        "child-shell",
      );
      expect(childTrace).toContain('"toolName":"bash"');
      expect(childTrace).toContain("child-shell");
    } finally {
      pair.close();
      if (previousScript === undefined) {
        delete process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
      } else {
        process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = previousScript;
      }
      await rm(workspace, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20,
      });
    }
  });

  it("runs a deterministic goal end-to-end", async () => {
    const pair = createConnectionPair();
    serveConnection(pair.hostSide, {
      workspaceRoot: process.cwd(),
      defaultModel: "deterministic",
    });

    // 1) handshake
    pair.clientSend({
      envelope: "request",
      id: "h",
      kind: "handshake",
      timestamp: TIMESTAMP,
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        client: { name: "test", version: "0.0.0" },
      },
    });
    const handshakeResp = await pair.waitFor(
      (m) => m.envelope === "response" && m.id === "h",
    );
    expect(handshakeResp).toMatchObject({ ok: true });
    const ready = await pair.waitFor(
      (m) => m.envelope === "event" && m.kind === "host.ready",
    );
    expect(ready).toMatchObject({
      kind: "host.ready",
      payload: { protocolVersion: PROTOCOL_VERSION },
    });

    // 2) start a run
    pair.clientSend({
      envelope: "request",
      id: "s",
      kind: "run.start",
      timestamp: TIMESTAMP,
      payload: { goal: "inspect this repo" },
    });
    const startResp = await pair.waitFor(
      (m) => m.envelope === "response" && m.id === "s",
    );
    expect(startResp).toMatchObject({ ok: true });
    if (startResp.envelope !== "response" || !startResp.ok) {
      throw new Error("run.start did not return an ok response");
    }
    expect(startResp.result.runId).toMatch(/^run_/);

    // 3) wait for terminal event
    const terminal = await pair.waitFor(
      (m) =>
        m.envelope === "event" &&
        (m.kind === "run.completed" || m.kind === "run.failed"),
    );
    expect(terminal.envelope).toBe("event");
    if (terminal.envelope !== "event") return;
    if (terminal.kind === "run.failed") {
      throw new Error(
        `run failed: ${JSON.stringify(terminal.payload, null, 2)}`,
      );
    }
    expect(terminal.kind).toBe("run.completed");

    // 4) we should have seen at least one run.event in between
    const runEvents = pair
      .clientMessages()
      .filter((m) => m.envelope === "event" && m.kind === "run.event");
    expect(runEvents.length).toBeGreaterThan(0);
  });

  it("starts a background agent through the real task_create tool", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-agent-task-create-"),
    );
    const previousScript = process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
    process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = JSON.stringify([
      {
        toolCalls: [
          {
            toolName: "task_create",
            arguments: {
              kind: "agent",
              title: "background repo inspection",
              payload: {
                goal: "Inspect the repository in the background.",
                role: "background-inspector",
                prompt: "Return one concise sentence.",
                allowedTools: ["glob"],
                maxSteps: 1,
              },
            },
          },
        ],
      },
      { message: "scripted background agent completed." },
      { message: "parent launched the background agent." },
      { message: "scripted fallback completed." },
    ]);

    let resolveTerminal!: (event: HostMessage) => void;
    const terminal = new Promise<HostMessage>((resolve) => {
      resolveTerminal = resolve;
    });
    let resolveApprovalRequest!: (approvalId: string) => void;
    const approvalRequest = new Promise<string>((resolve) => {
      resolveApprovalRequest = resolve;
    });
    const emitted: HostMessage[] = [];
    let runtime: HostRuntime | undefined;
    try {
      await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
      runtime = new HostRuntime({
        workspaceRoot: workspace,
        defaultModel: "scripted",
        emit: (event) => {
          emitted.push(event);
          if (
            event.kind === "approval.requested" &&
            typeof event.payload.approvalId === "string"
          ) {
            resolveApprovalRequest(event.payload.approvalId);
          }
          if (event.kind === "run.completed" || event.kind === "run.failed") {
            resolveTerminal(event);
          }
        },
      });

      const started = await runtime.startRun({
        goal: "launch a background agent task",
        model: "scripted",
        accessMode: "bypass",
      });
      expect(started).toMatchObject({ ok: true });
      if (!started.ok) throw new Error(started.error.message);

      const approvalId = await approvalRequest;
      expect(
        runtime.resolveApproval(
          approvalId,
          "approved",
          "Approved task_create for background agent test.",
          true,
        ),
      ).toMatchObject({ ok: true });

      const completed = await terminal;
      expect(completed).toMatchObject({
        envelope: "event",
        kind: "run.completed",
        payload: { state: "completed" },
      });

      const task = await waitForAgentTaskTerminal(runtime);
      expect(task).toMatchObject({
        kind: "agent",
        status: "completed",
        title: "background repo inspection",
      });
      const output = await runtime.readTaskOutput({
        taskId: task.id,
        maxChunks: 10,
      });
      expect(output).toMatchObject({
        ok: true,
        status: "completed",
        complete: true,
      });
      if (!output.ok) throw new Error(output.error.message);
      const summary = JSON.parse(output.chunks[0]?.data ?? "{}") as {
        type?: string;
        childRunId?: string;
        agentId?: string;
        finality?: string;
      };
      expect(summary).toMatchObject({
        type: "agent.completed",
        agentId: "dynamic_background-inspector",
      });
      expect(summary.childRunId).toMatch(/^run_/);
      expect(["complete", "partial"]).toContain(summary.finality);

      const runEvents = emitted
        .filter(
          (event) => event.envelope === "event" && event.kind === "run.event",
        )
        .map((event) => event.payload.event as SparkwrightEvent);
      expect(
        runEvents.some(
          (event) =>
            event.type === "tool.completed" &&
            (event.payload as { toolName?: string }).toolName === "task_create",
        ),
      ).toBe(true);
      const completedSubagent = runEvents.find(
        (event) =>
          event.type === "subagent.completed" &&
          (event.metadata as { entrypoint?: string }).entrypoint ===
            "agent_task",
      );
      expect(completedSubagent).toBeDefined();
      expect(completedSubagent?.payload).toMatchObject({ taskId: task.id });
      expect(completedSubagent?.metadata).toMatchObject({ taskId: task.id });
    } finally {
      if (previousScript === undefined) {
        delete process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
      } else {
        process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = previousScript;
      }
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("runs required verification after workspace writes before final answer", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-verification-"),
    );
    const xdg = await mkdtemp(join(tmpdir(), "sparkwright-host-config-"));
    const pair = createConnectionPair();
    const previousScript = process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = JSON.stringify([
      {
        message: "write then verify",
        toolCalls: [
          {
            toolName: "edit",
            arguments: {
              path: "README.md",
              reason: "Add verified section",
              patch: [
                "--- a/README.md",
                "+++ b/README.md",
                "@@ -1 +1,5 @@",
                " # Demo",
                "+",
                "+## Verified Write",
                "+",
                "+This section exercises required verification.",
                "",
              ].join("\n"),
            },
          },
        ],
      },
      { message: "Verified write completed." },
    ]);
    process.env.XDG_CONFIG_HOME = xdg;

    try {
      await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
      await mkdir(join(workspace, ".sparkwright"), { recursive: true });
      await writeFile(
        join(workspace, ".sparkwright", "config.json"),
        JSON.stringify(
          {
            capabilities: {
              verification: {
                mode: "require",
                defaultProfile: "fast",
                profiles: {
                  fast: [
                    {
                      id: "unit",
                      kind: "custom",
                      command: process.execPath,
                      args: ["-e", "process.exit(0)"],
                    },
                  ],
                },
                afterWrites: {
                  profile: "fast",
                  injectOutput: "onFailure",
                },
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "scripted",
      });
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor((m) => m.envelope === "response" && m.id === "h");

      pair.clientSend({
        envelope: "request",
        id: "verified_run",
        kind: "run.start",
        timestamp: TIMESTAMP,
        payload: {
          goal: "write README and verify",
          model: "scripted",
          accessMode: "accept-edits",
        },
      });
      const startResp = await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "verified_run",
      );
      expect(startResp).toMatchObject({ envelope: "response", ok: true });

      const completed = await pair.waitFor(
        (m) => m.envelope === "event" && m.kind === "run.completed",
      );
      expect(completed).toMatchObject({
        envelope: "event",
        kind: "run.completed",
        payload: { state: "completed", stopReason: "final_answer" },
      });
      const events = pair
        .clientMessages()
        .filter((m) => m.envelope === "event" && m.kind === "run.event")
        .map((m) => m.payload.event as SparkwrightEvent);
      await expect(
        readFile(join(workspace, "README.md"), "utf8"),
      ).resolves.toContain("## Verified Write");

      const write = events.find(
        (event) => event.type === "workspace.write.completed",
      );
      expect(write).toBeTruthy();
      const verification = events.find((event) => {
        if (event.type !== "workflow_hook.completed") return false;
        const payload = event.payload as
          | {
              hookName?: string;
              result?: { metadata?: Record<string, unknown> };
            }
          | undefined;
        const metadata = payload?.result?.metadata;
        return (
          payload?.hookName === "workflow:verification_fast" &&
          metadata?.verificationSource === "profile" &&
          metadata?.profile === "fast" &&
          metadata?.verifierId === "unit"
        );
      });
      expect(verification?.sequence).toBeGreaterThan(write?.sequence ?? 0);
      expect(verification?.payload).toMatchObject({
        result: {
          status: "continue",
          metadata: {
            exitCode: 0,
            timedOut: false,
          },
        },
      });
    } finally {
      if (previousScript === undefined)
        delete process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
      else process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = previousScript;
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      pair.close();
      await rm(xdg, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("accepts run.inject_message for an active run", async () => {
    const pair = createConnectionPair();
    serveConnection(pair.hostSide, {
      workspaceRoot: process.cwd(),
      defaultModel: "deterministic",
    });

    pair.clientSend({
      envelope: "request",
      id: "h",
      kind: "handshake",
      timestamp: TIMESTAMP,
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        client: { name: "test", version: "0.0.0" },
      },
    });
    await pair.waitFor((m) => m.envelope === "response" && m.id === "h");

    pair.clientSend({
      envelope: "request",
      id: "s",
      kind: "run.start",
      timestamp: TIMESTAMP,
      payload: { goal: "inspect this repo" },
    });
    const startResp = await pair.waitFor(
      (m) => m.envelope === "response" && m.id === "s",
    );
    if (startResp.envelope !== "response" || !startResp.ok) {
      throw new Error("run.start did not return an ok response");
    }
    const runId = String(startResp.result.runId);

    pair.clientSend({
      envelope: "request",
      id: "inject",
      kind: "run.inject_message",
      timestamp: TIMESTAMP,
      payload: {
        runId,
        content: "also inspect package.json",
        metadata: { source: "test" },
      },
    });

    const injectResp = await pair.waitFor(
      (m) => m.envelope === "response" && m.id === "inject",
    );
    expect(injectResp).toMatchObject({ ok: true });

    const enqueued = await pair.waitFor(
      (m) =>
        m.envelope === "event" &&
        m.kind === "run.event" &&
        (m.payload.event as { type?: string }).type === "run.command.enqueued",
    );
    expect(enqueued).toMatchObject({ kind: "run.event" });
  });

  it("inspects persisted session diagnostics", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-host-"));
    try {
      await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
      const pair = createConnectionPair();
      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "deterministic",
      });

      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor((m) => m.envelope === "response" && m.id === "h");

      pair.clientSend({
        envelope: "request",
        id: "s",
        kind: "run.start",
        timestamp: TIMESTAMP,
        payload: { goal: "inspect this repo" },
      });
      await pair.waitFor((m) => m.envelope === "response" && m.id === "s");
      await pair.waitFor(
        (m) => m.envelope === "event" && m.kind === "run.completed",
      );

      pair.clientSend({
        envelope: "request",
        id: "list",
        kind: "session.list",
        timestamp: TIMESTAMP,
        payload: { limit: 1 },
      });
      const listResp = await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "list",
      );
      if (listResp.envelope !== "response" || !listResp.ok) {
        throw new Error("session.list did not return an ok response");
      }
      const sessions = listResp.result.sessions as Array<{ id: string }>;
      const sessionId = sessions[0]?.id;
      expect(sessionId).toBeTruthy();

      pair.clientSend({
        envelope: "request",
        id: "inspect",
        kind: "session.inspect",
        timestamp: TIMESTAMP,
        payload: { sessionId },
      });
      const inspectResp = await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "inspect",
      );

      expect(inspectResp).toMatchObject({
        envelope: "response",
        ok: true,
        result: {
          sessionId,
          consistency: { ok: true },
          timeline: { phases: expect.any(Array) },
        },
      });

      pair.clientSend({
        envelope: "request",
        id: "inspect_compaction",
        kind: "session.inspect",
        timestamp: TIMESTAMP,
        payload: { sessionId, compaction: true },
      });
      const inspectCompactionResp = await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "inspect_compaction",
      );

      expect(inspectCompactionResp).toMatchObject({
        envelope: "response",
        ok: true,
        result: {
          sessionId,
          compaction: {
            status: "not_compacted",
            artifact: null,
            events: [],
            latestEvent: null,
            consistency: {
              ok: true,
              artifactMatchesLatestCompletedEvent: null,
              findings: [],
            },
          },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("compacts completed session turns through the host protocol", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-host-"));
    try {
      const sessionRootDir = join(workspace, ".sparkwright", "sessions");
      const sessionId = "session_compact_protocol";
      const runId = "run_compact_protocol" as RunId;
      const store = new FileSessionStore({ rootDir: sessionRootDir });
      await store.create({ id: sessionId });
      await store.append(sessionId, runId);
      const runDir = join(
        sessionRootDir,
        sessionId,
        "agents",
        "main",
        "runs",
        runId,
      );
      await mkdir(runDir, { recursive: true });
      await writeFile(
        join(runDir, "run.json"),
        JSON.stringify({
          id: runId,
          goal: "please refactor the TUI and preserve packages/tui/src/app.tsx behavior",
        }),
        "utf8",
      );
      await writeFile(
        join(runDir, "result.json"),
        JSON.stringify({
          message: [
            "Must keep session compact warnings visible and do not hide skipped reasons.",
            "Wrote packages/tui/src/app.tsx and packages/tui/src/state/run-controller.ts.",
            "Verification passed after protocol compact.",
            "Refactored the TUI layer renderer and extracted the capabilities panel. ".repeat(
              80,
            ),
          ].join("\n"),
        }),
        "utf8",
      );

      const pair = createConnectionPair();
      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "deterministic",
      });
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor((m) => m.envelope === "response" && m.id === "h");

      pair.clientSend({
        envelope: "request",
        id: "compact",
        kind: "session.compact",
        timestamp: TIMESTAMP,
        payload: { sessionId, reason: "test", llm: true },
      });
      const compactResp = await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "compact",
      );

      expect(compactResp).toMatchObject({
        envelope: "response",
        ok: true,
        result: {
          sessionId,
          compactedRunCount: 1,
          throughRunId: runId,
          artifactPath: join(sessionRootDir, sessionId, "compact.json"),
        },
      });
      if (compactResp.envelope !== "response" || !compactResp.ok) {
        throw new Error("expected compact response");
      }
      expect(compactResp.result.freedChars).toBeGreaterThan(0);
      expect(compactResp.result.skippedReason).toBeUndefined();
      expect(compactResp.result.measurement).toMatchObject({
        regime: "density_bound",
        summarizer: expect.objectContaining({
          applied: true,
          mode: "deterministic_stub",
        }),
      });
      expect(compactResp.result.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "SESSION_SUMMARIZER_DETERMINISTIC_PREVIEW",
          }),
        ]),
      );
      const artifact = JSON.parse(
        await readFile(join(sessionRootDir, sessionId, "compact.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(artifact).toMatchObject({
        schemaVersion: SESSION_COMPACT_SCHEMA_VERSION,
        sessionId,
        throughRunId: runId,
        compactedRunCount: 1,
        freedChars: compactResp.result.freedChars,
      });
      expect(String(artifact.content)).toContain(
        "Session deterministic-summary preview.",
      );
      expect(String(artifact.content)).toContain("packages/tui/src/app.tsx");
      expect(artifact.metadata).toMatchObject({
        mode: "deterministic-v2",
        warnings: expect.arrayContaining([
          expect.objectContaining({
            code: "SESSION_SUMMARIZER_DETERMINISTIC_PREVIEW",
          }),
        ]),
      });
      expect(
        (
          artifact.metadata as {
            appliedStages?: Array<Record<string, unknown>>;
          }
        ).appliedStages,
      ).toContainEqual(
        expect.objectContaining({
          name: "session_summarize",
          tier: "summarize",
        }),
      );
      const sessionEvents: SessionEvent[] = [];
      for await (const event of store.loadEvents(sessionId)) {
        sessionEvents.push(event);
      }
      expect(sessionEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "session.compaction.completed",
            payload: expect.objectContaining({
              compactedRunCount: 1,
              throughRunId: runId,
              freedChars: compactResp.result.freedChars,
              artifactPath: join(sessionRootDir, sessionId, "compact.json"),
              warningCodes: expect.arrayContaining([
                "SESSION_SUMMARIZER_DETERMINISTIC_PREVIEW",
              ]),
            }),
            metadata: expect.objectContaining({
              source: "host",
              reason: "test",
            }),
          }),
        ]),
      );

      const inspectRuntime = new HostRuntime({
        workspaceRoot: workspace,
        sessionRootDir,
        defaultModel: "deterministic",
        emit: () => {},
      });
      const inspected =
        await inspectRuntime.inspectSessionCompaction(sessionId);
      expect(inspected).toMatchObject({
        ok: true,
        sessionId,
        compaction: {
          status: "compacted",
          artifact: {
            path: join(sessionRootDir, sessionId, "compact.json"),
            throughRunId: runId,
            compactedRunCount: 1,
            freedChars: compactResp.result.freedChars,
            warningCodes: expect.arrayContaining([
              "SESSION_SUMMARIZER_DETERMINISTIC_PREVIEW",
            ]),
          },
          latestEvent: {
            type: "session.compaction.completed",
            throughRunId: runId,
            artifactPath: join(sessionRootDir, sessionId, "compact.json"),
          },
          consistency: {
            ok: true,
            artifactMatchesLatestCompletedEvent: true,
          },
        },
      });
      expect(JSON.stringify(inspected)).not.toContain(
        "Session deterministic-summary preview.",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("records skipped session compaction as a durable session event", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-host-"));
    try {
      const sessionRootDir = join(workspace, ".sparkwright", "sessions");
      const sessionId = "session_compact_empty_protocol";
      const store = new FileSessionStore({ rootDir: sessionRootDir });
      await store.create({ id: sessionId });

      const runtime = new HostRuntime({
        workspaceRoot: workspace,
        sessionRootDir,
        defaultModel: "deterministic",
        emit: () => {},
      });
      const result = await runtime.compactSession(sessionId, "empty audit");

      expect(result).toMatchObject({
        ok: true,
        sessionId,
        skippedReason: "no_completed_turns",
        artifactPath: null,
      });
      const sessionEvents: SessionEvent[] = [];
      for await (const event of store.loadEvents(sessionId)) {
        sessionEvents.push(event);
      }
      expect(sessionEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "session.compaction.skipped",
            payload: expect.objectContaining({
              compactedRunCount: 0,
              throughRunId: null,
              freedChars: 0,
              artifactPath: null,
              skippedReason: "no_completed_turns",
            }),
            metadata: expect.objectContaining({
              source: "host",
              reason: "empty audit",
            }),
          }),
        ]),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses a model-backed session summarizer when llm is requested with a real model ref", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-host-"));
    const previousScript = process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
    try {
      const sessionRootDir = join(workspace, ".sparkwright", "sessions");
      const sessionId = "session_compact_model_protocol";
      const runId = "run_model_compact_protocol" as RunId;
      const store = new FileSessionStore({ rootDir: sessionRootDir });
      await store.create({ id: sessionId });
      await store.append(sessionId, runId);
      const runDir = join(
        sessionRootDir,
        sessionId,
        "agents",
        "main",
        "runs",
        runId,
      );
      await mkdir(runDir, { recursive: true });
      await writeFile(
        join(runDir, "run.json"),
        JSON.stringify({
          id: runId,
          goal: "Must preserve packages/host/src/runtime.ts.",
        }),
        "utf8",
      );
      await writeFile(
        join(runDir, "result.json"),
        JSON.stringify({
          message: [
            "Wrote packages/host/src/runtime.ts.",
            "Verification passed.",
            "Model-backed compaction detail ".repeat(120),
          ].join("\n"),
        }),
        "utf8",
      );
      process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = JSON.stringify([
        {
          message: JSON.stringify({
            content:
              "Model summary: User: Must preserve packages/host/src/runtime.ts. Constraints: Must preserve packages/host/src/runtime.ts. Wrote packages/host/src/runtime.ts. Verification passed. workspace_write verification run_model_compact_protocol",
            coveredSignalIds: [],
            unknownSignalIds: [],
          }),
        },
      ]);

      const pair = createConnectionPair();
      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "scripted/session-summarizer",
      });
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor((m) => m.envelope === "response" && m.id === "h");

      pair.clientSend({
        envelope: "request",
        id: "compact-model",
        kind: "session.compact",
        timestamp: TIMESTAMP,
        payload: { sessionId, reason: "test", llm: true },
      });
      const compactResp = await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "compact-model",
      );

      expect(compactResp).toMatchObject({
        envelope: "response",
        ok: true,
        result: {
          sessionId,
          compactedRunCount: 1,
          throughRunId: runId,
          artifactPath: join(sessionRootDir, sessionId, "compact.json"),
          measurement: {
            regime: "density_bound",
            summarizer: expect.objectContaining({
              applied: true,
              mode: "llm",
              modelId: "scripted/session-summarizer",
              promptVersion: "session-summarizer.prompt.v1",
              oracleVersion: "session-signals.v1",
            }),
          },
        },
      });
      if (compactResp.envelope !== "response" || !compactResp.ok) {
        throw new Error("expected compact response");
      }
      const warnings = Array.isArray(compactResp.result.warnings)
        ? (compactResp.result.warnings as Array<{ code?: string }>)
        : [];
      expect(
        warnings.some(
          (warning) =>
            warning.code === "SESSION_SUMMARIZER_DETERMINISTIC_PREVIEW",
        ),
      ).not.toBe(true);
      const artifact = JSON.parse(
        await readFile(join(sessionRootDir, sessionId, "compact.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(String(artifact.content)).toContain("Model summary:");
      expect(artifact.metadata).toMatchObject({
        mode: "llm",
        summaryFingerprint: expect.objectContaining({
          modelId: "scripted/session-summarizer",
          promptVersion: "session-summarizer.prompt.v1",
          oracleVersion: "session-signals.v1",
          throughRunId: runId,
        }),
        measurement: expect.objectContaining({
          summarizer: expect.objectContaining({
            mode: "llm",
          }),
        }),
      });
    } finally {
      if (previousScript === undefined) {
        delete process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
      } else {
        process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = previousScript;
      }
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("applies project task budget config to manual session summarization", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-host-"));
    try {
      await mkdir(join(workspace, ".sparkwright"), { recursive: true });
      await writeFile(
        join(workspace, ".sparkwright", "config.json"),
        JSON.stringify({
          tasks: {
            compaction: {
              budget: { maxSourceChars: 10, maxOutputTokens: 100 },
            },
          },
        }),
        "utf8",
      );
      const sessionRootDir = join(workspace, ".sparkwright", "sessions");
      const sessionId = "session_compact_budget_protocol";
      const runId = "run_compact_budget_protocol" as RunId;
      const store = new FileSessionStore({ rootDir: sessionRootDir });
      await store.create({ id: sessionId });
      await store.append(sessionId, runId);
      const runDir = join(
        sessionRootDir,
        sessionId,
        "agents",
        "main",
        "runs",
        runId,
      );
      await mkdir(runDir, { recursive: true });
      await writeFile(
        join(runDir, "run.json"),
        JSON.stringify({
          id: runId,
          goal: "Must preserve packages/host/src/runtime.ts.",
        }),
        "utf8",
      );
      await writeFile(
        join(runDir, "result.json"),
        JSON.stringify({
          message: [
            "Wrote packages/host/src/runtime.ts.",
            "Verification passed.",
            "Budgeted compaction detail ".repeat(120),
          ].join("\n"),
        }),
        "utf8",
      );

      const pair = createConnectionPair();
      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "deterministic",
      });
      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor((m) => m.envelope === "response" && m.id === "h");

      pair.clientSend({
        envelope: "request",
        id: "compact-budget",
        kind: "session.compact",
        timestamp: TIMESTAMP,
        payload: { sessionId, llm: true },
      });
      const compactResp = await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "compact-budget",
      );

      expect(compactResp).toMatchObject({
        envelope: "response",
        ok: true,
        result: {
          sessionId,
          compactedRunCount: 1,
          artifactPath: join(sessionRootDir, sessionId, "compact.json"),
          warnings: expect.arrayContaining([
            expect.objectContaining({
              code: "SESSION_SUMMARIZER_DETERMINISTIC_PREVIEW",
            }),
            expect.objectContaining({
              code: "SESSION_SUMMARIZER_SOURCE_TOO_LARGE",
            }),
          ]),
        },
      });
      const artifact = JSON.parse(
        await readFile(join(sessionRootDir, sessionId, "compact.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(String(artifact.content)).not.toContain(
        "Session deterministic-summary preview.",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not inject stale compact artifacts as conversation history", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-host-"));
    try {
      const sessionRootDir = join(workspace, ".sparkwright", "sessions");
      const sessionId = "session_compact_stale_artifact";
      const runId = "run_compact_live" as RunId;
      const staleRunId = "run_compact_stale" as RunId;
      const store = new FileSessionStore({ rootDir: sessionRootDir });
      await store.create({ id: sessionId });
      await store.append(sessionId, runId);
      const runDir = join(
        sessionRootDir,
        sessionId,
        "agents",
        "main",
        "runs",
        runId,
      );
      await mkdir(runDir, { recursive: true });
      await writeFile(
        join(runDir, "run.json"),
        JSON.stringify({ id: runId, goal: "live goal" }),
        "utf8",
      );
      await writeFile(
        join(runDir, "result.json"),
        JSON.stringify({ message: "live answer" }),
        "utf8",
      );
      await writeFile(
        join(sessionRootDir, sessionId, "compact.json"),
        JSON.stringify(
          {
            schemaVersion: SESSION_COMPACT_SCHEMA_VERSION,
            sessionId: asSessionId(sessionId),
            createdAt: "2026-06-21T00:00:00.000Z",
            throughRunId: staleRunId,
            compactedRunCount: 1,
            sourceRunIds: [staleRunId],
            content: "stale compact content that must not be injected",
            originalCharCount: 1000,
            summaryCharCount: 50,
            freedChars: 950,
          },
          null,
          2,
        ),
        "utf8",
      );

      const runtime = new HostRuntime({
        workspaceRoot: workspace,
        sessionRootDir,
        defaultModel: "deterministic",
        emit: () => {},
      });
      const history = await (
        runtime as unknown as {
          loadConversationHistory(
            rootDir: string,
            id: string,
          ): Promise<ContextItem[]>;
        }
      ).loadConversationHistory(sessionRootDir, sessionId);

      expect(history.map((item) => item.source?.kind)).toEqual([
        "session_compact_warning",
        "session_turn",
        "session_turn",
      ]);
      expect(history[0]?.content).toContain("ignored");
      expect(history.map((item) => item.content).join("\n")).not.toContain(
        "stale compact content",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects unsafe session ids instead of using them as paths", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-host-"));
    try {
      const pair = createConnectionPair();
      serveConnection(pair.hostSide, {
        workspaceRoot: workspace,
        defaultModel: "deterministic",
      });

      pair.clientSend({
        envelope: "request",
        id: "h",
        kind: "handshake",
        timestamp: TIMESTAMP,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "test", version: "0.0.0" },
        },
      });
      await pair.waitFor((m) => m.envelope === "response" && m.id === "h");

      pair.clientSend({
        envelope: "request",
        id: "start_bad",
        kind: "run.start",
        timestamp: TIMESTAMP,
        payload: { goal: "inspect this repo", sessionId: "../escape" },
      });
      const startResp = await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "start_bad",
      );
      expect(startResp).toMatchObject({
        envelope: "response",
        ok: false,
        error: { code: "invalid_payload" },
      });

      pair.clientSend({
        envelope: "request",
        id: "inspect_bad",
        kind: "session.inspect",
        timestamp: TIMESTAMP,
        payload: { sessionId: "../escape" },
      });
      const inspectResp = await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "inspect_bad",
      );
      expect(inspectResp).toMatchObject({
        envelope: "response",
        ok: false,
        error: { code: "invalid_payload" },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects a concurrent run.start while another is still spinning up", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-runtime-"));
    let runtime: HostRuntime | undefined;
    try {
      let resolveCompleted!: () => void;
      let rejectCompleted!: (error: Error) => void;
      const completed = new Promise<void>((resolve, reject) => {
        resolveCompleted = resolve;
        rejectCompleted = reject;
      });
      runtime = new HostRuntime({
        workspaceRoot: workspace,
        defaultModel: "deterministic",
        emit: (message) => {
          if (message.envelope !== "event") return;
          if (message.kind === "run.completed") resolveCompleted();
          if (message.kind === "run.failed") {
            rejectCompleted(new Error(message.payload.failure.message));
          }
        },
      });
      // Fire two startRun calls back-to-back without awaiting. The first
      // takes the `startingRun` reservation synchronously inside its async
      // body; the second observes the reservation and is rejected before its
      // own `await createModel(...)` runs.
      const first = runtime.startRun({ goal: "inspect repo" });
      const second = runtime.startRun({ goal: "another goal" });
      const [r1, r2] = await Promise.all([first, second]);
      // Exactly one wins.
      const oks = [r1, r2].filter((r) => r.ok);
      const errs = [r1, r2].filter((r) => !r.ok);
      expect(oks).toHaveLength(1);
      expect(errs).toHaveLength(1);
      expect(errs[0]!.ok).toBe(false);
      if (!errs[0]!.ok) {
        expect(errs[0]!.error.message).toMatch(/already active/);
      }
      await completed;
      runtime.cleanup();
      runtime = undefined;
    } finally {
      runtime?.cleanup();
      await rmWhenReady(workspace);
    }
  });

  it("characterizes two connections starting the same session without shared coordination", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-runtime-"));
    const first = createConnectionPair();
    const second = createConnectionPair();
    try {
      for (const pair of [first, second]) {
        serveConnection(pair.hostSide, {
          workspaceRoot: workspace,
          defaultModel: "deterministic",
        });
        pair.clientSend({
          envelope: "request",
          id: "handshake",
          kind: "handshake",
          timestamp: TIMESTAMP,
          payload: {
            protocolVersion: PROTOCOL_VERSION,
            client: { name: "test", version: "0.0.0" },
          },
        });
      }
      await Promise.all(
        [first, second].map((pair) =>
          pair.waitFor(
            (message) =>
              message.envelope === "response" && message.id === "handshake",
          ),
        ),
      );

      for (const [index, pair] of [first, second].entries()) {
        pair.clientSend({
          envelope: "request",
          id: `start_${index}`,
          kind: "run.start",
          timestamp: TIMESTAMP,
          payload: {
            goal: `connection ${index}`,
            sessionId: "shared_session",
          },
        });
      }
      const responses = await Promise.all([
        first.waitFor(
          (message) =>
            message.envelope === "response" && message.id === "start_0",
        ),
        second.waitFor(
          (message) =>
            message.envelope === "response" && message.id === "start_1",
        ),
      ]);

      // P0 fact: the reservation lives on each per-connection HostRuntime, so
      // both starts are admitted. P4 replaces this assertion with same-lane
      // serialization through the process coordinator.
      expect(responses).toEqual([
        expect.objectContaining({ envelope: "response", ok: true }),
        expect.objectContaining({ envelope: "response", ok: true }),
      ]);
    } finally {
      first.close();
      second.close();
      await rmWhenReady(workspace);
    }
  });

  it("rejects Host injection when the current Core run is already terminal", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-runtime-"));
    const runtime = new HostRuntime({
      workspaceRoot: workspace,
      emit: () => {},
    });
    try {
      const run = createRun({ goal: "already complete" });
      await run.start();
      (runtime as unknown as { active: unknown }).active = {
        runId: run.record.id,
        run,
        trace: { append() {} },
        sessionId: "terminal_inject",
      };

      expect(
        runtime.injectRunMessage(run.record.id, { content: "too late" }),
      ).toMatchObject({
        ok: false,
        error: {
          code: "run_not_found",
          message: expect.stringContaining("closed"),
        },
      });
      expect(
        run.events
          .all()
          .filter((event) => event.type === "run.command.enqueued"),
      ).toHaveLength(0);
    } finally {
      runtime.cleanup();
      await rmWhenReady(workspace);
    }
  });

  it("disconnect aborts an execution that is still assembling", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-runtime-"));
    const events: HostMessage[] = [];
    const runtime = new HostRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      emit: (event) => events.push(event),
    });
    try {
      const starting = runtime.startRun({ goal: "cancel during assembly" });
      runtime.cleanup();
      const result = await starting;

      expect(result).toMatchObject({
        ok: false,
        error: {
          message: expect.stringContaining("cancelled during assembly"),
        },
      });
      expect(runtime.hasActiveRun()).toBe(false);
      expect(
        events.some(
          (event) =>
            event.envelope === "event" && event.kind === "run.continuation",
        ),
      ).toBe(false);
    } finally {
      runtime.cleanup();
      await rmWhenReady(workspace);
    }
  });

  it("includes cron and durable task summaries in capability inspection", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-runtime-"));
    const stateHome = await mkdtemp(join(tmpdir(), "sparkwright-state-"));
    const previousStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateHome;
    try {
      const cronStore = new CronStore({ rootDir: defaultCronRoot() });
      const cronJob = await cronStore.createJob(
        {
          name: "readme-daily",
          prompt: "summarize README.md",
          schedule: "every 1d",
          workspace,
        },
        new Date("2026-06-09T00:00:00.000Z"),
      );

      const taskStore = new FileTaskStore({
        rootDir: join(workspace, ".sparkwright", "tasks"),
      });
      const taskId = createTaskId();
      taskStore.create({
        id: taskId,
        parentRunId: "run_automation_snapshot" as RunId,
        kind: "maintenance-check",
        title: "README maintenance",
      });
      taskStore.update(taskId, {
        status: "failed",
        completedAt: "2026-06-09T00:00:01.000Z",
        error: {
          code: "SYNTHETIC_TASK_FAILURE",
          message: "synthetic task failure",
        },
      });

      const runtime = new HostRuntime({
        workspaceRoot: workspace,
        defaultModel: "deterministic",
        emit: () => {},
      });
      const inspected = await runtime.inspectCapabilities();
      expect(inspected.ok).toBe(true);
      if (!inspected.ok) return;
      expect(inspected.snapshot.automation).toMatchObject({
        cron: {
          rootDir: defaultCronRoot(),
          total: 1,
          jobs: [
            expect.objectContaining({
              id: cronJob.id,
              name: "readme-daily",
              state: "scheduled",
              schedule: "every 1d",
            }),
          ],
        },
        tasks: {
          rootDir: join(workspace, ".sparkwright", "tasks"),
          total: 1,
          tasks: [
            expect.objectContaining({
              id: taskId,
              kind: "maintenance-check",
              status: "failed",
              error: {
                code: "SYNTHETIC_TASK_FAILURE",
                message: "synthetic task failure",
              },
            }),
          ],
        },
      });
    } finally {
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousStateHome;
      await rm(workspace, { recursive: true, force: true });
      await rm(stateHome, { recursive: true, force: true });
    }
  });
});
