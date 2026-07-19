import type {
  RunAssessment,
  RunIssue,
  RunResult,
  VerificationResult,
} from "@sparkwright/core";
import { isResumableRunFailureReason } from "@sparkwright/core";

export interface ExecutionEpisodeAssessment {
  runId: string;
  assessment: RunAssessment;
}

export interface ExecutionAssessment {
  schemaVersion: "execution-assessment.v1";
  health: RunAssessment["health"];
  issues: RunIssue[];
  verification: VerificationResult[];
  /** @reserved Public execution summary count consumed by protocol/SDK clients. */
  episodeCount: number;
  rootRunId?: string;
  /** @reserved Public execution terminal identity consumed by protocol/SDK clients. */
  finalRunId?: string;
  episodes: ExecutionEpisodeAssessment[];
}

const MAX_EXECUTION_EPISODES = 64;
const MAX_EXECUTION_ISSUES = 64;
const MAX_EXECUTION_VERIFICATION = 96;

export function assessmentForRunResult(result: RunResult): RunAssessment {
  return result.assessment;
}

export function aggregateExecutionAssessment(input: {
  episodes: readonly ExecutionEpisodeAssessment[];
  hostIssues?: readonly RunIssue[];
}): ExecutionAssessment {
  const episodes = input.episodes.slice(-MAX_EXECUTION_EPISODES);
  const latestVerification = new Map<string, VerificationResult>();
  for (const episode of episodes) {
    for (const result of episode.assessment.verification) {
      latestVerification.set(verificationIdentity(result), result);
    }
  }
  const verification = [...latestVerification.values()]
    .filter((result) => result.status !== "stale")
    .slice(-MAX_EXECUTION_VERIFICATION);

  const issues: RunIssue[] = [];
  for (const [index, episode] of episodes.entries()) {
    const superseded = index < episodes.length - 1;
    for (const issue of episode.assessment.issues) {
      if (issue.kind === "verification_failure") continue;
      if (
        superseded &&
        issue.kind === "run_failure" &&
        issue.details?.reason &&
        isResumableRunFailureReason(issue.details.reason)
      )
        continue;
      issues.push(issue);
    }
  }

  const failedVerification = verification.filter(
    (result) => result.status === "failed" || result.status === "timed_out",
  );
  if (failedVerification.length > 0) {
    const last = failedVerification.at(-1);
    issues.push({
      code: "VERIFICATION_FAILED",
      kind: "verification_failure",
      disposition: "failing",
      count: failedVerification.length,
      ...(last
        ? {
            details: {
              ...(last.command ? { lastCommand: last.command } : {}),
              ...(last.verifierId ? { lastVerifierId: last.verifierId } : {}),
              ...(last.exitCode !== undefined
                ? { lastExitCode: last.exitCode }
                : {}),
            },
          }
        : {}),
    });
  }
  issues.push(...(input.hostIssues ?? []));

  const boundedIssues = issues.slice(-MAX_EXECUTION_ISSUES);
  return {
    schemaVersion: "execution-assessment.v1",
    health: boundedIssues.some((issue) => issue.disposition === "failing")
      ? "failing"
      : boundedIssues.length > 0
        ? "degraded"
        : "clean",
    issues: boundedIssues,
    verification,
    episodeCount: episodes.length,
    ...(episodes[0]?.runId ? { rootRunId: episodes[0].runId } : {}),
    ...(episodes.at(-1)?.runId ? { finalRunId: episodes.at(-1)!.runId } : {}),
    episodes,
  };
}

function verificationIdentity(result: VerificationResult): string {
  if (result.source === "command") {
    return `command:${normalizeCommand(result.command) ?? result.id}`;
  }
  return `${result.source}:${result.profile ?? ""}:${result.verifierId ?? result.id}`;
}

function normalizeCommand(command: string | undefined): string | undefined {
  return command?.replace(/\s+/gu, " ").trim();
}
