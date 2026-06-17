import {
  createContextItemId,
  type SparkwrightEvent,
  type WorkflowHook,
} from "@sparkwright/core";
import type {
  CapabilityVerificationCommandConfig,
  CapabilityVerificationConfig,
} from "./config.js";
import {
  createConfiguredWorkflowHooks,
  type CreateConfiguredWorkflowHooksOptions,
} from "./workflow-hooks.js";

const DEFAULT_PROFILE = "fast";
const DEFAULT_WRITE_TOOLS = ["edit_anchored_text", "apply_patch"];

export interface CreateVerificationWorkflowHooksOptions extends Omit<
  CreateConfiguredWorkflowHooksOptions,
  "hooks"
> {
  verification?: CapabilityVerificationConfig;
}

export function createVerificationWorkflowHooks(
  options: CreateVerificationWorkflowHooksOptions,
): WorkflowHook[] {
  const config = options.verification;
  const mode = config?.mode ?? "suggest";
  if (!config || mode === "off") return [];

  const profileName = verificationProfileName(config);
  const commands = config.profiles?.[profileName] ?? [];
  if (mode === "suggest") {
    return [createVerificationSuggestionHook(profileName, commands)];
  }
  if (commands.length === 0) {
    return [createMissingProfileStopGate(profileName)];
  }

  const commandHooks = createConfiguredWorkflowHooks({
    ...options,
    hooks: commands.map((command) => ({
      name: verificationHookName(profileName, command.id),
      description: `Run ${command.id} verification after workspace writes.`,
      hook: "PostToolUse",
      frequency: config.afterWrites?.frequency,
      matcher: {
        toolName: DEFAULT_WRITE_TOOLS,
        status: "completed",
      },
      action: {
        type: "command",
        command: command.command,
        args: command.args,
        cwd: command.cwd,
        timeoutMs: command.timeoutMs,
        maxOutputBytes: command.maxOutputBytes,
        blockOnFailure: false,
        injectOutput: config.afterWrites?.injectOutput ?? "onFailure",
      },
    })),
  });

  const stopGateEnabled = config.stopGate?.enabled ?? true;
  const requireCleanAfterLastWrite =
    config.stopGate?.requireCleanAfterLastWrite ?? true;
  return [
    ...commandHooks,
    ...(stopGateEnabled && requireCleanAfterLastWrite
      ? [createVerificationStopGate(profileName, commands)]
      : []),
  ];
}

function createVerificationSuggestionHook(
  profileName: string,
  commands: readonly CapabilityVerificationCommandConfig[],
): WorkflowHook {
  return {
    name: "verification:suggest",
    hook: "SessionStart",
    handle() {
      const renderedCommands = commands
        .map((command) =>
          [command.command, ...(command.args ?? [])].join(" ").trim(),
        )
        .filter(Boolean);
      return {
        status: "continue",
        context: [
          {
            id: createContextItemId(),
            type: "system",
            source: {
              kind: "extension",
              uri: "verification:suggest",
            },
            content:
              renderedCommands.length > 0
                ? `Project verification profile "${profileName}" is available. Run relevant verification commands before final answers after code writes: ${renderedCommands.join("; ")}.`
                : `Project verification profile "${profileName}" is configured, but it has no commands.`,
            metadata: {
              layer: "working",
              stability: "session",
              verificationProfile: profileName,
            },
          },
        ],
      };
    },
  };
}

function createMissingProfileStopGate(profileName: string): WorkflowHook {
  return {
    name: "verification:stop-gate",
    hook: "Stop",
    handle() {
      return {
        status: "block",
        reason: `Verification profile "${profileName}" has no commands.`,
        metadata: {
          profile: profileName,
          missingCommands: true,
        },
      };
    },
  };
}

function createVerificationStopGate(
  profileName: string,
  commands: readonly CapabilityVerificationCommandConfig[],
): WorkflowHook {
  return {
    name: "verification:stop-gate",
    hook: "Stop",
    handle(input) {
      const events = stopPayloadEvents(input.payload);
      const latestWrite = latestWorkspaceWrite(events);
      if (!latestWrite) return { status: "continue" };

      const missing = commands.filter(
        (command) =>
          !hasSuccessfulVerificationAfter(
            events,
            verificationHookName(profileName, command.id),
            latestWrite.sequence,
          ),
      );
      if (missing.length === 0) return { status: "continue" };

      return {
        status: "block",
        reason:
          `Verification profile "${profileName}" has not passed after the latest workspace write. ` +
          `Missing: ${missing.map((command) => command.id).join(", ")}.`,
        metadata: {
          profile: profileName,
          latestWriteSequence: latestWrite.sequence,
          missing: missing.map((command) => command.id),
        },
      };
    },
  };
}

function verificationProfileName(config: CapabilityVerificationConfig): string {
  return (
    config.afterWrites?.profile ?? config.defaultProfile ?? DEFAULT_PROFILE
  );
}

function verificationHookName(profileName: string, commandId: string): string {
  return `verification:${profileName}:${commandId}`;
}

function stopPayloadEvents(payload: unknown): readonly SparkwrightEvent[] {
  if (!isRecord(payload)) return [];
  return Array.isArray(payload.events)
    ? (payload.events as SparkwrightEvent[])
    : [];
}

function latestWorkspaceWrite(
  events: readonly SparkwrightEvent[],
): SparkwrightEvent | undefined {
  return events
    .filter((event) => event.type === "workspace.write.completed")
    .sort((a, b) => b.sequence - a.sequence)[0];
}

function hasSuccessfulVerificationAfter(
  events: readonly SparkwrightEvent[],
  hookName: string,
  sequence: number,
): boolean {
  return events.some((event) => {
    if (
      event.sequence <= sequence ||
      event.type !== "workflow_hook.completed" ||
      !isRecord(event.payload)
    ) {
      return false;
    }
    if (event.payload.hookName !== hookName) return false;
    const result = isRecord(event.payload.result)
      ? event.payload.result
      : undefined;
    if (!result || result.status !== "continue") return false;
    const metadata = isRecord(result.metadata) ? result.metadata : undefined;
    return metadata?.exitCode === 0 && metadata.timedOut !== true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
