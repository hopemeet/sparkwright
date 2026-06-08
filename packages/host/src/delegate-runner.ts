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
  type TraceLevel,
} from "@sparkwright/core";
import type { CapabilityDelegateToolConfig } from "./config.js";
import { loadHostConfig } from "./config.js";
import { resolveAgentProfiles } from "./agent-profiles.js";
import {
  acpConfigFromAgentProfile,
  createAcpDelegateTool,
} from "./acp-child-agent.js";
import {
  createExternalCommandDelegateTool,
  externalCommandConfigFromAgentProfile,
} from "./external-command-agent.js";

export interface RunConfiguredDelegateInput {
  workspaceRoot: string;
  toolName: string;
  goal: string;
  env?: Record<string, string | undefined>;
  metadata?: Record<string, unknown>;
  approvalResolver?: ApprovalResolver;
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
        | "execution_failed";
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

  const delegates = loaded.config.capabilities?.agents?.delegateTools ?? [];
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

  const profiles = await resolveAgentProfiles(
    input.workspaceRoot,
    loaded.config.capabilities?.agents?.profiles,
  );
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

  const parent = createRun({
    goal: input.goal,
    model: {
      async complete() {
        return { message: "" };
      },
    },
    maxSteps: 1,
  });
  const persistence =
    input.persistTrace === false
      ? undefined
      : createDelegateRunPersistence({
          workspaceRoot: input.workspaceRoot,
          sessionId: input.sessionId ?? createSessionId(),
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
          description:
            delegate.description ??
            `Delegate a bounded task to ${profile.name ?? profile.id}.`,
          workspaceRoot: input.workspaceRoot,
          requiresApproval: delegate.requiresApproval,
          forbidNesting: delegate.forbidNesting ?? true,
        })
      : createExternalCommandDelegateTool({
          getParent: () => parent,
          profile,
          toolName: input.toolName,
          description:
            delegate.description ??
            `Delegate a bounded task to ${profile.name ?? profile.id}.`,
          workspaceRoot: input.workspaceRoot,
          requiresApproval: delegate.requiresApproval,
          forbidNesting: delegate.forbidNesting ?? true,
        });

  const requiresApproval = delegate.requiresApproval ?? true;
  if (requiresApproval) {
    if (!input.approvalResolver) {
      await persistence?.finish({
        state: "failed",
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
    await persistence?.finish({ state: "failed", message });
    return {
      ok: false,
      code: "execution_failed",
      message,
      events: parent.events.all(),
      ...persistence?.resultMetadata(),
    };
  }
}

function delegateToolName(delegate: CapabilityDelegateToolConfig): string {
  return delegate.toolName ?? `delegate_${delegate.profileId}`;
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
                code: "DELEGATE_DIRECT_RUN_FAILED",
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
              code: "DELEGATE_DIRECT_RUN_FAILED",
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
