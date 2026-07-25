import type { ApprovalSubjectPayload } from "@sparkwright/protocol";

export type ApprovalChoice = "allow-once" | "allow-session" | "deny";

export type ApprovalSubject = ApprovalSubjectPayload;
export type RememberableApprovalSubject = Exclude<
  ApprovalSubject,
  { kind: "one_shot" }
>;

export interface SessionApprovalRule {
  /** Composite principal-scope + subject key used for lookup. */
  key: string;
  /** @reserved Producer effect key consumed by approval rule inspection UI. */
  subjectKey: string;
  principalScope: string;
  kind: RememberableApprovalSubject["kind"];
  label: string;
}

/**
 * Validate the producer-authored protocol subject. Malformed network input is
 * deliberately reduced to a one-shot request; the TUI never reconstructs a
 * reusable scope from display details.
 */
export function approvalSubject(value: unknown): ApprovalSubject {
  const record = recordValue(value);
  const label = stringValue(record?.label);
  if (!record || !label) {
    return { kind: "one_shot", label: "Allow this request once" };
  }
  if (record.kind === "one_shot") return { kind: "one_shot", label };

  const key = stringValue(record.key);
  if (!key) return { kind: "one_shot", label };
  if (record.kind === "workspace_file") {
    const path = stringValue(record.path);
    const operation = record.operation;
    if (
      path &&
      (operation === "create" ||
        operation === "replace" ||
        operation === "edit" ||
        operation === "remove" ||
        operation === "legacy_write" ||
        operation === "write")
    ) {
      return { kind: record.kind, operation, path, key, label };
    }
  }
  if (record.kind === "shell_command") {
    const command = stringValue(record.command);
    const cwd = stringValue(record.cwd);
    if (command && cwd) {
      const background =
        typeof record.background === "boolean" ? record.background : undefined;
      const lifetime =
        record.lifetime === "job" || record.lifetime === "service"
          ? record.lifetime
          : undefined;
      return {
        kind: record.kind,
        command,
        cwd,
        ...(background !== undefined ? { background } : {}),
        ...(lifetime ? { lifetime } : {}),
        key,
        label,
      };
    }
  }
  if (record.kind === "tool_call") {
    const toolName = stringValue(record.toolName);
    if (toolName) return { kind: record.kind, toolName, key, label };
  }
  return { kind: "one_shot", label };
}

export function approvalChoices(
  subject: ApprovalSubject,
): readonly ApprovalChoice[] {
  return subject.kind === "one_shot"
    ? ["allow-once", "deny"]
    : ["allow-once", "allow-session", "deny"];
}

export function approvalChoiceLabel(
  choice: ApprovalChoice,
  subject: ApprovalSubject,
): string {
  if (choice === "allow-once") return "Allow once";
  if (choice === "deny") return "Deny";
  return subject.label;
}

export function sessionApprovalRule(
  subject: ApprovalSubject,
  principalScope = "main",
): SessionApprovalRule | undefined {
  if (subject.kind === "one_shot") return undefined;
  return {
    key: approvalRuleKey(principalScope, subject.key),
    subjectKey: subject.key,
    principalScope,
    kind: subject.kind,
    label: subject.label,
  };
}

export function approvalRuleKey(
  principalScope: string,
  subjectKey: string,
): string {
  return `${principalScope}\0${subjectKey}`;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
