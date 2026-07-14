import type { WorkflowCommandVerifierDefinition } from "@sparkwright/agent-runtime";
import {
  createContextItemId,
  type WorkflowHook,
  type WorkflowHookResult,
} from "@sparkwright/core";
import type {
  CapabilityVerificationCommandConfig,
  CapabilityVerificationConfig,
} from "./config-zod-schema.js";
import {
  createInvariantProjectionHooks,
  type CreateInvariantProjectionHooksOptions,
  type InvariantBuiltinVerifierInput,
} from "./invariant-projection.js";

const DEFAULT_PROFILE = "fast";
const MISSING_PROFILE_BUILTIN_VERIFIER = "verification-profile-missing";

export interface CreateVerificationWorkflowHooksOptions extends Omit<
  CreateInvariantProjectionHooksOptions,
  | "assetName"
  | "contentHash"
  | "verificationSource"
  | "profile"
  | "verifiers"
  | "guidance"
  | "injectOutput"
  | "builtinVerifiers"
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
  const renderedCommands = renderedVerificationCommands(commands);
  const guidance = verificationGuidance(profileName, renderedCommands);
  if (mode === "suggest") {
    return [
      {
        name: `verification:${profileName}`,
        id: "verification-guidance",
        hook: "TurnStart",
        onError: "continue",
        handle() {
          return {
            status: "continue",
            context: [
              {
                id: createContextItemId(),
                type: "system",
                source: {
                  kind: "extension",
                  uri: `verification:${profileName}`,
                },
                content: guidance,
                metadata: {
                  layer: "working",
                  stability: "turn",
                  verificationSource: "profile",
                  profile: profileName,
                },
              },
            ],
            metadata: {
              verificationSource: "profile",
              profile: profileName,
            },
          };
        },
      },
    ];
  }
  return createInvariantProjectionHooks({
    ...options,
    workflowRunId: `verification_${safeWorkflowRunIdSegment(profileName)}`,
    assetName: `verification:${profileName}`,
    contentHash: `builtin:verification-profile:${profileName}:${renderedCommands.join("|")}`,
    verificationSource: "profile",
    profile: profileName,
    verifiers: verificationCommandVerifiers(profileName, commands),
    guidance,
    injectOutput: config.afterWrites?.injectOutput,
    builtinVerifiers: {
      [MISSING_PROFILE_BUILTIN_VERIFIER]: missingProfileVerifier,
    },
  }).hooks;
}

function renderedVerificationCommands(
  commands: readonly CapabilityVerificationCommandConfig[],
): string[] {
  return commands
    .map((command) =>
      [command.command, ...(command.args ?? [])].join(" ").trim(),
    )
    .filter(Boolean);
}

function verificationGuidance(
  profileName: string,
  renderedCommands: readonly string[],
): string {
  return renderedCommands.length > 0
    ? `Project verification profile "${profileName}" is available. Run relevant verification commands before final answers after code writes: ${renderedCommands.join("; ")}.`
    : `Project verification profile "${profileName}" is configured, but it has no commands.`;
}

function verificationCommandVerifiers(
  profileName: string,
  commands: readonly CapabilityVerificationCommandConfig[],
): WorkflowCommandVerifierDefinition[] {
  if (commands.length === 0) {
    return [
      {
        id: "missing-profile",
        kind: "command",
        command: MISSING_PROFILE_BUILTIN_VERIFIER,
        expect: "zero",
        authorized: true,
        metadata: {
          builtinVerifier: MISSING_PROFILE_BUILTIN_VERIFIER,
          verificationSource: "profile",
          profile: profileName,
        },
      },
    ];
  }
  return commands.map((command) => ({
    id: command.id,
    kind: "command" as const,
    command: command.command,
    ...(command.args ? { args: command.args } : {}),
    ...(command.cwd ? { cwd: command.cwd } : {}),
    ...(command.timeoutMs !== undefined
      ? { timeoutMs: command.timeoutMs }
      : {}),
    ...(command.maxOutputBytes !== undefined
      ? { maxOutputBytes: command.maxOutputBytes }
      : {}),
    expect: "zero" as const,
    authorized: true,
    metadata: {
      verificationSource: "profile",
      profile: profileName,
    },
  }));
}

function missingProfileVerifier(
  input: InvariantBuiltinVerifierInput,
): WorkflowHookResult {
  const profile =
    typeof input.verifier.metadata?.profile === "string"
      ? input.verifier.metadata.profile
      : "unknown";
  return {
    status: "continue",
    metadata: {
      command: `verification profile "${profile}" has no commands`,
      exitCode: 1,
      timedOut: false,
      verificationSource: "profile",
      profile,
    },
  };
}

function verificationProfileName(config: CapabilityVerificationConfig): string {
  return (
    config.afterWrites?.profile ?? config.defaultProfile ?? DEFAULT_PROFILE
  );
}

function safeWorkflowRunIdSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]+/g, "_") || DEFAULT_PROFILE;
}
