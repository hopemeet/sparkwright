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
  createAgentProfilePolicy,
  deriveChildAgentProfile,
} from "@sparkwright/agent-runtime";

const derived = deriveChildAgentProfile({
  parentAgent: {
    id: "planner",
    allowedTools: ["read", "search", "delegate"],
    deniedTools: ["shell"],
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

`createAgentTool` and `mountAgentTool` expose a profile-backed child run through
the normal tool path. The parent model receives the child result, not the
child's entire intermediate context.

## Boundary

This package deliberately avoids scheduling, shared memory, credential handling,
or workspace storage ownership. Those remain host responsibilities. Agent
profiles only shape runs.
