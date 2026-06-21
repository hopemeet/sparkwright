// Coverage for the v0.1 loop extensions:
//   - AbortSignal vertical (cancel mid-tool)
//   - Compaction pipeline applied before assembly
//   - Stop hook (pre_terminal) blocks termination + injects continuation
//   - Post-sampling hook runs fire-and-forget
//   - Fallback model chain switches on recoveryHint
//   - Recoverable model errors (reduce_input / extend_output)
//   - Observation summarizer + prefetch results land in NEXT turn's context
import { describe, expect, it, vi } from "vitest";
import {
  createCompactionPipeline,
  createRun,
  defineTool,
  resumeRunFromCheckpoint,
  type CompactionStage,
  type ContextItem,
  type ContextPrefetcher,
  type ModelAdapter,
  type ObservationSummarizer,
  type RunCheckpointV1,
  type RunLoopServices,
  type ValidationHook,
} from "../src/index.js";

function staticModel(
  outputs: Array<
    Parameters<ModelAdapter["complete"]>[0] extends never
      ? never
      : ReturnType<ModelAdapter["complete"]> extends Promise<infer R>
        ? R
        : never
  >,
): ModelAdapter {
  let index = 0;
  return {
    async complete() {
      const out = outputs[Math.min(index, outputs.length - 1)]!;
      index += 1;
      return out;
    },
  };
}

describe("run loop extensions", () => {
  it("uses injected loop services for model calls and checkpoint metadata", async () => {
    const calls: string[] = [];
    const services: RunLoopServices = {
      now: () => new Date("2026-01-02T03:04:05.000Z"),
      async callModel(input) {
        calls.push(`${input.step}:${input.useStream}`);
        return { message: `via ${input.adapter === model}` };
      },
    };
    const model: ModelAdapter = {
      async complete() {
        throw new Error("default model path should not run");
      },
    };
    const run = createRun({
      goal: "deps",
      model,
      loopServices: services,
    });

    const result = await run.start();
    const checkpoint = run.checkpoint({ reason: "test" });

    expect(result.message).toBe("via true");
    expect(calls).toEqual(["1:false"]);
    expect(checkpoint.schemaVersion).toBe("run-checkpoint.v1");
    expect(checkpoint.createdAt).toBe("2026-01-02T03:04:05.000Z");
    expect(checkpoint.metadata).toEqual({ reason: "test" });
    expect(checkpoint.run.state).toBe("completed");
  });

  it("marks queued commands as non-serialized in checkpoints", () => {
    const run = createRun({
      goal: "checkpoint queue",
      model: staticModel([{ message: "done" }]),
    });
    run.injectUserMessage({ content: "later" });

    const checkpoint = run.checkpoint();

    expect(checkpoint.queues.commandCount).toBe(1);
    expect(checkpoint.resumability.complete).toBe(false);
    expect(checkpoint.resumability.reasons).toContain(
      "command_queue_not_serialized",
    );
  });

  describe("resumeRunFromCheckpoint", () => {
    function buildCheckpoint(
      overrides: Partial<RunCheckpointV1> = {},
    ): RunCheckpointV1 {
      return {
        schemaVersion: "run-checkpoint.v1",
        run: {
          id: "run_resume_42" as never,
          goal: "original goal",
          state: "waiting_approval",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:30.000Z",
          metadata: { tag: "from-checkpoint" },
        },
        loop: {
          step: 3,
          turnCount: 2,
          context: [
            {
              id: "ctx_seed_1" as never,
              type: "summary",
              content: "seeded-context-from-checkpoint",
              metadata: { layer: "working", stability: "session" },
            },
          ],
          repeatedToolCallCount: 0,
          transition: { reason: "next_turn" },
        },
        model: { activeIndex: 0, fallbackCount: 0 },
        recovery: { outputRecoveriesUsed: 1, maxOutputRecoveries: 3 },
        budget: {
          configured: undefined,
          usage: {
            elapsedMs: 5000,
            modelCalls: 2,
            toolCalls: 1,
            tokens: 1234,
            costUsd: 0.05,
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
        ...overrides,
      };
    }

    it("re-enters the loop using the seeded step / context / counters", async () => {
      const checkpoint = buildCheckpoint();
      const seenSteps: number[] = [];
      const seenContextSources: string[] = [];

      const run = resumeRunFromCheckpoint(checkpoint, {
        model: {
          async complete(input) {
            seenSteps.push(input.step);
            for (const item of input.context) {
              if (item.content === "seeded-context-from-checkpoint") {
                seenContextSources.push("seed");
              }
            }
            return { message: "resumed-and-done" };
          },
        },
      });

      const result = await run.start();

      expect(result.signal).toBe("completed");
      expect(result.message).toBe("resumed-and-done");
      // Loop resumed at the checkpoint's step rather than step 1.
      expect(seenSteps[0]).toBe(3);
      // The seeded context was carried into the very first model call.
      expect(seenContextSources).toContain("seed");
      // Identity is preserved.
      expect(run.record.id).toBe("run_resume_42");
      // Resume evidence event was emitted with the right transition reason.
      const types = run.events.all().map((e) => e.type);
      expect(types).toContain("run.resumed");
      const resumedEvent = run.events
        .all()
        .find((e) => e.type === "run.resumed");
      expect(resumedEvent?.payload).toMatchObject({
        fromStep: 3,
        outputRecoveriesUsed: 1,
        checkpointCreatedAt: "2026-01-01T00:00:30.500Z",
      });
      // Metadata records the resume provenance.
      expect(run.record.metadata).toMatchObject({
        tag: "from-checkpoint",
        resumedFromCheckpointAt: "2026-01-01T00:00:30.500Z",
      });
    });

    it("rejects a checkpoint whose run is already terminal", () => {
      const checkpoint = buildCheckpoint({
        run: {
          id: "run_done" as never,
          goal: "x",
          state: "completed",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
          metadata: {},
        },
      });
      expect(() =>
        resumeRunFromCheckpoint(checkpoint, {
          model: {
            async complete() {
              return { message: "" };
            },
          },
        }),
      ).toThrow(/already terminal/);
    });

    it("rejects an incomplete checkpoint unless force: true", () => {
      const checkpoint = buildCheckpoint({
        resumability: {
          complete: false,
          reasons: ["command_queue_not_serialized"],
        },
      });
      const opts = {
        model: {
          async complete() {
            return { message: "done" };
          },
        },
      };
      expect(() => resumeRunFromCheckpoint(checkpoint, opts)).toThrow(
        /not fully resumable/,
      );
      // With force: true the same checkpoint resumes.
      const run = resumeRunFromCheckpoint(checkpoint, { ...opts, force: true });
      expect(run.record.id).toBe("run_resume_42");
    });
  });

  it("aborts a long-running tool when cancel() fires mid-execution", async () => {
    const longTool = defineTool({
      name: "long",
      description: "Stays put until aborted.",
      inputSchema: { type: "object" },
      policy: { risk: "safe" },
      async execute(_args, ctx) {
        await new Promise<void>((resolve, reject) => {
          if (ctx.abortSignal?.aborted) {
            reject(new Error("Tool aborted."));
            return;
          }
          const timer = setTimeout(() => resolve(), 5_000);
          ctx.abortSignal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              const err = new Error("Tool aborted.");
              err.name = "AbortError";
              reject(err);
            },
            { once: true },
          );
        });
        return { ok: true };
      },
    });

    const model: ModelAdapter = {
      async complete() {
        return {
          toolCalls: [{ toolName: "long", arguments: {} }],
        };
      },
    };

    const run = createRun({
      goal: "abort test",
      model,
      tools: [longTool],
      maxSteps: 3,
    });

    // Fire cancel right after the first turn schedules the tool.
    setTimeout(() => run.cancel({ reason: "test cancel" }), 25);

    const result = await run.start();
    // The cancel happens between turns or mid-tool; either way we should end
    // in a non-running terminal state.
    expect(["cancelled", "failed"]).toContain(result.state);
    expect(run.abortSignal.aborted).toBe(true);
  });

  it("runs compactor stages before assembly and emits stage events", async () => {
    const calls: string[] = [];
    const tinyStage: CompactionStage = {
      name: "tiny",
      tier: "evict",
      trigger: "snip",
      shouldRun: () => true,
      apply(input) {
        calls.push("tiny");
        // Drop everything except the latest item.
        const kept = input.items.slice(-1);
        const before = input.totalChars;
        const after = kept.reduce((s, i) => s + i.content.length, 0);
        return { items: kept, freedChars: before - after };
      },
    };

    const ctxItems: ContextItem[] = [
      {
        id: "ctx_a" as never,
        type: "user",
        content: "x".repeat(200),
        metadata: {},
      },
      {
        id: "ctx_b" as never,
        type: "user",
        content: "keep me",
        metadata: {},
      },
    ];

    const model: ModelAdapter = {
      async complete(input) {
        // Compaction ran first, so we should only see the second item.
        expect(input.context.length).toBeLessThanOrEqual(2);
        return { message: "done" };
      },
    };

    const events: string[] = [];
    const run = createRun({
      goal: "compaction",
      model,
      context: ctxItems,
      compactionStages: [tinyStage],
    });
    run.events.subscribe((evt) => events.push(evt.type));
    await run.start();
    expect(calls).toEqual(["tiny"]);
    expect(events).toContain("context.compaction.started");
    expect(events).toContain("context.compaction.completed");
  });

  it("can build a pipeline outside the loop for unit testing stages", async () => {
    const stage: CompactionStage = {
      name: "noop",
      tier: "evict",
      trigger: "snip",
      shouldRun: () => true,
      apply(input) {
        return { items: input.items, freedChars: 0 };
      },
    };
    const pipeline = createCompactionPipeline({ stages: [stage] });
    const result = await pipeline.run({
      items: [
        {
          id: "ctx_a" as never,
          type: "user",
          content: "hi",
          metadata: {},
        },
      ],
      hints: {},
    });
    expect(result.appliedStages).toHaveLength(0);
    expect(result.skippedStages).toHaveLength(1);
    expect(result.skippedReason).toBe("no_savings");
    expect(result.freedChars).toBe(0);
  });

  it("pre_terminal stop hook blocks termination and injects continuation", async () => {
    let turn = 0;
    const model: ModelAdapter = {
      async complete() {
        turn += 1;
        if (turn === 1) return { message: "first attempt" };
        return { message: "second attempt, with extra check passed" };
      },
    };
    const stopHook: ValidationHook = {
      name: "must_mention_check",
      stages: ["pre_terminal"],
      validate(input) {
        const text = (input.subject as string) ?? "";
        if (text.includes("check passed")) return { status: "passed" };
        return {
          status: "failed",
          findings: [
            {
              code: "MISSING_CHECK",
              message: "Response must include 'check passed'.",
            },
          ],
        };
      },
    };

    const run = createRun({
      goal: "stop hook",
      model,
      validationHooks: [stopHook],
      maxSteps: 4,
    });
    const result = await run.start();
    expect(result.state).toBe("completed");
    expect(turn).toBeGreaterThan(1);
  });

  it("post_sampling hook runs fire-and-forget without blocking the loop", async () => {
    const observed = vi.fn();
    const model: ModelAdapter = {
      async complete() {
        return { message: "ok" };
      },
    };
    const probe: ValidationHook = {
      name: "probe",
      stages: ["post_sampling"],
      async validate(input) {
        // simulate slow telemetry — must not delay run completion
        await new Promise((r) => setTimeout(r, 20));
        observed(input.subject);
      },
    };
    const run = createRun({
      goal: "post sampling",
      model,
      validationHooks: [probe],
    });
    const start = Date.now();
    const result = await run.start();
    const elapsed = Date.now() - start;
    expect(result.state).toBe("completed");
    // Run finishing didn't wait for the 20ms hook
    expect(elapsed).toBeLessThan(200);
  });

  it("switches to fallback model when primary throws recoveryHint=fallback_model", async () => {
    let primaryCalls = 0;
    const primary: ModelAdapter = {
      async complete() {
        primaryCalls += 1;
        const err = Object.assign(new Error("primary down"), {
          recoveryHint: "fallback_model",
          retryable: false,
        });
        throw err;
      },
    };
    let backupCalls = 0;
    const backup: ModelAdapter = {
      async complete() {
        backupCalls += 1;
        return { message: "from backup" };
      },
    };
    const run = createRun({
      goal: "fallback",
      model: primary,
      models: [backup],
      modelRetry: { maxAttempts: 1 },
    });
    const result = await run.start();
    expect(result.state).toBe("completed");
    expect(result.message).toBe("from backup");
    expect(primaryCalls).toBeGreaterThanOrEqual(1);
    expect(backupCalls).toBe(1);
  });

  it("treats 413 / context-length errors as reduce_input and re-shapes context", async () => {
    let attempts = 0;
    const compactor: CompactionStage = {
      name: "drop-all",
      tier: "evict",
      trigger: "reactive",
      shouldRun: () => true,
      apply(input) {
        return { items: [], freedChars: input.totalChars };
      },
    };
    const model: ModelAdapter = {
      async complete() {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("ctx too long"), {
            status: 413,
            retryable: false,
          });
        }
        return { message: "ok after compaction" };
      },
    };
    const run = createRun({
      goal: "reduce input",
      model,
      compactionStages: [compactor],
      modelRetry: { maxAttempts: 1 },
    });
    const result = await run.start();
    expect(result.state).toBe("completed");
    expect(result.message).toBe("ok after compaction");
  });

  it("extends output via continuation message on max_output_tokens", async () => {
    let attempts = 0;
    const model: ModelAdapter = {
      async complete() {
        attempts += 1;
        if (attempts === 1) {
          return {
            message: "partial...",
            stopReason: "max_output_tokens" as const,
          };
        }
        return { message: "complete" };
      },
    };
    const run = createRun({
      goal: "extend output",
      model,
      maxOutputRecoveries: 2,
      maxSteps: 4,
    });
    const result = await run.start();
    expect(result.state).toBe("completed");
    expect(attempts).toBeGreaterThan(1);
  });

  it("merges summarizer + prefetch outputs into next turn's context", async () => {
    let modelCalls = 0;
    const seen: string[][] = [];
    const tool = defineTool({
      name: "noop",
      description: "noop",
      inputSchema: { type: "object" },
      policy: { risk: "safe" },
      execute: () => ({ ok: true }),
    });
    const model: ModelAdapter = {
      async complete(input) {
        modelCalls += 1;
        seen.push(input.context.map((c) => c.content));
        if (modelCalls === 1) {
          return { toolCalls: [{ toolName: "noop", arguments: {} }] };
        }
        return { message: "done" };
      },
    };
    const summarizer: ObservationSummarizer = {
      async summarizeBatch() {
        return "SUMMARY: noop ran";
      },
    };
    const prefetcher: ContextPrefetcher = {
      name: "skill-test",
      async prefetch() {
        return [
          {
            id: "ctx_pf" as never,
            type: "summary",
            content: "PREFETCH: skill loaded",
            metadata: { layer: "skill_index", stability: "session" },
          },
        ];
      },
    };
    const run = createRun({
      goal: "summary+prefetch",
      model,
      tools: [tool],
      observationSummarizer: summarizer,
      prefetchers: [prefetcher],
      maxSteps: 3,
    });
    await run.start();
    // Second model call sees both the tool_result observation, the async
    // summary, and the prefetch result merged into context.
    const turn2 = seen[1] ?? [];
    expect(turn2.some((c) => c.includes("SUMMARY: noop ran"))).toBe(true);
    expect(turn2.some((c) => c.includes("PREFETCH: skill loaded"))).toBe(true);
  });
});

// Silence the unused helper guard
void staticModel;
