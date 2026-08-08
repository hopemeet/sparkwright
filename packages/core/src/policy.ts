// AI maintenance note: Policy = decide whether an action is allowed, denied,
// or requires approval. Layer policies with `createLayeredPolicy`; treat new
// constraints as additional layers, not as edits to the default policy.
// Risk → tool gate is enforced in run.ts via `checkToolGate`.

import { isRecord } from "./record-utils.js";
export type PolicyDecisionKind = "allow" | "deny" | "requires_approval";
export type PermissionMode =
  | "plan"
  | "default"
  | "accept_edits"
  | "dont_ask"
  | "bypass_permissions";

export interface PolicyResource {
  kind: string;
  id?: string;
  name?: string;
  path?: string;
  uri?: string;
  metadata?: Record<string, unknown>;
}

export interface PolicyInput {
  action: string;
  resource?: PolicyResource;
  metadata?: Record<string, unknown>;
}

export interface PolicyDecision {
  action: string;
  decision: PolicyDecisionKind;
  reason: string;
  metadata: Record<string, unknown>;
}

export interface Policy {
  decide(input: PolicyInput): Promise<PolicyDecision> | PolicyDecision;
}

export interface PermissionModePolicyOptions {
  mode: PermissionMode;
  basePolicy?: Policy;
}

export interface ToolGovernancePolicyOptions {
  agentId?: string;
  roles?: string[];
}

export interface WorkspaceMutationPolicyOptions {
  allowWorkspaceWrites: boolean;
  /** Optional workspace-relative file paths this run may mutate. */
  allowedPaths?: readonly string[];
  /** Maximum distinct file paths this run may write. Undefined means unlimited. */
  maxWriteFiles?: number;
  /** Maximum changed diff lines per write. Undefined means unlimited. */
  maxDiffLines?: number;
  /** Whether unified diffs may include deleted lines. Defaults to true. */
  allowDeletions?: boolean;
}

export interface WorkspaceReadScopePolicyOptions {
  /**
   * Workspace-relative paths or globs whose CONTENTS the run must not read.
   * Matching `workspace.read` actions are denied outright. Patterns support
   * `*` (single segment) and `**` (any depth) and a bare directory path
   * (e.g. `secrets`) denies everything beneath it.
   */
  confidentialPaths: readonly string[];
}

export interface RunConfidentialPathsOptions {
  /**
   * Whether to prepend SparkWright's built-in conservative confidential path
   * set. Defaults to true at run boundaries; set false only when the embedder
   * intentionally owns the full read-confidentiality list.
   */
  confidentialDefaults?: boolean;
  /** Additional workspace-relative paths or globs to deny for this run. */
  confidentialPaths?: readonly string[];
}

export const DEFAULT_CONFIDENTIAL_PATHS = [
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "**/*secret*",
  "**/*token*",
  "**/*credential*",
  ".ssh",
  ".aws",
  ".gcp",
  ".azure",
] as const;

export function resolveRunConfidentialPaths(
  options: RunConfidentialPathsOptions = {},
): string[] {
  const paths = [
    ...(options.confidentialDefaults === false
      ? []
      : DEFAULT_CONFIDENTIAL_PATHS),
    ...(options.confidentialPaths ?? []),
  ];
  return [...new Set(paths)];
}

/**
 * Read-confidentiality layer. The workspace path policy enforces the workspace
 * *boundary* (path-escape) but nothing scopes reads of sensitive files *inside*
 * the root — so a prompt can induce the model to read a secrets file and the
 * only thing stopping disclosure is the model's own discretion. This layer
 * closes that gap. This low-level policy denies `workspace.read` of any
 * matching file at the tool layer; callers that want SparkWright's conservative
 * default deny set should pass `resolveRunConfidentialPaths()`.
 */
export function createWorkspaceReadScopePolicy(
  options: WorkspaceReadScopePolicyOptions,
): Policy {
  const matchers = options.confidentialPaths
    .map(normalizeWorkspacePolicyPath)
    .filter((path): path is string => path !== undefined)
    .map((pattern) => ({
      pattern,
      regex: confidentialPatternToRegExp(pattern),
    }));

  return {
    decide(input): PolicyDecision {
      if (matchers.length === 0 || input.action !== "workspace.read") {
        return allowDecision(input, "Outside workspace read-scope policy.");
      }

      const path = workspaceWritePathFromInput(input);
      if (!path)
        return allowDecision(input, "No workspace read path supplied.");

      const hit = matchers.find((matcher) => matcher.regex.test(path));
      if (hit) {
        return denyDecision(
          input,
          `Read denied: ${path} is a confidential path for this run.`,
          { path, pattern: hit.pattern },
        );
      }
      return allowDecision(
        input,
        "Workspace read is outside confidential scope.",
        {
          path,
        },
      );
    },
  };
}

export function createDefaultPolicy(): Policy {
  return {
    decide({ action, metadata = {} }) {
      if (action === "workspace.write") {
        return {
          action,
          decision: "requires_approval",
          reason: "Workspace writes require approval by default.",
          metadata,
        };
      }

      return {
        action,
        decision: "allow",
        reason: "Allowed by default policy.",
        metadata,
      };
    },
  };
}

export function createLayeredPolicy(policies: Policy[]): Policy {
  return {
    async decide(input): Promise<PolicyDecision> {
      if (policies.length === 0) {
        return allowDecision(input, "Allowed by empty layered policy.");
      }

      const decisions = await Promise.all(
        policies.map((policy) => policy.decide(input)),
      );
      const deny = decisions.find((decision) => decision.decision === "deny");
      if (deny) return deny;

      const approval = decisions.find(
        (decision) => decision.decision === "requires_approval",
      );
      if (approval) return approval;

      return decisions[0] ?? allowDecision(input, "Allowed by layered policy.");
    },
  };
}

export function createPermissionModePolicy(
  options: PermissionModePolicyOptions,
): Policy {
  const basePolicy = options.basePolicy ?? createDefaultPolicy();

  return {
    async decide(input): Promise<PolicyDecision> {
      const baseDecision = await basePolicy.decide(input);
      if (baseDecision.decision === "deny") return baseDecision;

      switch (options.mode) {
        case "default":
          return baseDecision;

        case "plan":
          if (isReadOnlyAction(input)) return baseDecision;
          return requireApproval(input, "Plan mode requires approval.");

        case "accept_edits":
          if (input.action === "workspace.write") {
            return allowDecision(
              input,
              "Workspace write allowed by accept_edits mode.",
            );
          }
          return baseDecision;

        case "dont_ask":
          if (baseDecision.decision === "requires_approval") {
            return denyDecision(
              input,
              "Action requires approval, but dont_ask mode cannot prompt.",
              {
                blockedDecision: baseDecision,
              },
            );
          }
          return baseDecision;

        case "bypass_permissions":
          return allowDecision(
            input,
            "Allowed by bypass_permissions mode after deny checks.",
            {
              baseDecision,
            },
          );
      }
    },
  };
}

export function createToolGovernancePolicy(
  options: ToolGovernancePolicyOptions = {},
): Policy {
  const roles = new Set(options.roles ?? []);

  return {
    decide(input): PolicyDecision {
      if (input.action !== "tool.execute") {
        return allowDecision(
          input,
          "Action is outside tool governance policy.",
        );
      }

      const governance = governanceFromInput(input);
      if (!governance) {
        return allowDecision(input, "No tool governance metadata supplied.");
      }

      if (
        Array.isArray(governance.allowedAgents) &&
        options.agentId !== undefined &&
        !governance.allowedAgents.includes(options.agentId)
      ) {
        return denyDecision(input, "Tool is outside the agent allowlist.", {
          agentId: options.agentId,
          allowedAgents: governance.allowedAgents,
        });
      }

      if (
        Array.isArray(governance.allowedRoles) &&
        governance.allowedRoles.length > 0 &&
        !governance.allowedRoles.some((role) => roles.has(role))
      ) {
        return denyDecision(input, "Tool is outside the role allowlist.", {
          roles: [...roles],
          allowedRoles: governance.allowedRoles,
        });
      }

      if (
        Array.isArray(governance.sideEffects) &&
        governance.sideEffects.some((effect) =>
          ["write", "network", "external"].includes(effect),
        )
      ) {
        return requireApproval(
          input,
          "Tool side effects require approval by governance policy.",
          {
            sideEffects: governance.sideEffects,
          },
        );
      }

      return allowDecision(input, "Allowed by tool governance policy.");
    },
  };
}

export function createWorkspaceMutationPolicy(
  options: WorkspaceMutationPolicyOptions,
): Policy {
  const allowedPaths = new Set(
    (options.allowedPaths ?? [])
      .map(normalizeWorkspacePolicyPath)
      .filter((path): path is string => path !== undefined),
  );
  const writtenPaths = new Set<string>();
  const allowDeletions = options.allowDeletions ?? true;

  return {
    decide(input): PolicyDecision {
      if (options.allowWorkspaceWrites) {
        if (input.action !== "workspace.write") {
          return allowDecision(
            input,
            "Workspace mutations allowed for this run.",
          );
        }

        const path = workspaceWritePathFromInput(input);
        if (!path) {
          return denyDecision(
            input,
            "Workspace write path is required for mutation policy.",
          );
        }

        if (allowedPaths.size > 0 && !allowedPaths.has(path)) {
          return denyDecision(
            input,
            `Workspace write is outside the allowed target scope: ${path}`,
            { path, allowedPaths: [...allowedPaths] },
          );
        }

        const nextWrittenPaths = new Set(writtenPaths);
        nextWrittenPaths.add(path);
        if (
          options.maxWriteFiles !== undefined &&
          nextWrittenPaths.size > options.maxWriteFiles
        ) {
          return denyDecision(
            input,
            `Workspace write exceeds the run file budget of ${options.maxWriteFiles}.`,
            {
              path,
              writtenPaths: [...writtenPaths],
              maxWriteFiles: options.maxWriteFiles,
              guidance:
                "A previous workspace write already used the distinct-file budget for this run. Do not retry another workspace write for this path in the current run; re-read changed files, report the limit, or provide the remaining patch as unapplied text.",
            },
          );
        }

        const diff =
          typeof input.metadata?.diff === "string"
            ? input.metadata.diff
            : undefined;
        const diffStats = diff ? summarizeUnifiedDiff(diff) : undefined;
        if (
          diffStats &&
          options.maxDiffLines !== undefined &&
          diffStats.changedLines > options.maxDiffLines
        ) {
          return denyDecision(
            input,
            `Workspace write exceeds the diff budget of ${options.maxDiffLines} changed lines.`,
            { path, diffStats, maxDiffLines: options.maxDiffLines },
          );
        }
        if (diffStats && !allowDeletions && diffStats.deletedLines > 0) {
          return denyDecision(
            input,
            "Workspace write deletions are not allowed for this run.",
            { path, diffStats },
          );
        }

        writtenPaths.add(path);
        return allowDecision(input, "Workspace write is within run limits.", {
          path,
          writtenPaths: [...writtenPaths],
          ...(diffStats ? { diffStats } : {}),
        });
      }

      if (input.action === "workspace.write") {
        return denyDecision(
          input,
          "Workspace writes require an explicit write-enabled run.",
        );
      }

      if (input.action !== "tool.execute") {
        return allowDecision(
          input,
          "Action is outside workspace mutation policy.",
        );
      }

      const sideEffects = sideEffectsFromInput(input);
      if (sideEffects.length === 0) {
        return denyDecision(
          input,
          "Unclassified tools cannot execute in a read-only run.",
          { reason: "missing_side_effect_classification" },
        );
      }
      if (!sideEffects.includes("write")) {
        return allowDecision(input, "Tool has no declared write side effect.");
      }

      return denyDecision(
        input,
        "Tools with write side effects require an explicit write-enabled run.",
        { sideEffects },
      );
    },
  };
}

function allowDecision(
  input: PolicyInput,
  reason: string,
  metadata: Record<string, unknown> = {},
): PolicyDecision {
  return {
    action: input.action,
    decision: "allow",
    reason,
    metadata: {
      ...(input.metadata ?? {}),
      ...metadata,
    },
  };
}

function denyDecision(
  input: PolicyInput,
  reason: string,
  metadata: Record<string, unknown> = {},
): PolicyDecision {
  return {
    action: input.action,
    decision: "deny",
    reason,
    metadata: {
      ...(input.metadata ?? {}),
      ...metadata,
    },
  };
}

function requireApproval(
  input: PolicyInput,
  reason: string,
  metadata: Record<string, unknown> = {},
): PolicyDecision {
  return {
    action: input.action,
    decision: "requires_approval",
    reason,
    metadata: {
      ...(input.metadata ?? {}),
      ...metadata,
    },
  };
}

function isReadOnlyAction(input: PolicyInput): boolean {
  if (input.action === "workspace.read" || input.action.endsWith(".read")) {
    return true;
  }

  if (input.action !== "tool.execute") return false;

  const risk = toolRiskFromInput(input);
  if (risk !== "safe") return false;

  const sideEffects = sideEffectsFromInput(input);
  return (
    sideEffects.length > 0 &&
    sideEffects.every((effect) => effect === "read" || effect === "none")
  );
}

function toolRiskFromInput(input: PolicyInput): string | undefined {
  const fromResource = input.resource?.metadata?.risk;
  if (typeof fromResource === "string") return fromResource;

  const fromMetadata = input.metadata?.risk;
  return typeof fromMetadata === "string" ? fromMetadata : undefined;
}

function governanceFromInput(
  input: PolicyInput,
): Record<string, unknown> | undefined {
  const fromResource = input.resource?.metadata?.governance;
  if (isRecord(fromResource)) return fromResource;

  const fromMetadata = input.metadata?.governance;
  if (isRecord(fromMetadata)) return fromMetadata;

  return undefined;
}

function sideEffectsFromInput(input: PolicyInput): string[] {
  const governance = governanceFromInput(input);
  const sideEffects = governance?.sideEffects;
  if (!Array.isArray(sideEffects)) return [];
  return sideEffects.filter(
    (sideEffect): sideEffect is string => typeof sideEffect === "string",
  );
}

function workspaceWritePathFromInput(input: PolicyInput): string | undefined {
  const raw =
    typeof input.metadata?.path === "string"
      ? input.metadata.path
      : typeof input.resource?.path === "string"
        ? input.resource.path
        : undefined;
  return raw ? normalizeWorkspacePolicyPath(raw) : undefined;
}

function normalizeWorkspacePolicyPath(path: string): string | undefined {
  const normalized = path
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part.length > 0 && part !== ".")
    .join("/");
  if (!normalized || normalized === ".." || normalized.startsWith("../")) {
    return undefined;
  }
  return normalized;
}

/**
 * Compile a normalized confidential pattern into an anchored RegExp.
 * - `**` matches any number of path segments (including zero).
 * - `*` matches within a single segment.
 * - A pattern with no wildcard matches the exact file OR anything beneath it
 *   when used as a directory prefix (`secrets` matches `secrets/key.txt`).
 */
function confidentialPatternToRegExp(pattern: string): RegExp {
  const hasWildcard = pattern.includes("*");
  const source = pattern
    .split("/")
    .map((segment) => globSegmentToRegExpSource(segment))
    .join("/");
  // Wildcard patterns match exactly; literal patterns also match as a directory
  // prefix so a whole confidential folder can be named once.
  const tail = hasWildcard ? "" : "(?:/.*)?";
  return new RegExp(`^${source}${tail}$`);
}

/**
 * Translate one glob path segment to a RegExp source: `**` -> any depth (`.*`),
 * `*` -> within-segment (`[^/]*`), all other characters escaped literally.
 */
function globSegmentToRegExpSource(segment: string): string {
  if (segment === "**") return ".*";
  let out = "";
  for (const ch of segment) {
    if (ch === "*") {
      out += "[^/]*";
    } else if (/[.+^${}()|[\]\\?]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return out;
}

function summarizeUnifiedDiff(diff: string): {
  addedLines: number;
  deletedLines: number;
  changedLines: number;
} {
  let addedLines = 0;
  let deletedLines = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) addedLines += 1;
    else if (line.startsWith("-")) deletedLines += 1;
  }
  return {
    addedLines,
    deletedLines,
    changedLines: addedLines + deletedLines,
  };
}
