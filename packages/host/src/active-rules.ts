import type { WorkflowHookMatcher } from "@sparkwright/core";
import type {
  CapabilityEventRuleSummary,
  CapabilityWorkflowRuleSummary,
} from "@sparkwright/protocol";
import type {
  CapabilityEventHookConfig,
  CapabilityHookActionConfig,
  CapabilityVerificationCommandConfig,
  CapabilityVerificationConfig,
  CapabilityWorkflowHookConfig,
} from "./config.js";
import {
  DOCUMENTED_COMMAND_RULE_ACTION_SUMMARY,
  DOCUMENTED_COMMAND_RULE_CONFIGURATION_HINT,
  DOCUMENTED_COMMAND_RULE_DESCRIPTION,
  DOCUMENTED_COMMAND_RULE_DISABLE_HINT,
  DOCUMENTED_COMMAND_RULE_MATCHER_SUMMARY,
  DOCUMENTED_COMMAND_RULE_NAME,
  evaluateDocumentedCommandRule,
} from "./documented-command-check.js";

const DEFAULT_VERIFICATION_PROFILE = "fast";

export function describeActiveWorkflowRules(input: {
  workflowHooks?: CapabilityWorkflowHookConfig[];
  verification?: CapabilityVerificationConfig;
  documentedCommand?: {
    goal?: string;
    shouldWrite?: boolean;
  };
}): CapabilityWorkflowRuleSummary[] {
  return [
    ...describeConfiguredWorkflowRules(input.workflowHooks),
    ...describeVerificationWorkflowRules(input.verification),
    describeDocumentedCommandWorkflowRule(input.documentedCommand),
  ];
}

export function describeActiveEventRules(input: {
  eventHooks?: CapabilityEventHookConfig[];
}): CapabilityEventRuleSummary[] {
  return describeConfiguredEventRules(input.eventHooks);
}

function describeConfiguredWorkflowRules(
  hooks: readonly CapabilityWorkflowHookConfig[] | undefined,
): CapabilityWorkflowRuleSummary[] {
  return (hooks ?? []).map((hook) => {
    const enabled = hook.enabled !== false;
    return {
      name: hook.name,
      source: "config",
      lifecycle: hook.hook,
      matcher: summarizeMatcher(hook.matcher),
      action: summarizeAction(hook.action, hook.onError),
      blockingPotential: actionCanBlock(hook.action, hook.onError),
      enabled,
      active: enabled,
      status: enabled ? "active" : "disabled",
      ...(hook.description ? { description: hook.description } : {}),
      disableHint: enabled
        ? "Set this capabilities.hooks.workflow entry to enabled=false."
        : "Set this capabilities.hooks.workflow entry to enabled=true to register it.",
      configurationHint: "Configured in capabilities.hooks.workflow.",
    };
  });
}

function describeConfiguredEventRules(
  hooks: readonly CapabilityEventHookConfig[] | undefined,
): CapabilityEventRuleSummary[] {
  return (hooks ?? []).map((hook) => {
    const enabled = hook.enabled !== false;
    return {
      name: hook.name,
      source: "config",
      trigger: formatMatchValue(hook.trigger),
      matcher: summarizeMatcher(hook.matcher),
      action: summarizeAction(hook.action, undefined),
      blockingPotential: false,
      enabled,
      active: enabled,
      status: enabled ? "active" : "disabled",
      ...(hook.description ? { description: hook.description } : {}),
      disableHint: enabled
        ? "Set this capabilities.hooks.events entry to enabled=false."
        : "Set this capabilities.hooks.events entry to enabled=true to register it.",
      configurationHint: "Configured in capabilities.hooks.events.",
    };
  });
}

function describeVerificationWorkflowRules(
  verification: CapabilityVerificationConfig | undefined,
): CapabilityWorkflowRuleSummary[] {
  if (!verification) return [];
  const mode = verification.mode ?? "suggest";
  if (mode === "off") return [];

  const profileName = verificationProfileName(verification);
  const workflowName = verificationWorkflowRuleName(profileName);
  const commands = verification.profiles?.[profileName] ?? [];
  if (mode === "suggest") {
    return [
      {
        name: workflowName,
        source: "verification",
        lifecycle: "TurnStart",
        matcher: "all",
        action:
          commands.length > 0
            ? `inject system context for profile "${profileName}"`
            : `inject system context for missing profile "${profileName}"`,
        blockingPotential: false,
        enabled: true,
        active: true,
        status: "active",
        description:
          "Suggests configured verification commands at the start of a run.",
        disableHint: "Set capabilities.verification.mode=off.",
        configurationHint: `Configure capabilities.verification.profiles.${profileName}.`,
      },
    ];
  }

  if (commands.length === 0) {
    return [
      {
        name: workflowName,
        source: "verification",
        lifecycle: "Stop",
        matcher: "all",
        action: `fail verification invariant because profile "${profileName}" has no commands`,
        blockingPotential: false,
        enabled: true,
        active: true,
        status: "active",
        description:
          "Requires the selected verification profile to define commands.",
        disableHint: "Set capabilities.verification.mode=off.",
        configurationHint: `Add commands under capabilities.verification.profiles.${profileName}.`,
      },
    ];
  }

  const commandRules = commands.map((command) =>
    describeVerificationCommandRule(profileName, workflowName, command),
  );
  return commandRules;
}

function describeVerificationCommandRule(
  profileName: string,
  workflowName: string,
  command: CapabilityVerificationCommandConfig,
): CapabilityWorkflowRuleSummary {
  return {
    name: `${workflowName}:${command.id}`,
    source: "verification",
    lifecycle: "Stop",
    matcher: "run-level invariant after workspace writes",
    action: `invariant verifier command: ${formatCommand(command.command, command.args)}`,
    blockingPotential: false,
    enabled: true,
    active: true,
    status: "active",
    description: `Runs ${command.id} verification after workspace writes.`,
    disableHint:
      "Set capabilities.verification.mode=off or remove this command from the selected profile.",
    configurationHint: `Configure this command under capabilities.verification.profiles.${profileName}.`,
  };
}

function describeDocumentedCommandWorkflowRule(
  input:
    | {
        goal?: string;
        shouldWrite?: boolean;
      }
    | undefined,
): CapabilityWorkflowRuleSummary {
  const activation = evaluateDocumentedCommandRule({
    goal: input?.goal,
    shouldWrite: input?.shouldWrite,
  });
  return {
    name: DOCUMENTED_COMMAND_RULE_NAME,
    source: "builtin",
    lifecycle: "Stop",
    matcher: DOCUMENTED_COMMAND_RULE_MATCHER_SUMMARY,
    action: DOCUMENTED_COMMAND_RULE_ACTION_SUMMARY,
    blockingPotential: false,
    enabled: activation.enabled,
    active: activation.active,
    status: activation.active
      ? "active"
      : activation.hasRunContext
        ? "inactive"
        : "available",
    description: DOCUMENTED_COMMAND_RULE_DESCRIPTION,
    disableHint: DOCUMENTED_COMMAND_RULE_DISABLE_HINT,
    configurationHint: DOCUMENTED_COMMAND_RULE_CONFIGURATION_HINT,
  };
}

function verificationProfileName(config: CapabilityVerificationConfig): string {
  return (
    config.afterWrites?.profile ??
    config.defaultProfile ??
    DEFAULT_VERIFICATION_PROFILE
  );
}

function verificationWorkflowRuleName(profileName: string): string {
  return `verification:${profileName.replace(/[^A-Za-z0-9_.:-]+/g, "_") || DEFAULT_VERIFICATION_PROFILE}`;
}

function summarizeMatcher(matcher: WorkflowHookMatcher | undefined): string {
  if (!matcher) return "all";
  const parts: string[] = [];
  for (const key of [
    "toolName",
    "eventType",
    "signal",
    "status",
    "pathGlob",
    "excludePathGlob",
  ] as const) {
    const value = matcher[key];
    if (value === undefined) continue;
    parts.push(`${key}=${formatMatchValue(value)}`);
  }
  return parts.length > 0 ? parts.join("; ") : "all";
}

function summarizeAction(
  action: CapabilityHookActionConfig,
  onError: "continue" | "block" | undefined,
): string {
  const suffix = [onError === "block" ? "onError=block" : undefined]
    .filter((part): part is string => !!part)
    .map((part) => `; ${part}`)
    .join("");
  if (action.type === "block") {
    return `block: ${truncate(action.reason)}${suffix}`;
  }
  if (action.type === "context") {
    return `inject ${action.contextType ?? "summary"} context${suffix}`;
  }
  if (action.type === "command") {
    const block = action.blockOnFailure === true ? "; blockOnFailure=true" : "";
    const inject = `; injectOutput=${action.injectOutput ?? "always"}`;
    const resultMode =
      action.resultMode === "stdoutJson" ? "; resultMode=stdoutJson" : "";
    return `command: ${formatCommand(action.command, action.args)}${block}${inject}${resultMode}${suffix}`;
  }
  if (action.type === "http") {
    const httpBlock =
      action.blockOnFailure === true ? "; blockOnFailure=true" : "";
    const httpInject = `; injectOutput=${action.injectOutput ?? "always"}`;
    const httpResultMode =
      action.resultMode === "responseJson" ? "; resultMode=responseJson" : "";
    return `http: ${action.method ?? "POST"} ${action.url}${httpBlock}${httpInject}${httpResultMode}${suffix}`;
  }
  const target = action.agentId
    ? `agentId=${action.agentId}`
    : `toolName=${action.toolName}`;
  const agentInject = `; injectOutput=${action.injectOutput ?? "always"}`;
  const agentResultMode =
    action.resultMode === "workflowResult" ? "; resultMode=workflowResult" : "";
  return `agent: ${target}; goal=${truncate(action.goal)}${agentInject}${agentResultMode}${suffix}`;
}

function actionCanBlock(
  action: CapabilityHookActionConfig,
  onError: "continue" | "block" | undefined,
): boolean {
  return (
    action.type === "block" ||
    (action.type === "command" && action.blockOnFailure === true) ||
    (action.type === "command" && action.resultMode === "stdoutJson") ||
    (action.type === "http" && action.blockOnFailure === true) ||
    (action.type === "http" && action.resultMode === "responseJson") ||
    (action.type === "agent" && action.resultMode === "workflowResult") ||
    onError === "block"
  );
}

function formatMatchValue(value: string | readonly string[]): string {
  return typeof value === "string" ? value : value.join("|");
}

function formatCommand(
  command: string,
  args: readonly string[] | undefined,
): string {
  return [command, ...(args ?? [])].join(" ").trim();
}

function truncate(value: string): string {
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}
