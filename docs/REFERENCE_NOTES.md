# Reference Notes

This document captures the external ideas and working vocabulary that informed Sparkwright planning. It is not a bibliography and does not claim that any single vendor architecture is the correct design for Sparkwright.

## Agent Harness Engineering

An agent harness is the runtime environment around a model. It turns probabilistic text generation into controlled execution.

Typical harness responsibilities:

- orchestration loop
- tool registration and execution
- memory and context management
- prompt/input assembly
- output classification and tool-call parsing
- run state and persistence
- error handling
- guardrails and policy
- validation loops
- subagent or child-run coordination
- provider adapters
- observability and trace

Sparkwright should not try to implement every production component at once. It should define the kernel and the extension routes that let these components appear over time.

## Why Harness Quality Matters

The same model can behave very differently depending on the harness.

A strong harness gives the model:

- the right tools at the right time
- bounded high-signal context
- clear observations after actions
- permission boundaries
- validation feedback
- durable state
- recovery paths after errors

A weak harness often makes a strong model look unstable because it loses state, floods context, permits unsafe actions, hides errors, or gives the model no way to verify work.

## Production Harness Components

Sparkwright uses the component map in [Harness Component Model](HARNESS_COMPONENT_MODEL.md) as its planning baseline.

The most important production ideas for v0 are:

- a bounded model-tool-observation loop
- typed and policy-checked tools
- approval gates for risky actions
- proposal-first workspace mutation
- JSONL trace and artifacts
- structured errors
- validation hooks
- provider adapters at the edge

Memory, subagents, embeddings, cloud orchestration, and GUI trace viewers are important but should not distract from the first trustworthy loop.

## Ratchet Mechanism

A harness should improve from real failures.

The ratchet loop:

```txt
agent fails -> failure is recorded -> finding is reviewed -> rule, hook, test, or policy is added -> future runs enforce it
```

Examples:

- If an agent comments out tests to pass CI, add a rule and pre-commit hook that rejects commented-out tests.
- If a tool repeatedly returns huge logs, store logs as artifacts and return summaries to the model.
- If workspace writes are too broad, require diff review and tighter path policy.

The goal is not to make the model perfect. The goal is to make every repeatable failure cheaper to catch next time.

## Context Lifecycle

Context should be managed as a scarce resource.

Useful strategies:

- compaction of old dialogue and tool results
- artifact storage for large outputs
- summaries instead of raw logs
- search-driven file loading
- progressive tool disclosure
- child runs or subagents for broad exploration, returning short summaries

For v0, Sparkwright only needs bounded context assembly and traceable context items. More advanced memory and retrieval can come later.

## Provider Strategy

Providers are required to run real models, but provider SDKs should not define the kernel.

Early implementation should use official or open-source SDKs behind adapters. Sparkwright should not rebuild provider clients unless the provider boundary affects trace, policy, approval, or protocol semantics.

Recommended early approach:

- fake model adapter for deterministic tests
- one real model adapter or generic HTTP adapter
- normalized `ModelInput` and `ModelOutput` inside core

## Design Tension

Harnesses should become thinner as models improve, but they do not disappear. They move.

Older scaffolding may become unnecessary, while newly possible tasks create new needs around state, permissions, validation, and recovery.

Sparkwright should therefore optimize for replaceable edges and durable protocols rather than hard-coded strategies.
