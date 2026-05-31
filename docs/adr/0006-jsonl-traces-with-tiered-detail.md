# ADR 0006: JSONL Traces With Tiered Detail

## Status

Accepted

## Context

Trace is positioned as the **primary interface** of the Sparkwright runtime, not as debug output (see `docs/HARNESS_PRINCIPLES.md`, "Trace Is The Primary Interface"). It must support:

- audit of every meaningful runtime action,
- approval review (the approver looks at the trace plus the diff artifact),
- artifact linkage and replay,
- failure analysis that becomes future rules,
- consumption by both humans (CLI scrollback, `tail -f`) and machines (SDKs, downstream sinks).

These consumers have conflicting needs. A human debugging a run wants full payloads; a production sink wants compact summaries and predictable bytes-per-event; an enterprise audit log wants only the execution skeleton plus identifiers. A single format cannot serve all three, but the kernel cannot afford three different trace formats either.

A second tension is between in-process observability and durable persistence. Subscribers (telemetry, live UI) want the raw event stream the moment it is emitted. The on-disk trace wants filtering, redaction, and stable ordering.

## Decision

The trace format is **JSONL: one serialized `SparkwrightEvent` per line, in sequence order**, with three tiers of detail selected per run by the caller:

- `minimal`: execution skeleton — types, sequence numbers, identifiers, statuses, counts. Suitable for compliance logs and minimum-cost retention.
- `standard`: normalized summaries with truncated large values. The default for demos and most production runs.
- `debug`: full normalized payloads. Suitable for development and incident forensics.

The same event envelope is used at all three levels — only payload detail varies. Redaction is a separate filter (regex-based, key + value patterns) that composes on top of any level. The default `FileRunStore` writes the filtered, redacted JSONL stream to `.sparkwright/runs/<run-id>/trace.jsonl`.

In-process, `EventLog` always emits the full event to subscribers; level filtering and redaction happen at the persistence boundary (`RunStore`, `TraceSink`). This means embedders see full payloads if they want them, while disk and external sinks see filtered output.

## Consequences

Positive:

- JSONL is trivially streamable: `tail -f`, `jq`, log shippers, and SDKs all consume it without a custom parser.
- One serialized event per line means partial files (after a crash) remain readable up to the last complete line, with no recovery logic needed.
- Tiered detail lets one kernel serve compliance, production, and development without forking the format.
- Filtering at the persistence boundary keeps the kernel's emission path simple — subscribers always get the truth.
- Redaction composes orthogonally with levels, so secrets are stripped uniformly whether the run is `minimal` or `debug`.
- Append-only semantics make traces a stable artifact for diffing across runs (paired with ADR 0005's deterministic golden path).

Negative:

- JSONL files grow without bound; rotation and retention are an embedder responsibility.
- Three levels mean three sets of filtering rules to maintain; adding a new event type (see `docs/AI_TASK_INDEX.md`) requires updating each level's summarizer.
- Filtering happens after serialization in the default store, so very large payloads briefly exist in memory before being trimmed — a streaming-summarize path may be needed if very large tool outputs become common.
- The default redactor uses regex patterns; sophisticated secret detection (entropy-based, structured-credential-aware) is out of scope and pushed to downstream sinks.

## Alternatives considered

- **Structured binary format (protobuf, msgpack)**: rejected because debuggability with standard Unix tools is a primary goal and the trace size advantage is not material at v0 scales.
- **Single trace level with downstream filtering only**: rejected because storage cost and data-exposure trade-offs differ per deployment; the kernel must let the caller make the trade.
- **Database-backed trace (sqlite per run)**: rejected as the default because it requires a query layer to inspect a run; JSONL keeps the floor low. A database-backed `RunStore` is a valid extension (see `docs/AI_TASK_INDEX.md`, "Add a new storage backend").
- **OpenTelemetry spans as the primary format**: rejected because the harness's event model is not span-shaped — events are facts in a sequence, not durations in a tree. OTel export remains a valid downstream `TraceSink`.

## Follow-Up

The reference implementation is `FileRunStore` and the `MemoryTrace` sink in `packages/core/src/trace.ts`. The file layout and level semantics are specified in `docs/PROTOCOL.md`. Schema for the event envelope lives in `schemas/event.schema.json`. Future revisions may add per-event-type retention policies and a structured truncation manifest so consumers can detect when payloads were summarized.
