# @sparkwright/agent-runtime

Experimental agent profile and policy helpers for Sparkwright.

An agent profile is a reusable run template for a specific agent role. It can
carry role guidance, tool boundaries, policy, step limits, and run budget.
Profiles do not own credentials, sessions, installed skills, cron state, logs,
or workspace storage.

This package provides lightweight profile composition, policy adaptation, and
sub-agent helpers so applications can keep agent capability boundaries explicit
while still using normal Sparkwright runs.

## API

```ts
import {
  composeInProcessChildAgentPrompt,
  createAgentProfilePolicy,
  deriveChildAgentProfile,
} from "@sparkwright/agent-runtime";

const derived = deriveChildAgentProfile({
  parentAgent: {
    id: "planner",
    allowedTools: ["read", "search", "delegate"],
    deniedTools: ["bash"],
  },
  childAgent: {
    id: "reviewer",
    allowedTools: ["read", "search"],
    policy: [
      {
        action: "workspace.write",
        resource: "*",
        effect: "deny",
      },
    ],
  },
});

const policy = createAgentProfilePolicy(derived.effectiveProfile);
```

`experimental.prompt` is compiled into an application prompt section for runs
spawned from the profile. Top-level `mode`, `model`, and `prompt` remain
compatibility fields; new callers should put orchestration-specific values
under `experimental`.

## Capability Rules

Rules match `action` and optional `resource`:

```ts
{
  action: "tool.execute",
  resource: "deploy-*",
  effect: "requires_approval",
}
```

Policy adapters prefer typed `PolicyResource` input and still accept legacy
`metadata.resource`, `metadata.toolName`, and `metadata.path` for compatibility.

Precedence is:

```txt
deny > requires_approval > allow
```

Inherited parent deny and approval rules remain constraining for child agents.
Child allow rules cannot override inherited denies.

## Tool Allow Lists

`allowedTools` and `deniedTools` are agent-scoped capability boundaries.

- `allowedTools: undefined` means no explicit allow-list restriction.
- `allowedTools: []` means no tools are allowed.
- `deniedTools` always removes matching tools.

When no explicit profile rule matches, `createAgentProfilePolicy` falls back to
the core default policy unless a caller supplies a custom fallback.

## Delegation

`spawnSubAgent` starts a child run from a child agent profile. The child run gets
its own prompt, tools, budget, trace linkage, and cancellation path. Parent run
restrictions remain constraining, so delegation cannot be used to bypass policy.

Host-style Core-backed children can opt into the shared task-agnostic behavior
and result contract with
`composeInProcessChildAgentPrompt(childAgentProfile.prompt)`. The helper keeps
profile specialization first and returns one application-prompt string.
`spawnSubAgent` does not inject it automatically, so low-level embedders retain
control of explicit custom prompt builders. ACP and external-command workers
keep their transport-owned input contracts.

`createAgentTool` and `mountAgentTool` expose a profile-backed child run through
the normal tool path. The parent model receives the child result, not the
child's entire intermediate context. Callers pass the complete spawn
`ToolDefinition.policy`; agent-runtime does not synthesize a parallel approval
option.

Built-in in-process adapters use `completeSpawnedAgentInvocation()` after they
have resolved and prepared one `SpawnedSubAgent`. The helper starts that child
once, projects runtime/workspace evidence into `ParentAgentResult`, records only
eligible clean results in the delegation ledger, and retains at most three
bounded successful tool observations when the child fails. It does not resolve
profiles, schedule batches, select a transport, or change the explicit
`spawnSubAgent` prompt opt-in boundary.

The shared child contract requires reports to distinguish pre-existing state,
attempted actions, and effects actually produced by successful actions. It also
stops repeated observations that neither change the deliverable nor resolve a
specific uncertainty. Core assessment health remains runtime/trace evidence; it
is not duplicated into the parent result as a warning.

## Boundary

This package deliberately avoids scheduling, shared memory, credential handling,
or workspace storage ownership. Those remain host responsibilities. Agent
profiles only shape runs.
