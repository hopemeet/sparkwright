import { isAbsolute, relative, resolve, sep } from "node:path";

export type ApprovalChoice = "allow-once" | "allow-session" | "deny";

export type ApprovalSubject =
  | {
      kind: "workspace-write";
      path: string;
      key: string;
      rememberLabel: string;
    }
  | {
      kind: "shell";
      command: string;
      cwd: string;
      key: string;
      rememberLabel: string;
    }
  | {
      kind: "tool";
      toolName: string;
      key: string;
      rememberLabel: string;
    }
  | { kind: "unknown" };

export interface SessionApprovalRule {
  key: string;
  kind: Exclude<ApprovalSubject["kind"], "unknown">;
  label: string;
}

export interface ApprovalRequestView {
  action: string;
  details: Record<string, unknown>;
}

export function approvalSubject(
  request: ApprovalRequestView,
  workspaceRoot: string,
): ApprovalSubject {
  const { action, details } = request;
  if (action === "workspace.write") {
    const rawPath = stringValue(details.path);
    const path = rawPath
      ? normalizeWorkspacePath(workspaceRoot, rawPath)
      : undefined;
    if (!path) return { kind: "unknown" };
    return {
      kind: "workspace-write",
      path,
      key: ruleKey("workspace-write", { workspaceRoot, path }),
      rememberLabel: `Allow writes to ${path} for this session`,
    };
  }

  if (action === "tool.execute") {
    const toolName = stringValue(details.toolName) ?? stringValue(details.name);
    const args =
      recordValue(details.arguments) ??
      recordValue(details.args) ??
      recordValue(details.toolArgs);
    if (!toolName || !args) return { kind: "unknown" };
    const identity = toolIdentity(toolName, details.governance);
    if (isShellToolName(toolName)) {
      const command = stringValue(args.command);
      if (!command) return { kind: "unknown" };
      const cwd = normalizeCwd(workspaceRoot, stringValue(args.cwd));
      return {
        kind: "shell",
        command,
        cwd,
        key: ruleKey("shell", { identity, args, cwd }),
        rememberLabel: "Allow this exact command here for this session",
      };
    }
    return {
      kind: "tool",
      toolName,
      key: ruleKey("tool", { identity, args }),
      rememberLabel: `Allow this exact ${toolName} call for this session`,
    };
  }

  if (action === "shell.execute") {
    const command = stringValue(details.command);
    if (!command) return { kind: "unknown" };
    const cwd = normalizeCwd(workspaceRoot, stringValue(details.cwd));
    return {
      kind: "shell",
      command,
      cwd,
      key: ruleKey("shell", { details, cwd }),
      rememberLabel: "Allow this exact command here for this session",
    };
  }

  return { kind: "unknown" };
}

export function approvalChoices(
  subject: ApprovalSubject,
): readonly ApprovalChoice[] {
  return subject.kind === "unknown"
    ? ["allow-once", "deny"]
    : ["allow-once", "allow-session", "deny"];
}

export function approvalChoiceLabel(
  choice: ApprovalChoice,
  subject: ApprovalSubject,
): string {
  if (choice === "allow-once") return "Allow once";
  if (choice === "deny") return "Deny";
  return subject.kind === "unknown"
    ? "Allow for this session"
    : subject.rememberLabel;
}

export function sessionApprovalRule(
  subject: ApprovalSubject,
): SessionApprovalRule | undefined {
  if (subject.kind === "unknown") return undefined;
  return {
    key: subject.key,
    kind: subject.kind,
    label: subject.rememberLabel,
  };
}

function normalizeWorkspacePath(
  workspaceRoot: string,
  input: string,
): string | undefined {
  const root = resolve(workspaceRoot);
  const target = resolve(root, input);
  const rel = relative(root, target);
  if (
    rel === "" ||
    rel.startsWith(`..${sep}`) ||
    rel === ".." ||
    isAbsolute(rel)
  ) {
    return undefined;
  }
  return rel.split(sep).join("/");
}

function normalizeCwd(workspaceRoot: string, cwd: string | undefined): string {
  return resolve(workspaceRoot, cwd ?? ".");
}

function toolIdentity(toolName: string, governance: unknown): unknown {
  const governanceRecord = recordValue(governance);
  return {
    toolName,
    origin: governanceRecord?.origin ?? null,
  };
}

function isShellToolName(toolName: string): boolean {
  return toolName === "bash";
}

function ruleKey(kind: string, value: unknown): string {
  return `${kind}:${stableStringify(value)}`;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
