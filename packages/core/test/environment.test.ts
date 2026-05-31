import { describe, expect, it } from "vitest";

import {
  createWorkspaceShellPolicy,
  createShellExecutionTool,
  LocalProcessEnvironment,
} from "../src/environment.js";
import { createRunId } from "../src/ids.js";
import { createToolCall, executeTool, ToolRegistry } from "../src/tools.js";

describe("LocalProcessEnvironment", () => {
  it("denies shell execution by default", async () => {
    const environment = new LocalProcessEnvironment();

    const result = await environment.executeShell({
      command: "npm",
      args: ["test"],
      cwd: "/workspace",
      env: { NODE_ENV: "test" },
      metadata: { runId: "run_123" },
    });

    expect(result.status).toBe("denied");
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("denied by default");
    expect(result.metadata).toMatchObject({
      environmentId: "local-process",
      safetyDecision: "deny",
      safetyReason: "Shell execution is denied by default.",
      policy: { source: "LocalProcessEnvironment.defaultPolicy" },
      request: {
        command: "npm",
        args: ["test"],
        cwd: "/workspace",
        envKeys: ["NODE_ENV"],
        runId: "run_123",
      },
    });
    expect(Number.isNaN(Date.parse(result.startedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(result.completedAt))).toBe(false);
  });

  it("passes policy-ready metadata into a configured executor", async () => {
    const environment = new LocalProcessEnvironment({
      id: "test-local",
      policy(_request, context) {
        expect(context).toMatchObject({
          action: "shell.execute",
          resource: {
            kind: "shell",
            name: "echo",
            metadata: {
              environmentId: "test-local",
              environmentKind: "local-process",
            },
          },
          metadata: {
            command: "echo",
            args: ["hello"],
            hasStdin: false,
            envKeys: [],
            toolCallId: "tool_123",
          },
        });

        return {
          decision: "allow",
          reason: "Allowed by test policy.",
          metadata: { policyId: "unit-test" },
        };
      },
      executor(request, context) {
        return {
          status: "completed",
          exitCode: 0,
          stdout: request.args?.join(" ") ?? "",
          stderr: "",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:00.001Z",
          metadata: {
            action: context.action,
            policySubject: context.resource.name,
          },
        };
      },
    });

    const result = await environment.executeShell({
      command: "echo",
      args: ["hello"],
      metadata: { toolCallId: "tool_123" },
    });

    expect(result).toEqual({
      status: "completed",
      exitCode: 0,
      stdout: "hello",
      stderr: "",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:00.001Z",
      metadata: {
        action: "shell.execute",
        policySubject: "echo",
      },
    });
  });

  it("describes the safety boundary without exposing process execution", () => {
    const environment = new LocalProcessEnvironment({
      metadata: { host: "developer-machine" },
    });

    expect(environment.describe()).toEqual({
      id: "local-process",
      kind: "local-process",
      capabilities: ["shell.execute"],
      safety: {
        defaultDecision: "deny",
        policyAction: "shell.execute",
        approvalReady: true,
      },
      metadata: { host: "developer-machine" },
    });
  });

  it("rejects malformed shell requests before policy evaluation", async () => {
    let policyCalls = 0;
    const environment = new LocalProcessEnvironment({
      policy() {
        policyCalls += 1;
        return { decision: "allow", reason: "unused" };
      },
    });

    await expect(environment.executeShell({ command: "  " })).rejects.toThrow(
      "non-empty command",
    );
    await expect(
      environment.executeShell({ command: "npm", timeoutMs: 0 }),
    ).rejects.toThrow("positive number");
    expect(policyCalls).toBe(0);
  });

  it("contains shell cwd and absolute path arguments to allowed roots", async () => {
    const environment = new LocalProcessEnvironment({
      policy: createWorkspaceShellPolicy({
        workspaceRoot: "/workspace",
        allowCommands: ["cat"],
      }),
      executor(request) {
        return {
          status: "completed",
          exitCode: 0,
          stdout: request.cwd ?? "",
          stderr: "",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:00.001Z",
          metadata: {},
        };
      },
    });

    await expect(
      environment.executeShell({ command: "cat", args: ["/etc/passwd"] }),
    ).resolves.toMatchObject({
      status: "denied",
      stderr: "Shell argument path escapes allowed roots: /etc/passwd",
    });

    await expect(
      environment.executeShell({ command: "cat", cwd: "/tmp" }),
    ).resolves.toMatchObject({
      status: "denied",
      stderr: "Shell cwd escapes allowed roots: /tmp",
    });

    await expect(
      environment.executeShell({
        command: "cat",
        cwd: "/workspace",
        args: ["/workspace/README.md"],
      }),
    ).resolves.toMatchObject({
      status: "completed",
      stdout: "/workspace",
    });
  });

  it("exposes shell execution as a governed tool", async () => {
    const environment = new LocalProcessEnvironment({
      id: "tool-env",
      policy() {
        return {
          decision: "allow",
          reason: "Allowed by test.",
        };
      },
      executor(request) {
        return {
          status: "completed",
          exitCode: 0,
          stdout: request.command,
          stderr: "",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:00.001Z",
          metadata: {},
        };
      },
    });
    const tool = createShellExecutionTool(environment, {
      requiresApproval: false,
    });
    const registry = new ToolRegistry();
    registry.register(tool);

    expect(registry.listDescriptors()[0]).toMatchObject({
      name: "shell.execute",
      policy: {
        risk: "risky",
        requiresApproval: false,
      },
      governance: {
        sideEffects: ["external"],
        dataSensitivity: "confidential",
        idempotency: "non_idempotent",
        audit: { level: "metadata" },
      },
    });

    const result = await executeTool(
      registry,
      createToolCall(createRunId(), "shell.execute", { command: "echo" }),
      {
        run: {
          id: createRunId(),
          goal: "test",
          state: "running",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          metadata: {},
        },
      },
    );

    expect(result).toMatchObject({
      status: "completed",
      output: {
        status: "completed",
        stdout: "echo",
      },
    });
  });
});
