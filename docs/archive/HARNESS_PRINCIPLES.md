# Harness Principles

Sparkwright is best understood as an agent harness runtime, not as a model wrapper or a chatbot framework.

An agent harness is the execution environment around a model. It assembles context, exposes tools, checks policy, runs actions, captures observations, validates work, persists state, and leaves evidence behind. The model proposes actions. The harness controls how those actions happen.

## Positioning

Sparkwright is a TypeScript runtime for building safe, inspectable, and extensible agent harnesses.

The first proof is a local coding and repository automation harness. That wedge makes tool use, workspace mutation, approval, validation, and trace easy to see. The kernel should remain broader than coding agents.

## What Sparkwright Should Be

- a small harness kernel for agent-native applications
- a control plane for tool execution, policy, approval, and workspace mutation
- an evidence plane for events, traces, artifacts, and replay-ready records
- a protocol-oriented foundation that can support future SDKs and adapters
- a local-first runtime that can later run behind CLIs, IDEs, CI jobs, servers, and workflow systems

## What Sparkwright Should Not Be

- a coding-IDE clone
- a generic chatbot framework
- a prompt-chain library
- a full RAG or long-term memory platform
- a no-code agent builder
- a GUI-first workbench
- a model provider abstraction buffet
- a multi-agent system before the single-agent harness is trustworthy

## Core Principles

### Thin Loop, Strong Boundaries

The orchestration loop should stay simple: prepare input, call the model, execute allowed tool calls, feed observations back, and stop when complete.

The strength of Sparkwright should live in boundaries: validation, policy, approval, workspace safety, event emission, artifacts, and failure handling.

### Model Proposes, Harness Disposes

The model can request tool calls and file changes. The harness decides whether they are valid, allowed, risky, denied, or require human approval.

Provider-specific behavior must not bypass runtime policy.

Agents provide local intelligence. The harness owns global control. A planner, worker, reviewer, or future subagent may suggest a next step, but the runtime keeps custody of lifecycle state, routing, policy, retries, budgets, and termination.

Planner output should therefore be declarative data that the harness can inspect:

```json
{
  "intent": "research",
  "suggestedAgent": "researcher",
  "input": "Find relevant project constraints."
}
```

It should not be imperative control flow such as directly calling another agent or tool outside the runtime.

### Trace Is The Primary Interface

Every meaningful runtime action should emit an append-only, serializable event.

Trace is not debug output after the fact. It is the foundation for audit, approval review, artifact linkage, failure analysis, future replay, and agent self-correction.

The core should be capable of preserving full normalized model and tool information, while storage layers choose how much to persist. Trace levels let applications trade off debuggability, cost, and data exposure:

- `standard`: normalized summaries
- `debug`: full normalized payloads

Redaction is a filter that can be applied on top of any level.

### Controlled Tool Calling Beats Tool Calling

The differentiator is not that tools can be called. It is that tool calls are typed, schema-validated, policy-checked, timeout-aware, observable, and recoverable.

Tools are production resources, not ordinary helper functions. A registered tool should describe who may call it, what it can touch, how risky it is, whether it needs approval, what it returns, and how its calls are audited. The registry is the permission boundary for agent capabilities.

### Workspace Writes Are Proposals Before Mutations

A file write should move through a clear path:

```txt
propose change -> validate and check policy -> request approval if needed -> create diff artifact -> apply write -> emit events
```

Direct mutation is convenient, but proposal-first mutation is what earns trust.

### Context Is A Budget, Not A Bucket

Large context windows do not remove the need for context engineering. Sparkwright should prefer bounded, high-signal context over loading everything.

Tool output is evidence. It should not always be prompt context. Long outputs should become artifacts or stored observations with concise summaries fed back to the model.

Run execution is also a budget. Future production paths should track tokens, duration, tool calls, retries, and model cost class while the run is active, not only after the bill arrives.

### Failures Should Become Future Constraints

A good harness improves from real failures.

When a run fails in a repeatable way, the system should make it easy to convert that failure into a rule, hook, test, policy, or reviewer check. This ratchet loop is a core product direction:

```txt
failure -> finding -> rule or hook -> future enforcement
```

### Provider Adapters Live At The Edge

The core runtime should consume normalized model input and output shapes. Hosted APIs, local models, routing gateways, and open-source wrappers should all be adapters, not kernel dependencies.

### Protocol First, TypeScript First

TypeScript is the first implementation. The protocol objects should remain JSON-friendly enough that future SDKs, servers, workers, or language bridges can be built without reverse-engineering TypeScript internals.

### Validate Abstractions Through The Golden Path

Before adding an abstraction, ask:

1. Does the local coding/repo automation golden path need it?
2. Can it be serialized?
3. Can it be inspected in a trace?
4. Can it fail in a predictable way?
5. Can it be replaced later without rewriting the kernel?

If the answer is weak, defer it.
