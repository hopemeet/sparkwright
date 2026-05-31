# ADR 0003: Anchored Edits Over Line Numbers

## Status

Accepted

## Context

Workspace mutation is the highest-trust operation in the Sparkwright harness. Coding and repo-automation agents need an edit primitive that is ergonomic for an LLM, safe to apply, and explainable in trace. Two common alternatives exist in other harnesses:

1. **Whole-file write**: the model produces the entire new file. This is easy to express but fragile — silent dropped sections, whitespace drift, and large prompt payloads are common failure modes.
2. **Line-number edits**: the model says "replace line 42 with X." Line numbers go stale the moment any other edit lands, and concurrent reads inside the same run make the model reason about a moving target.
3. **Search-and-replace with exact old text**: requires the model to reproduce previously seen content verbatim, including whitespace. This turns editing into a memory test and produces frequent `OLD_NOT_FOUND` failures.

None of these compose well with the harness posture that workspace writes must be proposable, inspectable, and verifiable before mutation.

## Decision

Workspace edits use **hash-anchored line references**. An anchored read returns each line with a short content-hash anchor (e.g. `42#WM`). Edits reference anchors. Before applying any edit, the workspace runtime re-reads the file and verifies that each referenced anchor still matches the current line content; if it does not, the edit is rejected with a structured error (`ANCHOR_NOT_FOUND`, `ANCHOR_HASH_MISMATCH`, `ANCHOR_LINE_OUT_OF_RANGE`) before any mutation occurs.

The v0 operations are `replace`, `delete`, `append`, `prepend`, all single-anchor. Ranges and multi-anchor operations are deferred.

Anchored edits do not replace the normal workspace write path. They produce the same diff proposal artifact and still go through policy, approval, validation, and baseline-hash verification before bytes change on disk.

## Consequences

Positive:

- Stale-line edits become impossible by construction; the harness fails closed before any write proposal is built.
- Edit payloads are small — references plus replacement lines, not whole files.
- The model is freed from reproducing exact whitespace and surrounding context.
- Trace explains rejections in a structured way (which anchor failed, what was expected, what was found), which feeds the failure-to-rule ratchet (see ADR 0002).
- Duplicate line content is handled correctly because the anchor encodes both line number and content hash.

Negative:

- The model must learn the anchor convention. In practice this requires one short instruction block in the tool description.
- Files with literal text resembling an anchor (`1#AB|`) need explicit handling and tests.
- CRLF and trailing-newline semantics need to be pinned down once and tested.

## Alternatives considered

- **Whole-file writes only**: rejected because the prompt cost grows with file size and silent drops are unrecoverable.
- **Line-number edits**: rejected because line numbers go stale within a single run as soon as the agent makes more than one change.
- **Search-and-replace on exact text**: kept as an escape hatch in tool design, but not the default agent-facing primitive because of the whitespace-memory failure mode.
- **AST-level edits**: rejected for v0 because they require a language-aware parser per file type and do not generalize to docs, configs, or unknown formats.

## Follow-Up

The reference implementation lives in `packages/core/src/anchored-edit.ts` and is wired through `LocalWorkspace` and `ControlledWorkspace`. Event shapes are described in `docs/PROTOCOL.md`. Future revisions may add range operations once single-anchor edits prove stable across more tool surfaces.
