# Spawn-Time Capability Grant Proposal

Status: Draft — direction agreed, grant-token shape pinned (pre-impl)
Date: 2026-07-08
Branch context: sits at the intersection of `feat/background-agent-jobs`
([background-task-lifecycle.md](background-task-lifecycle.md)) and the access
mode work ([agent-access-config-redesign.md](agent-access-config-redesign.md)).

> Internal planning document. It does not change runtime behavior by itself. It
> defines how a parent decides, per spawn, what a child agent may do, and how
> that grant is authorized through the parent's already-live approval channel.

## Purpose

Dynamic sub-agents (`spawn_agent` and `task_create(kind:"agent")`) are hard
read-only today: their toolset is `readOnlyChildTools` (read/glob/grep/list_dir
/tool_search) with no `write` and no `bash`, and the child run is created with
`interactionChannel: null` and **no** `approvalResolver`
(`runtime.ts` dynamic spawn child options). Two consequences observed in
practice (sessions `session_tui_mrarzy67`, `session_tui_mrasazv7`):

- A child asked to "run in the background" / "write a file" cannot act, answers
  with prose, and reports `completed` — a false success the parent then
  rationalizes (in trace, by hallucinating an error that never fired).
- More broadly, a read-only child cannot use the filesystem as a handoff medium
  (produce scratch files / artifacts a parent or sibling reads), which is a real
  capability floor, not just an edge case.

Two rejected framings and why:

- **"Follow the session accessMode" (blanket inherit).** Too coarse, and it
  cannot work under `ask`: a detached background child has no approver at
  act-time, so an inherited "ask" either deadlocks or silently downgrades to
  bypass — a covert authority escalation.
- **"Make spawned agents equal configured delegates by default."** Too broad.
  Configured delegates are backed by reviewed Agent.md/profile/config artifacts;
  dynamic spawned agents are model-authored at call time. A spawned child may
  request a write grant, but the default remains read-only and any widened
  authority must be visible on the spawn call.
- **"Keep it hard read-only."** Too strict. The blast radius is already bounded:
  `bypass` only lifts `requires_approval → allow` _after_ deny checks
  (`policy.ts`, "Allowed by bypass_permissions mode after deny checks"), while
  `createWorkspaceMutationPolicy` confines writes to the workspace (+ `--target`
  / file / diff budgets) and the shell sandbox denies network + guards the
  filesystem — none of which `bypass` overrides. So a writable child's worst
  case is workspace-scoped, git-recoverable mutation, not host-wide risk.

## Core idea

The parent declares, **per spawn**, what the child needs; the grant is
authorized **at spawn time** through the parent's live approval channel; the
child then carries a scoped grant token and acts (including detached) without a
free-form act-time approver.

Canonical long-term surface:

```
spawn_agent({
  goal,
  role,
  prompt,
  grant: { workspaceWrite: true },
  allowedTools: ["read", "grep", "write"]
})
```

The key move: **authorization time shifts from "child acts" to "parent spawns."**
The parent is foregrounded with a live approval channel when it spawns, so the
user is asked _then_, before the child detaches. This structurally dissolves the
detached-approver problem while avoiding a hidden blanket inheritance rule.

Normal path:

```txt
main -> spawn_agent(args include grant.workspaceWrite)
  -> parent tool gate asks/allows/denies
  -> child is created only after allow
  -> child consumes grant token for managed workspace writes
```

Fallback path:

```txt
main -> spawn_agent(read-only)
  -> child/guard detects write-required goal
  -> tool fails with "re-spawn with a workspaceWrite grant"
```

The fallback is a correction path, not the intended flow. Prompt/schema guidance
and the F2 guard should make the parent request the right grant before spawning.

## Grant surface

`grant` is the capability request; `allowedTools` is the concrete child tool
allowlist. Keeping them separate avoids making one string (`write`) mean both
"the write tool" and "the workspace-write capability group".

P0 should still accept `allowedTools: ["write"]` as model-facing sugar, but the
host must normalize it into:

- `grant.workspaceWrite === true`
- concrete managed write tools that survived child catalog filtering
- trace/session metadata that records both requested tools and the grant

Default behavior stays read-only:

- omitted `grant` -> no write grant
- omitted `allowedTools` -> read/glob/grep default
- explicit read tools -> silent safe spawn
- explicit write capability -> spawn-time governance

Dynamic spawned agents are hard-capped to the spawned child surface. They may
request write within that cap; they cannot request MCP, agent management, or
unreviewed external authority by inventing tool names.

## Grant authorization

Tools already support argument-dependent policy: the run loop calls
`tool.policyForArgs(args)` (`core/src/run.ts` ~3957), and wrapper tools already
use this shape (`task` and `bash` classify risk by arguments).

`spawn_agent.policyForArgs` should read the normalized grant:

- read-only grant -> `{ risk: "safe", requiresApproval: false }`
- workspace-write grant -> governance `sideEffects: ["write"]`
- disallowed grant/shell in P0 -> denied or argument-invalid before execution

The **parent run's** existing policy stack decides the spawn call:

- `bypass` -> allow after deny checks
- `ask`/`default` -> prompt on the live parent approval channel
- `read-only`, project ceiling, or disabled/unavailable write tools -> deny/fail
  before any child is created
- `--target`, file-count, and diff budgets -> allow the spawn only when the
  parent run can grant writes, then deny any child `workspace.write` that
  exceeds the parent envelope

The approval summary must be grant-aware: "Grant workspace write to child
`<role>` for goal: `<goal>`". A bare "Run tool spawn_agent" is not informed
consent. This likely needs a small tool-definition hook such as
`approvalSummaryForArgs`, because core currently formats tool approvals
generically.

## Grant consumption

Spawn-time approval must compile into a **child-scoped grant consumer**. It is
not enough for the parent to approve the `spawn_agent` tool call: later
`workspace.write` proposals happen inside the child run, and dynamic children
currently have `interactionChannel: null` and no `approvalResolver`.

P0 implementation shape:

- child policy remains layered with the parent run policy and child profile
  policy, so deny decisions and write envelopes still win
- child receives a restricted grant resolver or policy wrapper that only
  consumes this spawn's workspace-write grant
- no free-form interaction channel is passed to the child
- unsupported approval requests from the child are denied rather than routed to
  the parent silently
- managed write tools still emit the child's normal `workspace.write.*` events
  and the parent-visible `subagent.*.workspaceWrites` rollup remains evidence

This is the closure the original near-zero-plumbing sketch missed: the grant
must be both authorized by the parent and consumable by the child.

## Clamp invariants (a grant is not a blank check)

- **Grant ≤ parent envelope.** Child policy stays layered with the parent run
  policy. In a read-only session (`shouldWrite:false`),
  `spawn(grant.workspaceWrite)` is **denied** before the child is created. In a
  `--target`-scoped run the spawn may be approved, but every child
  `workspace.write` is clamped to the target path, file-count budget, and diff
  budget before the child-local grant resolver can approve it.
- **Container bounds unchanged.** Even a granted child stays workspace-bounded
  and sandboxed (network deny, fs deny-list-guard); `bypass` cannot escape these.
- **Monotone down the tree.** A child cannot self-elevate; nested spawn cannot
  exceed the parent (existing `maxDepth` + layered policy).
- **Default stays read-only.** Grant is explicit, per-spawn opt-in. The safe
  default is preserved.

## Grant levels

| grant   | ask/default behavior                        | P0 status                         |
| ------- | ------------------------------------------- | --------------------------------- |
| read    | silent (default)                            | implement                         |
| write   | **prompt**, child built only after approval | implement managed writes only     |
| scratch | silent/private scope                        | defer                             |
| shell   | prompt/highest bar                          | defer; prefer configured profiles |

`scratch` = a private per-child artifacts directory (session-GC'd). It needs a
new per-agent scratch write scope; there is only a session-level `artifacts/`
surface today.

## Approval semantics

- **Grant granularity = one token per spawn, not one prompt per write.** This is
  what lets a detached child act; it is also the right consent unit — the user
  authorizes the child's _scope_ once, up front.
- **Informed consent.** The spawn approval summary must name what is granted and
  why: "Grant _write_ to child `<role>` for goal: `<goal>`" — not a bare "Run
  tool spawn_agent."
- **Post-hoc auditability.** A granted child's actual writes still emit the
  mutation-audit / trace events (as the main agent's do) so the user can review
  or roll back after the fact.
- **No late self-elevation.** A child that was spawned read-only must fail fast
  when it detects a write-required goal; it does not ask for more authority.

## F2 linkage

The `assertReadOnlyChildCanSatisfyGoal` guard (shipped on
`fix/background-task-execution`) becomes a **routing hint** rather than a dead
end: when a goal implies write/exec but the spawn did not request that grant,
the error should say "re-spawn with `grant.workspaceWrite: true`" instead of
only "this child is read-only" or "perform the write yourself."

## Delivery split

### P0 — dynamic managed write grant

- Add a dynamic granted child catalog: read-only tools plus managed workspace
  write tools that survived global tool filtering. Do not reuse the full
  configured-delegate catalog, because that catalog may include `bash`.
- Add `grant.workspaceWrite` as the canonical request field. Accept
  `allowedTools:["write"]` as temporary sugar if that improves model uptake.
- Add `spawn_agent.policyForArgs` and grant-aware approval summaries.
- Compile allowed spawn approval into a child-scoped restricted grant consumer.
- Apply the same grant semantics to `task_create(kind:"agent")`; otherwise
  foreground `spawn_agent` and background agent tasks diverge.
- Update F2 errors to recommend re-spawning with the write grant.

Required tests:

- `ask/default + grant.workspaceWrite + approve` creates the child only after
  approval and lets the child complete a managed write without child-side user
  approval.
- `ask/default + deny` does not create/start a child.
- `bypass + grant.workspaceWrite` auto-allows after deny checks and records the
  auto-approved grant.
- default/no-grant spawn is approval-free and keeps read-only behavior.
- `read-only` / `shouldWrite:false` denies before child creation.
- `--target` escape or write-budget escape is denied when the child attempts
  the managed `workspace.write`; the grant does not escape the parent envelope.
- disabled or unavailable write tools fail before child creation.
- read-only child with write-required goal fails fast with re-spawn guidance.
- `task_create(kind:"agent")` matches `spawn_agent` parent-gate behavior.
- dynamic `bash` remains unavailable in P0.

### P1 — shell decision

Re-evaluate dynamic shell only after P0 proves the grant-token path. Candidate
rules:

- configured delegate remains the preferred shell path
- dynamic shell, if allowed, requires `bypass` plus foreground/awaited execution
- sandbox health and network mode must be visible in grant metadata
- untracked write-capable boundary markers must roll up clearly to the parent

### P2 — scratch grant

Add a per-agent scratch/artifacts write scope that is private, session-GC'd, and
not confused with user-visible workspace writes. This needs a new scope and
lifecycle decision, so it stays out of P0.

## Open decisions

1. Exact wire surface for `grant`: object field vs `capabilities` naming, and
   how long `allowedTools:["write"]` sugar should remain.
2. Whether the child grant consumer is best modeled as a restricted
   `approvalResolver`, a policy wrapper, or a small first-class grant policy in
   core.
3. How much grant metadata belongs in `subagent.requested/completed` payloads
   versus child run metadata.
4. Interaction with the background-task-lifecycle revival loop: a granted
   detached child that writes then completes should still notify/rewake the
   parent (P0 revival spine) — grant is orthogonal to revival but must not
   bypass its audit event.

## Relationship to sibling proposals

- **[background-task-lifecycle.md](background-task-lifecycle.md):** this proposal
  supplies the _authority_ dimension the lifecycle work assumed away by pinning
  agents read-only. Grant is orthogonal to foreground↔promote↔background but
  co-designed with it (detached grant relies on the revival/audit spine).
- **[agent-access-config-redesign.md](agent-access-config-redesign.md):** the
  grant is clamped by the same project>user accessMode clamp; a per-agent
  configured `allowedTools`/policy remains the human-reviewed ceiling a dynamic
  grant can never exceed.
