# ADR 0001: TypeScript-First Runtime

## Status

Proposed

## Context

Sparkwright needs to be easy to adopt by developers building CLIs, backends, IDE extensions, local tools, and workflow integrations. It also needs strong schema ergonomics and a low-friction open source contribution path.

## Decision

Start with a TypeScript-first implementation.

The initial public packages should be:

- `@sparkwright/core`
- `@sparkwright/cli`

Rust and Python should be added later where they are strongest:

- Rust for execution-heavy, sandboxing, filesystem, terminal, and diff components.
- Python as a client SDK and tool adapter, not as a separate core runtime in v0.

## Consequences

Positive:

- fast iteration
- strong fit with JSON schemas and model APIs
- easy CLI and server development
- approachable contribution path
- good fit for developer tooling

Negative:

- sandboxing and process isolation will need care
- Python-first users will wait for SDK support
- Rust-quality execution boundaries are deferred

## Follow-Up

Revisit after the TypeScript runtime can complete the golden path.
