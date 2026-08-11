# Provider Connection Coverage

## Current Confidence

- Status: `Verified`
- Last reviewed: 2026-08-11
- Latest evidence: the full P7.0 release gate, fresh isolated CLI and real PTY
  TUI runs verified two-connection inventory, disconnect visibility, exact-id
  reselection, cross-process persistence, endpoint-binding rejection,
  model-picker continuation, explicit removal, secret-free ordinary output,
  and a real macOS Keychain write that does not borrow the product terminal.
  P6.5a focused Host/Core regressions additionally verify typed runtime
  credentials, cross-Host automatic OAuth refresh, bearer fail-closed
  admission, and one credential recovery attempt per run step. The closing
  full release gate passed all workspace suites, the 16-case regression matrix,
  production audit, and both install smokes.

## Covered

- Two API-key connections for one bundled provider receive distinct opaque ids
  and one selected marker.
- CLI exact-id selection survives a fresh process.
- Disconnect removes the workspace grant without deleting the credential; the
  trusted-local management inventory keeps the entry visible as
  `disconnected`, while default/remote Host projections remain grant-filtered.
- CLI and TUI can reselect that exact disconnected entry without asking for the
  credential again; explicit removal then deletes its credential and metadata.
- TUI `/connect` shows two non-secret identities, selects either connection
  without requesting a secret, and continues to the provider-filtered model
  picker.
- `+ add connection` returns to the existing auth-method flow.
- Invalid ids and endpoint-binding mismatches fail closed without changing the
  usable connection.
- Ordinary CLI/TUI output and `provider-auth.json` exclude credential values.
  Metadata and file credential stores are mode `0600` in the isolated test.
- On macOS, Keychain writes answer only the two expected `security` password
  prompts on an isolated PTY. The product TUI remains responsive, never renders
  those prompts, and fails closed if the prompt sequence is unexpected.
- Explicit removal deletes the visible stored credential and makes its id
  unselectable.
- API keys and durable authorization-issued keys reach the existing adapter as
  `api_key`; bearer tokens remain distinct Host-private runtime credentials.
- Two Hosts resolving one OAuth credential inside its expiry safety window
  perform one locked refresh and observe the same rotated credential.
- A bearer realm without a code-owned runtime transport fails before adapter
  construction and does not appear in the error output.
- A run step whose refreshed credential still fails authentication invokes the
  CredentialResolver only once before terminating through the normal auth
  failure path.

## Weak Or Failing

- Browser/device OAuth completion and refresh were not exercised in this
  isolated fake-credential run.
- No bearer provider runtime is enabled; P6.5a deliberately verifies rejection
  rather than introducing an endpoint or entitlement contract.
- Real-provider requests were intentionally out of scope; the run verified the
  local connection control plane and public OpenRouter model-catalog refresh,
  not authenticated model inference.

## Stable Gate

```bash
npm --workspace @sparkwright/host test -- test/provider-auth.test.ts test/provider-oauth.test.ts test/provider-credential-store.test.ts test/provider-protocol.test.ts test/model-factory.test.ts test/protocol.test.ts
npm --workspace @sparkwright/sdk-core test -- test/client.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t provider
npm --workspace @sparkwright/tui test -- test/connect-dialog.test.tsx test/model-dialog.test.tsx test/sdk-cutover.test.ts test/build-command-registry.test.ts
npm --workspace @sparkwright/core test -- test/run.test.ts -t 'credentialResolver|model_auth_failed|model_quota_exhausted'
```

The retained-credential management invariant is now captured at Host manager,
Host local/remote protocol, CLI, and TUI layers. The isolated real-PTY scenario
is retained as a release-checkpoint smoke rather than the only evidence.
