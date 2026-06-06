# Harness Component Model

This document maps Sparkwright to a production agent harness model. It is a planning reference, not a claim that all components are implemented today.

## Component Status

| Component               | Role                                                           | Current State                                                                                                 | v0 Target                                                                                                                       | Later                                                                           |
| ----------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Orchestration loop      | Runs model-tool-observation cycles until termination.          | Bounded model-tool-observation loop exists.                                                                   | Bounded loop with max steps, explicit stop reasons, guarded state transitions, tool observations, and structured failure paths. | Streaming steps, resumable continuation, planner/executor modes.                |
| Tools                   | Agent capabilities with schemas and handlers.                  | Registry, descriptors, execution, basic result normalization.                                                 | Schema validation, timeout, policy gate, result size handling.                                                                  | Sandboxed executors, streaming tools, remote workers.                           |
| Memory                  | Cross-run recall and durable preferences.                      | Deferred.                                                                                                     | Not required for v0 beyond trace and artifacts.                                                                                 | Run summaries, project memory, pluggable stores.                                |
| Context management      | Selects high-signal input for each model call.                 | Default bounded assembler exists with omission metadata and layered item metadata.                            | Harden budgets and context selection events through repo-pilot.                                                                 | Compression, retrieval, observation masking, memory injection.                  |
| Prompt/input building   | Packs system rules, tools, context, history, and current goal. | Default prompt builder emits stable-before-dynamic neutral messages.                                          | Connect provider adapters to neutral prompt messages.                                                                           | Provider-specific packing and prompt templates.                                 |
| Output parsing          | Converts provider responses into actions or final answer.      | Assumes `ModelOutput` is already structured.                                                                  | Validate normalized model output.                                                                                               | Provider-specific repair and parser layers.                                     |
| Declarative planning    | Represents planner intent as inspectable data.                 | Deferred.                                                                                                     | Out of v0.                                                                                                                      | Plan protocol, plan review events, planner/executor modes.                      |
| State management        | Tracks run state and lifecycle.                                | `RunRecord` with mutable states.                                                                              | Guarded transitions, terminal state protection, approval deny path, run failure events.                                         | Checkpoints, resume, time-travel debugging.                                     |
| Error handling          | Keeps failures structured and recoverable.                     | Tool errors are caught; model/workspace/approval failures are incomplete.                                     | Shared error taxonomy, `run.failed` paths, model retry policy, tool timeout, and distinct stop reasons.                         | Backoff policies, recoverable tool errors, provider fallback.                   |
| Guardrails and security | Prevents unsafe or unauthorized actions.                       | Tool policy gates exist; runtime workspace writes are approval-gated; low-level workspace remains direct.     | Harden policy coverage, redaction, and unsafe direct API boundaries.                                                            | Capability scopes and sandbox hooks.                                            |
| Validation loop         | Checks work after action.                                      | Minimal validation hooks exist for tool results, workspace write proposals, and final output.                 | Exercise hooks through repo-pilot and document custom validators.                                                               | LLM judges, visual checks, reviewer subagents.                                  |
| Trajectory evaluation   | Evaluates the path, not only the final answer.                 | Trace contains the raw material.                                                                              | Out of v0 beyond trace and hooks.                                                                                               | Trace-driven eval runner for repetition, authorization, cost, and step quality. |
| Run budget              | Controls tokens, duration, tool calls, retries, and cost.      | Context character budgets, max steps, tool timeout, and retry limits exist.                                   | Keep v0 bounded and trace budget pressure.                                                                                      | Token usage accounting, budget zones, model routing, circuit breakers.          |
| Subagents               | Delegates bounded work to child agents.                        | Deferred.                                                                                                     | Out of v0.                                                                                                                      | Child run primitive if traces and use cases justify it.                         |
| Persistence             | Persists events, artifacts, and run state.                     | File-backed JSONL trace and local artifact files exist.                                                       | Harden run storage paths, artifact metadata, and CLI ergonomics.                                                                | Database trace store, checkpoints, remote storage.                              |
| Provider adapters       | Connects the runtime to model APIs.                            | `@sparkwright/provider-ai-sdk` bridges AI SDK `LanguageModel` into `ModelAdapter`; CLI still uses fake model. | Exercise the adapter through repo-pilot and add basic provider config.                                                          | Provider matrix, routing, fallback.                                             |
| Hooks and ratchets      | Turns repeated failures into enforceable checks.               | Validation hooks can emit trace evidence and block unsafe or low-quality outcomes.                            | Add examples that turn trace findings into durable hooks, tests, or policy.                                                     | Rule generation, reviewer agents, policy authoring tools.                       |

## v0 Scope

v0 should prove the harness kernel, not every production feature.

Required:

- bounded single-agent orchestration loop
- tool registry, schema validation, execution, and lifecycle events
- policy-enforced tool and workspace actions
- approval pause/resume for risky actions
- workspace read, diff, proposed write, approved write
- durable JSONL trace
- diff and output artifacts
- structured errors and failure events
- minimal context assembly
- validation hooks for tool results, workspace writes, and final output
- one real model adapter or generic HTTP adapter
- deterministic fake model for tests

## v1 Scope

v1 should harden the harness after the golden path works.

Candidates:

- resumable runs and checkpoints
- richer context assembly
- observation storage and output summarization
- provider-specific parsing and repair
- streaming provider support
- SSE or provider chunk timeout support
- concurrent tool calls where providers support them
- cancellation cleanup across model and tool calls
- usage and cost accounting
- retry and backoff policy expansion
- redaction and secret handling
- richer Tool Registry governance metadata
- run-level token, duration, tool-call, and cost budgets
- trace-driven trajectory evaluation
- declarative plan protocol experiments
- validation hooks for tests, lint, typecheck, and screenshots
- protocol conformance tests
- SQLite or database-backed trace store

See [Streaming Loop Requirements](../reference/STREAMING_LOOP_REQUIREMENTS.md) for the v1 streaming boundary.

## Deferred

These should stay out until the v0 loop is trustworthy:

- long-term memory systems
- embeddings and complex RAG
- broad provider matrix
- multi-agent/subagent orchestration
- a fully generalized session-processor abstraction
- UI part patching
- complex deferred tool-call bookkeeping
- plugin marketplace
- GUI trace viewer
- cloud daemon
- heavy sandboxing
- workflow DSL

## Golden Path Loop

The first useful loop should be deliberately plain:

```txt
create run
assemble bounded context
build model input
call model
validate model output
if final answer: complete
if tool calls:
  validate arguments
  check policy
  request approval if needed
  execute tool
  capture result or error
  store artifacts if needed
  append observation
repeat until complete, failed, cancelled, denied, or max steps reached
```

The loop can be simple because the harness around it is explicit.
