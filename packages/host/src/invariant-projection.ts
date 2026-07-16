import {
  commandExpectationSatisfied,
  createContextItemId,
  createRunId,
  type ContextItem,
  type FactLedgerSnapshot,
  type WorkflowHook,
  type WorkflowHookInput,
  type WorkflowHookResult,
} from "@sparkwright/core";
import type { WorkflowCommandVerifierDefinition } from "@sparkwright/agent-runtime";
import type { CapabilityWorkflowHookConfig } from "./config-zod-schema.js";
import {
  createConfiguredWorkflowHooks,
  type CreateConfiguredWorkflowHooksOptions,
} from "./workflow-hooks.js";

export type InvariantProjectionFailureSource = "profile" | "documented_command";

export interface CreateInvariantProjectionHooksOptions extends Omit<
  CreateConfiguredWorkflowHooksOptions,
  "hooks" | "workflowActive"
> {
  workflowRunId?: string;
  assetName: string;
  contentHash: string;
  verificationSource: InvariantProjectionFailureSource;
  profile?: string;
  verifiers: WorkflowCommandVerifierDefinition[];
  guidance?: string;
  injectOutput?: "always" | "onFailure" | "never";
  builtinVerifiers?: Record<string, InvariantBuiltinVerifierHandler>;
}

export interface InvariantProjectionHookSet {
  workflowRunId: string;
  hooks: WorkflowHook[];
}

export interface InvariantBuiltinVerifierInput {
  workflowRunId: string;
  verifier: WorkflowCommandVerifierDefinition;
  hookInput: WorkflowHookInput;
}

export type InvariantBuiltinVerifierHandler = (
  input: InvariantBuiltinVerifierInput,
) => WorkflowHookResult | void | Promise<WorkflowHookResult | void>;

interface VerifierFailure {
  verifierId: string;
  reason: "missing" | "failed" | "stale";
  satisfied?: boolean;
  stale?: boolean;
  exitCode?: number | null;
  timedOut?: boolean;
  command?: string;
  args?: string[];
  stdout?: string;
  stderr?: string;
  metadata?: Record<string, unknown>;
}

interface PendingRetry {
  writeEpoch: number;
  failures: VerifierFailure[];
}

export function createInvariantProjectionHooks(
  options: CreateInvariantProjectionHooksOptions,
): InvariantProjectionHookSet {
  const workflowRunId = options.workflowRunId ?? `invariant_${createRunId()}`;
  const familyName = `workflow:${workflowRunId}`;
  const lastMetadataByVerifier = new Map<string, Record<string, unknown>>();
  let terminalEmitted = false;
  let pendingRetry: PendingRetry | undefined;

  const emit = (
    input: WorkflowHookInput,
    type: Parameters<NonNullable<WorkflowHookInput["events"]>["emit"]>[0],
    payload: Record<string, unknown>,
  ): void => {
    input.events?.emit(type, {
      workflowRunId,
      assetName: options.assetName,
      contentHash: options.contentHash,
      projectionKind: "invariant",
      verificationSource: options.verificationSource,
      ...(options.profile ? { profile: options.profile } : {}),
      ...payload,
    });
  };

  const emitFailure = (
    input: WorkflowHookInput,
    reason: string,
    failures: VerifierFailure[],
    metadata: Record<string, unknown> = {},
  ): void => {
    if (terminalEmitted) return;
    terminalEmitted = true;
    emit(input, "workflow.failed", {
      reason,
      failures,
      failure: {
        kind: "verification",
        code:
          options.verificationSource === "documented_command"
            ? "DOCUMENTED_COMMAND_FAILED"
            : "VERIFICATION_PROFILE_FAILED",
        message: reason,
        metadata: {
          verificationSource: options.verificationSource,
          ...(options.profile ? { profile: options.profile } : {}),
          ...metadata,
        },
      },
    });
  };

  const verifierHooks = options.verifiers.map((verifier) =>
    invariantVerifierHook({
      ...options,
      familyName,
      workflowRunId,
      verifier,
      lastMetadataByVerifier,
    }),
  );

  const hooks: WorkflowHook[] = [
    ...verifierHooks,
    {
      name: familyName,
      id: "invariant-start",
      hook: "RunStart",
      onError: "continue",
      handle(input) {
        emit(input, "workflow.started", {
          status: "running",
        });
        return { status: "continue", metadata: invariantMetadata(options) };
      },
    },
    {
      name: familyName,
      id: "invariant-guidance",
      hook: "TurnStart",
      onError: "continue",
      handle() {
        pendingRetry = undefined;
        if (!options.guidance) {
          return { status: "continue", metadata: invariantMetadata(options) };
        }
        return {
          status: "continue",
          context: [guidanceContextItem(workflowRunId, options.guidance)],
          metadata: invariantMetadata(options),
        };
      },
    },
    {
      name: familyName,
      id: "invariant-settlement",
      hook: "Stop",
      onError: "block",
      handle(input) {
        const snapshot = input.facts?.snapshot();
        if (!snapshot) {
          return {
            status: "block",
            reason: "Invariant projection requires FactLedger access.",
            metadata: invariantMetadata(options),
          };
        }
        const status = invariantStatus(
          snapshot,
          familyName,
          options.verifiers,
          lastMetadataByVerifier,
        );
        if (status.kind === "no_writes" || status.kind === "clean") {
          pendingRetry = undefined;
          return {
            status: "continue",
            metadata: {
              ...invariantMetadata(options),
              writeEpoch: snapshot.writeEpoch,
              invariantStatus: status.kind,
            },
          };
        }
        pendingRetry = {
          writeEpoch: snapshot.writeEpoch,
          failures: status.failures,
        };
        return {
          status: "advance",
          reason: invariantRetryReason(options, status.failures),
          context: retryEvidenceContext(
            workflowRunId,
            options,
            snapshot.writeEpoch,
            status.failures,
          ),
          metadata: {
            ...invariantMetadata(options),
            writeEpoch: snapshot.writeEpoch,
            failures: status.failures,
          },
        };
      },
    },
    {
      name: familyName,
      id: "invariant-runtime-signal",
      hook: "RuntimeSignal",
      onError: "continue",
      handle(input) {
        const payload = isRecord(input.payload) ? input.payload : {};
        if (
          stringValue(payload.signal) === "budget.exceeded" &&
          stringValue(payload.source) === "workflow" &&
          pendingRetry
        ) {
          const retry = pendingRetry;
          pendingRetry = undefined;
          emitFailure(
            input,
            "Invariant verification could not pass before the workflow continuation budget was exhausted.",
            retry.failures,
            { writeEpoch: retry.writeEpoch, source: "workflow" },
          );
        }
        return { status: "continue", metadata: invariantMetadata(options) };
      },
    },
    {
      name: familyName,
      id: "invariant-run-end",
      hook: "RunEnd",
      onError: "continue",
      handle(input) {
        const payload = isRecord(input.payload) ? input.payload : {};
        const runState = stringValue(payload.state);
        if (runState === "cancelled") {
          emit(input, "workflow.interrupted", {
            kind: "cancelled",
            reason: stringValue(payload.reason),
          });
          if (!terminalEmitted) {
            terminalEmitted = true;
            emit(input, "workflow.cancelled", {
              reason: stringValue(payload.reason) ?? "manual_cancelled",
            });
          }
          return { status: "continue", metadata: invariantMetadata(options) };
        }
        if (runState === "failed") {
          emit(input, "workflow.interrupted", {
            kind: "run_failed",
            reason: stringValue(payload.reason),
          });
          return { status: "continue", metadata: invariantMetadata(options) };
        }
        if (runState !== "completed" || terminalEmitted) {
          return { status: "continue", metadata: invariantMetadata(options) };
        }
        const snapshot = input.facts?.snapshot();
        if (!snapshot) {
          return { status: "continue", metadata: invariantMetadata(options) };
        }
        const status = invariantStatus(
          snapshot,
          familyName,
          options.verifiers,
          lastMetadataByVerifier,
        );
        if (status.kind === "no_writes" || status.kind === "clean") {
          terminalEmitted = true;
          emit(input, "workflow.completed", {
            reason: status.kind,
            writeEpoch: snapshot.writeEpoch,
          });
        } else {
          emitFailure(
            input,
            "Invariant verification failed at run end.",
            status.failures,
            {
              writeEpoch: snapshot.writeEpoch,
            },
          );
        }
        return { status: "continue", metadata: invariantMetadata(options) };
      },
    },
  ];

  return { workflowRunId, hooks };
}

function invariantVerifierHook(
  input: CreateInvariantProjectionHooksOptions & {
    familyName: string;
    workflowRunId: string;
    verifier: WorkflowCommandVerifierDefinition;
    lastMetadataByVerifier: Map<string, Record<string, unknown>>;
  },
): WorkflowHook {
  const builtinVerifier = stringValue(input.verifier.metadata?.builtinVerifier);
  const builtinHandler = builtinVerifier
    ? input.builtinVerifiers?.[builtinVerifier]
    : undefined;
  if (builtinVerifier && !builtinHandler) {
    throw new Error(
      `Invariant verifier "${input.verifier.id}" references unknown built-in verifier "${builtinVerifier}".`,
    );
  }
  const inner = builtinHandler
    ? undefined
    : commandVerifierWorkflowHook(input, input.verifier);
  return {
    name: input.familyName,
    id: "invariant-command-verifier",
    hook: "Stop",
    onError: "block",
    async handle(hookInput) {
      const snapshot = hookInput.facts?.snapshot();
      if (!snapshot) {
        return {
          status: "block",
          reason: "Invariant verifier requires FactLedger access.",
          metadata: invariantMetadata(input),
        };
      }
      if (snapshot.writeEpoch === 0) {
        return skippedVerifierResult(input, "no workspace writes in this run");
      }
      const latest = latestVerifierResult(
        snapshot,
        input.familyName,
        input.verifier.id,
      );
      if (isCurrentEpochSatisfied(snapshot, latest)) {
        return skippedVerifierResult(
          input,
          "current write epoch already passed",
        );
      }
      const expect = input.verifier.expect ?? "zero";
      const verifierInput = {
        ...hookInput,
        metadata: {
          ...hookInput.metadata,
          ...invariantMetadata(input),
          workflowRunId: input.workflowRunId,
          verifierId: input.verifier.id,
          expect,
        },
      };
      const result = builtinHandler
        ? await builtinHandler({
            workflowRunId: input.workflowRunId,
            verifier: input.verifier,
            hookInput: verifierInput,
          })
        : await inner!.handle(verifierInput);
      const withMetadata = withVerifierMetadata(result, {
        workflowRunId: input.workflowRunId,
        verifier: input.verifier,
        expect,
      });
      const metadata = isRecord(withMetadata.metadata)
        ? withMetadata.metadata
        : {};
      input.lastMetadataByVerifier.set(input.verifier.id, metadata);
      return withMetadata;
    },
  };
}

function commandVerifierWorkflowHook(
  input: CreateInvariantProjectionHooksOptions & { familyName: string },
  verifier: WorkflowCommandVerifierDefinition,
): WorkflowHook {
  const [inner] = createConfiguredWorkflowHooks({
    ...input,
    hooks: [
      {
        name: input.familyName,
        hook: "Stop",
        action: {
          type: "command",
          command: verifier.command,
          args: verifier.args ?? [],
          ...(verifier.cwd ? { cwd: verifier.cwd } : {}),
          ...(verifier.timeoutMs !== undefined
            ? { timeoutMs: verifier.timeoutMs }
            : {}),
          ...(verifier.maxOutputBytes !== undefined
            ? { maxOutputBytes: verifier.maxOutputBytes }
            : {}),
          injectOutput: "never",
        },
      } satisfies CapabilityWorkflowHookConfig,
    ],
  });
  if (!inner) {
    throw new Error(`Failed to compile invariant verifier "${verifier.id}".`);
  }
  return inner;
}

function withVerifierMetadata(
  result: WorkflowHookResult | void,
  input: {
    workflowRunId: string;
    verifier: WorkflowCommandVerifierDefinition;
    expect: "zero" | "nonzero";
  },
): WorkflowHookResult {
  const base = result ?? { status: "continue" };
  const metadata = isRecord(base.metadata) ? base.metadata : {};
  const exitCode = numberOrNullValue(metadata.exitCode);
  const timedOut = metadata.timedOut === true;
  const verifierMetadata = isRecord(input.verifier.metadata)
    ? input.verifier.metadata
    : {};
  const satisfied = commandExpectationSatisfied(input.expect, {
    exitCode,
    timedOut,
  });
  return {
    ...base,
    metadata: {
      ...verifierMetadata,
      ...metadata,
      workflowRunId: input.workflowRunId,
      projectionKind: "invariant",
      verifierId: input.verifier.id,
      expect: input.expect,
      satisfied,
    },
  };
}

function invariantStatus(
  snapshot: FactLedgerSnapshot,
  hookName: string,
  verifiers: readonly WorkflowCommandVerifierDefinition[],
  lastMetadataByVerifier: Map<string, Record<string, unknown>>,
):
  | { kind: "no_writes" }
  | { kind: "clean" }
  | { kind: "dirty"; failures: VerifierFailure[] } {
  if (snapshot.writeEpoch === 0) return { kind: "no_writes" };
  const failures = verifiers.flatMap((verifier) => {
    const latest = latestVerifierResult(snapshot, hookName, verifier.id);
    if (isCurrentEpochSatisfied(snapshot, latest)) return [];
    const metadata = lastMetadataByVerifier.get(verifier.id);
    return [
      verifierFailureFromLatest(
        verifier,
        latest,
        snapshot.writeEpoch,
        metadata,
      ),
    ];
  });
  return failures.length === 0
    ? { kind: "clean" }
    : { kind: "dirty", failures };
}

function latestVerifierResult(
  snapshot: FactLedgerSnapshot,
  hookName: string,
  verifierId: string,
): FactLedgerSnapshot["verificationResults"][number] | undefined {
  return snapshot.verificationResults
    .filter(
      (result) =>
        result.hookName === hookName && result.verifierId === verifierId,
    )
    .sort((left, right) => left.sequence - right.sequence)
    .at(-1);
}

function isCurrentEpochSatisfied(
  snapshot: FactLedgerSnapshot,
  result: FactLedgerSnapshot["verificationResults"][number] | undefined,
): boolean {
  return (
    result?.writeEpoch === snapshot.writeEpoch &&
    result.satisfied === true &&
    result.stale !== true
  );
}

function verifierFailureFromLatest(
  verifier: WorkflowCommandVerifierDefinition,
  latest: FactLedgerSnapshot["verificationResults"][number] | undefined,
  writeEpoch: number,
  metadata: Record<string, unknown> | undefined,
): VerifierFailure {
  const reason =
    latest === undefined
      ? "missing"
      : latest.writeEpoch !== writeEpoch || latest.stale === true
        ? "stale"
        : "failed";
  return {
    verifierId: verifier.id,
    reason,
    ...(latest ? { satisfied: latest.satisfied, stale: latest.stale } : {}),
    ...(latest ? { exitCode: latest.exitCode, timedOut: latest.timedOut } : {}),
    command: stringValue(metadata?.command) ?? verifier.command,
    args: stringArrayValue(metadata?.args) ?? verifier.args ?? [],
    ...(stringValue(metadata?.stdout)
      ? { stdout: stringValue(metadata?.stdout) }
      : {}),
    ...(stringValue(metadata?.stderr)
      ? { stderr: stringValue(metadata?.stderr) }
      : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function retryEvidenceContext(
  workflowRunId: string,
  options: CreateInvariantProjectionHooksOptions,
  writeEpoch: number,
  failures: readonly VerifierFailure[],
): ContextItem[] {
  const policy = options.injectOutput ?? "onFailure";
  if (policy === "never") return [];
  return [
    {
      id: createContextItemId(),
      type: "summary",
      source: { kind: "extension", uri: `workflow:${workflowRunId}` },
      content: JSON.stringify({
        projectionKind: "invariant",
        verificationSource: options.verificationSource,
        ...(options.profile ? { profile: options.profile } : {}),
        writeEpoch,
        failures,
        guidance:
          "Required invariant verification has not passed for the latest workspace write. Fix the reported failures, then allow verification to run again.",
      }),
      metadata: {
        layer: "working",
        stability: "turn",
        workflowRunId,
        projectionKind: "invariant",
        verificationSource: options.verificationSource,
        ...(options.profile ? { profile: options.profile } : {}),
        writeEpoch,
      },
    },
  ];
}

function guidanceContextItem(
  workflowRunId: string,
  content: string,
): ContextItem {
  return {
    id: createContextItemId(),
    type: "system",
    source: { kind: "extension", uri: `workflow:${workflowRunId}:guidance` },
    content,
    metadata: {
      layer: "working",
      stability: "turn",
      workflowRunId,
      projectionKind: "invariant",
    },
  };
}

function invariantRetryReason(
  options: CreateInvariantProjectionHooksOptions,
  failures: readonly VerifierFailure[],
): string {
  const label =
    options.verificationSource === "documented_command"
      ? "Documented-command invariant"
      : `Verification profile${options.profile ? ` "${options.profile}"` : ""}`;
  return `${label} has not passed for the latest workspace write. Missing or failed: ${failures
    .map((failure) => failure.verifierId)
    .join(", ")}.`;
}

function skippedVerifierResult(
  input: CreateInvariantProjectionHooksOptions & {
    workflowRunId: string;
    verifier: WorkflowCommandVerifierDefinition;
  },
  reason: string,
): WorkflowHookResult {
  return {
    status: "skipped",
    reason,
    metadata: {
      ...invariantMetadata(input),
      workflowRunId: input.workflowRunId,
      verifierId: input.verifier.id,
    },
  };
}

function invariantMetadata(input: {
  verificationSource: InvariantProjectionFailureSource;
  profile?: string;
}): Record<string, unknown> {
  return {
    projectionKind: "invariant",
    verificationSource: input.verificationSource,
    ...(input.profile ? { profile: input.profile } : {}),
  };
}

function numberOrNullValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  return Array.isArray(value) &&
    value.every((entry): entry is string => typeof entry === "string")
    ? value
    : undefined;
}
