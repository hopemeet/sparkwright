# @sparkwright/agent-runtime

Experimental agent profile and policy helpers for Sparkwright.

This package is not a multi-agent orchestrator. It provides lightweight profile
composition and policy adaptation so applications can keep agent capability
boundaries explicit while still using normal Sparkwright runs.

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

`mode`, `model`, and `prompt` are not applied by this package. If an
application needs to carry those values while it owns orchestration, put them
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

## Boundary

This package deliberately avoids child run execution, scheduling, shared memory,
or multi-agent session orchestration. Those can be layered later after parent
and child trace, budget, cancellation, and artifact semantics are clear.
