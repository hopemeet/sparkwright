import { describe, expect, it } from "vitest";
import {
  createRun,
  defineTool,
  evaluateRuntimeState,
  type FactLedgerSnapshot,
} from "../src/index.js";

describe("execution control plane", () => {
  it("atomically binds a sole terminal tool result to the assistant response", async () => {
    let modelCalls = 0;
    const run = createRun({
      goal: "finish structurally",
      tools: [
        defineTool({
          name: "submit",
          description: "Submit a terminal result.",
          inputSchema: { type: "object" },
          terminal: {
            kind: "test_result",
            renderMessage: (output: { summary: string }) => output.summary,
          },
          execute: (args) => args as { summary: string },
        }),
      ],
      model: {
        async complete() {
          modelCalls += 1;
          return {
            message: "Human-readable bound answer.",
            toolCalls: [
              {
                toolName: "submit",
                arguments: { summary: "Structured summary." },
              },
            ],
          };
        },
      },
    });

    const result = await run.start();

    expect(modelCalls).toBe(1);
    expect(result).toMatchObject({
      signal: "completed",
      message: "Human-readable bound answer.",
      metadata: {
        terminalResult: {
          kind: "test_result",
          toolName: "submit",
          responseTextBound: true,
          output: { summary: "Structured summary." },
        },
      },
    });
  });

  it("uses the reserved finalization turn when terminal assistant text is absent", async () => {
    let modelCalls = 0;
    const run = createRun({
      goal: "finish without prose",
      tools: [
        defineTool({
          name: "submit",
          description: "Submit a terminal result.",
          inputSchema: { type: "object" },
          terminal: {
            kind: "test_result",
            renderMessage: (output: { summary: string }) => output.summary,
          },
          execute: (args) => args as { summary: string },
        }),
      ],
      model: {
        async complete() {
          modelCalls += 1;
          return modelCalls === 1
            ? {
                toolCalls: [
                  {
                    toolName: "submit",
                    arguments: { summary: "Rendered summary." },
                  },
                ],
              }
            : { message: "Finalized human-readable summary." };
        },
      },
    });

    await expect(run.start()).resolves.toMatchObject({
      signal: "completed",
      message: "Finalized human-readable summary.",
      metadata: {
        terminalResult: { responseTextBound: false },
      },
    });
    expect(modelCalls).toBe(2);
  });

  it("rejects mixed terminal responses before executing any tool call", async () => {
    let executions = 0;
    const run = createRun({
      goal: "do not mix terminal work",
      tools: [
        defineTool({
          name: "mutate",
          description: "Would mutate.",
          inputSchema: { type: "object" },
          execute() {
            executions += 1;
            return { changed: true };
          },
        }),
        defineTool({
          name: "submit",
          description: "Terminal.",
          inputSchema: { type: "object" },
          terminal: { kind: "test_result" },
          execute() {
            executions += 1;
            return { summary: "done" };
          },
        }),
      ],
      model: {
        async complete() {
          return {
            toolCalls: [
              { toolName: "mutate", arguments: {} },
              { toolName: "submit", arguments: {} },
            ],
          };
        },
      },
    });

    const result = await run.start();

    expect(executions).toBe(0);
    expect(result).toMatchObject({
      signal: "failed",
      failure: { code: "TERMINAL_TOOL_MIXED_CALLS" },
    });
  });

  it("records semantic tool effects for no-change and conflict outcomes", async () => {
    let modelCalls = 0;
    const run = createRun({
      goal: "observe structured effects",
      tools: [
        defineTool({
          name: "noop",
          description: "Already satisfied.",
          inputSchema: { type: "object" },
          governance: { sideEffects: ["write"], idempotency: "idempotent" },
          execute: () => ({ changed: false }),
        }),
        defineTool({
          name: "conflict",
          description: "Revision conflict.",
          inputSchema: { type: "object" },
          governance: { sideEffects: ["write"] },
          execute() {
            throw Object.assign(new Error("stale revision"), {
              code: "WORKSPACE_REVISION_CONFLICT",
            });
          },
        }),
      ],
      maxSteps: 4,
      model: {
        async complete() {
          modelCalls += 1;
          if (modelCalls === 1) {
            return {
              toolCalls: [{ toolName: "noop", arguments: { path: "a.ts" } }],
            };
          }
          if (modelCalls === 2) {
            return {
              toolCalls: [
                { toolName: "conflict", arguments: { path: "a.ts" } },
              ],
            };
          }
          return { message: "done" };
        },
      },
    });

    await run.start();

    expect(
      run.events.all().find((event) => event.type === "tool.completed")
        ?.payload,
    ).toMatchObject({
      effect: {
        kind: "no_change",
        retry: "after_state_change",
        reasonCode: "already_satisfied",
        targetKey: "path:a.ts",
      },
    });
    expect(
      run.events.all().find((event) => event.type === "tool.failed")?.payload,
    ).toMatchObject({
      effect: {
        kind: "blocked",
        retry: "after_state_change",
        reasonCode: "WORKSPACE_REVISION_CONFLICT",
      },
    });
  });

  it("does not reopen a natural final after writes and model-run verification", async () => {
    let modelCalls = 0;
    const runRef: { current?: ReturnType<typeof createRun> } = {};
    const mutate = defineTool({
      name: "mutate",
      description: "Record a managed test write.",
      inputSchema: { type: "object" },
      policy: { risk: "safe" },
      execute() {
        const run = runRef.current!;
        run.events.emit("workspace.write.completed", {
          path: "print_numbers.py",
          writeEpoch: 1,
          changeSet: {
            id: "change_python",
            actor: { kind: "main", principalScope: run.record.id },
            writeEpoch: 1,
            entries: [
              {
                path: "print_numbers.py",
                operation: "replace",
                beforeRevision: "before",
                afterRevision: "after",
              },
            ],
          },
        });
        return { changed: true };
      },
    });
    const bash = defineTool({
      name: "bash",
      description: "Run a deterministic Python check.",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      policy: { risk: "safe" },
      execute(args) {
        const command = (args as { command: string }).command;
        return {
          command,
          exitCode: 0,
          timedOut: false,
          stdout: command.includes("py_compile")
            ? ""
            : "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n",
          stderr: "",
        };
      },
    });
    const run = createRun({
      goal: "write and verify a Python script",
      tools: [mutate, bash],
      maxSteps: 8,
      model: {
        async complete() {
          modelCalls += 1;
          if (modelCalls === 1) {
            return { toolCalls: [{ toolName: "mutate", arguments: {} }] };
          }
          if (modelCalls === 2) {
            return {
              toolCalls: [
                {
                  toolName: "bash",
                  arguments: {
                    command: "python3 -m py_compile print_numbers.py",
                  },
                },
              ],
            };
          }
          if (modelCalls === 3) {
            return {
              toolCalls: [
                {
                  toolName: "bash",
                  arguments: { command: "python3 print_numbers.py" },
                },
              ],
            };
          }
          return { message: "print_numbers.py is complete and verified." };
        },
      },
    });
    runRef.current = run;

    const result = await run.start();
    const completed = run.events
      .all()
      .find((event) => event.type === "run.completed");

    expect(modelCalls).toBe(4);
    expect(result).toMatchObject({
      signal: "completed",
      message: "print_numbers.py is complete and verified.",
      metadata: {
        completionStatus: "completed",
      },
    });
    expect(completed?.payload).toMatchObject({
      factLedger: {
        changeSets: [{ id: "change_python" }],
        verificationReceipts: [],
      },
      completionStatus: "completed",
    });
    expect(
      (
        completed?.payload as { notices?: Array<{ code?: string }> } | undefined
      )?.notices?.map((notice) => notice.code),
    ).not.toContain("verification_not_run");
  });

  it("keeps child and verification problems as advisory evidence", () => {
    const run = createRun({
      goal: "summarize recorded evidence",
      model: { complete: async () => ({ message: "unused" }) },
    });
    run.events.emit("subagent.completed", {
      childRunId: "run_child",
      status: "partial",
      summary: "Child stopped early",
      blockers: [{ code: "CHILD_BLOCKED", kind: "dependency" }],
    });
    const ledger: FactLedgerSnapshot = {
      schemaVersion: "fact-ledger.v1",
      writeEpoch: 1,
      commands: [],
      verificationResults: [],
      writes: [],
      changeSets: [],
      verificationReceipts: [
        {
          id: "receipt_failed",
          level: "project",
          coveredChangeSets: [],
          writeEpoch: 1,
          command: "npm test",
          exitCode: 1,
          status: "failed",
          timestamp: "2026-07-24T00:00:00.000Z",
        },
      ],
      budgetExceeded: [],
    };

    const evaluation = evaluateRuntimeState({
      run: run.record,
      events: run.events.all(),
      factLedger: ledger,
    });

    expect(evaluation.status).toBe("completed");
    expect(evaluation.notices.map((notice) => notice.code)).toEqual(
      expect.arrayContaining(["child_partial", "verification_failed"]),
    );
  });

  it("keeps runtime-owned continuation budget exhaustion terminally partial", () => {
    const run = createRun({
      goal: "respect runtime budgets",
      model: { complete: async () => ({ message: "unused" }) },
    });
    const ledger: FactLedgerSnapshot = {
      schemaVersion: "fact-ledger.v1",
      writeEpoch: 0,
      commands: [],
      verificationResults: [],
      writes: [],
      changeSets: [],
      verificationReceipts: [],
      budgetExceeded: [
        {
          id: "budget:1",
          sequence: 1,
          writeEpoch: 0,
          source: "workflow",
          used: 1,
          limit: 1,
          step: 2,
          reason: "stop_hook_blocked",
        },
      ],
    };

    const evaluation = evaluateRuntimeState({
      run: run.record,
      events: [],
      factLedger: ledger,
    });

    expect(evaluation).toMatchObject({
      status: "partial",
      notices: [{ code: "budget_exhausted" }],
    });
  });
});
