import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { type ValidationFinding, type WorkflowHook } from "@sparkwright/core";

export const DOCUMENTED_COMMAND_RULE_NAME = "documented-command-check";
export const DOCUMENTED_COMMAND_RULE_ID = `builtin:${DOCUMENTED_COMMAND_RULE_NAME}`;
export const DOCUMENTED_COMMAND_RULE_DESCRIPTION =
  "Blocks final answers when README documented commands still point at missing workspace paths.";
export const DOCUMENTED_COMMAND_RULE_MATCHER_SUMMARY =
  "write-enabled goals about verification, tests, handoff, release, docs, or documented commands";
export const DOCUMENTED_COMMAND_RULE_ACTION_SUMMARY =
  "block final answer when README documented commands reference missing workspace paths";
export const DOCUMENTED_COMMAND_RULE_DISABLE_HINT =
  "No dedicated config switch; run without workspace writes when this guard is not needed.";
export const DOCUMENTED_COMMAND_RULE_CONFIGURATION_HINT =
  "Activated by the current goal and write access; no config is required.";

export interface DocumentedCommandIssue {
  file: string;
  command: string;
  message: string;
}

export interface DocumentedCommandRuleActivation {
  enabled: true;
  active: boolean;
  hasRunContext: boolean;
  reason: string;
}

export interface DocumentedCommandRulePack {
  name: typeof DOCUMENTED_COMMAND_RULE_NAME;
  id: typeof DOCUMENTED_COMMAND_RULE_ID;
  source: "builtin";
  lifecycle: "Stop";
  description: typeof DOCUMENTED_COMMAND_RULE_DESCRIPTION;
  /** @reserved Built-in rule descriptor field consumed by capability inspection. */
  matcherSummary: typeof DOCUMENTED_COMMAND_RULE_MATCHER_SUMMARY;
  /** @reserved Built-in rule descriptor field consumed by capability inspection. */
  actionSummary: typeof DOCUMENTED_COMMAND_RULE_ACTION_SUMMARY;
  blockingPotential: true;
  disableHint: typeof DOCUMENTED_COMMAND_RULE_DISABLE_HINT;
  configurationHint: typeof DOCUMENTED_COMMAND_RULE_CONFIGURATION_HINT;
  /** @reserved Built-in rule activation field consumed by capability inspection. */
  activation: DocumentedCommandRuleActivation;
  hooks: WorkflowHook[];
}

export function shouldCheckDocumentedCommands(input: {
  goal?: string;
  shouldWrite: boolean;
}): boolean {
  if (!input.shouldWrite || !input.goal) return false;
  const goal = input.goal.toLowerCase();
  return (
    /\b(handoff|prepare|release|verify|verified|verification|test|tests|testing|documented|docs?|commands?|pass)\b/.test(
      goal,
    ) &&
    /\b(fix|prepare|handoff|verify|pass|resolve|make|update|documented|commands?)\b/.test(
      goal,
    )
  );
}

export function checkDocumentedCommands(
  workspaceRoot: string,
): DocumentedCommandIssue[] {
  const files = readmeFiles(workspaceRoot);
  const issues: DocumentedCommandIssue[] = [];
  for (const file of files) {
    const content = readFileSync(resolve(workspaceRoot, file), "utf8");
    for (const command of documentedShellCommands(content)) {
      issues.push(...checkCommand(workspaceRoot, file, command));
    }
  }
  return issues;
}

export function summarizeDocumentedCommandIssues(
  issues: readonly DocumentedCommandIssue[],
): string | undefined {
  if (issues.length === 0) return undefined;
  const first = issues[0]!;
  return `Run completed with stale documented command (${issues.length} issue${issues.length === 1 ? "" : "s"}). ${first.file}: ${first.message}`;
}

export function evaluateDocumentedCommandRule(input: {
  goal?: string;
  shouldWrite?: boolean;
}): DocumentedCommandRuleActivation {
  const hasRunContext =
    input.goal !== undefined && input.shouldWrite !== undefined;
  if (input.shouldWrite !== true) {
    return {
      enabled: true,
      active: false,
      hasRunContext,
      reason: "workspace writes are disabled",
    };
  }
  if (!input.goal) {
    return {
      enabled: true,
      active: false,
      hasRunContext,
      reason: "no goal context",
    };
  }
  const active = shouldCheckDocumentedCommands({
    goal: input.goal,
    shouldWrite: true,
  });
  return {
    enabled: true,
    active,
    hasRunContext,
    reason: active
      ? "write-enabled goal requests verification/handoff/documented-command validation"
      : "goal does not request documented-command validation",
  };
}

export function createDocumentedCommandRulePack(input: {
  workspaceRoot: string;
  goal?: string;
  shouldWrite?: boolean;
}): DocumentedCommandRulePack {
  const activation = evaluateDocumentedCommandRule(input);
  return {
    name: DOCUMENTED_COMMAND_RULE_NAME,
    id: DOCUMENTED_COMMAND_RULE_ID,
    source: "builtin",
    lifecycle: "Stop",
    description: DOCUMENTED_COMMAND_RULE_DESCRIPTION,
    matcherSummary: DOCUMENTED_COMMAND_RULE_MATCHER_SUMMARY,
    actionSummary: DOCUMENTED_COMMAND_RULE_ACTION_SUMMARY,
    blockingPotential: true,
    disableHint: DOCUMENTED_COMMAND_RULE_DISABLE_HINT,
    configurationHint: DOCUMENTED_COMMAND_RULE_CONFIGURATION_HINT,
    activation,
    hooks: activation.active
      ? [createDocumentedCommandWorkflowHook(input.workspaceRoot, activation)]
      : [],
  };
}

export function createDocumentedCommandStopHook(input: {
  workspaceRoot: string;
  goal: string;
  shouldWrite: boolean;
}): WorkflowHook[] {
  return createDocumentedCommandRulePack(input).hooks;
}

function createDocumentedCommandWorkflowHook(
  workspaceRoot: string,
  activation: DocumentedCommandRuleActivation,
): WorkflowHook {
  const blockedSignatures = new Set<string>();
  return {
    name: DOCUMENTED_COMMAND_RULE_NAME,
    id: DOCUMENTED_COMMAND_RULE_ID,
    description: DOCUMENTED_COMMAND_RULE_DESCRIPTION,
    hook: "Stop",
    handle() {
      const issues = checkDocumentedCommands(workspaceRoot);
      const metadata = documentedCommandRuleMetadata(activation, issues);
      if (issues.length === 0) {
        return { status: "continue" as const, metadata };
      }
      const signature = documentedCommandIssueSignature(issues);
      if (blockedSignatures.has(signature)) {
        return {
          status: "continue" as const,
          metadata: { ...metadata, repeatedIssueSignature: true },
        };
      }
      blockedSignatures.add(signature);
      const findings: ValidationFinding[] = issues.map((issue) => ({
        code: "STALE_DOCUMENTED_COMMAND",
        severity: "error",
        message: `${issue.file}: ${issue.message}`,
        metadata: { command: issue.command, file: issue.file },
      }));
      return {
        status: "block",
        reason:
          "A documented command still references a missing workspace path. " +
          "Fix the documentation or repository layout before finalizing.",
        findings,
        metadata,
      };
    },
  };
}

function documentedCommandRuleMetadata(
  activation: DocumentedCommandRuleActivation,
  issues: readonly DocumentedCommandIssue[],
): Record<string, unknown> {
  return {
    source: "builtin",
    ruleName: DOCUMENTED_COMMAND_RULE_NAME,
    activationReason: activation.reason,
    issueCount: issues.length,
    issues,
  };
}

function documentedCommandIssueSignature(
  issues: readonly DocumentedCommandIssue[],
): string {
  return issues
    .map((issue) => `${issue.file}\u0000${issue.command}\u0000${issue.message}`)
    .sort()
    .join("\u0001");
}

function readmeFiles(workspaceRoot: string): string[] {
  try {
    return readdirSync(workspaceRoot)
      .filter((name) => /^readme(?:\.[^.]+)?$/i.test(name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function documentedShellCommands(content: string): string[] {
  const commands: string[] = [];
  const fencePattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(content)) !== null) {
    const lang = (match[1] ?? "").trim().toLowerCase();
    if (
      lang &&
      !["bash", "sh", "shell", "zsh", "console", "terminal"].includes(lang)
    ) {
      continue;
    }
    const block = match[2] ?? "";
    for (const line of block.split(/\r?\n/)) {
      const command = normalizeCommandLine(line);
      if (command) commands.push(command);
    }
  }
  return commands;
}

function normalizeCommandLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  return trimmed.replace(/^\$\s*/, "").trim() || undefined;
}

function checkCommand(
  workspaceRoot: string,
  file: string,
  command: string,
): DocumentedCommandIssue[] {
  return [
    ...checkCargoManifestCommand(workspaceRoot, file, command),
    ...checkCdCommand(workspaceRoot, file, command),
    ...checkNpmPrefixCommand(workspaceRoot, file, command),
    ...checkPythonScriptCommand(workspaceRoot, file, command),
  ];
}

function checkCargoManifestCommand(
  workspaceRoot: string,
  file: string,
  command: string,
): DocumentedCommandIssue[] {
  if (!/\bcargo\s+(?:\S+\s+)*test\b/.test(command)) return [];
  const manifest = optionValue(command, "--manifest-path");
  if (!manifest) return [];
  return pathIssue(workspaceRoot, file, command, manifest, {
    escapes: `cargo --manifest-path escapes the workspace: ${manifest}`,
    missing: `cargo --manifest-path points to missing file: ${manifest}`,
  });
}

function checkCdCommand(
  workspaceRoot: string,
  file: string,
  command: string,
): DocumentedCommandIssue[] {
  const match = /(?:^|[;&|]\s*)cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/.exec(
    command,
  );
  const dir = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!dir || dir === "-" || dir.startsWith("$")) return [];
  return pathIssue(workspaceRoot, file, command, dir, {
    escapes: `cd target escapes the workspace: ${dir}`,
    missing: `cd target points to missing directory: ${dir}`,
  });
}

function checkNpmPrefixCommand(
  workspaceRoot: string,
  file: string,
  command: string,
): DocumentedCommandIssue[] {
  if (!/\b(npm|pnpm|yarn)\b/.test(command)) return [];
  const prefix = optionValue(command, "--prefix");
  if (!prefix) return [];
  return pathIssue(workspaceRoot, file, command, prefix, {
    escapes: `package-manager --prefix escapes the workspace: ${prefix}`,
    missing: `package-manager --prefix points to missing directory: ${prefix}`,
  });
}

function checkPythonScriptCommand(
  workspaceRoot: string,
  file: string,
  command: string,
): DocumentedCommandIssue[] {
  const match =
    /(?:^|\s)(?:python|python3|python\d+(?:\.\d+)?)\s+(?!-m\b)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/.exec(
      command,
    );
  const script = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!script || script.startsWith("-") || script.startsWith("$")) return [];
  return pathIssue(workspaceRoot, file, command, script, {
    escapes: `python script path escapes the workspace: ${script}`,
    missing: `python script path points to missing file: ${script}`,
  });
}

function optionValue(command: string, option: string): string | undefined {
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `(?:^|\\s)${escaped}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s\\\\]+))`,
  ).exec(command);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function pathIssue(
  workspaceRoot: string,
  file: string,
  command: string,
  path: string,
  messages: { escapes: string; missing: string },
): DocumentedCommandIssue[] {
  const absolute = isAbsolute(path) ? path : resolve(workspaceRoot, path);
  const rel = relative(workspaceRoot, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return [{ file, command, message: messages.escapes }];
  }
  if (existsSync(absolute)) return [];
  return [{ file, command, message: messages.missing }];
}
