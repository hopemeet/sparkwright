import { describe, expect, it } from "vitest";
import { Client } from "../src/client.js";
import type { ClientTransport } from "../src/transport.js";
import { PROTOCOL_VERSION, type HostMessage } from "@sparkwright/protocol";

class FakeTransport implements ClientTransport {
  sent: HostMessage[] = [];
  private messageHandler?: (message: HostMessage) => void;
  private closeHandler?: (reason?: string) => void;

  send(message: HostMessage): void {
    this.sent.push(message);
  }

  onMessage(handler: (message: HostMessage) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (reason?: string) => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.closeHandler?.("closed by test");
  }

  receive(message: HostMessage): void {
    this.messageHandler?.(message);
  }
}

describe("@sparkwright/sdk-core Client", () => {
  it("sends a handshake request and resolves its response", async () => {
    const transport = new FakeTransport();
    const client = new Client({
      transport,
      client: { name: "test-client", version: "0.0.0" },
    });

    const handshake = client.handshake();
    const request = transport.sent[0];

    expect(request).toMatchObject({
      envelope: "request",
      kind: "handshake",
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        client: { name: "test-client", version: "0.0.0" },
      },
    });

    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-05-24T00:00:00.000Z",
      ok: true,
      result: {},
    });

    await expect(handshake).resolves.toBeUndefined();
  });

  it("emits host events from the transport", () => {
    const transport = new FakeTransport();
    const client = new Client({
      transport,
      client: { name: "test-client", version: "0.0.0" },
    });
    const readyEvents: HostMessage[] = [];

    client.on("host.ready", (event) => readyEvents.push(event));
    transport.receive({
      envelope: "event",
      id: "evt_1",
      kind: "host.ready",
      timestamp: "2026-05-24T00:00:00.000Z",
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        host: { name: "sparkwright-host", version: "0.1.0" },
      },
    });

    expect(readyEvents).toHaveLength(1);
    expect(readyEvents[0]).toMatchObject({
      envelope: "event",
      kind: "host.ready",
    });
  });

  it("emits typed task lifecycle events from the transport", () => {
    const transport = new FakeTransport();
    const client = new Client({
      transport,
      client: { name: "test-client", version: "0.0.0" },
    });
    const updates: Array<{ taskId: string; status: string }> = [];

    client.on("task.updated", (event) => {
      updates.push({
        taskId: event.payload.taskId,
        status: event.payload.status,
      });
    });
    transport.receive({
      envelope: "event",
      id: "evt_task_1",
      kind: "task.updated",
      timestamp: "2026-05-24T00:00:02.000Z",
      payload: {
        taskId: "task_1",
        parentRunId: "run_1",
        sessionId: "session_1",
        transition: "terminal",
        kind: "agent",
        completionPolicy: "detached",
        awaited: false,
        status: "completed",
        createdAt: "2026-05-24T00:00:00.000Z",
        completedAt: "2026-05-24T00:00:01.000Z",
        resultSummary: "done",
        outputRef: { method: "task.output", taskId: "task_1" },
      },
    });

    expect(updates).toEqual([{ taskId: "task_1", status: "completed" }]);
  });

  it("sends run.inject_message requests", async () => {
    const transport = new FakeTransport();
    const client = new Client({
      transport,
      client: { name: "test-client", version: "0.0.0" },
    });

    const injected = client.injectRunMessage({
      runId: "run_1",
      commandId: "command_1",
      mode: "steer",
      content: "please include tests",
      metadata: { source: "telegram" },
    });
    const request = transport.sent[0];

    expect(request).toMatchObject({
      envelope: "request",
      kind: "run.inject_message",
      payload: {
        runId: "run_1",
        commandId: "command_1",
        mode: "steer",
        content: "please include tests",
        metadata: { source: "telegram" },
      },
    });

    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-05-24T00:00:00.000Z",
      ok: true,
      result: {
        commandId: "command_1",
        mode: "steer",
        status: "queued",
      },
    });

    await expect(injected).resolves.toEqual({
      commandId: "command_1",
      mode: "steer",
      status: "queued",
    });
  });

  it("sends session.inspect requests", async () => {
    const transport = new FakeTransport();
    const client = new Client({
      transport,
      client: { name: "test-client", version: "0.0.0" },
    });

    const inspected = client.inspectSession({ sessionId: "session_1" });
    const request = transport.sent[0];

    expect(request).toMatchObject({
      envelope: "request",
      kind: "session.inspect",
      payload: { sessionId: "session_1" },
    });

    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-05-24T00:00:00.000Z",
      ok: true,
      result: {
        sessionId: "session_1",
        summary: { eventCount: 1 },
        consistency: { ok: true },
        timeline: { phases: [] },
      },
    });

    await expect(inspected).resolves.toMatchObject({
      sessionId: "session_1",
      summary: { eventCount: 1 },
    });
  });

  it("sends capability.inspect requests", async () => {
    const transport = new FakeTransport();
    const client = new Client({
      transport,
      client: { name: "test-client", version: "0.0.0" },
    });

    const inspected = client.inspectCapabilities();
    const request = transport.sent[0];

    expect(request).toMatchObject({
      envelope: "request",
      kind: "capability.inspect",
      payload: {},
    });

    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-05-24T00:00:00.000Z",
      ok: true,
      result: {
        tools: [{ name: "read", risk: "safe" }],
        skills: { indexed: [], loaded: [] },
        mcp: { statuses: [] },
        agents: { profiles: [{ id: "main", mode: "primary" }] },
      },
    });

    await expect(inspected).resolves.toMatchObject({
      tools: [{ name: "read" }],
      agents: { profiles: [{ id: "main" }] },
    });
  });

  it("sends provider catalog and non-secret auth profile requests", async () => {
    const transport = new FakeTransport();
    const client = new Client({
      transport,
      client: { name: "test-client", version: "0.0.0" },
    });

    const listed = client.listProviders({ model: "openai/gpt-test" });
    let request = transport.sent[0];
    expect(request).toMatchObject({
      envelope: "request",
      kind: "provider.list",
      payload: { model: "openai/gpt-test" },
    });
    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-08-08T00:00:00.000Z",
      ok: true,
      result: { selectedModel: "openai/gpt-test", providers: [] },
    });
    await expect(listed).resolves.toEqual({
      selectedModel: "openai/gpt-test",
      providers: [],
    });

    const refreshed = client.refreshProviderCatalog({ providerId: "openai" });
    request = transport.sent[1];
    expect(request).toMatchObject({
      envelope: "request",
      kind: "provider.catalog.refresh",
      payload: { providerId: "openai" },
    });
    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-08-08T00:00:00.000Z",
      ok: true,
      result: {
        status: "updated",
        refreshedProviders: ["openai"],
        catalogState: { generation: 1, source: "discovery", stale: false },
      },
    });
    await expect(refreshed).resolves.toMatchObject({
      status: "updated",
      catalogState: { generation: 1 },
    });

    const login = client.loginProvider({ profileId: "credential_1" });
    request = transport.sent[2];
    expect(request).toMatchObject({
      envelope: "request",
      kind: "provider.auth.login",
      payload: { profileId: "credential_1" },
    });
    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-08-08T00:00:00.000Z",
      ok: true,
      result: {
        profile: {
          id: "credential_1",
          providerId: "openai",
          status: "ready",
          generation: 1,
        },
      },
    });
    await expect(login).resolves.toMatchObject({
      profile: { id: "credential_1", status: "ready", generation: 1 },
    });
  });

  it("forwards provider method, secret, and connection mutation requests", async () => {
    const transport = new FakeTransport();
    const client = new Client({
      transport,
      client: { name: "test-client", version: "0.0.0" },
    });
    const binding = {
      providerId: "openai",
      driverId: "ai-sdk-openai.v1",
      endpoint: "https://api.openai.com/v1",
      endpointFingerprint: "endpoint_hash",
      authMethodId: "api_key",
    };

    const methods = client.listProviderAuthMethods({
      providerId: "openai",
      endpoint: "https://gateway.example/v1",
    });
    let request = transport.sent[0]!;
    expect(request).toMatchObject({
      kind: "provider.auth.methods",
      payload: {
        providerId: "openai",
        endpoint: "https://gateway.example/v1",
      },
    });
    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-08-09T00:00:00.000Z",
      ok: true,
      result: {
        providerId: "openai",
        binding,
        methods: [{ id: "api_key", type: "api_key", label: "API key" }],
      },
    });
    await expect(methods).resolves.toMatchObject({ providerId: "openai" });

    const submitted = client.submitProviderSecret({
      providerId: "openai",
      methodId: "api_key",
      endpoint: "https://gateway.example/v1",
      secret: "sdk-secret-sentinel",
      grantScope: "workspace",
    });
    request = transport.sent[1]!;
    expect(request).toMatchObject({
      kind: "provider.auth.submit_secret",
      payload: {
        providerId: "openai",
        methodId: "api_key",
        endpoint: "https://gateway.example/v1",
        secret: "sdk-secret-sentinel",
        grantScope: "workspace",
      },
    });
    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-08-09T00:00:00.000Z",
      ok: true,
      result: {
        connection: {
          id: "connection_1",
          providerId: "openai",
          status: "unverified",
          source: "stored",
          sourceLabel: "credential store",
          binding,
          selected: true,
          grantScope: "workspace",
          generation: 1,
        },
        revision: 1,
      },
    });
    await expect(submitted).resolves.toMatchObject({
      connection: { id: "connection_1" },
      revision: 1,
    });

    const selected = client.selectProviderConnection({
      connectionId: "connection_1",
      grantScope: "user",
    });
    request = transport.sent[2]!;
    expect(request).toMatchObject({
      kind: "provider.connection.select",
      payload: { connectionId: "connection_1", grantScope: "user" },
    });
    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-08-09T00:00:00.000Z",
      ok: true,
      result: { connectionId: "connection_1", revision: 2 },
    });
    await expect(selected).resolves.toMatchObject({ revision: 2 });

    const actions = [
      [
        "provider.connection.disconnect",
        () =>
          client.disconnectProviderConnection({
            connectionId: "connection_1",
          }),
      ],
      [
        "provider.connection.logout",
        () => client.logoutProviderConnection({ connectionId: "connection_1" }),
      ],
      [
        "provider.connection.remove",
        () => client.removeProviderConnection({ connectionId: "connection_1" }),
      ],
      [
        "provider.connection.refresh",
        () =>
          client.refreshProviderConnection({ connectionId: "connection_1" }),
      ],
    ] as const;
    for (const [kind, call] of actions) {
      const pending = call();
      request = transport.sent.at(-1)!;
      expect(request).toMatchObject({
        kind,
        payload: { connectionId: "connection_1" },
      });
      transport.receive({
        envelope: "response",
        id: request.id,
        timestamp: "2026-08-09T00:00:00.000Z",
        ok: true,
        result: { connectionId: "connection_1", revision: 3 },
      });
      await expect(pending).resolves.toMatchObject({ revision: 3 });
    }
  });

  it("forwards OAuth attempt lifecycle requests without parallel DTOs", async () => {
    const transport = new FakeTransport();
    const client = new Client({
      transport,
      client: { name: "test-client", version: "0.0.0" },
    });
    const attempt = {
      id: "oauth_1",
      providerId: "openrouter",
      methodId: "oauth_pkce",
      flow: "browser" as const,
      status: "pending" as const,
      createdAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2026-08-09T00:10:00.000Z",
      authorizationUrl: "https://auth.example/authorize",
    };

    const begun = client.beginProviderOAuth({
      providerId: "openrouter",
      methodId: "oauth_pkce",
    });
    let request = transport.sent[0]!;
    expect(request).toMatchObject({
      kind: "provider.auth.begin",
      payload: { providerId: "openrouter", methodId: "oauth_pkce" },
    });
    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-08-09T00:00:00.000Z",
      ok: true,
      result: { attempt },
    });
    await expect(begun).resolves.toEqual({ attempt });

    const inspected = client.inspectProviderOAuth({ attemptId: attempt.id });
    request = transport.sent[1]!;
    expect(request).toMatchObject({
      kind: "provider.auth.status",
      payload: { attemptId: attempt.id },
    });
    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-08-09T00:00:01.000Z",
      ok: true,
      result: { attempt },
    });
    await expect(inspected).resolves.toEqual({ attempt });

    const completed = client.completeProviderOAuth({
      attemptId: attempt.id,
      code: "authorization-code",
      state: "oauth-state",
    });
    request = transport.sent[2]!;
    expect(request).toMatchObject({
      kind: "provider.auth.complete",
      payload: {
        attemptId: attempt.id,
        code: "authorization-code",
        state: "oauth-state",
      },
    });
    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-08-09T00:00:02.000Z",
      ok: true,
      result: { attempt: { ...attempt, status: "completed" } },
    });
    await expect(completed).resolves.toMatchObject({
      attempt: { status: "completed" },
    });

    const cancelled = client.cancelProviderOAuth({ attemptId: attempt.id });
    request = transport.sent[3]!;
    expect(request).toMatchObject({
      kind: "provider.auth.cancel",
      payload: { attemptId: attempt.id },
    });
    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-08-09T00:00:03.000Z",
      ok: true,
      result: { attempt: { ...attempt, status: "cancelled" } },
    });
    await expect(cancelled).resolves.toMatchObject({
      attempt: { status: "cancelled" },
    });
  });

  it("sends session.compact requests", async () => {
    const transport = new FakeTransport();
    const client = new Client({
      transport,
      client: { name: "test-client", version: "0.0.0" },
    });

    const compacted = client.compactSession({
      sessionId: "session_1",
      reason: "test",
    });
    const request = transport.sent[0];

    expect(request).toMatchObject({
      envelope: "request",
      kind: "session.compact",
      payload: { sessionId: "session_1", reason: "test" },
    });

    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-05-24T00:00:00.000Z",
      ok: true,
      result: {
        sessionId: "session_1",
        compactedRunCount: 2,
        throughRunId: "run_2",
        originalCharCount: 1000,
        summaryCharCount: 200,
        artifactPath: "/tmp/compact.json",
      },
    });

    await expect(compacted).resolves.toMatchObject({
      sessionId: "session_1",
      compactedRunCount: 2,
      throughRunId: "run_2",
    });
  });

  it("sends task inspection requests", async () => {
    const transport = new FakeTransport();
    const client = new Client({
      transport,
      client: { name: "test-client", version: "0.0.0" },
    });

    const listed = client.listTasks({ status: "running", limit: 5 });
    let request = transport.sent[0];
    expect(request).toMatchObject({
      envelope: "request",
      kind: "task.list",
      payload: { status: "running", limit: 5 },
    });
    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-05-24T00:00:00.000Z",
      ok: true,
      result: { tasks: [] },
    });
    await expect(listed).resolves.toEqual({ tasks: [] });

    const got = client.getTask({ taskId: "task_1" });
    request = transport.sent[1];
    expect(request).toMatchObject({
      envelope: "request",
      kind: "task.get",
      payload: { taskId: "task_1" },
    });
    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-05-24T00:00:00.000Z",
      ok: true,
      result: {
        id: "task_1",
        parentRunId: "run_1",
        kind: "shell.background",
        status: "running",
        createdAt: "2026-05-24T00:00:00.000Z",
        metadata: {},
      },
    });
    await expect(got).resolves.toMatchObject({ id: "task_1" });

    const output = client.outputTask({
      taskId: "task_1",
      fromSequence: 3,
      maxChunks: 10,
    });
    request = transport.sent[2];
    expect(request).toMatchObject({
      envelope: "request",
      kind: "task.output",
      payload: { taskId: "task_1", fromSequence: 3, maxChunks: 10 },
    });
    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-05-24T00:00:00.000Z",
      ok: true,
      result: {
        taskId: "task_1",
        chunks: [],
        nextSequence: 3,
        complete: false,
        status: "running",
        stalled: true,
      },
    });
    await expect(output).resolves.toMatchObject({ taskId: "task_1" });

    const stopped = client.stopTask({ taskId: "task_1" });
    request = transport.sent[3];
    expect(request).toMatchObject({
      envelope: "request",
      kind: "task.stop",
      payload: { taskId: "task_1" },
    });
    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-05-24T00:00:00.000Z",
      ok: true,
      result: { cancelled: true, status: "cancelled" },
    });
    await expect(stopped).resolves.toEqual({
      cancelled: true,
      status: "cancelled",
    });

    const joined = client.joinTask({ taskId: "task_1" });
    request = transport.sent[4];
    expect(request).toMatchObject({
      envelope: "request",
      kind: "task.join",
      payload: { taskId: "task_1" },
    });
    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-05-24T00:00:00.000Z",
      ok: true,
      result: { taskId: "task_1", awaited: true, status: "running" },
    });
    await expect(joined).resolves.toEqual({
      taskId: "task_1",
      awaited: true,
      status: "running",
    });

    const promoted = client.promoteTask({ taskId: "task_1" });
    request = transport.sent[5];
    expect(request).toMatchObject({
      envelope: "request",
      kind: "task.promote",
      payload: { taskId: "task_1" },
    });
    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-05-24T00:00:00.000Z",
      ok: true,
      result: {
        taskId: "task_1",
        promoted: true,
        awaited: true,
        status: "running",
      },
    });
    await expect(promoted).resolves.toEqual({
      taskId: "task_1",
      promoted: true,
      awaited: true,
      status: "running",
    });
  });

  it("sends workflow inspection and resume requests", async () => {
    const transport = new FakeTransport();
    const client = new Client({
      transport,
      client: { name: "test-client", version: "0.0.0" },
    });

    const listed = client.listWorkflowRuns({
      sessionId: "sess_1",
      status: "running",
      limit: 5,
    });
    let request = transport.sent[0];
    expect(request).toMatchObject({
      envelope: "request",
      kind: "workflow.list",
      payload: { sessionId: "sess_1", status: "running", limit: 5 },
    });
    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-07-04T00:00:00.000Z",
      ok: true,
      result: { workflows: [] },
    });
    await expect(listed).resolves.toEqual({ workflows: [] });

    const resumed = client.resumeWorkflowRun({
      workflowRunId: "workflow_1",
      sessionId: "sess_1",
      model: "deterministic",
    });
    request = transport.sent[1];
    expect(request).toMatchObject({
      envelope: "request",
      kind: "workflow.resume",
      payload: {
        workflowRunId: "workflow_1",
        sessionId: "sess_1",
        model: "deterministic",
      },
    });
    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-07-04T00:00:00.000Z",
      ok: true,
      result: {
        runId: "run_1",
        workflowRunId: "workflow_1",
        sessionId: "sess_1",
      },
    });
    await expect(resumed).resolves.toEqual({
      runId: "run_1",
      workflowRunId: "workflow_1",
      sessionId: "sess_1",
    });

    const processed = client.processWorkflowControl({
      workflowRunId: "workflow_1",
      sessionId: "sess_1",
      commandId: "workflow_command_1",
    });
    request = transport.sent[2];
    expect(request).toMatchObject({
      envelope: "request",
      kind: "workflow.control.process",
      payload: {
        workflowRunId: "workflow_1",
        sessionId: "sess_1",
        commandId: "workflow_command_1",
      },
    });
    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-07-04T00:00:00.000Z",
      ok: true,
      result: {
        status: "applied",
        commandId: "workflow_command_1",
        code: "applied",
      },
    });
    await expect(processed).resolves.toEqual({
      status: "applied",
      commandId: "workflow_command_1",
      code: "applied",
    });
  });

  it("starts a run and collects stable lifecycle evidence", async () => {
    const transport = new FakeTransport();
    const client = new Client({
      transport,
      client: { name: "test-client", version: "0.0.0" },
    });

    const collected = client.startRunAndCollect({
      goal: "inspect metadata",
    });
    const request = transport.sent[0];

    expect(request).toMatchObject({
      envelope: "request",
      kind: "run.start",
      payload: { goal: "inspect metadata" },
    });

    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-05-24T00:00:00.000Z",
      ok: true,
      result: { runId: "run_1" },
    });
    transport.receive({
      envelope: "event",
      id: "evt_1",
      kind: "run.event",
      timestamp: "2026-05-24T00:00:00.000Z",
      payload: {
        runId: "run_1",
        event: { type: "model.stream.chunk", payload: { text: "a" } },
      },
    });
    transport.receive({
      envelope: "event",
      id: "evt_2",
      kind: "run.event",
      timestamp: "2026-05-24T00:00:01.000Z",
      payload: {
        runId: "run_1",
        event: {
          type: "tool.failed",
          payload: {
            error: { code: "TOOL_ARGUMENTS_INVALID", message: "bad args" },
          },
        },
      },
    });
    transport.receive({
      envelope: "event",
      id: "evt_3",
      kind: "run.event",
      timestamp: "2026-05-24T00:00:02.000Z",
      payload: {
        runId: "run_1",
        event: { type: "artifact.created", payload: { path: "a.log" } },
      },
    });
    transport.receive({
      envelope: "event",
      id: "evt_4",
      kind: "run.event",
      timestamp: "2026-05-24T00:00:03.000Z",
      payload: {
        runId: "run_1",
        event: {
          type: "workspace.write.completed",
          payload: { path: "README.md" },
        },
      },
    });
    transport.receive({
      envelope: "event",
      id: "evt_5",
      kind: "approval.requested",
      timestamp: "2026-05-24T00:00:04.000Z",
      payload: {
        runId: "run_1",
        approvalId: "approval_1",
        action: "workspace.write",
        summary: "write README.md",
        subject: { kind: "one_shot", label: "Write README.md once" },
        principal: { kind: "main", principalScope: "session:test" },
      },
    });
    transport.receive({
      envelope: "event",
      id: "evt_6",
      kind: "run.continuation",
      timestamp: "2026-05-24T00:00:05.000Z",
      payload: {
        runId: "run_2",
        previousRunId: "run_1",
        continuationCount: 1,
        reason: "workflow_record_active",
      },
    });
    transport.receive({
      envelope: "event",
      id: "evt_7",
      kind: "run.completed",
      timestamp: "2026-05-24T00:00:06.000Z",
      payload: {
        runId: "run_2",
        state: "completed",
        stopReason: "final_answer",
        message: "done",
        assessment: executionAssessment("failing", [
          {
            code: "UNRESOLVED_TOOL_FAILURE",
            kind: "tool_failure",
            disposition: "failing",
            count: 1,
            details: { codes: ["TOOL_ARGUMENTS_INVALID"] },
          },
        ]),
      },
    });

    await expect(collected).resolves.toMatchObject({
      runId: "run_1",
      runIds: ["run_1", "run_2"],
      terminal: { payload: { runId: "run_2" } },
      finalAnswer: "done",
      assessment: {
        schemaVersion: "execution-assessment.v1",
        health: "failing",
        issues: [expect.objectContaining({ code: "UNRESOLVED_TOOL_FAILURE" })],
      },
      toolFailures: [{ type: "tool.failed" }],
      artifacts: [{ type: "artifact.created" }],
      writes: [{ type: "workspace.write.completed" }],
      approvals: [{ kind: "approval.requested" }],
    });
    await expect(collected).resolves.toMatchObject({
      runEvents: [
        { type: "tool.failed" },
        { type: "artifact.created" },
        { type: "workspace.write.completed" },
      ],
    });
  });

  it("collects canonical run.failed failures", async () => {
    const transport = new FakeTransport();
    const client = new Client({
      transport,
      client: { name: "test-client", version: "0.0.0" },
    });

    const collected = client.startRunAndCollect({
      goal: "exercise terminal failure",
    });
    const request = transport.sent[0];

    transport.receive({
      envelope: "response",
      id: request.id,
      timestamp: "2026-05-24T00:00:00.000Z",
      ok: true,
      result: { runId: "run_1" },
    });
    transport.receive({
      envelope: "event",
      id: "evt_1",
      kind: "run.failed",
      timestamp: "2026-05-24T00:00:01.000Z",
      payload: {
        runId: "run_1",
        failure: {
          category: "runtime",
          code: "internal_error",
          message: "host failed",
        },
        assessment: executionAssessment("failing", [
          {
            code: "internal_error",
            kind: "run_failure",
            disposition: "failing",
            count: 1,
          },
        ]),
      },
    });

    await expect(collected).resolves.toMatchObject({
      failure: {
        category: "runtime",
        code: "internal_error",
        message: "host failed",
      },
    });
  });

  it("sends project trust inspection and manifest-pinned mutation requests", async () => {
    const transport = new FakeTransport();
    const client = new Client({
      transport,
      client: { name: "test-client", version: "0.0.0" },
    });
    const snapshot = {
      canonicalWorkspaceRoot: "/workspace/project",
      workspaceId: "workspace_test",
      status: "untrusted" as const,
      manifestHash: "sha256:manifest",
      scopes: [
        {
          scope: "commands" as const,
          status: "untrusted" as const,
          effects: ["process" as const],
          fileCount: 1,
          byteCount: 10,
          manifestHash: "sha256:commands",
        },
      ],
    };

    const inspected = client.inspectProjectTrust();
    const inspectRequest = transport.sent.at(-1)!;
    expect(inspectRequest).toMatchObject({
      envelope: "request",
      kind: "project.trust.inspect",
      payload: {},
    });
    transport.receive({
      envelope: "response",
      id: inspectRequest.id,
      timestamp: "2026-08-08T00:00:00.000Z",
      ok: true,
      result: snapshot,
    });
    await expect(inspected).resolves.toEqual(snapshot);

    const granted = client.grantProjectTrust({
      expectedManifestHash: snapshot.manifestHash,
      scopes: ["commands"],
    });
    const grantRequest = transport.sent.at(-1)!;
    expect(grantRequest).toMatchObject({
      envelope: "request",
      kind: "project.trust.grant",
      payload: {
        expectedManifestHash: "sha256:manifest",
        scopes: ["commands"],
      },
    });
    transport.receive({
      envelope: "response",
      id: grantRequest.id,
      timestamp: "2026-08-08T00:00:01.000Z",
      ok: true,
      result: snapshot,
    });
    await expect(granted).resolves.toEqual(snapshot);

    const revoked = client.revokeProjectTrust({ scopes: ["commands"] });
    const revokeRequest = transport.sent.at(-1)!;
    expect(revokeRequest).toMatchObject({
      envelope: "request",
      kind: "project.trust.revoke",
      payload: { scopes: ["commands"] },
    });
    transport.receive({
      envelope: "response",
      id: revokeRequest.id,
      timestamp: "2026-08-08T00:00:02.000Z",
      ok: true,
      result: snapshot,
    });
    await expect(revoked).resolves.toEqual(snapshot);
  });
});

function executionAssessment(
  health: "clean" | "degraded" | "failing",
  issues: Array<{
    code: string;
    kind: string;
    disposition: "degraded" | "failing";
    count: number;
    details?: Record<string, unknown>;
  }> = [],
) {
  return {
    schemaVersion: "execution-assessment.v1" as const,
    health,
    issues,
    verification: [],
    episodeCount: 0,
    episodes: [],
  };
}
