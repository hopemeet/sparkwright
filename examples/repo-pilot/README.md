# Repo Pilot

Repo Pilot is the first Sparkwright validation example.

The current golden path from the repository root:

```bash
npm install
npm run build
npm exec sparkwright -- run "inspect this example" \
  --workspace examples/repo-pilot \
  --target README.md \
  --write \
  --yes \
  --trace-level standard
```

The same flow from this directory:

```bash
node ../../packages/cli/dist/index.js run "exercise the golden path" \
  --workspace . \
  --target README.md \
  --write \
  --yes
```

To inspect the approval prompt, omit `--yes`:

```bash
npm exec sparkwright -- run "exercise the golden path" \
  --workspace examples/repo-pilot \
  --target README.md \
  --write
```

For a read-only smoke test, omit `--write`:

```bash
npm exec sparkwright -- run "inspect this example" \
  --workspace examples/repo-pilot \
  --target README.md \
  --trace-level minimal
```

This example proves:

- local workspace context
- safe file reads
- approval before writes
- diff artifact creation
- JSONL trace output
- bounded model-tool-observation loop
- structured run stop reasons

## Sparkwright CLI Golden Path

The CLI uses a deterministic model for this example. It first calls `read_file`, then optionally calls `append_file` when `--write` is set. Workspace writes still flow through the core approval and artifact path, so the run leaves a readable trace under `.sparkwright/sessions/<session-id>/trace.jsonl`.

Each session directory contains `trace.jsonl`, `agents/main/runs/<run-id>/run.json`, and an `artifacts/` directory when a write is proposed. In the write path, look for `workspace.write.requested`, `artifact.created`, `approval.requested`, `approval.resolved`, and either `workspace.write.completed` or `workspace.write.denied`.
