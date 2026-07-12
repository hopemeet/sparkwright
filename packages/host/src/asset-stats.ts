import {
  FileWorkflowStore,
  type WorkflowRunRecord,
} from "@sparkwright/agent-runtime";
import { FileSessionStore, loadTraceEventsFile } from "@sparkwright/core";
import { join } from "node:path";

/**
 * Runtime-time identity used by rebuildable Agent and Workflow projections.
 * It deliberately excludes host environment fields: those are attribution,
 * not authored-package identity.
 */
export interface AssetObservationIdentity {
  artifactKind: "agent" | "workflow";
  layer: string;
  logicalName: string;
  packageHashPolicyVersion: 1 | 2;
  packageHash: string;
  artifactId?: string;
}

export interface AssetObservation {
  identity: AssetObservationIdentity;
  event:
    | "agent.spawn"
    | "agent.delegate"
    | "workflow.run"
    | "workflow.node"
    | "workflow.usage";
  runId?: string;
  sessionId?: string;
  state?: "completed" | "failed" | "cancelled" | "partial";
  at?: string;
}

export interface AssetStatsEntry {
  identity: AssetObservationIdentity;
  observations: number;
  completed: number;
  failed: number;
  cancelled: number;
  partial: number;
  runIds: string[];
  sessionIds: string[];
}

export interface AssetStatsReport {
  entries: AssetStatsEntry[];
  /** @reserved Public projection scan count consumed by future diagnostics UIs. */
  observationsScanned: number;
}

export interface CollectedAssetStatsReport extends AssetStatsReport {
  sessionsScanned: number;
  workflowRecordsScanned: number;
  errors: Array<{ path: string; message: string }>;
}

export async function collectAssetStats(input: {
  workspaceRoot: string;
  sessionRootDir: string;
  sessionLimit?: number;
  artifactKind?: AssetObservationIdentity["artifactKind"];
}): Promise<CollectedAssetStatsReport> {
  const observations: AssetObservation[] = [];
  const errors: CollectedAssetStatsReport["errors"] = [];
  const sessionStore = new FileSessionStore({ rootDir: input.sessionRootDir });
  const sessions = await sessionStore.list({ limit: input.sessionLimit ?? 20 });
  if (input.artifactKind !== "workflow") {
    for (const session of sessions) {
      const path = join(input.sessionRootDir, session.id, "trace.jsonl");
      try {
        const events = await loadTraceEventsFile(path);
        for (const event of events) {
          if (
            event.type !== "subagent.started" &&
            event.type !== "subagent.completed" &&
            event.type !== "subagent.failed"
          ) {
            continue;
          }
          const entrypoint =
            typeof event.metadata.entrypoint === "string"
              ? event.metadata.entrypoint
              : undefined;
          const observation = agentObservationFromMetadata({
            metadata: event.metadata,
            event:
              entrypoint === "delegate" || entrypoint === "configured_delegate"
                ? "agent.delegate"
                : "agent.spawn",
            runId:
              typeof event.metadata.runId === "string"
                ? event.metadata.runId
                : undefined,
            sessionId: session.id,
            state:
              event.type === "subagent.completed"
                ? "completed"
                : event.type === "subagent.failed"
                  ? "failed"
                  : undefined,
            at: event.timestamp,
          });
          if (observation) observations.push(observation);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          errors.push({
            path,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  let workflowRecordsScanned = 0;
  if (input.artifactKind !== "agent") {
    const rootDir = join(input.workspaceRoot, ".sparkwright", "workflow-runs");
    try {
      const store = new FileWorkflowStore({ rootDir, createRoot: false });
      for (const record of store.list().records) {
        workflowRecordsScanned += 1;
        const run = workflowObservationFromRunRecord(record, "workflow.run");
        if (run) observations.push(run);
        if (record.metadata.workflowUsage) {
          const usage = workflowObservationFromRunRecord(
            record,
            "workflow.usage",
          );
          if (usage) observations.push(usage);
        }
        for (const [nodeId, attempts] of Object.entries(record.attempts)) {
          for (let attempt = 0; attempt < attempts; attempt += 1) {
            const node = workflowObservationFromRunRecord(
              record,
              "workflow.node",
            );
            if (node) {
              observations.push({
                ...node,
                runId: `${node.runId ?? record.id}:${nodeId}:${attempt + 1}`,
              });
            }
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        errors.push({
          path: rootDir,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return {
    ...aggregateAssetObservations(observations),
    sessionsScanned: sessions.length,
    workflowRecordsScanned,
    errors,
  };
}

export type AssetIdentityChange =
  | "content_changed"
  | "policy_changed"
  | "both_changed"
  | "unchanged";

export function classifyAssetIdentityChange(
  before: AssetObservationIdentity,
  after: AssetObservationIdentity,
): AssetIdentityChange {
  const policyChanged =
    before.packageHashPolicyVersion !== after.packageHashPolicyVersion;
  const contentChanged = before.packageHash !== after.packageHash;
  if (policyChanged && contentChanged) return "both_changed";
  if (policyChanged) return "policy_changed";
  if (contentChanged) return "content_changed";
  return "unchanged";
}

export function aggregateAssetObservations(
  observations: readonly AssetObservation[],
): AssetStatsReport {
  const entries = new Map<string, AssetStatsEntry>();
  for (const observation of observations) {
    const key = assetIdentityKey(observation.identity);
    const entry = entries.get(key) ?? {
      identity: { ...observation.identity },
      observations: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      partial: 0,
      runIds: [],
      sessionIds: [],
    };
    entry.observations += 1;
    if (observation.state) entry[observation.state] += 1;
    if (observation.runId && !entry.runIds.includes(observation.runId)) {
      entry.runIds.push(observation.runId);
    }
    if (
      observation.sessionId &&
      !entry.sessionIds.includes(observation.sessionId)
    ) {
      entry.sessionIds.push(observation.sessionId);
    }
    entries.set(key, entry);
  }
  return {
    observationsScanned: observations.length,
    entries: [...entries.values()]
      .map((entry) => ({
        ...entry,
        runIds: entry.runIds.sort(),
        sessionIds: entry.sessionIds.sort(),
      }))
      .sort((left, right) =>
        assetIdentityKey(left.identity).localeCompare(
          assetIdentityKey(right.identity),
        ),
      ),
  };
}

/** Extracts an Agent observation only from event-time trace metadata. */
export function agentObservationFromMetadata(input: {
  metadata: Record<string, unknown>;
  event: "agent.spawn" | "agent.delegate";
  runId?: string;
  sessionId?: string;
  state?: AssetObservation["state"];
  at?: string;
}): AssetObservation | undefined {
  const raw = input.metadata.agentAssetIdentity;
  if (!isRecord(raw) || raw.artifactKind !== "agent") return undefined;
  const identity = identityFromRecord(raw, "agent");
  return identity ? { ...input, identity } : undefined;
}

/** Extracts a Workflow observation from its durable event-time run pin. */
export function workflowObservationFromRunRecord(
  record: WorkflowRunRecord,
  event: Extract<AssetObservation["event"], `workflow.${string}`>,
): AssetObservation | undefined {
  if (!record.packageHash || !record.packageHashPolicyVersion) return undefined;
  return {
    identity: {
      artifactKind: "workflow",
      layer: record.layer ?? "unknown",
      logicalName: record.assetName,
      packageHashPolicyVersion: record.packageHashPolicyVersion,
      packageHash: record.packageHash,
    },
    event,
    ...(record.activeRunId ? { runId: String(record.activeRunId) } : {}),
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    ...(event === "workflow.run" && terminalState(record.status)
      ? { state: terminalState(record.status) }
      : {}),
    ...((record.updatedAt ?? record.createdAt)
      ? { at: record.updatedAt ?? record.createdAt }
      : {}),
  };
}

function assetIdentityKey(identity: AssetObservationIdentity): string {
  return [
    identity.artifactKind,
    identity.layer,
    identity.artifactId ?? identity.logicalName,
    `v${identity.packageHashPolicyVersion}`,
    identity.packageHash,
  ].join("|");
}

function identityFromRecord(
  record: Record<string, unknown>,
  kind: AssetObservationIdentity["artifactKind"],
): AssetObservationIdentity | undefined {
  if (
    typeof record.layer !== "string" ||
    typeof record.logicalName !== "string" ||
    typeof record.packageHash !== "string" ||
    (record.packageHashPolicyVersion !== 1 &&
      record.packageHashPolicyVersion !== 2)
  ) {
    return undefined;
  }
  return {
    artifactKind: kind,
    layer: record.layer,
    logicalName: record.logicalName,
    packageHashPolicyVersion: record.packageHashPolicyVersion,
    packageHash: record.packageHash,
    ...(typeof record.artifactId === "string"
      ? { artifactId: record.artifactId }
      : {}),
  };
}

function terminalState(
  status: WorkflowRunRecord["status"],
): AssetObservation["state"] | undefined {
  return status === "completed" || status === "failed" || status === "cancelled"
    ? status
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
