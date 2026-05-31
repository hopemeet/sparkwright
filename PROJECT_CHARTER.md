# Sparkwright Project Charter

## Mission

Sparkwright exists to provide the harness runtime primitives for building safe, inspectable, composable agent-native applications.

Its long-term purpose is to make the core infrastructure behind modern agent products reusable: model-tool orchestration, context handling, approval, policy, trace, workspace mutation, validation, and model-agnostic provider boundaries.

## Product Thesis

Many future applications will not be GUI-first. They will be intent-first systems where a user or system expresses a goal, an agent plans and executes work through tools, and humans retain control through policies, approvals, trace, and recovery.

Most teams should not have to rebuild that harness layer from scratch.

## Positioning

Sparkwright is an agent harness runtime kernel.

The model provides generation and reasoning. The harness provides execution boundaries: tools, state, context, permissions, validation, artifacts, trace, and recovery.

The core design stance is:

```txt
thin loop, strong boundaries
```

The runtime should be easy to embed in CLIs, local tools, IDE extensions, CI jobs, workflow steps, internal platforms, and future server runtimes.

## Primary v0 Audience

Sparkwright v0 optimizes for:

- developers building local or coding agents
- developer-tool authors building CLIs, IDE extensions, or repo automation
- platform engineers building controlled internal agent runtimes
- early vertical-agent teams that need runtime infrastructure

Research, data, and multi-language users matter, but they are not the primary v0 optimization target.

## Scope

Sparkwright v0 should include:

- run lifecycle management
- tool registration and execution
- structured event streams
- approval gates
- policy checks
- trace persistence
- workspace read, write, and diff primitives
- model adapter boundary
- validation hooks
- a minimal CLI example

## Non-Goals

Sparkwright v0 should not include:

- a full GUI workbench
- a coding-agent replacement product
- a generic chatbot framework
- long-term memory
- complex RAG pipelines
- multi-agent collaboration
- plugin marketplaces
- cloud hosting
- a full Python-native runtime
- Rust sandboxing before the TypeScript runtime proves the contract

## Core Objects

`Run`

One execution of an agent task. A run has a goal, state, context, events, artifacts, and policy.

`Step`

A unit of progress inside a run, such as model output, tool request, tool result, approval request, or artifact creation.

`Tool`

A typed capability the agent can call. Tools have names, descriptions, schemas, execution handlers, and policy metadata.

`Context`

The bounded input material available to a run. Context can come from user messages, files, tool results, summaries, or external systems.

`Event`

An append-only structured record of what happened. Events are the foundation for trace, debugging, replay, and audit.

`Approval`

A first-class pause point where a human or external policy engine can allow, deny, or modify an action.

`Policy`

The rule layer that decides which actions are allowed, denied, or require approval.

`Artifact`

A durable output from a run, such as a patch, file, report, log, or structured result.

## Operating Principles

- Start with a small runtime that genuinely works.
- Validate each abstraction with a real example.
- Keep the core model-agnostic.
- Treat safety as part of the runtime, not as a later plugin.
- Prefer clear protocols over clever APIs.
- Make traces readable by humans and agents.
- Avoid framework sprawl until real usage demands it.
- Keep provider, memory, storage, and UI implementations replaceable.
- Turn repeatable failures into future rules, hooks, tests, or policies.

## Definition of v0 Success

v0 succeeds when a developer can use Sparkwright to build a minimal local coding agent that:

- creates a run
- registers tools
- calls a model through an adapter
- executes a tool
- pauses for approval before a risky action
- edits a workspace file
- emits a diff artifact
- writes a JSONL trace
- can be understood from the README and docs without reading all source code
