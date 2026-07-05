# Delegates Run Event Metadata Divergence

## Record

- Pattern ID: `delegates-run-event-metadata-divergence`
- Status: `fixed`
- First seen: 2026-06-25
- Last seen: 2026-06-25
- Recorded count: 1

| Cause | Count |
| --- | ---: |
| `product_bug` | 1 |
| `test_bug` | 0 |
| `prompt_underspecified` | 0 |
| `model_variance` | 0 |
| `environment` | 0 |
| `stale_dist` | 0 |
| `dirty_workspace` | 0 |
| `unknown` | 0 |

## Symptom

`sparkwright delegates run --format json` can report `subagent.*` events whose
metadata names the external delegate profile as `agentId`, while the persisted
`trace.jsonl` for the same run stores those `subagent.*` events with
`agentId: "main"` and the delegate profile only in `agentProfileId`.

This makes the direct command output and trace diagnostics disagree about event
attribution. `trace summary` then lists only `main` in `agents:` for a direct
external delegate run, even though the run clearly contains
`subagent.*` events for the configured delegate profile.

## Root Cause

Direct `delegates run` persists through `createDelegateRunPersistence()` with
`agentId: "main"`. `FileRunStore.addStoreIdentity()` applies that store
identity to every persisted event, overwriting the in-memory event metadata
returned through the CLI JSON result.

## Fix

Parent-visible `subagent.*` events now carry `sessionId` before persistence,
use `agentId` for the parent/trace actor, and use `childAgentId` for the
child/delegate identity. ACP, external-command, configured in-process,
dynamic-spawn, direct CLI JSON output, persisted trace summary, and TUI display
all consume that same contract.

## Diagnostic Move

Compare the same direct delegate run in two views:

1. Parse `delegates run --format json` and inspect
   `events[].metadata.agentId` for a `subagent.completed` event.
2. Read the printed `tracePath` with
   `sparkwright trace events <trace> --type subagent.completed --jsonl`.
3. If stdout says the delegate profile id and the persisted trace says `main`,
   the two diagnostic surfaces diverged.

## Prevention

- Keep CLI regression coverage comparing direct delegate JSON event metadata
  with the persisted trace for `subagent.completed`.
- Preserve the public attribution contract for parent-visible `subagent.*`
  events: `sessionId` is present when the run is session-scoped; `agentId` is
  the persisted parent/actor identity; `childAgentId` is the child/delegate
  subject; `agentProfileId` is the configured profile.
- If new delegate transports expose pre-persistence events, make sure they use
  the same metadata shape as persisted trace events.

## Related

- Coverage: [../coverage/agents.md](../coverage/agents.md)
- Run notes:
  [../runs/2026-06-25-agent-multi-surface-qa.md](../runs/2026-06-25-agent-multi-surface-qa.md)
