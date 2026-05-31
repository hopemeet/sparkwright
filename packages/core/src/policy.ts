// AI maintenance note: Policy = decide whether an action is allowed, denied,
// or requires approval. Layer policies with `createLayeredPolicy`; treat new
// constraints as additional layers, not as edits to the default policy.
// Risk → tool gate is enforced in run.ts via `checkToolGate`.

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
          if (isReadOnlyAction(input.action)) return baseDecision;
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

function isReadOnlyAction(action: string): boolean {
  return action === "workspace.read" || action.endsWith(".read");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
