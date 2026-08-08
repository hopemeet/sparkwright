# Model-visible Contract Diverges From Runtime Authority

## Record

- Pattern ID: `model-visible-contract-runtime-divergence`
- Status: `fixed`
- First seen: 2026-07-22
- Last seen: 2026-07-23
- Recorded count: 7

| Cause                   | Count |
| ----------------------- | ----: |
| `product_bug`           |     7 |
| `test_bug`              |     0 |
| `prompt_underspecified` |     0 |
| `model_variance`        |     0 |
| `environment`           |     0 |
| `stale_dist`            |     0 |
| `dirty_workspace`       |     0 |
| `unknown`               |     0 |

## Symptom

The model-visible contract disagrees with the runtime that will execute it:
the primary profile body is absent, a system section describes itself as lower
authority, an unimplemented text tag claims trusted provenance, internal
context kind looks like provider authority, a read-only run identity implies
writes, an awaited task tells the model to wait unconditionally, or a deferred
schema is already present despite discovery guidance.

## Root Cause

Prompt, provider input, and runtime lifecycle were assembled by separate entry
points without a shared projection test. Source-level prompt text and tool
descriptors looked plausible in isolation, so review stopped before the final
`ModelInput` and terminal/revival state machine.

## Diagnostic Move

Inspect the final model request, not only prompt-named variables:

- compare provider message roles and section metadata for fresh/resume paths;
- compare `ModelInput.tools` before and after deferred discovery;
- compare tool-result guidance with the exact runtime terminal/wakeup timing;
- treat structured policy, approval, and provenance as authority over prose.

## Prevention

- Add entry-point role snapshots and unique-marker tests for fixed profile text.
- Assert deferred schemas are absent before discovery and present afterward.
- Test lifecycle guidance against both immediate-dependency and terminal paths.
- Never introduce a trusted natural-language tag without a structured producer
  and provenance check.

## Fix

- 2026-07-23: standard Host main episodes consume `mainAgent.prompt` once as
  system identity; bounded project-instruction wording matches its real role;
  the unimplemented reminder contract and internal context type label are
  removed; Direct Core identity is access-neutral; awaited wait guidance is
  conditional; Streaming Runtime filters deferred provider schemas until
  `tool_search` or Skill loading admits them.
- Verified by focused Host, Project Context, Core context, Agent Runtime task,
  and Streaming Runtime tests plus affected typechecks.

## Related

- Coverage: [../coverage/agents.md](../coverage/agents.md)
- Run notes: none; this repair used retained audit traces and deterministic
  final-input/state-machine reproductions without new model calls.
