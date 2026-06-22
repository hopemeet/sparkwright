# ADR 0005: Deterministic Default Model For The Golden Path

## Status

Accepted

## Context

The SparkWright CLI golden path is a protocol smoke test: it exercises run lifecycle, context assembly, tool execution, workspace mutation, approval, artifact creation, and JSONL trace emission end-to-end. The golden path runs in three places where stability matters most:

1. **Tests** — unit and integration suites that must produce deterministic event sequences.
2. **Demos** — `npm exec sparkwright -- run ...` invocations a new contributor runs in the first ten minutes.
3. **Documentation** — expected trace sequences in `docs/reference/PROTOCOL.md` and `docs/maintainer/CLI_GOLDEN_PATH.md`.

A real provider in any of these introduces nondeterminism (token sampling, provider outages, rate limits, billing, model version drift, network conditions) that has nothing to do with the kernel under test. It also gates contribution on having an API key.

## Decision

The CLI default model is a **deterministic in-process model**, not a real provider. The deterministic model produces a fixed, scripted sequence of tool calls and text completions that exercise the golden path. Provider-backed runs (OpenAI, AI SDK adapters) are opt-in via `--model provider/model` plus an environment variable such as `OPENAI_API_KEY`.

The deterministic model is a `ModelAdapter` like any other; it has no privileged access to the run loop. The same kernel code path runs in deterministic and provider-backed mode — the provider is the only swapped component. This is what makes the deterministic run a valid smoke test for the provider-backed run.

## Consequences

Positive:

- The golden path produces the same trace byte-for-byte (modulo timestamps and ids) on every run, which makes it usable in CI assertions and documentation examples.
- New contributors can run the full demo and see a real trace + artifact within seconds, without an API key or quota.
- Provider failures cannot break the kernel smoke test; provider issues are isolated to provider-specific tests.
- Diff-able traces become a debugging tool: a regression in the kernel shows up as a trace diff against the recorded golden.
- The deterministic adapter serves as the simplest possible reference implementation of `ModelAdapter` for contributors writing new providers.

Negative:

- Deterministic adapters can hide bugs that only surface under real provider behavior (streaming, partial tool calls, error envelopes). Provider-backed smoke tests must be maintained alongside the deterministic golden path to compensate.
- New event types or payload shapes require updating the deterministic script in lockstep, adding a small contribution overhead.
- The first impression of the CLI is a scripted run, not a "smart" agent; documentation must make clear that the default is a smoke test, not a feature demo.

## Alternatives considered

- **Default to OpenAI**: rejected because it gates onboarding on an API key, makes CI flaky, and bills contributors for trying the project.
- **Default to a small local model (llama.cpp, ollama)**: rejected because it adds a heavyweight runtime dependency, is still nondeterministic in token sampling, and produces inconsistent traces across machines.
- **Record-and-replay against a real provider**: useful for provider-edge tests, but too heavy as the default — fixture rot, large recorded payloads, and provider version drift make it unsuitable for the always-green golden path.
- **No default model; error if none configured**: rejected because it makes the first-run experience hostile and pushes every contributor through provider setup before they can verify their checkout.

## Follow-Up

The deterministic model lives alongside the CLI. The provider-backed path is documented in `README.md` and exercised by `packages/provider-ai-sdk/`. Future work includes a recorded-trace test mode for provider-edge regression catching, which complements rather than replaces the deterministic default.
