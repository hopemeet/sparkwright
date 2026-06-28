import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRunId,
  defineTool,
  EventLog,
  runWorkflowHooks,
} from "@sparkwright/core";
import {
  createPlatformShellSandboxRuntime,
  type ShellSandboxRuntime,
} from "@sparkwright/shell-sandbox";
import {
  bindConfiguredEventHooks,
  createConfiguredWorkflowHooks,
  createVerificationWorkflowHooks,
} from "../src/index.js";

function runRecord() {
  const now = new Date().toISOString();
  return {
    id: createRunId(),
    goal: "g",
    state: "running" as const,
    createdAt: now,
    updatedAt: now,
    metadata: {},
  };
}

async function waitForEvent(events: EventLog, type: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (events.all().some((event) => event.type === type)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${type}`);
}

describe("createConfiguredWorkflowHooks", () => {
  it("keeps configured workflow hooks in the awaited workflow hook lane", () => {
    const hooks = createConfiguredWorkflowHooks({
      workspaceRoot: process.cwd(),
      hooks: [
        {
          name: "awaited-check",
          hook: "PostToolUse",
          action: {
            type: "command",
            command: process.execPath,
            args: ["-e", "process.exit(0)"],
          },
        },
      ],
    });

    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({
      name: "awaited-check",
      hook: "PostToolUse",
    });
  });

  it("binds event command hooks through non-blocking user hook events", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-event-hook-"));
    try {
      const record = runRecord();
      const events = new EventLog(record.id);
      const controller = new AbortController();
      const unsubscribe = bindConfiguredEventHooks({
        workspaceRoot: workspace,
        run: {
          record,
          events,
          abortSignal: controller.signal,
        } as never,
        hooks: [
          {
            name: "record-write",
            trigger: "tool.completed",
            matcher: { toolName: "apply_patch", status: "completed" },
            action: {
              type: "command",
              command: process.execPath,
              args: ["-e", "console.log('observed')"],
            },
          },
        ],
      });

      events.emit("tool.completed", {
        toolName: "apply_patch",
        toolCallId: "call_1",
      });
      await waitForEvent(events, "user_hook.completed");
      unsubscribe();

      expect(events.all().map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "user_hook.invoked",
          "extension.process.started",
          "extension.process.completed",
          "user_hook.completed",
        ]),
      );
      expect(
        events.all().find((event) => event.type === "extension.process.started")
          ?.payload,
      ).toMatchObject({ kind: "user_hook", name: "record-write" });
      expect(
        events.all().some((event) => event.type === "workflow_hook.blocked"),
      ).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("converts block actions into blocking WorkflowHooks", async () => {
    const run = runRecord();
    const events = new EventLog(run.id);
    const hooks = createConfiguredWorkflowHooks({
      workspaceRoot: process.cwd(),
      hooks: [
        {
          name: "block-generated",
          hook: "PreToolUse",
          matcher: { toolName: "write_file", pathGlob: "generated/**" },
          action: { type: "block", reason: "Generated files are locked." },
        },
      ],
    });

    const result = await runWorkflowHooks({
      hooks,
      hook: "PreToolUse",
      run,
      payload: { toolName: "write_file", path: "generated/a.ts" },
      events,
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") {
      throw new Error("expected blocked workflow hook result");
    }
    expect(result.block.reason).toBe("Generated files are locked.");
  });

  it("converts context actions into injected ContextItems", async () => {
    const run = runRecord();
    const events = new EventLog(run.id);
    const hooks = createConfiguredWorkflowHooks({
      workspaceRoot: process.cwd(),
      hooks: [
        {
          name: "session-context",
          hook: "RunStart",
          action: {
            type: "context",
            content: "Always run tests before final answer.",
            contextType: "system",
          },
        },
      ],
    });

    const result = await runWorkflowHooks({
      hooks,
      hook: "RunStart",
      run,
      payload: {},
      events,
    });

    expect(result.status).toBe("continued");
    expect(result.context[0]).toMatchObject({
      type: "system",
      content: "Always run tests before final answer.",
    });
  });

  it("can block on command action failures", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-hook-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: workspace,
        hooks: [
          {
            name: "failing-check",
            hook: "Stop",
            action: {
              type: "command",
              command: process.execPath,
              args: ["-e", "console.error('nope'); process.exit(3)"],
              blockOnFailure: true,
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        payload: {},
        events,
      });

      expect(result.status).toBe("blocked");
      if (result.status !== "blocked") {
        throw new Error("expected blocked workflow hook result");
      }
      expect(result.block.reason).toContain("exit code 3");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("can use command stdout JSON as a WorkflowHookResult", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-hook-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: workspace,
        hooks: [
          {
            name: "json-check",
            hook: "Stop",
            action: {
              type: "command",
              command: process.execPath,
              args: [
                "-e",
                [
                  "process.stderr.write(",
                  "  process.env.SPARKWRIGHT_EVENT_TOKEN + ': ' +",
                  "  JSON.stringify({type:'progress', message:'checking policy'}) + '\\n');",
                  "console.log(JSON.stringify({status:'block', reason:'no ship', metadata:{source:'script'}}));",
                ].join("\n"),
              ],
              resultMode: "stdoutJson",
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        payload: {},
        events,
      });

      expect(result.status).toBe("blocked");
      if (result.status !== "blocked") {
        throw new Error("expected blocked workflow hook result");
      }
      expect(result.block.reason).toBe("no ship");
      expect(result.block.metadata).toMatchObject({
        source: "script",
        actionResult: { exitCode: 0 },
      });
      expect(events.all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "extension.process.progress",
            payload: expect.objectContaining({
              channel: "event",
              message: "checking policy",
            }),
          }),
          expect.objectContaining({
            type: "extension.process.completed",
            payload: expect.objectContaining({
              output: expect.not.objectContaining({
                stderrPreview: expect.stringContaining("SPARKWRIGHT_EVENT"),
              }),
            }),
          }),
        ]),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("can use HTTP response JSON as a WorkflowHookResult", async () => {
    const seenBodies: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        seenBodies.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            status: "block",
            reason: "http says no",
            metadata: { source: "http" },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address() as AddressInfo;
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: process.cwd(),
        http: {
          enabled: true,
          allow: [{ origin: `http://127.0.0.1:${address.port}` }],
          allowPrivateNetwork: true,
        },
        hooks: [
          {
            name: "http-check",
            hook: "Stop",
            action: {
              type: "http",
              url: `http://127.0.0.1:${address.port}/hook`,
              resultMode: "responseJson",
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        payload: { message: "ship?" },
        events,
      });

      expect(result.status).toBe("blocked");
      if (result.status !== "blocked") {
        throw new Error("expected blocked workflow hook result");
      }
      expect(result.block.reason).toBe("http says no");
      expect(result.block.metadata).toMatchObject({
        source: "http",
        actionResult: {
          hookName: "http-check",
          hook: "Stop",
          status: 200,
          ok: true,
        },
      });
      expect(seenBodies[0]).toMatchObject({
        hook: "Stop",
        run: { id: run.id, state: "running" },
      });
      expect(
        (seenBodies[0] as Record<string, unknown>).payload,
      ).toBeUndefined();
      expect(
        (seenBodies[0] as { run?: Record<string, unknown> }).run?.goal,
      ).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("requires explicit HTTP hook enablement before fetching", async () => {
    const run = runRecord();
    const events = new EventLog(run.id);
    const hooks = createConfiguredWorkflowHooks({
      workspaceRoot: process.cwd(),
      hooks: [
        {
          name: "http-disabled",
          hook: "Stop",
          onError: "block",
          action: {
            type: "http",
            url: "https://example.com/hook",
          },
        },
      ],
    });

    const result = await runWorkflowHooks({
      hooks,
      hook: "Stop",
      run,
      payload: {},
      events,
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") {
      throw new Error("expected blocked workflow hook result");
    }
    expect(result.block.reason).toContain("HTTP hook actions are disabled");
  });

  it("blocks link-local HTTP hook targets even when private network is allowed", async () => {
    const run = runRecord();
    const events = new EventLog(run.id);
    const hooks = createConfiguredWorkflowHooks({
      workspaceRoot: process.cwd(),
      http: {
        enabled: true,
        allow: [{ origin: "http://169.254.169.254" }],
        allowPrivateNetwork: true,
      },
      hooks: [
        {
          name: "metadata-http",
          hook: "Stop",
          onError: "block",
          action: {
            type: "http",
            url: "http://169.254.169.254/latest/meta-data",
          },
        },
      ],
    });

    const result = await runWorkflowHooks({
      hooks,
      hook: "Stop",
      run,
      payload: {},
      events,
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") {
      throw new Error("expected blocked workflow hook result");
    }
    expect(result.block.reason).toContain("blocked link-local address");
  });

  it("does not follow HTTP hook redirects to other hosts", async () => {
    const server = createServer((_req, res) => {
      // A followed redirect would pivot to a blocked link-local address.
      res.writeHead(302, {
        location: "http://169.254.169.254/latest/meta-data",
      });
      res.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address() as AddressInfo;
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: process.cwd(),
        http: {
          enabled: true,
          allow: [{ origin: `http://127.0.0.1:${address.port}` }],
          allowPrivateNetwork: true,
        },
        hooks: [
          {
            name: "http-redirect",
            hook: "Stop",
            action: {
              type: "http",
              url: `http://127.0.0.1:${address.port}/hook`,
              blockOnFailure: true,
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        payload: {},
        events,
      });

      // The 302 itself is surfaced as a failed (non-2xx) response. If the
      // redirect had been followed we'd see a connect error to 169.254, not a
      // clean status 302.
      expect(result.status).toBe("blocked");
      if (result.status !== "blocked") {
        throw new Error("expected blocked workflow hook result");
      }
      expect(result.block.reason).toContain("status 302");
      expect(result.block.metadata).toMatchObject({ status: 302, ok: false });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("can use agent workflowResult output as a WorkflowHookResult", async () => {
    const run = runRecord();
    const events = new EventLog(run.id);
    const controller = new AbortController();
    const parentRun = {
      record: run,
      events,
      abortSignal: controller.signal,
    } as never;
    const agentTool = defineTool<Record<string, unknown>, unknown>({
      name: "delegate_agent",
      description: "Delegate to a configured agent",
      inputSchema: { type: "object" },
      policy: { risk: "safe" },
      execute: (args, ctx) => {
        expect(args).toMatchObject({
          agentId: "reviewer",
          goal: "review final answer",
        });
        expect(ctx.run.id).toBe(run.id);
        return {
          status: "block",
          reason: "agent says no",
          metadata: { source: "agent" },
        };
      },
    });
    const hooks = createConfiguredWorkflowHooks({
      workspaceRoot: process.cwd(),
      getRun: () => parentRun,
      agentTool,
      hooks: [
        {
          name: "agent-check",
          hook: "Stop",
          action: {
            type: "agent",
            agentId: "reviewer",
            goal: "review final answer",
            resultMode: "workflowResult",
          },
        },
      ],
    });

    const result = await runWorkflowHooks({
      hooks,
      hook: "Stop",
      run,
      payload: {},
      events,
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") {
      throw new Error("expected blocked workflow hook result");
    }
    expect(result.block.reason).toBe("agent says no");
    expect(result.block.metadata).toMatchObject({
      source: "agent",
      actionResult: {
        hookName: "agent-check",
        hook: "Stop",
        agentId: "reviewer",
        goal: "review final answer",
      },
    });
  });

  it("can use command stdout JSON to rewrite PreToolUse arguments", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-hook-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: workspace,
        hooks: [
          {
            name: "json-rewrite",
            hook: "PreToolUse",
            action: {
              type: "command",
              command: process.execPath,
              args: [
                "-e",
                "console.log(JSON.stringify({status:'rewrite', patch:{arguments:{command:'npm test'}}}))",
              ],
              resultMode: "stdoutJson",
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "PreToolUse",
        run,
        payload: { toolName: "shell", arguments: { command: "npm t" } },
        events,
      });

      expect(result.status).toBe("continued");
      expect(result.rewrites).toEqual([
        expect.objectContaining({ arguments: { command: "npm test" } }),
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects workflow hook effects that the lifecycle cannot consume", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-hook-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: workspace,
        hooks: [
          {
            name: "bad-stop-rewrite",
            hook: "Stop",
            onError: "block",
            action: {
              type: "command",
              command: process.execPath,
              args: [
                "-e",
                "console.log(JSON.stringify({status:'rewrite', patch:{arguments:{command:'npm test'}}}))",
              ],
              resultMode: "stdoutJson",
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        payload: {},
        events,
      });

      expect(result.status).toBe("blocked");
      if (result.status !== "blocked") {
        throw new Error("expected blocked workflow hook result");
      }
      expect(result.block.reason).toContain("rewrite is only supported");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses onError for malformed command stdout JSON", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-hook-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: workspace,
        hooks: [
          {
            name: "bad-json",
            hook: "Stop",
            onError: "block",
            action: {
              type: "command",
              command: process.execPath,
              args: ["-e", "console.log('not json')"],
              resultMode: "stdoutJson",
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        payload: {},
        events,
      });

      expect(result.status).toBe("blocked");
      if (result.status !== "blocked") {
        throw new Error("expected blocked workflow hook result");
      }
      expect(result.block.reason).toContain("invalid JSON");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("drops malformed stderr progress without corrupting stdoutJson hook control", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-hook-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: workspace,
        hooks: [
          {
            name: "bad-progress-good-json",
            hook: "Stop",
            onError: "block",
            action: {
              type: "command",
              command: process.execPath,
              args: [
                "-e",
                [
                  "process.stderr.write(process.env.SPARKWRIGHT_EVENT_TOKEN + ': not json\\n');",
                  "process.stdout.write(JSON.stringify({status:'block', reason:'stdout still controls'}));",
                ].join("\n"),
              ],
              resultMode: "stdoutJson",
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        payload: {},
        events,
      });

      expect(result.status).toBe("blocked");
      if (result.status !== "blocked") {
        throw new Error("expected blocked workflow hook result");
      }
      expect(result.block.reason).toBe("stdout still controls");
      expect(events.all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "extension.process.completed",
            payload: expect.objectContaining({
              progressDropped: 1,
              output: expect.not.objectContaining({
                stderrPreview: expect.stringContaining("not json"),
              }),
            }),
          }),
        ]),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("deduplicates repeated Stop agent blocks for the same run", async () => {
    const run = runRecord();
    const events = new EventLog(run.id);
    const controller = new AbortController();
    const parentRun = {
      record: run,
      events,
      abortSignal: controller.signal,
    } as never;
    let calls = 0;
    const agentTool = defineTool<Record<string, unknown>, unknown>({
      name: "delegate_agent",
      description: "Delegate to a configured agent",
      inputSchema: { type: "object" },
      policy: { risk: "safe" },
      execute: () => {
        calls += 1;
        return { status: "block", reason: "still blocked" };
      },
    });
    const hooks = createConfiguredWorkflowHooks({
      workspaceRoot: process.cwd(),
      getRun: () => parentRun,
      agentTool,
      hooks: [
        {
          name: "agent-stop",
          hook: "Stop",
          action: {
            type: "agent",
            agentId: "reviewer",
            goal: "review final answer",
            resultMode: "workflowResult",
          },
        },
      ],
    });

    const first = await runWorkflowHooks({
      hooks,
      hook: "Stop",
      run,
      payload: {},
      events,
    });
    const second = await runWorkflowHooks({
      hooks,
      hook: "Stop",
      run,
      payload: {},
      events,
    });

    expect(first.status).toBe("blocked");
    expect(second.status).toBe("continued");
    expect(calls).toBe(1);
    expect(events.all().at(-1)?.payload).toMatchObject({
      result: {
        status: "skipped",
        metadata: { repeatedBlockSignature: true },
      },
    });
  });

  it("reports malformed agent workflowResult strings as invalid JSON", async () => {
    const run = runRecord();
    const events = new EventLog(run.id);
    const controller = new AbortController();
    const parentRun = {
      record: run,
      events,
      abortSignal: controller.signal,
    } as never;
    const agentTool = defineTool<Record<string, unknown>, unknown>({
      name: "delegate_agent",
      description: "Delegate to a configured agent",
      inputSchema: { type: "object" },
      policy: { risk: "safe" },
      execute: () => "not json",
    });
    const hooks = createConfiguredWorkflowHooks({
      workspaceRoot: process.cwd(),
      getRun: () => parentRun,
      agentTool,
      hooks: [
        {
          name: "agent-bad-json",
          hook: "Stop",
          onError: "block",
          action: {
            type: "agent",
            agentId: "reviewer",
            goal: "review final answer",
            resultMode: "workflowResult",
          },
        },
      ],
    });

    const result = await runWorkflowHooks({
      hooks,
      hook: "Stop",
      run,
      payload: {},
      events,
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") {
      throw new Error("expected blocked workflow hook result");
    }
    expect(result.block.reason).toContain("invalid JSON");
  });

  it("can skip configured hooks after they run once in a turn", async () => {
    const run = runRecord();
    const events = new EventLog(run.id);
    const hooks = createConfiguredWorkflowHooks({
      workspaceRoot: process.cwd(),
      hooks: [
        {
          name: "once",
          hook: "PostToolUse",
          frequency: "oncePerTurn",
          action: {
            type: "context",
            content: "ran",
          },
        },
      ],
    });

    const first = await runWorkflowHooks({
      hooks,
      hook: "PostToolUse",
      run,
      step: 1,
      payload: {},
      events,
    });
    const second = await runWorkflowHooks({
      hooks,
      hook: "PostToolUse",
      run,
      step: 1,
      payload: {},
      events,
    });

    expect(first.status).toBe("continued");
    expect(first.context).toHaveLength(1);
    expect(second.status).toBe("continued");
    expect(second.context).toHaveLength(0);
    expect(events.all().at(-1)?.payload).toMatchObject({
      result: {
        status: "skipped",
        reason: "configured hook already ran for this turn",
      },
    });
  });

  it("can suppress command output context on successful commands", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-hook-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: workspace,
        hooks: [
          {
            name: "quiet-check",
            hook: "Stop",
            action: {
              type: "command",
              command: process.execPath,
              args: ["-e", "console.log('ok')"],
              injectOutput: "onFailure",
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        payload: {},
        events,
      });

      expect(result.status).toBe("continued");
      expect(result.context).toEqual([]);
      expect(events.all().at(-1)?.payload).toMatchObject({
        result: {
          status: "continue",
          metadata: {
            hookName: "quiet-check",
            exitCode: 0,
            stdout: "ok\n",
            output: {
              stdoutPreview: "ok\n",
              stdoutBytes: 3,
              stdoutTruncated: false,
            },
          },
        },
      });
      expect(events.all().map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "extension.process.started",
          "extension.process.completed",
        ]),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("can pass workflow hook input to command actions on stdin", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-hook-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: workspace,
        hooks: [
          {
            name: "stdin-check",
            hook: "Stop",
            action: {
              type: "command",
              command: process.execPath,
              args: [
                "-e",
                [
                  "let data = '';",
                  "process.stdin.on('data', (chunk) => data += chunk);",
                  "process.stdin.on('end', () => {",
                  "  const input = JSON.parse(data);",
                  "  if (input.hook !== 'Stop') process.exit(2);",
                  "  if (input.payload.message !== 'reject me') process.exit(3);",
                  "  console.error(input.metadata.step);",
                  "  process.exit(4);",
                  "});",
                ].join("\n"),
              ],
              stdin: "json",
              blockOnFailure: true,
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        step: 7,
        payload: { message: "reject me" },
        metadata: { step: 7 },
        events,
      });

      expect(result.status).toBe("blocked");
      if (result.status !== "blocked") {
        throw new Error("expected blocked workflow hook result");
      }
      expect(result.block.reason).toContain("exit code 4");
      expect(result.block.metadata).toMatchObject({
        stderr: "7\n",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("blocks command hooks when enforce-mode sandbox is unavailable", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-hook-"));
    const runtime = unavailableRuntime();
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: workspace,
        sandbox: { mode: "enforce" },
        sandboxRuntime: runtime,
        hooks: [
          {
            name: "sandboxed-check",
            hook: "Stop",
            action: {
              type: "command",
              command: process.execPath,
              args: ["-e", "console.log('should not run')"],
              blockOnFailure: true,
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        payload: {},
        events,
      });

      expect(result.status).toBe("blocked");
      if (result.status !== "blocked") {
        throw new Error("expected blocked workflow hook result");
      }
      expect(result.block.metadata).toMatchObject({
        exitCode: null,
        sandbox: {
          sandboxed: false,
          mode: "enforce",
          runtime: "test-unavailable",
          available: false,
          fallbackReason: expect.stringContaining("test-unavailable"),
          enforced: true,
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("falls back in warn mode and records sandbox metadata", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-hook-"));
    const runtime = unavailableRuntime();
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: workspace,
        sandbox: { mode: "warn" },
        sandboxRuntime: runtime,
        hooks: [
          {
            name: "warn-check",
            hook: "Stop",
            action: {
              type: "command",
              command: process.execPath,
              args: ["-e", "console.log('fallback')"],
              injectOutput: "never",
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        payload: {},
        events,
      });

      expect(result.status).toBe("continued");
      expect(events.all().at(-1)?.payload).toMatchObject({
        result: {
          metadata: {
            exitCode: 0,
            stdout: "fallback\n",
            sandbox: {
              sandboxed: false,
              mode: "warn",
              runtime: "test-unavailable",
              available: false,
              fallbackReason: expect.stringContaining("test-unavailable"),
              enforced: false,
            },
          },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps command hooks from writing forced deny paths when runtime is available", async () => {
    const runtime = createPlatformShellSandboxRuntime();
    if (!(await runtime.isAvailable())) return;
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-hook-"));
    const configPath = join(workspace, ".sparkwright", "config.json");
    try {
      await mkdir(join(workspace, ".sparkwright"), { recursive: true });
      await writeFile(configPath, "original\n", "utf8");
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createConfiguredWorkflowHooks({
        workspaceRoot: workspace,
        sandbox: { mode: "enforce" },
        sandboxRuntime: runtime,
        configPaths: [configPath],
        hooks: [
          {
            name: "deny-config-write",
            hook: "Stop",
            action: {
              type: "command",
              command: "/bin/bash",
              args: ["-c", "echo bad > .sparkwright/config.json"],
              blockOnFailure: true,
            },
          },
        ],
      });

      const result = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        payload: {},
        events,
      });

      expect(result.status).toBe("blocked");
      await expect(readFile(configPath, "utf8")).resolves.toBe("original\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("createVerificationWorkflowHooks", () => {
  it("defaults to suggestion mode when mode is omitted", async () => {
    const run = runRecord();
    const events = new EventLog(run.id);
    const hooks = createVerificationWorkflowHooks({
      workspaceRoot: process.cwd(),
      verification: {
        defaultProfile: "fast",
        profiles: {
          fast: [{ id: "lint", command: "npm", args: ["run", "lint"] }],
        },
      },
    });

    const result = await runWorkflowHooks({
      hooks,
      hook: "RunStart",
      run,
      payload: {},
      events,
    });

    expect(result.status).toBe("continued");
    expect(result.context[0]?.content).toContain("npm run lint");
    expect(hooks.some((hook) => hook.hook === "Stop")).toBe(false);
  });

  it("allows final answers when verification passed after the latest write", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-verify-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createVerificationWorkflowHooks({
        workspaceRoot: workspace,
        verification: {
          mode: "require",
          defaultProfile: "fast",
          profiles: {
            fast: [
              {
                id: "ok",
                command: process.execPath,
                args: ["-e", "process.exit(0)"],
              },
            ],
          },
        },
      });

      events.emit("workspace.write.completed", { path: "src/a.ts" });
      await runWorkflowHooks({
        hooks,
        hook: "PostToolUse",
        run,
        step: 1,
        payload: {
          toolName: "apply_patch",
          status: "completed",
          path: "src/a.ts",
        },
        events,
      });

      const stop = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        step: 2,
        payload: { events: events.all() },
        events,
      });

      expect(stop.status).toBe("continued");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("blocks final answers when the latest write is not verified", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-verify-"));
    try {
      const run = runRecord();
      const events = new EventLog(run.id);
      const hooks = createVerificationWorkflowHooks({
        workspaceRoot: workspace,
        verification: {
          mode: "require",
          defaultProfile: "fast",
          profiles: {
            fast: [
              {
                id: "lint",
                command: process.execPath,
                args: ["-e", "process.exit(0)"],
              },
            ],
          },
        },
      });

      events.emit("workspace.write.completed", { path: "src/a.ts" });
      await runWorkflowHooks({
        hooks,
        hook: "PostToolUse",
        run,
        step: 1,
        payload: {
          toolName: "apply_patch",
          status: "completed",
          path: "src/a.ts",
        },
        events,
      });
      events.emit("workspace.write.completed", { path: "src/b.ts" });

      const stop = await runWorkflowHooks({
        hooks,
        hook: "Stop",
        run,
        step: 2,
        payload: { events: events.all() },
        events,
      });

      expect(stop.status).toBe("blocked");
      if (stop.status !== "blocked") {
        throw new Error("expected blocked workflow hook result");
      }
      expect(stop.block.reason).toContain("latest workspace write");
      expect(stop.block.metadata).toMatchObject({
        profile: "fast",
        missing: ["lint"],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

function unavailableRuntime(): ShellSandboxRuntime {
  return {
    id: "test-unavailable",
    platform: "unsupported",
    isAvailable: async () => false,
    execute: async () => {
      throw new Error("should not execute");
    },
  };
}
