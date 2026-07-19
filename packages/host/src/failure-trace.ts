import { join } from "node:path";
import {
  assessRun,
  createRunId,
  createSessionId,
  createSessionRunStoreFactory,
  FileSessionStore,
  type RunRecord,
  type RunResult,
} from "@sparkwright/core";
import {
  createSessionFileRunStoreFactory,
  EventLog,
} from "@sparkwright/core/internal";
import type { RunAccessMode, TraceLevel } from "@sparkwright/protocol";

export interface HostStartFailureTraceInput {
  goal: string;
  message: string;
  sessionRootDir: string;
  source: string;
  sessionId?: string;
  runId?: string;
  traceLevel?: TraceLevel;
  targetPath?: string;
  accessMode?: RunAccessMode;
  metadata?: Record<string, unknown>;
}

export type HostClientStartFailureInput = Omit<
  HostStartFailureTraceInput,
  "goal"
> & {
  goal?: string;
  /** @reserved Public host-client diagnostic field consumed by start-failure trace writers. */
  resumeRunId?: string;
};

export interface HostStartFailureTraceResult {
  tracePath?: string;
  sessionId?: string;
  runId?: string;
}

export async function recordHostClientStartFailure(
  input: HostClientStartFailureInput,
): Promise<HostStartFailureTraceResult> {
  const { resumeRunId, ...traceInput } = input;
  return writeHostStartFailureTrace({
    ...traceInput,
    goal: input.goal ?? (resumeRunId ? `resume ${resumeRunId}` : "start host"),
  });
}

export async function writeHostStartFailureTrace(
  input: HostStartFailureTraceInput,
): Promise<HostStartFailureTraceResult> {
  const sessionId = input.sessionId ?? createSessionId();
  const runId = (input.runId ?? createRunId()) as RunRecord["id"];
  const now = new Date().toISOString();
  const traceLevel = input.traceLevel ?? "standard";
  const metadata = {
    source: input.source,
    failurePhase: "host_start",
    ...(input.targetPath ? { targetPath: input.targetPath } : {}),
    ...(input.accessMode !== undefined ? { accessMode: input.accessMode } : {}),
    traceLevel,
    ...input.metadata,
  };
  const run: RunRecord = {
    id: runId,
    goal: input.goal,
    state: "failed",
    stopReason: "model_completion_failed",
    createdAt: now,
    updatedAt: now,
    metadata,
  };
  const result: RunResult = {
    signal: "failed",
    state: "failed",
    stopReason: "model_completion_failed",
    message: input.message,
    failure: {
      category: "runtime",
      code: "HOST_START_FAILED",
      message: input.message,
      retryable: false,
    },
    assessment: assessRun([], {
      terminal: {
        state: "failed",
        reason: "model_completion_failed",
        failure: { code: "HOST_START_FAILED" },
      },
    }),
    metadata,
  };

  try {
    const sessionStore = new FileSessionStore({
      rootDir: input.sessionRootDir,
    });
    const store = createSessionRunStoreFactory({
      sessionStore,
      sessionId,
      runStoreFactory: createSessionFileRunStoreFactory({
        sessionRootDir: input.sessionRootDir,
        sessionId,
        agentId: "main",
        traceLevel,
      }),
      metadata: { source: input.source },
    })(run);
    const events = new EventLog(runId);
    await store.append(
      events.emit(
        "run.created",
        { goal: input.goal },
        { source: input.source },
      ),
    );
    const capabilityFailure = inferCapabilityIndexFailure(input.message);
    if (capabilityFailure) {
      await store.append(
        events.emit(
          "capability.index.failed",
          {
            kind: capabilityFailure.kind,
            source: capabilityFailure.source,
            message: input.message,
            code: capabilityFailure.code,
          },
          {
            source: input.source,
            failurePhase: "host_start",
          },
        ),
      );
    }
    await store.append(
      events.emit(
        "run.failed",
        {
          reason: "host_start_failed",
          code: "HOST_START_FAILED",
          message: input.message,
          failure: {
            category: "runtime",
            code: "HOST_START_FAILED",
            message: input.message,
            retryable: false,
          },
          assessment: result.assessment,
          metadata,
        },
        { source: input.source },
      ),
    );
    await store.finish(run, result);
    return {
      tracePath: join(input.sessionRootDir, sessionId, "trace.jsonl"),
      sessionId,
      runId,
    };
  } catch {
    return { sessionId: input.sessionId, runId: input.runId };
  }
}

function inferCapabilityIndexFailure(message: string):
  | {
      kind: "skills";
      code: "SKILL_INDEX_FAILED";
      source?: string;
    }
  | undefined {
  if (!/\bskill\b/i.test(message)) return undefined;
  const source = message.match(/(?:^|\s)(\/[^\n:]+SKILL\.md)\b/)?.[1];
  return {
    kind: "skills",
    code: "SKILL_INDEX_FAILED",
    ...(source ? { source } : {}),
  };
}
