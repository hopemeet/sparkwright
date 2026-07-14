import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  FileSessionStore,
  SESSION_COMPACT_SCHEMA_VERSION,
  asSessionId,
  compactSessionTurns,
  createDeterministicSessionSummarizer,
  writeSessionCompactArtifact,
  type CompactionWarning,
  type ContextUsageHint,
  type SessionCompactionMeasurement,
  type SessionCompactionOptions,
  type SessionCompactionTurn,
} from "@sparkwright/core";
import type { ProtocolError } from "@sparkwright/protocol";
import { DETERMINISTIC_PROVIDER } from "./config/contracts.js";
import {
  loadHostConfig,
  type TaskConfig,
} from "./config/config-implementation.js";
import { createModel, type ResolvedModelConfig } from "./model-factory.js";
import { createModelSessionSummarizer } from "./session-summarizer.js";
import {
  sessionRootDirFor,
  type SessionQueryContext,
} from "./session-queries.js";

export interface SessionCompactionContext extends SessionQueryContext {
  defaultModel?: string;
}

export type SessionCompactSuccessResult = {
  ok: true;
  sessionId: string;
  compactedRunCount: number;
  throughRunId: string | null;
  originalCharCount: number;
  summaryCharCount: number;
  freedChars: number;
  measurement: SessionCompactionMeasurement;
  skippedReason?: string;
  warnings?: CompactionWarning[];
  artifactPath: string | null;
};

export type SessionCompactResult =
  | SessionCompactSuccessResult
  | { ok: false; error: ProtocolError };

export async function compactHostSession(input: {
  context: SessionCompactionContext;
  sessionId: string;
  reason?: string;
  manualLlm?: boolean;
  turns: SessionCompactionTurn[];
}): Promise<SessionCompactResult> {
  let safeSessionId: string;
  try {
    safeSessionId = asSessionId(input.sessionId);
  } catch (error) {
    return protocolFailure("invalid_payload", error);
  }
  const sessionRootDir = sessionRootDirFor(input.context);
  try {
    if (!(await stat(join(sessionRootDir, safeSessionId))).isDirectory()) {
      return sessionNotFound(input.sessionId);
    }
  } catch {
    return sessionNotFound(input.sessionId);
  }

  const loaded = await loadHostConfig(input.context.workspaceRoot);
  const prepared = await sessionCompactionOptionsForTask({
    context: input.context,
    reason: input.reason,
    taskConfig: loaded.config.tasks?.compaction,
    manualLlm: input.manualLlm === true,
  });
  let compacted: Awaited<ReturnType<typeof compactSessionTurns>>;
  try {
    compacted = await compactSessionTurns(input.turns, prepared.options);
  } catch (error) {
    const originalCharCount = input.turns.reduce(
      (sum, turn) => sum + turn.goal.length + turn.message.length,
      0,
    );
    return await recordSessionCompactionEvent(sessionRootDir, input.reason, {
      ok: true,
      sessionId: safeSessionId,
      compactedRunCount: 0,
      throughRunId: null,
      originalCharCount,
      summaryCharCount: originalCharCount,
      freedChars: 0,
      measurement: emptySessionCompactionMeasurement({
        sourceRunCount: input.turns.length,
        originalCharCount,
      }),
      artifactPath: null,
      skippedReason: "compaction_failed",
      warnings: mergeCompactionWarnings(prepared.warnings, [
        {
          code: "SESSION_COMPACTION_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      ]),
    });
  }
  const warnings = mergeCompactionWarnings(
    prepared.warnings,
    compacted.warnings,
  );
  if (compacted.skippedReason !== undefined) {
    return await recordSessionCompactionEvent(sessionRootDir, input.reason, {
      ok: true,
      sessionId: safeSessionId,
      compactedRunCount: compacted.compactedRunCount,
      throughRunId: compacted.throughRunId,
      originalCharCount: compacted.originalCharCount,
      summaryCharCount: compacted.summaryCharCount,
      freedChars: compacted.freedChars,
      measurement: compacted.measurement,
      artifactPath: null,
      skippedReason: compacted.skippedReason,
      warnings,
    });
  }
  try {
    const artifactPath = await writeSessionCompactArtifact({
      sessionRootDir,
      artifact: {
        schemaVersion: SESSION_COMPACT_SCHEMA_VERSION,
        sessionId: asSessionId(safeSessionId),
        createdAt: new Date().toISOString(),
        throughRunId: compacted.throughRunId,
        compactedRunCount: compacted.compactedRunCount,
        sourceRunIds: compacted.sourceRunIds,
        content: compacted.content,
        originalCharCount: compacted.originalCharCount,
        summaryCharCount: compacted.summaryCharCount,
        freedChars: compacted.freedChars,
        metadata: sessionCompactArtifactMetadata({
          compacted,
          warnings,
          reason: input.reason,
        }),
      },
    });
    return await recordSessionCompactionEvent(sessionRootDir, input.reason, {
      ok: true,
      sessionId: safeSessionId,
      compactedRunCount: compacted.compactedRunCount,
      throughRunId: compacted.throughRunId,
      originalCharCount: compacted.originalCharCount,
      summaryCharCount: compacted.summaryCharCount,
      freedChars: compacted.freedChars,
      measurement: compacted.measurement,
      artifactPath,
      warnings,
    });
  } catch (error) {
    return await recordSessionCompactionEvent(sessionRootDir, input.reason, {
      ok: true,
      sessionId: safeSessionId,
      compactedRunCount: 0,
      throughRunId: null,
      originalCharCount: compacted.originalCharCount,
      summaryCharCount: compacted.originalCharCount,
      freedChars: 0,
      measurement: {
        ...compacted.measurement,
        summaryCharCount: compacted.originalCharCount,
        freedChars: 0,
        savingsRatio: 0,
        regime: "no_savings",
      },
      artifactPath: null,
      skippedReason: "artifact_write_failed",
      warnings: [
        ...(warnings ?? []),
        {
          code: "SESSION_COMPACT_ARTIFACT_WRITE_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    });
  }
}

async function recordSessionCompactionEvent(
  sessionRootDir: string,
  reason: string | undefined,
  result: SessionCompactSuccessResult,
): Promise<SessionCompactSuccessResult> {
  const store = new FileSessionStore({ rootDir: sessionRootDir });
  try {
    await store.appendEvent(result.sessionId, {
      type: result.skippedReason
        ? "session.compaction.skipped"
        : "session.compaction.completed",
      payload: {
        compactedRunCount: result.compactedRunCount,
        throughRunId: result.throughRunId,
        originalCharCount: result.originalCharCount,
        summaryCharCount: result.summaryCharCount,
        freedChars: result.freedChars,
        measurement: result.measurement,
        artifactPath: result.artifactPath,
        ...(result.skippedReason
          ? { skippedReason: result.skippedReason }
          : {}),
        ...(result.warnings
          ? { warningCodes: result.warnings.map((warning) => warning.code) }
          : {}),
      },
      metadata: { source: "host", ...(reason ? { reason } : {}) },
    });
    return result;
  } catch (error) {
    return {
      ...result,
      warnings: mergeCompactionWarnings(result.warnings, [
        {
          code: "SESSION_COMPACTION_EVENT_WRITE_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      ]),
    };
  }
}

async function sessionCompactionOptionsForTask(input: {
  context: SessionCompactionContext;
  reason?: string;
  taskConfig?: TaskConfig;
  manualLlm: boolean;
}): Promise<{
  options: SessionCompactionOptions;
  warnings?: CompactionWarning[];
}> {
  const enabled = input.manualLlm || input.taskConfig?.enabled === true;
  const options: SessionCompactionOptions = { reason: input.reason };
  if (!enabled) return { options };
  const model = await createModel({
    modelRef: input.taskConfig?.model ?? input.context.defaultModel,
    goal: "Summarize completed session history for future context.",
    workspaceRoot: input.context.workspaceRoot,
  });
  if (!model.ok) {
    return {
      options,
      warnings: [
        {
          code: "SESSION_SUMMARIZER_MODEL_UNAVAILABLE",
          message: model.message,
        },
      ],
    };
  }
  const modelId = model.resolved.modelRef;
  const deterministic = model.resolved.providerKey === DETERMINISTIC_PROVIDER;
  return {
    options: {
      ...options,
      summarizer: deterministic
        ? createDeterministicSessionSummarizer()
        : createModelSessionSummarizer({ model: model.adapter, modelId }),
      summarizerTrigger: input.manualLlm ? "manual" : "auto",
      summarizerBudget: input.taskConfig?.budget,
      summarizerUsage: sessionSummarizerUsageHint(model.resolved),
      summarizerModelId: modelId,
    },
    warnings:
      deterministic && input.manualLlm
        ? [
            {
              code: "SESSION_SUMMARIZER_DETERMINISTIC_PREVIEW",
              message:
                "Session compaction used the deterministic summarizer preview because the resolved compaction model is deterministic.",
            },
          ]
        : undefined,
  };
}

function mergeCompactionWarnings(
  ...groups: Array<CompactionWarning[] | undefined>
): CompactionWarning[] | undefined {
  const warnings = groups.flatMap((group) => group ?? []);
  return warnings.length > 0 ? warnings : undefined;
}

function sessionSummarizerUsageHint(
  resolved: ResolvedModelConfig,
): ContextUsageHint {
  const unavailable = resolved.pricingSource === "unavailable";
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    modelCalls: 0,
    costStatus: unavailable ? "unavailable" : "estimated",
    ...(unavailable ? { costUnavailableReasons: { missing_pricing: 1 } } : {}),
  };
}

function sessionCompactArtifactMetadata(input: {
  compacted: {
    appliedStages: Array<{ tier: string; metadata?: Record<string, unknown> }>;
    skippedStages: Array<Record<string, unknown>>;
    measurement: SessionCompactionMeasurement;
  };
  warnings?: CompactionWarning[];
  reason?: string;
}): Record<string, unknown> {
  const summarizeMetadata = input.compacted.appliedStages.find(
    (stage) => stage.tier === "summarize",
  )?.metadata;
  const mode =
    recordString(summarizeMetadata, "mode") === "llm"
      ? "llm"
      : "deterministic-v2";
  const summaryFingerprint = isPlainRecord(
    summarizeMetadata?.summaryFingerprint,
  )
    ? { ...summarizeMetadata.summaryFingerprint }
    : undefined;
  return {
    source: "host",
    mode,
    appliedStages: input.compacted.appliedStages,
    skippedStages: input.compacted.skippedStages,
    measurement: input.compacted.measurement,
    ...(summaryFingerprint ? { summaryFingerprint } : {}),
    ...(input.warnings ? { warnings: input.warnings } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

function emptySessionCompactionMeasurement(input: {
  sourceRunCount: number;
  originalCharCount: number;
}): SessionCompactionMeasurement {
  return {
    sourceRunCount: input.sourceRunCount,
    originalCharCount: input.originalCharCount,
    summaryCharCount: input.originalCharCount,
    freedChars: 0,
    savingsRatio: 0,
    freedByTier: { dedup: 0, extract: 0, evict: 0, summarize: 0 },
    regime: "no_savings",
    signalCount: 0,
  };
}

function sessionNotFound(sessionId: string): {
  ok: false;
  error: ProtocolError;
} {
  return {
    ok: false,
    error: {
      code: "session_not_found",
      message: `session not found: ${sessionId}`,
    },
  };
}

function protocolFailure(
  code: ProtocolError["code"],
  error: unknown,
): { ok: false; error: ProtocolError } {
  return {
    ok: false,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function recordString(value: unknown, key: string): string | undefined {
  return isPlainRecord(value) && typeof value[key] === "string"
    ? value[key]
    : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
