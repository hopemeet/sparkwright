# Troubleshooting

## `npm exec sparkwright -- ...` cannot find the CLI

Build the workspace first:

```bash
npm install
npm run build
```

The local CLI binary points at `packages/cli/dist/index.js`, so it only exists after TypeScript compilation.

## Approval is denied in a non-interactive shell

When `--write` is used without `--yes`, the CLI prompts for approval. In CI or another non-interactive shell, Sparkwright denies the write and records `workspace.write.denied` plus a failed tool result.

For deterministic smoke tests, use:

```bash
npm exec sparkwright -- run "inspect this repo and suggest a README improvement" \
  --workspace examples/repo-pilot \
  --target README.md \
  --write \
  --yes
```

## OpenAI provider runs fail before starting

Provider-backed CLI runs require both a provider and a model:

```bash
OPENAI_API_KEY=... npm exec sparkwright -- run "inspect this repo" \
  --workspace examples/repo-pilot \
  --target README.md \
  --provider openai \
  --model <model-name>
```

If `OPENAI_API_KEY` is missing, the CLI exits before creating a run. Real provider behavior is intentionally outside the deterministic golden path, so v0 release checks use the deterministic model by default.

OpenAI-compatible providers can be tested with the same CLI path by setting `OPENAI_BASE_URL`. Set the base URL without the trailing `/responses` (the AI SDK appends it):

```bash
OPENAI_API_KEY=... \
OPENAI_BASE_URL=https://your-openai-compatible-gateway.example.com/v1 \
npm exec sparkwright -- run "inspect this repo" \
  --workspace examples/repo-pilot \
  --target README.md \
  --provider openai \
  --model <your-model>
```

If `curl` can reach OpenAI but provider-backed CLI runs time out, check Node's path separately:

```bash
node -e 'fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }).then(r => console.log(r.status)).catch(e => console.error(e))'
```

When Node cannot connect directly, set a proxy for the CLI:

```bash
HTTPS_PROXY=http://127.0.0.1:7890 \
HTTP_PROXY=http://127.0.0.1:7890 \
npm exec sparkwright -- run "inspect this repo" \
  --workspace examples/repo-pilot \
  --target README.md \
  --provider openai \
  --model <model-name>
```

Use the port from your local proxy tool. The CLI explicitly passes these proxy variables to the OpenAI provider path.

## Workspace path escaped errors

All `LocalWorkspace` reads and writes resolve relative to the workspace root. Paths that escape the root fail with `WORKSPACE_PATH_ESCAPED`.

Use workspace-relative paths such as `README.md`; avoid absolute paths and `..` traversal.

## Trace files are too large or too small

Choose a trace level:

```bash
--trace-level minimal
--trace-level standard
--trace-level debug
```

`minimal` keeps the event skeleton, `standard` keeps useful summaries, and `debug` keeps full normalized payloads. Trace and artifact storage apply default redaction for common secret keys and token-shaped values, but callers should still avoid placing secrets in tool outputs when possible.

## A write was proposed but not applied

Check the run trace for one of these events:

- `workspace.write.denied`: policy, approval, or conflict blocked the write.
- `approval.resolved`: the approval decision was `denied`.
- `tool.failed`: the write happened inside a tool and the controlled workspace returned a structured error.

If the file changed between proposal and application, the write fails with `WORKSPACE_WRITE_CONFLICT`.
