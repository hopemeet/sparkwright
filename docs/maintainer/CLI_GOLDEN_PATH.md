# CLI Golden Path

This maintainer smoke doc records what the repo-pilot CLI flow must prove. For
user-facing commands and mode selection, start with
[User Manual](../guides/USER_MANUAL.md).

## Required Smoke Command

Run from the repository root after installing dependencies:

```bash
npm run build --workspaces
npm exec sparkwright -- run "inspect this repo and suggest a README improvement" \
  --workspace examples/repo-pilot \
  --target README.md \
  --write \
  --yes \
  --trace-level standard
```

This path uses the deterministic provider by default. It should remain stable
enough for local release checks and demos.

## Behavior Contract

The golden path proves:

- the run starts with `examples/repo-pilot` as the workspace root
- the model reads `README.md` through a registered tool
- `--write` creates a workspace write proposal
- validation and policy run before a diff artifact is persisted
- approval resolves through `--yes`
- approved writes create a diff artifact and apply through the controlled workspace
- denied writes skip mutation and do not materialize a diff artifact
- session trace and run files are written under `examples/repo-pilot/.sparkwright/sessions/<session-id>/`

## Expected Outputs

The CLI should print the trace path:

```txt
Trace written to examples/repo-pilot/.sparkwright/sessions/<session-id>/trace.jsonl
```

The session directory should contain:

- `trace.jsonl`: one event per line, filtered by `--trace-level`
- `transcript.jsonl`: a transcript-oriented event stream
- `agents/main/runs/<run-id>/run.json`: run metadata and final state
- `agents/main/runs/<run-id>/result.json`: terminal result with signal, state, stop reason, and failure details when present
- `artifacts/`: diff metadata and patch text for approved writes

The write path should include these high-signal events:

- `workspace.write.requested`
- `approval.requested`
- `approval.resolved`
- `artifact.created`
- `workspace.write.completed` or `workspace.write.denied`

Validation hooks, when configured by a caller, should emit
`validation.started`, `validation.completed`, and `validation.failed`. CLI
progress output should include the validation stage, hook name, and first
finding code for failed validations.
