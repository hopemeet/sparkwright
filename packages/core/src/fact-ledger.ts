import type { SparkwrightEvent } from "./events.js";
import {
  commandExpectationSatisfied,
  commandExpectationValue,
  forcedContinuationBudgetExceededFromEvent,
  hookCommandFactFromWorkflowHookCompleted,
  shellCommandFactFromToolCompleted,
  shellCommandRequestFromEvent,
  workspaceWriteFactFromEvent,
  isVerificationGoal,
  type ClassifiedCommandFactInput,
  type CommandExpectation,
  type ForcedContinuationBudgetExceededFactInput,
  type ShellCommandRequestFact,
} from "./fact-classifier.js";
import type { ForcedContinuationSource } from "./types.js";
import { isRecord } from "./record-utils.js";

export type FactLedgerCommandInitiator =
  | "model-initiated"
  | "verifier-launched";

export type FactLedgerCommandSource = "shell_tool" | "workflow_hook";

export interface FactLedgerEpochMarker {
  writeEpoch: number;
}

export interface FactLedgerCommandFact {
  id: string;
  source: FactLedgerCommandSource;
  initiator: FactLedgerCommandInitiator;
  sequence: number;
  writeEpoch: number;
  stale: boolean;
  toolCallId?: string;
  toolName?: string;
  hookName?: string;
  hook?: string;
  profile?: string;
  nodeId?: string;
  verifierId?: string;
  verificationSource?: string;
  command?: string;
  args?: string[];
  commandKey?: string;
  exitCode: number | null;
  timedOut: boolean;
  verificationRelevant: boolean;
}

export interface FactLedgerVerificationResult {
  id: string;
  commandFactId: string;
  sequence: number;
  writeEpoch: number;
  stale: boolean;
  hookName?: string;
  profile?: string;
  nodeId?: string;
  verifierId: string;
  verificationSource?: string;
  expect: CommandExpectation;
  satisfied: boolean;
  exitCode: number | null;
  timedOut: boolean;
}

export interface FactLedgerWriteFact {
  id: string;
  sequence: number;
  writeEpoch: number;
  path?: string;
}

export interface FactLedgerBudgetExceededFact {
  id: string;
  sequence: number;
  writeEpoch: number;
  source: ForcedContinuationSource;
  used: number;
  limit: number;
  step?: number;
  reason?: string;
}

export interface FactLedgerSnapshot {
  schemaVersion: "fact-ledger.v1";
  writeEpoch: number;
  commands: FactLedgerCommandFact[];
  verificationResults: FactLedgerVerificationResult[];
  writes: FactLedgerWriteFact[];
  budgetExceeded: FactLedgerBudgetExceededFact[];
}

export interface FactLedgerReader {
  /** @reserved Public FactLedger read API consumed by workflow node-entry epoch markers. */
  currentEpoch(): number;
  /** @reserved Public FactLedger read API consumed by workflow node-entry epoch markers. */
  markEpoch(): FactLedgerEpochMarker;
  snapshot(): FactLedgerSnapshot;
}

export class FactLedger implements FactLedgerReader {
  private writeEpoch = 0;
  private verificationGoal = false;
  private readonly shellRequests = new Map<string, ShellCommandRequestFact>();
  private readonly commands: Omit<FactLedgerCommandFact, "stale">[] = [];
  private readonly verificationResults: Omit<
    FactLedgerVerificationResult,
    "stale"
  >[] = [];
  private readonly writes: FactLedgerWriteFact[] = [];
  private readonly budgetExceeded: FactLedgerBudgetExceededFact[] = [];

  observeEvent(event: SparkwrightEvent): void {
    this.observeGoal(event);

    const write = workspaceWriteFactFromEvent(event);
    if (write) {
      this.writeEpoch += 1;
      this.writes.push({
        id: `write:${write.sequence}`,
        sequence: write.sequence,
        writeEpoch: this.writeEpoch,
        ...(write.path ? { path: write.path } : {}),
      });
      return;
    }

    const budgetExceeded = forcedContinuationBudgetExceededFromEvent(event);
    if (budgetExceeded) {
      this.recordBudgetExceeded(budgetExceeded);
      return;
    }

    const request = shellCommandRequestFromEvent(event);
    if (request) {
      this.shellRequests.set(request.toolCallId, request);
      return;
    }

    const shellFact = shellCommandFactFromToolCompleted(
      event,
      this.requestForToolCompletion(event),
      { verificationGoal: this.verificationGoal },
    );
    if (shellFact) {
      this.recordCommand(shellFact);
      return;
    }

    const hookFact = hookCommandFactFromWorkflowHookCompleted(event);
    if (hookFact) {
      const command = this.recordCommand(hookFact);
      const verification = verificationResultForHookCommand(
        command,
        hookFact.expect,
      );
      if (verification) this.verificationResults.push(verification);
    }
  }

  currentEpoch(): number {
    return this.writeEpoch;
  }

  markEpoch(): FactLedgerEpochMarker {
    return { writeEpoch: this.writeEpoch };
  }

  snapshot(): FactLedgerSnapshot {
    const stale = (writeEpoch: number) => writeEpoch < this.writeEpoch;
    return {
      schemaVersion: "fact-ledger.v1",
      writeEpoch: this.writeEpoch,
      commands: this.commands.map((fact) => ({
        ...fact,
        stale: stale(fact.writeEpoch),
      })),
      verificationResults: this.verificationResults.map((fact) => ({
        ...fact,
        stale: stale(fact.writeEpoch),
      })),
      writes: this.writes.map((fact) => ({ ...fact })),
      budgetExceeded: this.budgetExceeded.map((fact) => ({ ...fact })),
    };
  }

  private recordCommand(
    input: ClassifiedCommandFactInput,
  ): Omit<FactLedgerCommandFact, "stale"> {
    const id =
      input.source === "shell_tool"
        ? `cmd:shell:${input.sequence}:${input.toolCallId ?? this.commands.length}`
        : `cmd:hook:${input.sequence}:${input.hookName ?? this.commands.length}`;
    const fact = {
      id,
      source: input.source,
      initiator: input.initiator,
      sequence: input.sequence,
      writeEpoch: this.writeEpoch,
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(input.hookName ? { hookName: input.hookName } : {}),
      ...(input.hook ? { hook: input.hook } : {}),
      ...(input.profile ? { profile: input.profile } : {}),
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      ...(input.verifierId ? { verifierId: input.verifierId } : {}),
      ...(input.verificationSource
        ? { verificationSource: input.verificationSource }
        : {}),
      ...(input.command ? { command: input.command } : {}),
      ...(input.args ? { args: input.args } : {}),
      ...(input.commandKey ? { commandKey: input.commandKey } : {}),
      exitCode: input.exitCode,
      timedOut: input.timedOut,
      verificationRelevant: input.verificationRelevant,
    };
    this.commands.push(fact);
    return fact;
  }

  private recordBudgetExceeded(
    input: ForcedContinuationBudgetExceededFactInput,
  ): void {
    this.budgetExceeded.push({
      id: `budget:${input.sequence}:${input.source}`,
      sequence: input.sequence,
      writeEpoch: this.writeEpoch,
      source: input.source,
      used: input.used,
      limit: input.limit,
      ...(input.step !== undefined ? { step: input.step } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    });
  }

  private requestForToolCompletion(
    event: SparkwrightEvent,
  ): ShellCommandRequestFact | undefined {
    if (event.type !== "tool.completed" || !isRecord(event.payload)) {
      return undefined;
    }
    const id =
      typeof event.payload.toolCallId === "string"
        ? event.payload.toolCallId
        : typeof event.payload.id === "string"
          ? event.payload.id
          : undefined;
    return id ? this.shellRequests.get(id) : undefined;
  }

  private observeGoal(event: SparkwrightEvent): void {
    if (this.verificationGoal || !isRecord(event.payload)) return;
    if (event.type !== "run.created" && event.type !== "prompt.built") return;
    const goal =
      typeof event.payload.goal === "string" ? event.payload.goal : undefined;
    if (!goal) return;
    this.verificationGoal = isVerificationGoal(goal);
  }
}

export function factLedgerSnapshotFromUnknown(
  value: unknown,
): FactLedgerSnapshot | undefined {
  if (!isRecord(value) || value.schemaVersion !== "fact-ledger.v1") {
    return undefined;
  }
  const writeEpoch =
    typeof value.writeEpoch === "number" && Number.isInteger(value.writeEpoch)
      ? value.writeEpoch
      : 0;
  return {
    schemaVersion: "fact-ledger.v1",
    writeEpoch,
    commands: Array.isArray(value.commands)
      ? value.commands
          .map((item) => commandFactFromRaw(item, writeEpoch))
          .filter((item): item is FactLedgerCommandFact => Boolean(item))
      : [],
    verificationResults: Array.isArray(value.verificationResults)
      ? value.verificationResults
          .map((item) => verificationResultFromRaw(item, writeEpoch))
          .filter((item): item is FactLedgerVerificationResult => Boolean(item))
      : [],
    writes: Array.isArray(value.writes)
      ? value.writes
          .map(writeFactFromRaw)
          .filter((item): item is FactLedgerWriteFact => Boolean(item))
      : [],
    budgetExceeded: Array.isArray(value.budgetExceeded)
      ? value.budgetExceeded
          .map((item) => budgetExceededFactFromRaw(item, writeEpoch))
          .filter((item): item is FactLedgerBudgetExceededFact => Boolean(item))
      : [],
  };
}

function verificationResultForHookCommand(
  command: Omit<FactLedgerCommandFact, "stale">,
  commandExpect: CommandExpectation | undefined,
): Omit<FactLedgerVerificationResult, "stale"> | undefined {
  const verifierId = command.verifierId;
  const expect = commandExpect;
  if (!verifierId || !expect) return undefined;
  return {
    id: `verify:${command.sequence}:${verifierId}`,
    commandFactId: command.id,
    sequence: command.sequence,
    writeEpoch: command.writeEpoch,
    ...(command.hookName ? { hookName: command.hookName } : {}),
    ...(command.profile ? { profile: command.profile } : {}),
    ...(command.nodeId ? { nodeId: command.nodeId } : {}),
    verifierId,
    ...(command.verificationSource
      ? { verificationSource: command.verificationSource }
      : {}),
    expect,
    satisfied: commandExpectationSatisfied(expect, command),
    exitCode: command.exitCode,
    timedOut: command.timedOut,
  };
}

function commandFactFromRaw(
  value: unknown,
  currentWriteEpoch: number,
): FactLedgerCommandFact | undefined {
  if (!isRecord(value)) return undefined;
  const source =
    value.source === "shell_tool" || value.source === "workflow_hook"
      ? value.source
      : undefined;
  const initiator =
    value.initiator === "model-initiated" ||
    value.initiator === "verifier-launched"
      ? value.initiator
      : undefined;
  const sequence = numberValue(value.sequence);
  const writeEpoch = numberValue(value.writeEpoch) ?? 0;
  const exitCode =
    typeof value.exitCode === "number" && Number.isFinite(value.exitCode)
      ? value.exitCode
      : null;
  if (!source || !initiator || sequence === undefined) return undefined;
  return {
    id: stringValue(value.id) ?? `cmd:${sequence}`,
    source,
    initiator,
    sequence,
    writeEpoch,
    stale:
      typeof value.stale === "boolean"
        ? value.stale
        : writeEpoch < currentWriteEpoch,
    ...(stringValue(value.toolCallId)
      ? { toolCallId: stringValue(value.toolCallId) }
      : {}),
    ...(stringValue(value.toolName)
      ? { toolName: stringValue(value.toolName) }
      : {}),
    ...(stringValue(value.hookName)
      ? { hookName: stringValue(value.hookName) }
      : {}),
    ...(stringValue(value.hook) ? { hook: stringValue(value.hook) } : {}),
    ...(stringValue(value.profile)
      ? { profile: stringValue(value.profile) }
      : {}),
    ...(stringValue(value.nodeId) ? { nodeId: stringValue(value.nodeId) } : {}),
    ...(stringValue(value.verifierId)
      ? { verifierId: stringValue(value.verifierId) }
      : {}),
    ...(stringValue(value.verificationSource)
      ? { verificationSource: stringValue(value.verificationSource) }
      : {}),
    ...(stringValue(value.command)
      ? { command: stringValue(value.command) }
      : {}),
    ...(stringArrayValue(value.args)
      ? { args: stringArrayValue(value.args) }
      : {}),
    ...(stringValue(value.commandKey)
      ? { commandKey: stringValue(value.commandKey) }
      : {}),
    exitCode,
    timedOut: value.timedOut === true,
    verificationRelevant: value.verificationRelevant === true,
  };
}

function verificationResultFromRaw(
  value: unknown,
  currentWriteEpoch: number,
): FactLedgerVerificationResult | undefined {
  if (!isRecord(value)) return undefined;
  const verifierId = stringValue(value.verifierId);
  const sequence = numberValue(value.sequence);
  const writeEpoch = numberValue(value.writeEpoch) ?? 0;
  const expect = commandExpectationValue(value.expect);
  const exitCode =
    typeof value.exitCode === "number" && Number.isFinite(value.exitCode)
      ? value.exitCode
      : null;
  if (!verifierId || sequence === undefined || !expect) return undefined;
  return {
    id: stringValue(value.id) ?? `verify:${sequence}:${verifierId}`,
    commandFactId: stringValue(value.commandFactId) ?? `cmd:${sequence}`,
    sequence,
    writeEpoch,
    stale:
      typeof value.stale === "boolean"
        ? value.stale
        : writeEpoch < currentWriteEpoch,
    ...(stringValue(value.hookName)
      ? { hookName: stringValue(value.hookName) }
      : {}),
    ...(stringValue(value.profile)
      ? { profile: stringValue(value.profile) }
      : {}),
    ...(stringValue(value.nodeId) ? { nodeId: stringValue(value.nodeId) } : {}),
    verifierId,
    ...(stringValue(value.verificationSource)
      ? { verificationSource: stringValue(value.verificationSource) }
      : {}),
    expect,
    satisfied:
      typeof value.satisfied === "boolean"
        ? value.satisfied
        : commandExpectationSatisfied(expect, {
            exitCode,
            timedOut: value.timedOut === true,
          }),
    exitCode,
    timedOut: value.timedOut === true,
  };
}

function writeFactFromRaw(value: unknown): FactLedgerWriteFact | undefined {
  if (!isRecord(value)) return undefined;
  const sequence = numberValue(value.sequence);
  const writeEpoch = numberValue(value.writeEpoch);
  if (sequence === undefined || writeEpoch === undefined) return undefined;
  return {
    id: stringValue(value.id) ?? `write:${sequence}`,
    sequence,
    writeEpoch,
    ...(stringValue(value.path) ? { path: stringValue(value.path) } : {}),
  };
}

function budgetExceededFactFromRaw(
  value: unknown,
  currentWriteEpoch: number,
): FactLedgerBudgetExceededFact | undefined {
  if (!isRecord(value)) return undefined;
  const sequence = numberValue(value.sequence);
  const writeEpoch = numberValue(value.writeEpoch) ?? currentWriteEpoch;
  const source =
    value.source === "revival" || value.source === "workflow"
      ? value.source
      : undefined;
  const used = numberValue(value.used);
  const limit = numberValue(value.limit);
  if (
    sequence === undefined ||
    !source ||
    used === undefined ||
    limit === undefined
  ) {
    return undefined;
  }
  return {
    id: stringValue(value.id) ?? `budget:${sequence}:${source}`,
    sequence,
    writeEpoch,
    source,
    used,
    limit,
    ...(numberValue(value.step) !== undefined
      ? { step: numberValue(value.step) }
      : {}),
    ...(stringValue(value.reason) ? { reason: stringValue(value.reason) } : {}),
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === "string");
  return out.length > 0 ? out : undefined;
}
