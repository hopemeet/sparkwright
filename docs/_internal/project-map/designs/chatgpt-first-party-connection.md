# ChatGPT Managed Connection

- Status: Verified
- Date: 2026-08-21
- Review: the TUI now presents ChatGPT account login and OpenAI API-key setup
  under one OpenAI product group. This is presentation-only: ChatGPT remains
  bound to its code-owned `chatgpt.com` endpoint, managed credential, catalog,
  and adapter, and never receives an API key or custom endpoint.
- Review: the offline/signed catalog split was checked against this contract.
  ChatGPT still obtains its account-visible models only through authenticated,
  connection-scoped discovery, so no login, transport, or adapter change is
  required here.

## Product Contract

The user flow is intentionally short:

```text
/connect
  -> OpenAI
  -> Continue with ChatGPT (default)
     or Use OpenAI API key
     or Other sign-in options… -> Sign in with device code
  -> account-visible model
```

The OpenAI row is a TUI product group, not a new provider id. Calls made after
the user chooses a method continue to carry exact `chatgpt` or `openai`
provider identity. Connections remain separately bound and the model picker is
filtered by the selected connection's exact provider.

SparkWright ships the required runtime as a version-pinned Host dependency. It
does not search `PATH`, require a separately installed CLI, ask the user to copy
tokens, or write ChatGPT tokens into project configuration.

The TUI opens the browser automatically without invoking a shell. If the
desktop opener is unavailable, the authorization URL remains visible as a
manual fallback. Device code remains available for remote/headless terminals
whose browser callback cannot return to the current device, but is not a
peer-level default. Escape cancels the active attempt and closes its subprocess.

## Runtime Boundary

`packages/host/src/chatgpt-app-server.ts` owns one JSONL-over-stdio client for
the officially supported App Server protocol. Each session:

1. resolves `@openai/codex/bin/codex.js` relative to the installed Host package;
2. starts it with `process.execPath`, never a user-controlled shell or `PATH`;
3. performs `initialize` / `initialized` with experimental API capability;
4. bounds lines, request timeouts, turn timeouts, and diagnostic text;
5. rejects unhandled server requests and terminates the child on close.

Browser and device-code methods call `account/login/start`. The App Server owns
the OAuth callback, access token, refresh token, refresh operation, and logout.
SparkWright's credential store contains only a versioned managed-transport
marker bound to `https://chatgpt.com`; that marker is never usable as a Bearer
token or API key. The current marker is a compact fixed value below the macOS
Keychain interactive-input boundary. Host recognizes only the exact historical
128-byte truncation of the earlier verbose marker, allowing affected accounts
to recover without repeating browser authorization.

`account/read` verifies completion and refresh. `model/list` supplies the
account-visible catalog. No email, access token, refresh token, authorization
code, or App Server stderr is projected through Protocol DTOs.

## Model Boundary

The Host-private `chatgpt_app_server` runtime credential is admitted only by
`model-factory.ts`; the generic AI SDK builder rejects it. A model call creates
an ephemeral thread in a temporary empty working directory with:

- `approvalPolicy: "never"`;
- `sandbox: "read-only"`;
- instructions forbidding App Server-owned commands, edits, web, MCP, and
  subagents;
- SparkWright tool descriptors supplied as dynamic function tools.

Text deltas become the ordinary `ModelOutput.message`. Dynamic tool requests
become ordinary SparkWright `toolCalls`; the App Server turn is interrupted so
Core remains the only tool/policy/approval executor. Any command, file-change,
MCP, web, collaboration, approval, or other unexpected App Server action fails
the model call closed.

The adapter deletes the temporary directory and closes the child in every
success, failure, cancellation, and timeout path.

## Ownership

- Provider catalog, connection transaction, binding, grants, selection, and
  managed marker: `provider-catalog.ts`, `provider-auth.ts`,
  `provider-oauth.ts`.
- App Server process/protocol, account verification, model discovery, and
  `ModelAdapter`: `chatgpt-app-server.ts`.
- Adapter admission: `model-factory.ts`; defensive rejection:
  `model-builder.ts`.
- Browser launch and OAuth presentation: `tui/lib/open-external-url.ts` and
  `tui/components/connect-dialog.tsx`.
- Protocol and SDK: unchanged generic provider OAuth/connection DTOs.

## Security And Compatibility

- Only code-owned `chatgpt` descriptors can select the managed runtime.
- Official endpoint and driver bindings must match exactly.
- The dependency and protocol are version-pinned; upgrades require schema
  regeneration, focused protocol tests, and a real login/model smoke.
- Stdio JSONL is the stable integration transport. Experimental dynamic tools
  are isolated behind the Host adapter and must fail closed on drift.
- The process receives no prompt-supplied command, executable, environment, or
  working directory.
- Browser launch accepts only HTTP(S) URLs without embedded credentials and
  never invokes a shell.

Third-party attribution remains in `THIRD_PARTY_NOTICES.md`; product and source
documentation must not describe this work as copied from another client.

## Acceptance Evidence

- Unit: App Server model discovery, read-only isolated thread construction,
  dynamic-tool projection, browser/device driver lifecycle, compact and
  historical-truncated managed markers, catalog descriptor, TUI auto-open,
  fallback URL, visible discovery failure, and model-stage retry.
- Real runtime: package-relative App Server initialization, authenticated
  `account/read`, seven account-visible models, a text completion, and a dynamic
  tool call all passed on 2026-08-18.
- Real TUI: the original `/connect -> ChatGPT -> Browser login` route reached a
  valid OpenAI authorization URL rather than `OAuth login could not be
started`; Escape cancelled and the stored connection later rendered all
  seven models. The 2026-08-21 grouped-flow regression walked `/connect ->
OpenAI`, verified distinct ChatGPT-account/OpenAI-key connection identities,
  primary browser/API-key choices, nested device code, and exact OpenAI API
  endpoint selection without starting or mutating a login.
- Grouped-flow gate: ConnectDialog 11/11, full TUI 567/567, Host 635/635, CLI
  177/177, Core 688/688, the 16-case regression matrix, production audit, and
  source/release install smokes passed on 2026-08-21.
- Closing gate: the full repository `npm run release:check` passed, including
  all 634 Host tests and all 562 TUI tests; the production dependency audit,
  regression matrix, and source/release install smokes passed.

## Upgrade Checklist

1. Update the exact `@openai/codex` version.
2. Generate the version-matched App Server TypeScript schema in a temporary
   directory and review lifecycle/request/notification drift.
3. Run Host typecheck and the focused provider/App Server tests.
4. Run TUI connect render tests, real PTY browser/device start-and-cancel, real
   `account/read`, `model/list`, text completion, and dynamic-tool projection.
5. Update this design, module maps, test-map evidence, lockfile, and third-party
   notice when the version or contract changes.
