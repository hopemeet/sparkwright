import { describe, expect, it } from "vitest";
import { createRunId, defineTool, type ModelAdapter } from "@sparkwright/core";
import {
  ApprovalBroker,
  ServerCapabilityRegistry,
  ConnectionHub,
  RunManager,
  SessionManager,
  createServerRuntime,
} from "../src/index.js";

describe("server-runtime", () => {
  it("fans out run events through filtered subscriptions", async () => {
    const hub = new ConnectionHub();
    const seen: string[] = [];
    hub.subscribe({ eventTypes: ["run.completed"] }, (message) => {
      seen.push(message.type);
    });

    const runs = new RunManager({ hub });
    const run = runs.createRun({
      goal: "finish",
      model: finalModel("done"),
    });

    await runs.startRun(run.record.id);

    expect(seen).toEqual(["run.event"]);
    expect(
      hub.replay({ runIds: [run.record.id] }).map((message) => message.type),
    ).toContain("run.result");
  });

  it("bridges InteractionChannel approvals through the approval broker", async () => {
    const hub = new ConnectionHub();
    const broker = new ApprovalBroker({ hub });
    const requested: string[] = [];
    hub.subscribe({ types: ["interaction.requested"] }, (message) => {
      const metadata = message.metadata;
      if (metadata.interactionKind === "approval") {
        requested.push(String(metadata.interactionId));
      }
    });

    const channel = broker.createInteractionChannel();
    const approval = channel.approve?.({
      id: "approval_test" as never,
      runId: createRunId(),
      action: "workspace.write",
      summary: "Write README",
      details: {},
      createdAt: new Date().toISOString(),
      status: "pending",
    });

    expect(requested).toEqual(["approval_test"]);
    expect(
      broker.resolveApproval({
        approvalId: "approval_test",
        decision: "approved",
      }),
    ).toBe(true);
    await expect(approval).resolves.toMatchObject({
      approvalId: "approval_test",
      decision: "approved",
    });
  });

  it("creates sessions and associates managed runs", async () => {
    const hub = new ConnectionHub();
    const sessions = new SessionManager({ hub });
    const runs = new RunManager({ hub, sessionManager: sessions });
    const session = await sessions.createSession({
      metadata: { user: "test" },
    });

    const run = runs.createRun({
      sessionId: session.id,
      goal: "finish",
      model: finalModel("done"),
    });

    const updated = await sessions.getSession(session.id);
    expect(updated?.runIds).toEqual([run.record.id]);
  });

  it("mounts registered tool capabilities onto managed runs", async () => {
    const hub = new ConnectionHub();
    const capabilities = new ServerCapabilityRegistry(hub);
    capabilities.registerTool(
      defineTool({
        name: "echo",
        description: "Echo input.",
        inputSchema: { type: "object" },
        execute(args: unknown) {
          return args;
        },
      }),
    );

    const runs = new RunManager({ hub, capabilities });
    const run = runs.createRun({
      goal: "use tool",
      maxSteps: 2,
      model: {
        async complete(input) {
          if (input.step === 1) {
            expect(input.tools.map((tool) => tool.name)).toContain("echo");
            return {
              toolCalls: [{ toolName: "echo", arguments: { text: "hi" } }],
            };
          }
          return { message: "done" };
        },
      },
    });

    await expect(runs.startRun(run.record.id)).resolves.toMatchObject({
      signal: "completed",
    });
  });

  it("does not override an explicit core approval resolver", async () => {
    const hub = new ConnectionHub();
    const broker = new ApprovalBroker({ hub });
    const runs = new RunManager({ hub, approvalBroker: broker });
    const run = runs.createRun({
      goal: "approval",
      model: finalModel("done"),
      approvalResolver(request) {
        return {
          approvalId: request.id,
          decision: "approved",
        };
      },
    });

    await expect(
      run.requestApproval({
        action: "workspace.write",
        summary: "Write file",
      }),
    ).resolves.toBe(true);
    expect(broker.pending()).toEqual([]);
  });

  it("creates a complete runtime bundle", () => {
    const runtime = createServerRuntime();

    expect(runtime.hub).toBeInstanceOf(ConnectionHub);
    expect(runtime.approvals).toBeInstanceOf(ApprovalBroker);
    expect(runtime.sessions).toBeInstanceOf(SessionManager);
    expect(runtime.capabilities).toBeInstanceOf(ServerCapabilityRegistry);
    expect(runtime.runs).toBeInstanceOf(RunManager);
  });
});

function finalModel(message: string): ModelAdapter {
  return {
    async complete() {
      return { message };
    },
  };
}
