import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type HostMessage } from "@sparkwright/protocol";
import {
  asSessionId,
  type ContextItem,
  FileSessionStore,
  SESSION_COMPACT_SCHEMA_VERSION,
  type SessionEvent,
  type RunId,
  type SparkwrightEvent,
} from "@sparkwright/core";
import { FileTaskStore, createTaskId } from "@sparkwright/agent-runtime";
import { CronStore, defaultCronRoot } from "@sparkwright/cron";
import type { Connection } from "../src/connection.js";
import { serveConnection } from "../src/server.js";
import { HostRuntime } from "../src/runtime.js";

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
    id: "test_host",
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

describe("host protocol", () => {
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
          permissionMode: "default",
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
          permissionMode: "default",
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
        permissionMode: "default",
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
          permissionMode: "default",
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

  it("resumes a legacy run directory into a new host-owned session", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-host-resume-legacy-"),
    );
    const runId = "run_resume_legacy_test";
    const runDir = join(workspace, ".sparkwright", "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
    await writeFile(
      join(runDir, "checkpoint.json"),
      checkpointJson({ runId, goal: "resume legacy checkpoint" }),
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
        id: "resume_legacy",
        kind: "run.resume",
        timestamp: TIMESTAMP,
        payload: {
          runId,
          model: "deterministic",
          permissionMode: "default",
        },
      });

      const resp = await pair.waitFor(
        (m) => m.envelope === "response" && m.id === "resume_legacy",
      );
      expect(resp).toMatchObject({
        envelope: "response",
        ok: true,
        result: { runId, resumedFromRunId: runId },
      });
      if (
        resp.envelope !== "response" ||
        !resp.ok ||
        typeof resp.result.sessionId !== "string"
      ) {
        throw new Error("Expected run.resume to return a new sessionId.");
      }
      expect(resp.result.sessionId).toMatch(/^session_/);
      expect(resp.result.sessionId).not.toBe(runId);

      await pair.waitFor(
        (m) => m.envelope === "event" && m.kind === "run.completed",
      );
      const sessionJson = await readFile(
        join(
          workspace,
          ".sparkwright",
          "sessions",
          resp.result.sessionId,
          "session.json",
        ),
        "utf8",
      );
      expect(JSON.parse(sessionJson)).toMatchObject({
        id: resp.result.sessionId,
        runIds: [runId],
      });
    } finally {
      pair.close();
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
          permissionMode: "default",
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
                  allowedTools: ["read_file"],
                },
                {
                  id: "reviewer",
                  name: "Reviewer",
                  mode: "child",
                  allowedTools: ["read_file"],
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
            disabled: ["shell"],
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
            ],
            delegateTools: [
              {
                toolName: "delegate_reviewer",
                profileId: "reviewer",
                profileName: "Reviewer",
                protocol: "in_process",
                risk: "risky",
                requiresApproval: false,
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
        expect(
          (
            resp.result as { skills: { indexed: Array<{ name: string }> } }
          ).skills.indexed.some((skill) => skill.name === "reviewer"),
        ).toBe(true);
        expect(tools.find((tool) => tool.name === "read_file")).toMatchObject({
          origin: "local:@sparkwright/coding-tools",
        });
        expect(tools.some((tool) => tool.name === "read_file")).toBe(true);
        expect(tools.some((tool) => tool.name === "delegate_reviewer")).toBe(
          true,
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
            toolName: "apply_patch",
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
          shouldWrite: true,
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
            toolName: "delegate_writer",
            arguments: { goal: "Patch README.md from the writer delegate." },
          },
        ],
      },
      {
        toolCalls: [
          {
            toolName: "apply_patch",
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
                  allowedTools: ["apply_patch"],
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
          shouldWrite: true,
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
        agentId: "writer",
        agentProfileId: "writer",
        delegateTool: "delegate_writer",
        entrypoint: "delegate",
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
            toolName: "spawn_agent",
            arguments: {
              goal: "Read README.md.",
              role: "reader",
              prompt: "Read only.",
              allowedTools: ["read_file"],
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
        agentId: "dynamic_reader",
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
            toolName: "delegate_runner",
            arguments: { goal: "Run a tiny shell command." },
          },
        ],
      },
      {
        toolCalls: [
          {
            toolName: "shell",
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
          shell: { sandbox: { mode: "off" } },
          capabilities: {
            agents: {
              profiles: [
                { id: "main", mode: "primary" },
                {
                  id: "runner",
                  name: "Runner",
                  mode: "child",
                  prompt: "Run the requested shell command.",
                  use: ["shell"],
                  allowedTools: ["shell"],
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
      expect(approval.payload).toMatchObject({
        details: {
          toolName: "shell",
          arguments: { command: "printf child-shell" },
        },
      });
      pair.clientSend({
        envelope: "request",
        id: "approve",
        kind: "approval.resolve",
        timestamp: TIMESTAMP,
        payload: {
          approvalId: approval.payload.approvalId,
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
      expect(childTrace).toContain('"toolName":"shell"');
      expect(childTrace).toContain("child-shell");
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
            toolName: "apply_patch",
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
                  frequency: "always",
                  injectOutput: "onFailure",
                },
                stopGate: {
                  enabled: true,
                  requireCleanAfterLastWrite: true,
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
          permissionMode: "accept_edits",
          shouldWrite: true,
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
      const verification = events.find(
        (event) =>
          event.type === "workflow_hook.completed" &&
          (event.payload as { hookName?: string }).hookName ===
            "verification:fast:unit",
      );
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
            rejectCompleted(
              new Error(
                (message.payload as { error?: { message?: string } }).error
                  ?.message ?? "run failed",
              ),
            );
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
