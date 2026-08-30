# Troubleshooting

## `npm exec sparkwright -- ...` cannot find the CLI

Build the workspace first:

```bash
npm install
npm run build
```

The local CLI binary points at `packages/cli/dist/index.js`, so it only exists after TypeScript compilation.

For source installs, `bash ./install.sh` writes the command under
`~/.sparkwright/bin`. If `sparkwright` is not found after installation, add that
directory to your shell `PATH`:

```bash
export PATH="$HOME/.sparkwright/bin:$PATH"
```

To see the executable, install root, config files, capability roots, user state,
and workspace state that the CLI is using, run:

```bash
sparkwright doctor paths --workspace . --format text
```

To verify the full source install path in a clean temporary root, including
installed CLI/TUI/ACP entrypoints and uninstall boundaries, run:

```bash
npm run source:install-smoke
```

## Approval is denied in a non-interactive shell

With `--access-mode ask`, the CLI prompts for approval. In CI or another non-interactive shell, SparkWright denies the write and records `workspace.write.denied` plus a failed tool result.

For deterministic smoke tests, use:

```bash
npm exec sparkwright -- run "inspect this repo and suggest a README improvement" \
  --workspace examples/repo-pilot \
  --target README.md \
  --access-mode bypass
```

## OpenAI provider runs fail before starting

Provider-backed CLI runs require a usable provider connection and a model
reference in `provider/model` form. Connect without editing config:

```bash
sparkwright provider connect openai --workspace .
```

For browser OAuth, use an interactive terminal and keep the command or TUI
open until the local callback completes:

```bash
sparkwright provider connect openrouter --auth-method oauth_pkce --workspace .
```

For ChatGPT subscription login, choose `OpenAI` and then `Continue with
ChatGPT` in `/connect`. SparkWright opens the browser and runs its bundled,
version-pinned login runtime; no separate executable or `PATH` setup is
required. If the browser cannot be opened, the TUI keeps the authorization URL
visible. For a remote/headless terminal whose callback cannot return to this
device, choose `Other sign-in options…` and then `Sign in with device code`.

If ChatGPT reports that the bundled runtime is missing, reinstall SparkWright
so its production dependencies are restored. If login succeeds but model
discovery fails, press Ctrl+R in the model picker. SparkWright retains the
connection and retries `model/list`; it does not require another browser login.
Builds containing the compact-marker fix also recover the exact historical
macOS Keychain truncation automatically.

If the attempt expires or is cancelled, start `/connect` or the command again.
If a stored OAuth connection reports `needs_refresh`, run
`sparkwright provider refresh <connection-id>`; SparkWright will not replace
that selected connection with an unrelated environment key.

Environment credentials remain supported:

```bash
OPENAI_API_KEY=... npm exec sparkwright -- run "inspect this repo" \
  --workspace examples/repo-pilot \
  --target README.md \
  --model openai/<model-name>
```

If the selected provider has no applicable stored connection, config key, or
environment key, the CLI exits non-zero with `host_start_failed` and records a
failed trace. Run `sparkwright provider list --workspace .` to inspect
non-secret status. A stored connection is not reused for a newly chosen
endpoint. Conversely, changing project `baseURL` does not redirect an already
selected stored connection: its original endpoint remains authoritative until
you select or create another connection. A failed selected stored connection
does not fall back to an ambient key. Real provider behavior is intentionally
outside the deterministic golden path, so release checks use the deterministic
model by default.

### Provider catalog refresh fails

A catalog timeout, HTTP failure, invalid signature, invalid JSON, or older
catalog version does not clear the active model list. SparkWright continues
with the scoped discovery cache, signed last-known-good base, or bundled
offline snapshot. Retry explicitly with:

```bash
sparkwright provider catalog refresh --workspace .
sparkwright provider catalog refresh openrouter --workspace .
```

The first command refreshes configured signed metadata and every available
authenticated discovery source independently. The provider-specific form only
refreshes that account-visible inventory. If the cache reports `stale`, it is
still usable; check deployment URL/keyring configuration and network access
before retrying. Custom providers and explicit user model policies remain
available without catalog network access.

If the TUI model list is empty after connecting, type the provider-local model
id directly in `/connect` (for example `anthropic/<model-name>` for OpenRouter),
or use `/model` with a full `provider/model` reference. This remains subject to
the provider's configured model allow/deny policy. Use
`SPARKWRIGHT_OFFLINE=1` when catalog refresh and model discovery must make no
network request; use
`SPARKWRIGHT_PROVIDER_CATALOG_AUTO_REFRESH=off` to keep explicit refresh while
disabling the periodic signed-base check.

OpenAI-compatible providers can be tested with the same CLI path by setting `OPENAI_BASE_URL`. Set the base URL without the trailing `/responses` (the AI SDK appends it):

```bash
OPENAI_API_KEY=... \
OPENAI_BASE_URL=https://your-openai-compatible-gateway.example.com/v1 \
npm exec sparkwright -- run "inspect this repo" \
  --workspace examples/repo-pilot \
  --target README.md \
  --model openai/<your-model>
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
  --model openai/<model-name>
```

Use the port from your local proxy tool. The CLI explicitly passes these proxy variables to the OpenAI provider path.

## Workspace path escaped errors

All `LocalWorkspace` reads and writes resolve relative to the workspace root. Paths that escape the root fail with `WORKSPACE_PATH_ESCAPED`.

Use workspace-relative paths such as `README.md`; avoid absolute paths and `..` traversal.

## Trace files are too large or too small

Choose a trace level:

```bash
--trace-level standard
--trace-level debug
```

`standard` keeps useful summaries, and `debug` keeps full normalized payloads.
Trace and artifact storage apply default redaction for common secret keys and
token-shaped values, but callers should still avoid placing secrets in tool
outputs when possible.

## A write was proposed but not applied

Check the run trace for one of these events:

- `workspace.write.denied`: policy, approval, or conflict blocked the write.
- `approval.resolved`: the approval decision was `denied`.
- `tool.failed`: the write happened inside a tool and the controlled workspace returned a structured error.

If the file changed between proposal and application, the write fails with `WORKSPACE_WRITE_CONFLICT`.
