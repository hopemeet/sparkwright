import { join } from "node:path";
import {
  createApprovalRequest,
  createRun,
  createSessionId,
  createSessionFileRunStoreFactory,
  createSessionRunStoreFactory,
  FileSessionStore,
  resolveApproval,
  type ApprovalResolver,
  type RunResult,
  type SparkwrightEvent,
} from "@sparkwright/core";
import type { TraceLevel } from "@sparkwright/protocol";
import { loadHostConfig } from "./config.js";
import { resolveAgentProfiles } from "./agent-profiles.js";
import { resolveSkillRootsForRuntime } from "./skill-roots.js";
import {
  acpConfigFromAgentProfile,
  createAcpDelegateTool,
} from "./acp-child-agent.js";
import {
  createExternalCommandDelegateTool,
  externalCommandConfigFromAgentProfile,
} from "./external-command-agent.js";
import {
  delegateToolName,
  delegateToolDescription,
  describeDelegateCapability,
  errorCode,
  resolveAgentDelegateTools,
  type DelegateFailureCode,
  type DelegateToolCollision,
} from "./delegate-capability.js";

export interface RunConfiguredDelegateInput {
  workspaceRoot: string;
  toolName: string;
  goal: string;
  env?: Record<string, string | undefined>;
  metadata?: Record<string, unknown>;
  approvalResolver?: ApprovalResolver;
  shouldWrite?: boolean;
  sessionId?: string;
  traceLevel?: TraceLevel;
  persistTrace?: boolean;
}

export type RunConfiguredDelegateResult =
  | {
      ok: true;
      toolName: string;
      profileId: string;
      protocol: "acp" | "external_command";
      output: unknown;
      events: SparkwrightEvent[];
      sessionId?: string;
      runId?: string;
      tracePath?: string;
    }
  | {
      ok: false;
      code:
        | "config_error"
        | "delegate_not_found"
        | "unsupported_delegate_kind"
        | "approval_denied"
        | DelegateFailureCode;
      message: string;
      events?: SparkwrightEvent[];
      sessionId?: string;
      runId?: string;
      tracePath?: string;
    };

export async function runConfiguredDelegate(
  input: RunConfiguredDelegateInput,
): Promise<RunConfiguredDelegateResult> {
  const loaded = await loadHostConfig(input.workspaceRoot, input.env);
  if (loaded.errors.length > 0) {
    return {
      ok: false,
      code: "config_error",
      message: loaded.errors
        .map((error) => `${error.file}: ${error.field}: ${error.message}`)
        .join("\n"),
    };
  }

  const agentConfig = loaded.config.capabilities?.agents;
  const profiles = await resolveAgentProfiles(
    input.workspaceRoot,
    loaded.config.capabilities?.agents?.profiles,
  );
  const delegateToolCollisions: DelegateToolCollision[] = [];
  const delegates = resolveAgentDelegateTools(
    profiles,
    agentConfig?.delegateTools,
    {
      exposeChildrenAsDelegates: agentConfig?.exposeChildrenAsDelegates,
      onCollision: (collision) => delegateToolCollisions.push(collision),
    },
  );
  const targetCollision = delegateToolCollisions.find(
    (item) => item.toolName === input.toolName,
  );
  if (targetCollision) {
    return {
      ok: false,
      code: "config_error",
      message:
        `delegate tool collision for ${input.toolName}: ` +
        `profile ${targetCollision.profileId} (${targetCollision.source}) was dropped; ` +
        `owned by profile ${targetCollision.conflictsWith} (fail-closed)`,
    };
  }
  const delegate = delegates.find(
    (item) => delegateToolName(item) === input.toolName,
  );
  if (!delegate) {
    return {
      ok: false,
      code: "delegate_not_found",
      message: `delegate tool not found: ${input.toolName}`,
    };
  }

  const profile = profiles.find((item) => item.id === delegate.profileId);
  if (!profile) {
    return {
      ok: false,
      code: "delegate_not_found",
      message: `delegate profile not found: ${delegate.profileId}`,
    };
  }

  const acpConfig = acpConfigFromAgentProfile(profile);
  const externalCommandConfig = externalCommandConfigFromAgentProfile(profile);
  const skillRoots = resolveSkillRootsForRuntime(
    input.workspaceRoot,
    loaded.config.capabilities?.skills?.roots,
  );
  const protocol = acpConfig
    ? "acp"
    : externalCommandConfig
      ? "external_command"
      : undefined;
  if (!protocol) {
    return {
      ok: false,
      code: "unsupported_delegate_kind",
      message:
        `delegate tool ${input.toolName} targets an internal SparkWright profile. ` +
        "Use normal run-loop delegation for internal profiles; delegates run supports metadata.acp and metadata.externalCommand.",
    };
  }
  const descriptor = describeDelegateCapability({
    delegate,
    profile,
    protocol,
    command:
      protocol === "acp" ? acpConfig!.command : externalCommandConfig!.command,
    args: protocol === "acp" ? acpConfig!.args : externalCommandConfig!.args,
    timeoutMs:
      protocol === "acp"
        ? acpConfig!.timeoutMs
        : externalCommandConfig!.timeoutMs,
    workspaceAccess:
      protocol === "acp"
        ? (acpConfig!.workspaceAccess ?? "none")
        : (externalCommandConfig!.workspaceAccess ?? "none"),
    allowReadWriteWorkspaceAccess: input.shouldWrite === true,
    outputLimits:
      protocol === "external_command"
        ? {
            stdoutBytes:
              externalCommandConfig!.maxStdoutBytes ??
              externalCommandConfig!.maxOutputBytes,
            stderrBytes:
              externalCommandConfig!.maxStderrBytes ??
              externalCommandConfig!.maxOutputBytes,
          }
        : undefined,
  });

  const sessionId = input.sessionId ?? createSessionId();
  const parent = createRun({
    goal: input.goal,
    model: {
      async complete() {
        return { message: "" };
      },
    },
    maxSteps: 1,
    metadata: {
      sessionId,
      agentId: "main",
    },
  });
  const persistence =
    input.persistTrace === false
      ? undefined
      : createDelegateRunPersistence({
          workspaceRoot: input.workspaceRoot,
          sessionId,
          traceLevel: input.traceLevel ?? "standard",
          source: "delegates.run",
          parent,
        });
  const tool =
    protocol === "acp"
      ? createAcpDelegateTool({
          getParent: () => parent,
          profile,
          toolName: input.toolName,
          description: delegateToolDescription(delegate, profile),
          workspaceRoot: input.workspaceRoot,
          requiresApproval: delegate.requiresApproval,
          forbidNesting: delegate.forbidNesting ?? true,
          maxDepth: agentConfig?.maxDepth,
          entrypoint: "delegates_run",
          allowReadWriteWorkspaceAccess: input.shouldWrite === true,
          sandbox: loaded.config.shell?.sandbox,
          skillRoots: skillRoots.map((root) => root.root),
          configPaths: loaded.attempted.map((entry) => entry.path),
        })
      : createExternalCommandDelegateTool({
          getParent: () => parent,
          profile,
          toolName: input.toolName,
          description: delegateToolDescription(delegate, profile),
          workspaceRoot: input.workspaceRoot,
          requiresApproval: delegate.requiresApproval,
          forbidNesting: delegate.forbidNesting ?? true,
          maxDepth: agentConfig?.maxDepth,
          entrypoint: "delegates_run",
          allowReadWriteWorkspaceAccess: input.shouldWrite === true,
          sandbox: loaded.config.shell?.sandbox,
          skillRoots: skillRoots.map((root) => root.root),
          configPaths: loaded.attempted.map((entry) => entry.path),
        });

  const requiresApproval = delegate.requiresApproval ?? true;
  if (requiresApproval) {
    if (!input.approvalResolver) {
      await persistence?.finish({
        state: "failed",
        code: "DELEGATE_APPROVAL_DENIED",
        message: `delegate tool ${input.toolName} requires approval`,
      });
      return {
        ok: false,
        code: "approval_denied",
        message: `delegate tool ${input.toolName} requires approval`,
        events: parent.events.all(),
        ...persistence?.resultMetadata(),
      };
    }
    const request = createApprovalRequest({
      runId: parent.record.id,
      action: "delegate.run",
      summary: `Run delegate tool ${input.toolName}`,
      details: {
        toolName: input.toolName,
        profileId: profile.id,
        protocol,
        goal: input.goal,
        capability: descriptor,
      },
    });
    parent.events.emit("approval.requested", {
      approvalId: request.id,
      action: request.action,
      summary: request.summary,
      details: request.details,
    });
    const response = await resolveApproval(request, input.approvalResolver);
    parent.events.emit("approval.resolved", {
      approvalId: request.id,
      decision: response.decision,
    });
    if (response.decision !== "approved") {
      await persistence?.finish({
        state: "failed",
        code: "DELEGATE_APPROVAL_DENIED",
        message: response.message ?? `approval denied for ${input.toolName}`,
      });
      return {
        ok: false,
        code: "approval_denied",
        message: response.message ?? `approval denied for ${input.toolName}`,
        events: parent.events.all(),
        ...persistence?.resultMetadata(),
      };
    }
  }

  try {
    const output = await tool.execute(
      { goal: input.goal, metadata: input.metadata },
      { run: parent.record } as never,
    );
    await persistence?.finish({ state: "completed" });
    return {
      ok: true,
      toolName: input.toolName,
      profileId: profile.id,
      protocol,
      output,
      events: parent.events.all(),
      ...persistence?.resultMetadata(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await persistence?.finish({
      state: "failed",
      code: errorCode(error),
      message,
    });
    return {
      ok: false,
      code: errorCode(error),
      message,
      events: parent.events.all(),
      ...persistence?.resultMetadata(),
    };
  }
}

function createDelegateRunPersistence(input: {
  workspaceRoot: string;
  sessionId: string;
  traceLevel: TraceLevel;
  source: string;
  parent: ReturnType<typeof createRun>;
}): {
  finish(input: {
    state: "completed" | "failed";
    code?: DelegateFailureCode;
    message?: string;
  }): Promise<void>;
  resultMetadata(): { sessionId: string; runId: string; tracePath?: string };
} {
  const sessionRootDir = join(input.workspaceRoot, ".sparkwright", "sessions");
  const sessionStore = new FileSessionStore({ rootDir: sessionRootDir });
  let tracePath: string | undefined;
  const fileRunStoreFactory = createSessionFileRunStoreFactory({
    sessionRootDir,
    sessionId: input.sessionId,
    agentId: "main",
    traceLevel: input.traceLevel,
  });
  const store = createSessionRunStoreFactory({
    sessionStore,
    sessionId: input.sessionId,
    runStoreFactory: (record) => {
      const fileStore = fileRunStoreFactory(record);
      tracePath = fileStore.tracePath;
      return fileStore;
    },
    metadata: {
      source: input.source,
    },
  })(input.parent.record);
  const pending: Array<Promise<void>> = [];
  const append = (event: SparkwrightEvent): void => {
    pending.push(Promise.resolve(store.append(event)));
  };
  input.parent.events.subscribeWithReplay(append);

  return {
    async finish(finishInput) {
      const now = new Date().toISOString();
      const result: RunResult =
        finishInput.state === "completed"
          ? {
              signal: "completed",
              state: "completed",
              stopReason: "final_answer",
              metadata: {
                source: input.source,
              },
            }
          : {
              signal: "failed",
              state: "failed",
              stopReason: "state_transition_invalid",
              message: finishInput.message,
              failure: {
                category: "runtime",
                code: finishInput.code ?? "DELEGATE_EXECUTION_FAILED",
                message: finishInput.message ?? "delegate direct run failed",
                retryable: false,
                metadata: {
                  source: input.source,
                },
              },
              metadata: {
                source: input.source,
              },
            };
      input.parent.record.state = finishInput.state;
      input.parent.record.stopReason = result.stopReason;
      input.parent.record.updatedAt = now;
      input.parent.events.emit(
        finishInput.state === "completed" ? "run.completed" : "run.failed",
        finishInput.state === "completed"
          ? { reason: result.stopReason }
          : {
              reason: result.stopReason,
              code: finishInput.code ?? "DELEGATE_EXECUTION_FAILED",
              message: finishInput.message,
              failure: result.failure,
              metadata: result.metadata,
            },
      );
      await Promise.all(pending);
      await store.finish(input.parent.record, result);
    },
    resultMetadata() {
      return {
        sessionId: input.sessionId,
        runId: input.parent.record.id,
        tracePath,
      };
    },
  };
}
