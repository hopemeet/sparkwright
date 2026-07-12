import type { WorkflowRunRecord } from "@sparkwright/agent-runtime";

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
      layer: "project",
      logicalName: record.assetName,
      packageHashPolicyVersion: record.packageHashPolicyVersion,
      packageHash: record.packageHash,
    },
    event,
    ...(record.activeRunId ? { runId: String(record.activeRunId) } : {}),
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    ...(terminalState(record.status)
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
