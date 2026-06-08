import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type HostMessage } from "@sparkwright/protocol";
import type { SparkwrightEvent } from "@sparkwright/core";
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
          traceLevel: "minimal",
          metadata: { source: "test", traceLevel: "minimal", ticket: "T-1" },
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
        traceLevel: "minimal",
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
        hasMessage: true,
      });
      expect(
        (modelCompleted?.payload as Record<string, unknown> | undefined)
          ?.toolCallCount,
      ).toEqual(expect.any(Number));
      expect(
        (modelCompleted?.payload as Record<string, unknown> | undefined)
          ?.message,
      ).toBeUndefined();
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

  it("continues a resumed run through the todo supervisor when the ledger is unfinished", async () => {
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
      const continuation = await pair.waitFor(
        (m) => m.envelope === "event" && m.kind === "run.continuation",
      );
      expect(continuation).toMatchObject({
        envelope: "event",
        kind: "run.continuation",
        payload: {
          previousRunId: runId,
          continuationCount: 1,
          reason: "unfinished_todo",
        },
      });
      const completed = await pair.waitFor(
        (m) => m.envelope === "event" && m.kind === "run.completed",
      );
      expect(completed).toMatchObject({
        envelope: "event",
        kind: "run.completed",
        payload: {
          state: "completed",
          todoHandoff: { reason: "stalled_without_progress" },
        },
      });
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
      expect(
        events.some(
          (event) =>
            event.type === "mcp.server.prepared" &&
            (event.payload as { name?: string; status?: string }).name ===
              "disabled" &&
            (event.payload as { status?: string }).status === "disabled",
        ),
      ).toBe(true);
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
          capabilities: {
            tools: {
              disabled: ["shell"],
              defer: ["delegate_*"],
            },
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
          skills: {
            loaded: [],
          },
          mcp: {
            statuses: [
              { serverName: "disabled", status: "disabled", toolNames: [] },
              {
                serverName: "missing",
                status: "failed",
                toolNames: [],
                errorCode: "MCP_SERVER_COMMAND_NOT_FOUND",
                errorPhase: "connect",
                errorMessage: expect.stringContaining("ENOENT"),
              },
            ],
          },
          agents: {
            profiles: [
              { id: "main", mode: "primary" },
              { id: "reviewer", name: "Reviewer", mode: "child" },
            ],
          },
        },
      });
      if (resp.envelope === "response" && resp.ok) {
        expect(
          (
            resp.result as { skills: { indexed: Array<{ name: string }> } }
          ).skills.indexed.some((skill) => skill.name === "reviewer"),
        ).toBe(true);
        expect(
          (resp.result.tools as Array<{ name: string }>).some(
            (tool) => tool.name === "read_file",
          ),
        ).toBe(true);
        expect(
          (resp.result.tools as Array<{ name: string }>).some(
            (tool) => tool.name === "delegate_reviewer",
          ),
        ).toBe(true);
        expect(
          (resp.result.tools as Array<{ name: string }>).some(
            (tool) => tool.name === "spawn_agent",
          ),
        ).toBe(true);
        expect(
          (resp.result.tools as Array<{ name: string }>).some(
            (tool) => tool.name === "manage_skill",
          ),
        ).toBe(true);
        expect(
          (resp.result.tools as Array<{ name: string }>).some(
            (tool) => tool.name === "manage_agent",
          ),
        ).toBe(true);
        expect(
          (resp.result.tools as Array<{ name: string }>).some(
            (tool) => tool.name === "inspect_skills",
          ),
        ).toBe(true);
        expect(
          (resp.result.tools as Array<{ name: string }>).some(
            (tool) => tool.name === "inspect_agents",
          ),
        ).toBe(true);
        expect(
          (resp.result.tools as Array<{ name: string }>).some(
            (tool) => tool.name === "shell",
          ),
        ).toBe(false);
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
    try {
      const runtime = new HostRuntime({
        workspaceRoot: workspace,
        defaultModel: "deterministic",
        emit: () => {},
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
      // Let the winning run drain its async work so the test exits cleanly.
      await new Promise((resolve) => setTimeout(resolve, 50));
      runtime.cleanup();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
