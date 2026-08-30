# Provider Connection Coverage

## Current Confidence

- Status: `Verified`
- Last reviewed: 2026-08-22
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
  P6.5b regressions additionally verify complete OAuth account/tenant bindings,
  two-account exact selection, realm and refresh-drift rejection, and locked
  legacy-identity migration without public identity exposure. Its closing full
  release gate passed Core 688/688, Host 632/632, CLI 177/177, TUI 560/560,
  the 16-case regression matrix, production audit, and both install smokes.
  Review-driven hardening adds OAuth catalog resolution, malformed-envelope and
  identity-drift network denial, endpoint-only public fingerprints, shared
  refresh failure, and migration/refresh race coverage.
  The 2026-08-18 managed ChatGPT route ships a package-relative App Server,
  browser/device login, managed marker, account-visible discovery, model/tool
  adapter, and TUI browser opener. The follow-up regression keeps the marker
  below the Keychain interactive-input boundary, recognizes the exact
  historical truncation, and exposes model-stage refresh failures. Focused
  ChatGPT Host 6/6, TUI ConnectDialog 6/6, typechecks, real App Server
  account/model/text/tool smokes, and real TUI seven-model picker passed. The
  closing release gate passed Host 634/634, TUI 562/562, the 16-case regression
  matrix, production audit, and both install smokes.
  The endpoint-selection follow-up verifies official-default, separately
  labelled configured, and validated custom API-key destinations. Host rejects
  malformed/insecure endpoint submissions before persistence, selected stored
  endpoints remain runtime-authoritative across project `baseURL` changes, and
  exact endpoints cross Protocol/SDK without exposing the secret. Focused
  Host/Protocol/SDK/TUI 57/57 and real PTY official/configured/custom flows
  passed. The closing repository gate passed Host 635/635, TUI 564/564, the
  16-case regression matrix, production audit with 0 vulnerabilities, and both
  install smokes.
  The TUI presentation follow-up combines raw `chatgpt` and `openai` catalog
  entries into one OpenAI product group while preserving exact connection and
  model routing. ConnectDialog 11/11, TUI 567/567, Host 635/635, CLI 177/177,
  Core 688/688, and a real PTY grouped-provider/connection/method/endpoint walk
  passed; the device route is visible only under other sign-in options. The
  closing release gate passed the 16-case regression matrix, production audit,
  and both install smokes.
  The 2026-08-22 catalog hardening verifies custom configured providers remain
  constructible with ProviderAuthManager present, selected custom endpoints do
  not inherit official inventory, signed background refresh is credential-free
  and same/cross-process coordinated, offline mode makes no source call, and a
  fresh signed cache is not redundantly fetched. Focused Host catalog/auth/model
  tests pass 61/61. ConnectDialog passes 12/12 and full TUI passes 568/568 with
  provider-local manual model input.

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
- The `/connect` model stage also accepts an exact provider-local id when the
  catalog is missing or stale; Host allow/deny policy remains authoritative.
- Signed background refresh runs only when due, never invokes account discovery,
  coalesces same-process calls, and uses an expiring cross-process lease.
- `+ add connection` returns to the existing auth-method flow.
- API-key setup defaults to the official endpoint, offers a differing
  config/environment endpoint as a labelled alternative, and validates an
  explicitly typed custom endpoint before displaying the destination hostname
  and accepting a masked key.
- The selected stored connection's endpoint overrides project `baseURL` during
  runtime construction; later config changes cannot redirect that key, and a
  different endpoint requires a new connection.
- Endpoint validation rejects non-loopback HTTP, user information, query,
  fragment, control characters, and oversized values before credential state
  is written.
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
- Two OAuth accounts for the same provider remain separate opaque connections;
  switching the selected id resolves the exact account credential.
- OAuth completion rejects a realm different from the code-owned issuer before
  persistence. Refresh rejects account/tenant drift before replacing the old
  credential and marks the connection as needing refresh.
- Legacy account/tenant identity present only in the encrypted credential
  envelope migrates under the connection refresh lock; the connection id,
  grant, and selection remain stable while generation/fingerprint advance.
- Account/tenant values remain absent from public catalog, Protocol, CLI, and
  TUI projections; the public endpoint fingerprint is identical across two
  accounts while their Host-private complete fingerprints differ.
- Authenticated model discovery uses the same stored-credential resolver as
  model construction. Invalid OAuth envelopes and account drift stop before
  fetch; expiry-window credentials refresh before the access token is sent.
- Concurrent callers observe one failed refresh as failure, and an unrelated
  identity migration cannot be mistaken for refresh completion.
- ChatGPT starts from the bundled Host dependency without a separately
  installed executable or `PATH` lookup.
- Browser/device OAuth delegates token and refresh ownership to App Server;
  SparkWright stores only a managed marker and never projects token bytes.
- The compact managed marker stays below the macOS Keychain interactive-input
  boundary; the exact historical 128-byte truncated marker recovers without a
  second browser login.
- Account-visible model discovery, ordinary text completion, and dynamic tool
  projection are covered with fake protocol sessions and real runtime smokes.
- TUI opens the browser without a shell, hides the long URL after success,
  retains it on opener failure, and cancels the active attempt on Escape.
  Discovery errors stay visible, and Ctrl+R retries from the model stage.
- TUI presents ChatGPT account and OpenAI API-key connections under one OpenAI
  row, labels their non-secret identities separately, and still filters models
  using the selected connection's exact provider id.
- `Continue with ChatGPT` and `Use OpenAI API key` are primary choices;
  device-code login remains available under `Other sign-in options…` for
  callback-constrained terminals.

## Weak Or Failing

- No bearer provider runtime is enabled; P6.5a deliberately verifies rejection
  rather than introducing an endpoint or entitlement contract.
- Browser authorization completion was not automated in the real PTY run; the
  test stopped after receiving a valid authorization URL and cancelled it.
- Dynamic tools use the App Server experimental API and therefore remain
  version-pinned with a required real upgrade smoke.

## Stable Gate

```bash
npm --workspace @sparkwright/host test -- test/provider-catalog-generator.test.ts test/provider-catalog.test.ts test/provider-catalog-store.test.ts test/provider-catalog-source.test.ts test/provider-auth.test.ts test/provider-oauth.test.ts test/provider-credential-store.test.ts test/provider-protocol.test.ts test/model-factory.test.ts test/protocol.test.ts
npm --workspace @sparkwright/sdk-core test -- test/client.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t provider
npm --workspace @sparkwright/tui test -- test/connect-dialog.test.tsx test/model-dialog.test.tsx test/sdk-cutover.test.ts test/build-command-registry.test.ts
npm --workspace @sparkwright/core test -- test/run.test.ts -t 'credentialResolver|model_auth_failed|model_quota_exhausted'
```

The retained-credential management invariant is now captured at Host manager,
Host local/remote protocol, CLI, and TUI layers. The isolated real-PTY scenario
is retained as a release-checkpoint smoke rather than the only evidence.
