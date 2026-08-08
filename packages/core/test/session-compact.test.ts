import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPACTION_SAFETY_PREFIX,
  SESSION_COMPACT_SCHEMA_VERSION,
  asSessionId,
  createRunId,
  compactSessionTurns,
  createDeterministicSessionSummarizer,
  loadSessionCompactArtifact,
  measureSessionCompactionCorpus,
  sessionCompactArtifactToContextItem,
  writeSessionCompactArtifact,
  type SessionSummarizer,
} from "../src/index.js";

describe("session compact artifacts", () => {
  it("round-trips a compact artifact and projects it to safe context", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-compact-"));
    try {
      const sessionId = asSessionId("session_compact_test");
      const runId = createRunId();
      const path = await writeSessionCompactArtifact({
        sessionRootDir: root,
        artifact: {
          schemaVersion: SESSION_COMPACT_SCHEMA_VERSION,
          sessionId,
          createdAt: "2026-06-14T00:00:00.000Z",
          throughRunId: runId,
          compactedRunCount: 1,
          sourceRunIds: [runId],
          content: "User asked for a TUI refactor; assistant completed it.",
          originalCharCount: 1000,
          summaryCharCount: 56,
          freedChars: 944,
        },
      });

      expect(path.endsWith("compact.json")).toBe(true);
      const artifact = await loadSessionCompactArtifact({
        sessionRootDir: root,
        sessionId,
      });
      expect(artifact).toMatchObject({
        sessionId,
        throughRunId: runId,
        compactedRunCount: 1,
        freedChars: 944,
      });
      expect(artifact).not.toBeNull();
      if (!artifact) return;

      const item = sessionCompactArtifactToContextItem(artifact);
      expect(item.type).toBe("summary");
      expect(item.content).toContain(COMPACTION_SAFETY_PREFIX);
      expect(item.metadata).toMatchObject({
        sessionId,
        throughRunId: runId,
        compactedRunCount: 1,
        freedChars: 944,
        compactionSafetyPrefix: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsupported v1 compact artifacts instead of migrating them", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-compact-v1-"));
    try {
      const sessionId = asSessionId("session_compact_v1_test");
      const runId = createRunId();
      await mkdir(join(root, sessionId), { recursive: true });
      await writeFile(
        join(root, sessionId, "compact.json"),
        JSON.stringify(
          {
            schemaVersion: "session-compact.v1",
            sessionId,
            createdAt: "2026-06-14T00:00:00.000Z",
            throughRunId: runId,
            compactedRunCount: 1,
            sourceRunIds: [runId],
            content: "Old compact payload.",
            originalCharCount: 100,
            summaryCharCount: 20,
          },
          null,
          2,
        ),
        "utf8",
      );

      await expect(
        loadSessionCompactArtifact({ sessionRootDir: root, sessionId }),
      ).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects compact artifacts that cannot anchor throughRunId", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-compact-anchor-"));
    try {
      const sessionId = asSessionId("session_compact_anchor_test");
      const runId = createRunId();
      const missingRunId = createRunId();
      await mkdir(join(root, sessionId), { recursive: true });
      await writeFile(
        join(root, sessionId, "compact.json"),
        JSON.stringify(
          {
            schemaVersion: SESSION_COMPACT_SCHEMA_VERSION,
            sessionId,
            createdAt: "2026-06-14T00:00:00.000Z",
            throughRunId: missingRunId,
            compactedRunCount: 1,
            sourceRunIds: [runId],
            content: "Broken compact payload.",
            originalCharCount: 100,
            summaryCharCount: 20,
            freedChars: 80,
          },
          null,
          2,
        ),
        "utf8",
      );

      await expect(
        loadSessionCompactArtifact({ sessionRootDir: root, sessionId }),
      ).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips short sessions without writing pretend savings", async () => {
    const result = await compactSessionTurns([
      {
        runId: createRunId(),
        goal: "Quick check",
        message: "Done.",
      },
    ]);

    expect(result.skippedReason).toBe("no_savings");
    expect(result.freedChars).toBe(0);
    expect(result.compactedRunCount).toBe(0);
    expect(result.summaryCharCount).toBe(result.originalCharCount);
  });

  it("extracts long turns while preserving paths and constraints", async () => {
    const runId = createRunId();
    const result = await compactSessionTurns(
      [
        {
          runId,
          goal: "Reference doc review for docs/reference/CONTEXT_PLANE.md.",
          message: [
            "Must preserve session-specific extractors and do not reuse runtime tool_result compaction.",
            "Wrote docs/reference/CONTEXT_PLANE.md and packages/core/src/session-compaction.ts.",
            "Verification passed after deterministic extraction.",
            "Repeated analysis ".repeat(180),
          ].join("\n"),
        },
      ],
      { reason: "unit test" },
    );

    expect(result.skippedReason).toBeUndefined();
    expect(result.compactedRunCount).toBe(1);
    expect(result.freedChars).toBeGreaterThan(0);
    expect(result.summaryCharCount).toBeLessThan(result.originalCharCount);
    expect(result.content).toContain("docs/reference/CONTEXT_PLANE.md");
    expect(result.content).toContain("Must preserve");
    expect(result.content).toContain("workspace_write");
    expect(result.appliedStages).toContainEqual(
      expect.objectContaining({
        name: "session_turn_extract",
        tier: "extract",
      }),
    );
  });

  it("does not silently truncate raw turns that survive extraction", async () => {
    const sentinel = "KEEP_SENTINEL_AFTER_SIX_HUNDRED_CHARS";
    const rawMessage = `${"near-term detail ".repeat(45)}${sentinel}`;
    expect(rawMessage.length).toBeGreaterThan(600);
    expect(rawMessage.length).toBeLessThan(1_200);

    const result = await compactSessionTurns([
      {
        runId: createRunId(),
        goal: "Extract the long first turn.",
        message: `Must preserve the extracted turn paths packages/core/src/session-compaction.ts. ${"long analysis ".repeat(150)}`,
      },
      {
        runId: createRunId(),
        goal: "Keep the recent raw turn intact.",
        message: rawMessage,
      },
    ]);

    expect(result.skippedReason).toBeUndefined();
    expect(result.content).toContain(sentinel);
    expect(result.content).not.toContain("Applied stages:");
  });

  it("evicts middle raw turns when many short turns exceed the session budget", async () => {
    const turns = Array.from({ length: 32 }, (_, index) => ({
      runId: createRunId(),
      goal: `Review turn ${index} for packages/core/src/session-compaction.ts ${"goal ".repeat(30)}`,
      message: `Must keep chronological anchors for turn ${index}. ${"short answer ".repeat(70)}`,
    }));

    const result = await compactSessionTurns(turns, { reason: "many turns" });

    expect(result.skippedReason).toBeUndefined();
    expect(result.freedChars).toBeGreaterThan(0);
    expect(result.content).toContain("[evicted");
    expect(result.warnings?.[0]?.code).toBe("SESSION_TURNS_EVICTED");
    expect(result.appliedStages.some((stage) => stage.tier === "evict")).toBe(
      true,
    );
  });

  it("preserves golden coding-session signals across realistic turns", async () => {
    const turns = [
      {
        runId: createRunId(),
        goal: [
          "Reference-driven refactor for docs/reference/CONTEXT_PLANE.md.",
          "Must verify source before trusting the reference doc.",
          "需要保留真实模型 mini、多轮、多 agent、多 skill 的验收要求。",
        ].join("\n"),
        message: [
          "Read docs/reference/CONTEXT_PLANE.md and packages/core/src/pipeline.ts.",
          "Created packages/core/src/session-compaction.ts and modified packages/host/src/runtime.ts.",
          "Verification passed: npm --workspace @sparkwright/core test.",
          "Detailed review notes ".repeat(160),
        ].join("\n"),
      },
      {
        runId: createRunId(),
        goal: [
          "Use a sub-agent to inspect packages/tui/src/app.tsx and packages/tui/src/state/run-controller.ts.",
          "Do not mutate user files outside the temporary fixture.",
          "不要修改真实用户项目，只能使用临时 fixture。",
        ].join("\n"),
        message: [
          "spawn_agent failed once with timeout, then recovered from partial tool observations.",
          "Wrote packages/tui/src/app.tsx and kept /compact warning behavior visible.",
          "Tests passed after retry; remaining risk is trace pricing unavailable.",
          "Multi-agent trace detail ".repeat(150),
        ].join("\n"),
      },
      {
        runId: createRunId(),
        goal: "Resume the session and verify stale compact artifacts are not injected.",
        message: [
          "Blocked on an unsupported session-compact.v1 artifact; ignored it and replayed raw turns.",
          "Verified packages/host/test/protocol.test.ts covers session_compact_warning.",
          "Final validation passed.",
          "Resume replay detail ".repeat(150),
        ].join("\n"),
      },
    ];

    const result = await compactSessionTurns(turns, {
      reason: "golden corpus",
    });

    expect(result.skippedReason).toBeUndefined();
    expect(result.content).toContain("docs/reference/CONTEXT_PLANE.md");
    expect(result.content).toContain("packages/core/src/session-compaction.ts");
    expect(result.content).toContain("packages/tui/src/app.tsx");
    expect(result.content).toContain("Must verify source");
    expect(result.content).toContain("不要");
    expect(result.content).toContain("failure_or_blocked");
    expect(result.content).toContain("workspace_write");
    expect(result.content).toContain("verification");
    expect(result.summaryCharCount).toBeLessThan(result.originalCharCount);
  });

  it("keeps large repetitive sessions bounded while preserving head and tail anchors", async () => {
    const turns = Array.from({ length: 180 }, (_, index) => ({
      runId: createRunId(),
      goal: [
        `Turn ${index}: inspect packages/core/src/session-compaction.ts and docs/reference/CONTEXT_PLANE.md.`,
        "Must keep paths, constraints, write status, and verification status.",
      ].join("\n"),
      message: [
        `Completed turn ${index}. Wrote packages/core/test/session-compact.test.ts.`,
        "Verification passed with deterministic corpus checks.",
        "Large repetitive analysis ".repeat(35),
      ].join("\n"),
    }));
    const firstRunId = turns[0]!.runId;
    const lastRunId = turns[turns.length - 1]!.runId;

    const result = await compactSessionTurns(turns, {
      reason: "scale corpus",
    });

    expect(result.skippedReason).toBeUndefined();
    expect(result.freedChars).toBeGreaterThan(50_000);
    expect(result.summaryCharCount).toBeLessThan(result.originalCharCount / 3);
    expect(result.content).toContain(firstRunId);
    expect(result.content).toContain(lastRunId);
    expect(result.content).toContain("[evicted");
    expect(
      result.warnings?.some((w) => w.code === "SESSION_TURNS_EVICTED"),
    ).toBe(true);
  });

  it("applies the deterministic session summarizer stub behind explicit manual opt-in", async () => {
    const result = await compactSessionTurns(
      [
        {
          runId: createRunId(),
          goal: "Must preserve docs/reference/CONTEXT_PLANE.md in the summary.",
          message: [
            "Wrote packages/core/src/session-compaction.ts.",
            "Verification passed.",
            "Detailed implementation notes ".repeat(180),
          ].join("\n"),
        },
      ],
      {
        summarizer: createDeterministicSessionSummarizer(),
        summarizerTrigger: "manual",
        summarizerBudget: { maxSourceChars: 20_000, maxOutputTokens: 1_000 },
      },
    );

    expect(result.skippedReason).toBeUndefined();
    expect(result.content).toContain("Session deterministic-summary preview.");
    expect(result.content).toContain("docs/reference/CONTEXT_PLANE.md");
    expect(result.appliedStages).toContainEqual(
      expect.objectContaining({ name: "session_summarize", tier: "summarize" }),
    );
    expect(result.measurement).toMatchObject({
      regime: "density_bound",
      summarizer: expect.objectContaining({
        applied: true,
        mode: "deterministic_stub",
        oracleVersion: "session-signals.v1",
      }),
    });
  });

  it("requires trace-derived approval, write, and subagent signals in summaries", async () => {
    const result = await compactSessionTurns(
      [
        {
          runId: createRunId(),
          goal: "Must preserve trace-derived facts for packages/host/src/runtime.ts.",
          message: [
            "Implemented trace fact extraction and verification.",
            "Verification passed.",
            "Trace signal detail ".repeat(180),
          ].join("\n"),
          traceFacts: {
            approvals: { requested: 2, approved: 1, denied: 1 },
            workspaceWrites: {
              completed: ["packages/host/src/runtime.ts"],
              denied: ["secrets/.env"],
            },
            subagents: [
              {
                childRunId: "run_child_trace",
                finality: "partial",
                role: "reviewer",
                health: "failing",
              },
            ],
          },
        },
      ],
      {
        summarizer: createDeterministicSessionSummarizer(),
        summarizerTrigger: "manual",
        summarizerBudget: { maxSourceChars: 20_000, maxOutputTokens: 1_000 },
      },
    );

    expect(result.skippedReason).toBeUndefined();
    expect(result.content).toContain("approval");
    expect(result.content).toContain("approval_requested:2");
    expect(result.content).toContain("workspace_write");
    expect(result.content).toContain("packages/host/src/runtime.ts");
    expect(result.content).toContain("secrets/.env");
    expect(result.content).toContain("subagent");
    expect(result.content).toContain("run_child_trace");
    expect(result.content).toContain("partial");
    expect(result.content).toContain("failing");
  });

  it("skips the summarizer when source chars exceed the hard input floor", async () => {
    const result = await compactSessionTurns(
      [
        {
          runId: createRunId(),
          goal: "Must preserve packages/core/src/session-compaction.ts.",
          message: `Verification passed. ${"source detail ".repeat(200)}`,
        },
      ],
      {
        summarizer: createDeterministicSessionSummarizer(),
        summarizerTrigger: "manual",
        summarizerBudget: { maxSourceChars: 10, maxOutputTokens: 100 },
      },
    );

    expect(result.skippedReason).toBeUndefined();
    expect(result.content).not.toContain(
      "Session deterministic-summary preview.",
    );
    expect(result.skippedStages).toContainEqual(
      expect.objectContaining({
        name: "session_summarize",
        reason: "source_over_max_source_chars",
      }),
    );
    expect(
      result.warnings?.some(
        (w) => w.code === "SESSION_SUMMARIZER_SOURCE_TOO_LARGE",
      ),
    ).toBe(true);
  });

  it("defaults auto summarization with explicit dollar cap to skip when cost is unknown", async () => {
    const result = await compactSessionTurns(
      [
        {
          runId: createRunId(),
          goal: "Must preserve docs/reference/HOST_PROTOCOL.md.",
          message: `Verification passed. ${"density detail ".repeat(200)}`,
        },
      ],
      {
        summarizer: createDeterministicSessionSummarizer(),
        summarizerTrigger: "auto",
        summarizerBudget: {
          maxSourceChars: 20_000,
          maxOutputTokens: 1_000,
          maxCostUsd: 0.01,
        },
        summarizerUsage: {
          inputTokens: 10_000,
          outputTokens: 100,
          totalTokens: 10_100,
          costUsd: 0,
          costStatus: "unavailable",
          modelCalls: 2,
          contextWindowPressure: 0.95,
        },
      },
    );

    expect(result.content).not.toContain(
      "Session deterministic-summary preview.",
    );
    expect(result.skippedStages).toContainEqual(
      expect.objectContaining({
        name: "session_summarize",
        reason: "unknown_cost_policy_skip",
      }),
    );
    expect(
      result.warnings?.some(
        (w) => w.code === "SESSION_SUMMARIZER_COST_UNAVAILABLE",
      ),
    ).toBe(true);
  });

  it("allows unknown-cost auto summarization when token_cap_only is explicit", async () => {
    const result = await compactSessionTurns(
      [
        {
          runId: createRunId(),
          goal: "Must preserve docs/reference/RUN_EVENTS.md.",
          message: `Verification passed. ${"density detail ".repeat(200)}`,
        },
      ],
      {
        summarizer: createDeterministicSessionSummarizer(),
        summarizerTrigger: "auto",
        summarizerBudget: {
          maxSourceChars: 20_000,
          maxOutputTokens: 1_000,
          maxCostUsd: 0.01,
          unknownCostPolicy: "token_cap_only",
        },
        summarizerUsage: {
          inputTokens: 10_000,
          outputTokens: 100,
          totalTokens: 10_100,
          costUsd: 0,
          costStatus: "unavailable",
          modelCalls: 2,
          contextWindowPressure: 0.95,
        },
      },
    );

    expect(result.content).toContain("Session deterministic-summary preview.");
    expect(result.appliedStages).toContainEqual(
      expect.objectContaining({ name: "session_summarize", tier: "summarize" }),
    );
    expect(
      result.warnings?.some(
        (w) => w.code === "SESSION_SUMMARIZER_COST_UNAVAILABLE",
      ),
    ).toBe(true);
  });

  it("rejects summarizer output that omits required deterministic signals", async () => {
    const badSummarizer: SessionSummarizer = {
      summarizeSession() {
        return { content: "A vague summary with no required coverage." };
      },
    };
    const result = await compactSessionTurns(
      [
        {
          runId: createRunId(),
          goal: "Must preserve packages/host/src/runtime.ts.",
          message: `Verification passed. ${"dense analysis ".repeat(200)}`,
        },
      ],
      {
        summarizer: badSummarizer,
        summarizerTrigger: "manual",
        summarizerBudget: { maxSourceChars: 20_000, maxOutputTokens: 1_000 },
      },
    );

    expect(result.content).not.toContain("A vague summary");
    expect(result.skippedStages).toContainEqual(
      expect.objectContaining({
        name: "session_summarize",
        reason: "oracle_rejected",
      }),
    );
    expect(
      result.warnings?.some(
        (w) => w.code === "SESSION_SUMMARY_ORACLE_REJECTED",
      ),
    ).toBe(true);
  });

  it("does not trust coveredSignalIds unless the content carries the signal", async () => {
    const badSummarizer: SessionSummarizer = {
      summarizeSession(input) {
        return {
          content: "A vague summary that claims coverage out of band.",
          coveredSignalIds: input.requiredSignals.entries.map(
            (signal) => signal.id,
          ),
        };
      },
    };
    const result = await compactSessionTurns(
      [
        {
          runId: createRunId(),
          goal: "Must preserve packages/core/src/session-compaction.ts.",
          message: `Verification passed. ${"dense analysis ".repeat(200)}`,
        },
      ],
      {
        summarizer: badSummarizer,
        summarizerTrigger: "manual",
        summarizerBudget: { maxSourceChars: 20_000, maxOutputTokens: 1_000 },
      },
    );

    expect(result.content).not.toContain("claims coverage");
    expect(result.skippedStages).toContainEqual(
      expect.objectContaining({
        name: "session_summarize",
        reason: "oracle_rejected",
      }),
    );
  });

  it("rejects summaries that mark required deterministic signals unknown", async () => {
    const badSummarizer: SessionSummarizer = {
      summarizeSession(input) {
        return {
          content:
            "Short summary: the model could not safely preserve details.",
          unknownSignalIds: input.requiredSignals.entries.map(
            (signal) => signal.id,
          ),
        };
      },
    };
    const result = await compactSessionTurns(
      [
        {
          runId: createRunId(),
          goal: "Must preserve packages/core/src/session-compaction.ts.",
          message: `Verification passed. ${"dense analysis ".repeat(200)}`,
        },
      ],
      {
        summarizer: badSummarizer,
        summarizerTrigger: "manual",
        summarizerBudget: { maxSourceChars: 20_000, maxOutputTokens: 1_000 },
      },
    );

    expect(result.content).not.toContain("could not safely preserve");
    expect(result.skippedStages).toContainEqual(
      expect.objectContaining({
        name: "session_summarize",
        reason: "oracle_rejected",
        metadata: expect.objectContaining({
          unknownSignalIds: expect.arrayContaining([expect.any(String)]),
        }),
      }),
    );
  });

  it("rejects a summary that drops an exact sentinel beyond the constraint prefix", async () => {
    const sentinel = "SIGNAL-COMPACT-ALPHA";
    const padding = "pad ".repeat(45);
    const goal = `Preserve exactly: ${padding}${sentinel}`;
    // The sentinel sits past the 180-char window the constraint extractor keeps,
    // so only the dedicated literal signal can guard its verbatim presence.
    expect(goal.indexOf(sentinel)).toBeGreaterThan(180);

    const droppingSummarizer: SessionSummarizer = {
      summarizeSession(input) {
        const lines = ["Faithful-looking summary."];
        for (const signal of input.requiredSignals.entries) {
          // Cover every non-literal signal honestly, but paraphrase the literal
          // away while still claiming coverage out of band.
          lines.push(
            signal.kind === "literal"
              ? "- a preserved token (paraphrased)"
              : `- [${signal.id}] ${signal.text}`,
          );
        }
        return {
          content: lines.join("\n"),
          coveredSignalIds: input.requiredSignals.entries.map(
            (signal) => signal.id,
          ),
        };
      },
    };

    const result = await compactSessionTurns(
      [
        {
          runId: createRunId(),
          goal,
          message: `Verification passed. ${"dense analysis ".repeat(200)}`,
        },
      ],
      {
        summarizer: droppingSummarizer,
        summarizerTrigger: "manual",
        summarizerBudget: { maxSourceChars: 20_000, maxOutputTokens: 1_000 },
      },
    );

    expect(result.content).not.toContain("Faithful-looking summary.");
    expect(result.content).toContain(sentinel);
    expect(result.skippedStages).toContainEqual(
      expect.objectContaining({
        name: "session_summarize",
        reason: "oracle_rejected",
        metadata: expect.objectContaining({
          missingSignalIds: expect.arrayContaining([
            expect.stringMatching(/^literal:/),
          ]),
        }),
      }),
    );
    expect(
      result.warnings?.some(
        (w) => w.code === "SESSION_SUMMARY_ORACLE_REJECTED",
      ),
    ).toBe(true);
  });

  it("accepts a summary that reproduces the exact sentinel verbatim", async () => {
    const sentinel = "SIGNAL-COMPACT-ALPHA";
    const padding = "pad ".repeat(45);
    const goal = `Preserve exactly: ${padding}${sentinel}`;

    const faithfulSummarizer: SessionSummarizer = {
      summarizeSession(input) {
        const lines = ["Compact summary."];
        for (const signal of input.requiredSignals.entries) {
          lines.push(`- [${signal.id}] ${signal.text}`);
        }
        return {
          content: lines.join("\n"),
          coveredSignalIds: input.requiredSignals.entries.map(
            (signal) => signal.id,
          ),
        };
      },
    };

    const result = await compactSessionTurns(
      [
        {
          runId: createRunId(),
          goal,
          message: `Verification passed. ${"dense analysis ".repeat(200)}`,
        },
      ],
      {
        summarizer: faithfulSummarizer,
        summarizerTrigger: "manual",
        summarizerBudget: { maxSourceChars: 20_000, maxOutputTokens: 1_000 },
      },
    );

    expect(result.content).toContain(sentinel);
    expect(result.content).toContain("Compact summary.");
    expect(result.appliedStages).toContainEqual(
      expect.objectContaining({ name: "session_summarize", tier: "summarize" }),
    );
  });

  it("times out a stuck summarizer and keeps deterministic content", async () => {
    const stuckSummarizer: SessionSummarizer = {
      summarizeSession() {
        return new Promise(() => {});
      },
    };
    const result = await compactSessionTurns(
      [
        {
          runId: createRunId(),
          goal: "Must preserve docs/reference/HOST_PROTOCOL.md.",
          message: `Verification passed. ${"dense implementation detail ".repeat(200)}`,
        },
      ],
      {
        summarizer: stuckSummarizer,
        summarizerTrigger: "manual",
        summarizerBudget: { maxSourceChars: 20_000, maxOutputTokens: 1_000 },
        summarizerTimeoutMs: 10,
      },
    );

    expect(result.content).toContain("docs/reference/HOST_PROTOCOL.md");
    expect(result.skippedStages).toContainEqual(
      expect.objectContaining({
        name: "session_summarize",
        reason: "summarizer_failed",
      }),
    );
    expect(
      result.warnings?.some(
        (warning) =>
          warning.code === "SESSION_SUMMARIZER_FAILED" &&
          warning.message.includes("timed out"),
      ),
    ).toBe(true);
  });

  it("measures a density/regime corpus for P3d evaluation", async () => {
    const duplicateGoal =
      "Repeat the same request for packages/core/src/session-compaction.ts.";
    const duplicateMessage = `Must preserve the same answer. ${"duplicate detail ".repeat(100)}`;
    const denseRunId = createRunId();
    const report = await measureSessionCompactionCorpus([
      {
        id: "redundancy",
        expectedRegime: "redundancy_bound",
        turns: [
          {
            runId: createRunId(),
            goal: duplicateGoal,
            message: duplicateMessage,
          },
          {
            runId: createRunId(),
            goal: duplicateGoal,
            message: duplicateMessage,
          },
        ],
      },
      {
        id: "density",
        expectedRegime: "density_bound",
        turns: [
          {
            runId: denseRunId,
            goal: "Must preserve docs/reference/HOST_PROTOCOL.md.",
            message: `Verification passed. ${"dense implementation detail ".repeat(220)}`,
          },
        ],
        options: {
          summarizer: createDeterministicSessionSummarizer(),
          summarizerTrigger: "manual",
          summarizerBudget: { maxSourceChars: 20_000, maxOutputTokens: 1_000 },
        },
      },
    ]);

    expect(report.totals.caseCount).toBe(2);
    expect(report.totals.byRegime.redundancy_bound).toBe(1);
    expect(report.totals.byRegime.density_bound).toBe(1);
    expect(report.cases.every((entry) => entry.passedExpectedRegime)).toBe(
      true,
    );
    expect(report.totals.freedChars).toBeGreaterThan(0);
  });

  it("keeps auto summarization dormant in a redundancy-bound regime", async () => {
    const goal =
      "Repeat the same request for packages/core/src/session-compaction.ts.";
    const message = `Must preserve the same answer. ${"duplicate detail ".repeat(100)}`;
    const result = await compactSessionTurns(
      [
        { runId: createRunId(), goal, message },
        { runId: createRunId(), goal, message },
      ],
      {
        summarizer: createDeterministicSessionSummarizer(),
        summarizerTrigger: "auto",
        summarizerBudget: { maxSourceChars: 20_000, maxOutputTokens: 1_000 },
        summarizerUsage: {
          inputTokens: 10_000,
          outputTokens: 100,
          totalTokens: 10_100,
          costUsd: 0,
          costStatus: "estimated",
          modelCalls: 2,
          contextWindowPressure: 0.95,
        },
      },
    );

    expect(result.content).not.toContain(
      "Session deterministic-summary preview.",
    );
    expect(result.appliedStages.some((stage) => stage.tier === "dedup")).toBe(
      true,
    );
    expect(
      result.appliedStages.some((stage) => stage.tier === "summarize"),
    ).toBe(false);
  });
});
