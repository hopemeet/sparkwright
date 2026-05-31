# CLI Golden Path

The smallest runnable Sparkwright demo is the repo-pilot CLI flow. It proves that a local run can read a workspace file, propose a write, create a diff artifact, require approval, apply the write, and leave an inspectable JSONL trace.

## Run It

From the repository root:

```bash
npm install
npm run build --workspaces
npm exec sparkwright -- run "inspect this repo and suggest a README improvement" \
  --workspace examples/repo-pilot \
  --target README.md \
  --write \
  --yes \
  --trace-level standard
```

`npm exec sparkwright --` invokes the local workspace CLI after build. After packaging or linking the CLI, the same flow should be exposed as `sparkwright run ...`.

## Modes

Read-only trace smoke test:

```bash
npm exec sparkwright -- run "inspect this repo" \
  --workspace examples/repo-pilot \
  --target README.md \
  --trace-level minimal
```

Interactive approval:

```bash
npm exec sparkwright -- run "inspect this repo and suggest a README improvement" \
  --workspace examples/repo-pilot \
  --target README.md \
  --write \
  --trace-level debug
```

Non-interactive approval for demos and CI smoke checks:

```bash
npm exec sparkwright -- run "inspect this repo and suggest a README improvement" \
  --workspace examples/repo-pilot \
  --target README.md \
  --write \
  --yes
```

If `--write` is used without `--yes` in a non-interactive shell, the CLI denies the approval request and records `workspace.write.denied` in the trace.

Provider-backed OpenAI path:

```bash
OPENAI_API_KEY=... npm exec sparkwright -- run "inspect this repo and suggest a README improvement" \
  --workspace examples/repo-pilot \
  --target README.md \
  --provider openai \
  --model <model-name> \
  --trace-level standard
```

The default provider is `deterministic`, which keeps the golden path repeatable. The OpenAI provider path uses `@sparkwright/provider-ai-sdk` and the AI SDK OpenAI provider, but Sparkwright still owns tool execution, approval, workspace writes, and trace output.

## What Happens

1. The run starts with `examples/repo-pilot` as the workspace root.
2. The selected model asks the `read_file` tool to read `README.md`.
3. With `--write`, the deterministic model asks the `append_file` tool to add the `Sparkwright CLI Golden Path` section. Provider-backed models may choose their own valid tool calls.
4. The runtime creates a workspace write proposal.
5. Validation and policy run before any diff artifact is persisted.
6. Approval is resolved by the prompt or by `--yes`.
7. Approved writes create a diff artifact and apply through the controlled workspace; denied writes are skipped without materializing the diff.
8. The session trace and per-run files are written under `examples/repo-pilot/.sparkwright/sessions/<session-id>/`.

## Outputs

The CLI prints event progress and the trace path:

```txt
Trace written to examples/repo-pilot/.sparkwright/sessions/<session-id>/trace.jsonl
```

The session directory contains:

- `trace.jsonl`: one event per line, filtered by `--trace-level`.
- `transcript.jsonl`: a transcript-oriented event stream.
- `agents/main/runs/<run-id>/run.json`: run metadata and final state.
- `agents/main/runs/<run-id>/result.json`: terminal result with signal, state, stop reason, and failure details when present.
- `artifacts/`: diff metadata and patch text for approved writes.

The most useful write-path events are `workspace.write.requested`, `approval.requested`, `approval.resolved`, `artifact.created`, and either `workspace.write.completed` or `workspace.write.denied`.

Validation hooks, when configured by a caller, are emitted as `validation.started`, `validation.completed`, and `validation.failed`. The CLI progress output includes the validation stage, hook name, and first finding code for failed validations so terminal output points directly to the relevant trace evidence.
