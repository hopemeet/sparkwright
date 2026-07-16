# Repo Pilot

Repo Pilot is the first Sparkwright validation example.

The current golden path from the repository root:

```bash
npm install
npm run build
npm exec sparkwright -- run "inspect this example" \
  --workspace examples/repo-pilot \
  --target README.md \
  --access-mode bypass \
  --trace-level standard
```

The same flow from this directory:

```bash
node ../../packages/cli/dist/index.js run "exercise the golden path" \
  --workspace . \
  --target README.md \
  --access-mode bypass
```

To inspect the approval prompt, use `--access-mode ask`:

```bash
npm exec sparkwright -- run "exercise the golden path" \
  --workspace examples/repo-pilot \
  --target README.md \
  --access-mode ask
```

For a read-only smoke test, use `--access-mode read-only` (the default):

```bash
npm exec sparkwright -- run "inspect this example" \
  --workspace examples/repo-pilot \
  --target README.md \
  --access-mode read-only \
  --trace-level minimal
```

## Scripts

This package defines a few top-level scripts (see `package.json`):

- `build` — compile `golden-path.ts` to `dist/` with `tsc`.
- `typecheck` — type-check without emitting (`tsc --noEmit`).
- `test` — alias for `typecheck` (this example has no runtime unit tests).
- `golden-path` — run the README golden-path validator (`dist/golden-path.js`),
  asserting the README still documents the full write path.
- `smoke` — the read-only variant of the validator (`--readonly`), skipping the
  write/approval token checks.
- `clean` — remove the `dist/` build output.

This example proves:

- local workspace context
- safe file reads
- approval before writes
- diff artifact creation
- JSONL trace output
- bounded model-tool-observation loop
- structured run stop reasons

## Sparkwright CLI Golden Path

The CLI uses a deterministic model for this example. It first calls `read`, then optionally calls `append_file` when the access mode enables writes. Workspace writes still flow through the core approval and artifact path, so the run leaves a readable trace under `.sparkwright/sessions/<session-id>/trace.jsonl`.

Each session directory contains `trace.jsonl`, `agents/main/runs/<run-id>/run.json`, and an `artifacts/` directory when a write is proposed. In the write path, look for `workspace.write.requested`, `artifact.created`, `approval.requested`, `approval.resolved`, and either `workspace.write.completed` or `workspace.write.denied`.
