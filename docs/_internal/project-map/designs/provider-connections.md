# Design: Provider Connections and Model Catalog

> **Status: P6.1-P6.2 implemented; P6.3-P6.4 remain planned.**
> This document locks the ownership, security, compatibility, migration, and
> acceptance decisions for P6. Active behavior remains defined by
> [Host](../modules/host.md), [Protocol](../modules/protocol.md),
> [TUI](../modules/tui.md), [CLI](../modules/cli.md), and
> [Edge Packages](../modules/edge-packages.md) until each later phase lands.

| ADR field       | Value                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| Decision status | Accepted as the P6 implementation baseline                                                            |
| Decision date   | 2026-08-09                                                                                            |
| Scope           | Provider catalog, connections, credentials, authentication, and model selection                       |
| Supersedes      | No active runtime contract; later phases replace the current configured-credential path incrementally |

## 1. Decision

SparkWright will evolve the existing configured-provider authentication path
into a Host-owned provider connection system with:

- a built-in provider and model catalog that does not require users to list
  every model in config;
- API-key, environment, and provider-supported OAuth connection methods;
- credentials stored outside project configuration;
- one shared Host resolution path for TUI, CLI, SDK, main runs, Agents,
  Workflows, and auxiliary model tasks;
- explicit separation between project trust and permission to use a stored
  connection;
- deterministic non-interactive model selection;
- versioned, concurrency-safe connection metadata and credential storage; and
- no credential material in ordinary protocol DTOs, traces, logs, errors, or
  diagnostic output.

This work extends existing owners. It does not add a general integration
framework or a second provider/model registry.

## 2. Current Baseline

The design starts from these source-verified facts:

1. `@sparkwright/provider-registry` already owns `ProviderDefinition`, async
   model enumeration, model resolution, capability filtering, adapter
   construction, and adapter caching. It is the only future authority for
   provider/model/adapter behavior.
2. Host currently constructs a temporary registry containing one configured
   provider and one selected model. This bridge is compatible with the current
   config model but does not expose the registry as a product catalog.
3. `ProviderAuthManager` currently reads providers and models only from
   effective config. Credentials remain in environment variables or config;
   its persisted state contains only opaque profile activation and generation.
4. Current `login` and `refresh` actions do not acquire a credential. They only
   change activation/generation for an already available environment/config
   credential.
5. Current profile identity includes workspace, provider id, and AI SDK
   package. It therefore cannot represent a user connection safely shared
   across explicitly authorized workspaces.
6. Current protocol exposes `provider.list` and local-trusted
   `provider.auth.login|logout|refresh` operations. Provider summaries are
   non-secret.
7. TUI `/model` consumes that catalog, supports stable-ref selection, and
   exposes authentication actions through key chords. There is no dedicated
   `/connect` flow.
8. A non-empty `identity.providers.<id>.models` map is currently an allowlist,
   not only a metadata override.
9. Current main-model fallback is request override, then effective config,
   then the documented deterministic path. Recent and favorite models are not
   runtime routing inputs.

Relevant sources:

- [provider-registry](../../../../packages/provider-registry/src/index.ts)
- [provider auth](../../../../packages/host/src/provider-auth.ts)
- [model builder](../../../../packages/host/src/model-builder.ts)
- [model factory](../../../../packages/host/src/model-factory.ts)
- [config schema](../../../../packages/host/src/config-zod-schema.ts)
- [config implementation](../../../../packages/host/src/config/config-implementation.ts)
- [connection authority](../../../../packages/host/src/connection.ts)
- [model dialog](../../../../packages/tui/src/components/model-dialog.tsx)

## 3. Goals

- A new interactive user can connect a built-in provider and select a model
  without first editing YAML or JSON.
- A non-interactive user can keep using `identity.model`, `--model`,
  environment variables, and existing provider config.
- TUI and CLI observe the same connections and model catalog.
- Provider credentials can be shared across workspaces only through an
  explicit user-owned grant, never merely because project config is trusted.
- Project config cannot redirect a stored official-provider credential to an
  endpoint chosen by the project.
- Catalog refresh can add model inventory without adding executable code,
  authentication endpoints, request options, or credential policy.
- Existing users do not silently gain access to models excluded by their
  current config.
- API-key and OAuth changes are visible across concurrent SparkWright
  processes without lost updates or duplicate refreshes.

## 4. Non-goals

- A generic integration/plugin runtime.
- Remote browser clients submitting raw provider secrets in P6.
- Automatically installing arbitrary provider packages from catalog data.
- Executing catalog-supplied commands, callbacks, scripts, or validation URLs.
- Treating Project Trust as credential delegation.
- Making Recent or Favorite models affect CI, Workflow, cron, resume, or other
  non-interactive model routing.
- Removing environment/config compatibility in the first release.
- Adding provider fallback after an explicitly selected connection fails.

## 5. Ownership

### 5.1 ProviderRegistry remains the provider authority

The existing `ProviderRegistry` remains the single owner of:

- provider identity and display metadata;
- model enumeration and resolution;
- model capabilities, context limits, pricing, and aliases;
- adapter construction and cache keys; and
- provider-local model defaults.

Host must stop building a separate product-level model database. P6.1 will
compose built-in and configured `ProviderDefinition` instances into the
existing registry and adapt SparkWright's public `provider/model` reference to
the registry's internal reference grammar at one Host boundary.

### 5.2 Host owns connection policy

Host will own a narrow `ProviderConnectionDescriptor` keyed by provider id. It
may describe:

- allowed connection methods;
- official endpoint identity;
- known environment variable names;
- OAuth implementation identifiers supplied by built-in code or a governed
  in-process extension;
- a bounded validation strategy; and
- catalog refresh policy.

It must not duplicate model lists, model resolution, or adapter creation.
Remote catalog data cannot create or modify this descriptor.

### 5.3 ProviderConnectionManager evolves in place

The current `ProviderAuthManager` will evolve in place into the
`ProviderConnectionManager`. It will own:

- connection metadata and active/default selection;
- credential-handle resolution;
- API-key submission;
- ambient environment and legacy-config candidates;
- OAuth attempt and token-refresh state;
- endpoint binding and workspace grants;
- validation state;
- suppression state; and
- connection revision/generation publication.

There must not be separate long-lived Auth, OAuth, Validation, and Connection
managers with overlapping mutable state.

### 5.4 Storage is an adapter boundary

`CredentialStore` and `ProviderCatalogStore` are storage ports used by the
owners above, not independent product-policy services.

- `CredentialStore` persists secret values and supports atomic modify/CAS.
- `ProviderCatalogStore` persists versioned catalog snapshots and last-known-
  good state.
- TUI preference storage owns Favorite and Recent ordering only.

### 5.5 ModelResolver is stateless

Host will use one stateless resolver to combine:

1. ProviderRegistry inventory;
2. config model policy and metadata overlays;
3. connection availability and workspace grants; and
4. the request's explicit model scope.

It does not persist preferences or credentials.

## 6. Connection Identity and Grants

### 6.1 Stable identity

Each stored connection has a high-entropy opaque `connectionId`. Secret values
are addressed only by that id.

The immutable binding behind the id contains at least:

```ts
interface ConnectionBinding {
  providerId: string;
  driverId: string;
  normalizedEndpoint: string;
  endpointFingerprint: string;
  authMethodId: string;
  authRealm?: string;
  accountSlot?: string;
  tenant?: string;
}
```

`endpointFingerprint` is a comparison and cache identity. It is not a DNS
pinning or server-authentication mechanism.

`driverId` identifies a code-owned, versioned adapter/connection driver. It is
not copied from project-controlled `npm` text. Legacy configured packages are
treated as custom driver inputs and cannot mutate a built-in driver's identity.

The schema supports more than one account/tenant even if the initial UI offers
only one active default per provider.

### 6.2 Endpoint normalization

Before a binding is created, Host must:

- parse the endpoint as a URL;
- reject user information and fragments;
- reject query strings unless a built-in driver explicitly requires and owns
  them;
- lowercase and IDNA-normalize the host through the URL implementation;
- remove default ports;
- normalize the path and trailing slash consistently;
- require HTTPS for non-loopback hosts; and
- treat every changed normalized endpoint as a different binding.

A custom endpoint cannot inherit a connection created for an official
endpoint, even if the provider id and adapter are unchanged. An endpoint whose
text happens to equal an official endpoint also does not inherit a connection
created through project-controlled provider configuration.

### 6.3 Project Trust and connection grants

Project Trust controls whether project configuration may participate in Host
assembly. It does not grant a project access to a user credential.

Connection use requires a separate user-owned grant:

```ts
type ConnectionGrant =
  | { scope: "workspace"; workspaceId: string; connectionId: string }
  | { scope: "user"; connectionId: string };
```

`workspaceId` is a non-secret stable digest of the canonical workspace path in
the current user-state namespace. It is not supplied by project config.

Rules:

- `/connect` in a workspace creates a workspace grant by default.
- A user may deliberately promote a connection to user scope.
- User-level config may select a user-scoped default connection.
- Project config may select provider/model policy, but never a `connectionId`
  or secret handle.
- Legacy project `npm`, `baseURL`, and `providerOptions` remain readable only as
  a project-controlled custom binding. They cannot overwrite a built-in driver
  or attach an existing built-in/user connection.
- A legacy project `apiKey` remains workspace-bound and is never migrated into
  user-scoped storage without an explicit user action.
- A trusted project selecting a provider without an applicable grant prompts
  in an interactive local client and fails clearly in non-interactive mode.
- Changing a project's provider endpoint invalidates the applicable binding
  and requires a new connection/grant.

## 7. Credential Sources and Operation Semantics

### 7.1 Candidate precedence

Every source projects a connection candidate. Selection order is:

```text
explicit request-scoped connection
-> workspace/user-selected default connection
-> ambient environment connection
-> legacy config connection
```

After an explicit stored connection is selected, refresh or validation failure
must not silently fall back to environment or legacy config.

Environment and legacy-config values remain ambient sources. They are never
copied into the Secret Store without an explicit migration action.

### 7.2 User operations

| Operation         | Stored API key/OAuth                                                  | Environment/legacy source               |
| ----------------- | --------------------------------------------------------------------- | --------------------------------------- |
| `connect`         | Create/select a connection and grant                                  | Select the discovered candidate         |
| `disconnect`      | Remove active selection/grant; keep secret                            | Suppress the exact ambient binding      |
| `logout`          | Best-effort provider revoke where supported, then remove local secret | Suppress; Host cannot delete the source |
| `remove`          | Delete local secret and metadata without claiming remote revoke       | Suppress/remove local metadata only     |
| `refresh`         | Refresh OAuth or revalidate API key; publish a new revision           | Re-read exact source and revalidate     |
| `catalog refresh` | No credential mutation                                                | No credential mutation                  |

Suppression is keyed by the complete immutable connection binding, not only by
provider id. A source change creates a new candidate and does not inherit an
unrelated suppression accidentally.

### 7.3 Connection state

Durable connection state is:

```ts
type ConnectionStatus =
  | "unconfigured"
  | "ready"
  | "unverified"
  | "needs_refresh"
  | "failed"
  | "suppressed";
```

`ready` means the credential was resolved and passed a driver-owned,
side-effect-free validation strategy. If no safe validation strategy exists,
the state is `unverified`; successful storage alone never means `ready`.

Transient UI progress such as `connecting` is attempt state and is not written
as durable connection truth.

## 8. Secret Storage and Cross-process Consistency

### 8.1 Backend policy

Secret storage preference is:

1. operating-system credential facility;
2. an explicitly configured headless backend; or
3. an explicit opt-in `0600` file fallback labelled as lower assurance.

SparkWright must not silently fall back from an unavailable system credential
facility to a plaintext file. Metadata files never contain API keys, access
tokens, refresh tokens, authorization codes, PKCE verifiers, or OAuth state.

### 8.2 Concurrency contract

The metadata and fallback stores must provide:

- one `modify`/CAS write path;
- a monotonic store revision;
- a cross-process lock;
- atomic replace and durable write;
- last-valid recovery after corrupt or partial state;
- file watch or bounded polling for revision changes; and
- OAuth refresh single-flight by connection id.

The existing in-process mutation queue and listener remain useful local
optimizations but are not cross-process correctness mechanisms.

An already running TUI Host must observe a successful CLI connect, refresh,
disconnect, or remove without restart.

### 8.3 Secret transport

API keys may cross only a dedicated trusted-local protocol request because the
TUI and Host are separate processes. This boundary can promise containment,
not JavaScript string zeroization.

The secret request must:

- require `provider_secret.submit` authority;
- be rejected for WebSocket and other remote transports in P6;
- accept no secret through argv, URL, query string, or ordinary config writer;
- cap byte length and reject control characters;
- bypass generic request logging and error serialization;
- never emit the payload in protocol events, trace, crash reports, or notices;
- return only an opaque connection summary; and
- release references immediately after the credential store accepts them.

CLI accepts API keys through hidden input or `--api-key-stdin`; there is no
`--api-key <value>` option.

## 9. Authentication Methods and OAuth Attempts

### 9.1 Method declarations

A provider connection descriptor may expose bounded methods:

```ts
type ProviderAuthMethod =
  | { id: string; type: "api_key"; label: string }
  | { id: string; type: "environment"; names: string[] }
  | {
      id: string;
      type: "oauth";
      label: string;
      prompts?: ProviderAuthPrompt[];
    };
```

Prompt schemas are limited to text, secret, and select with bounded conditional
display. They are presentation data, not executable code.

OAuth implementations are shipped in built-in code or registered by a
governed in-process extension. Project config and remote catalog data cannot
define issuer URLs, client ids, callbacks, token endpoints, or refresh code.

### 9.2 Attempt identity and state

Each OAuth attempt has a high-entropy opaque `attemptId` and is bound to:

- the initiating principal and local connection;
- provider and method;
- proposed immutable connection binding;
- OAuth issuer/realm;
- PKCE verifier and challenge where applicable;
- state and nonce where applicable;
- creation and expiration time; and
- single-consumption status.

Attempt state is separate from durable connection state:

```ts
type AuthAttemptStatus =
  | "pending"
  | "completed"
  | "failed"
  | "expired"
  | "cancelled";
```

Attempts expire after ten minutes by default, can be cancelled, and reject
duplicate completion or replay. Terminal status may be retained briefly for UI
reconciliation but contains no token, code, or verifier.

Browser callbacks and device polling are completed and verified by Host.
Clients may submit a user-visible authorization code when the method requires
one, but cannot assert that authentication succeeded.

## 10. Protocol and Authority Boundary

P6 will split the current provider-management authority into:

```text
provider_catalog.read
provider_connection.manage
provider_secret.submit
```

- `provider_catalog.read` permits non-secret catalog and connection-summary
  reads.
- `provider_connection.manage` permits begin/cancel OAuth, select, disconnect,
  refresh, logout, remove, and authenticated catalog discovery.
- `provider_secret.submit` permits the dedicated raw-secret request and is
  local-transport-only.

The existing `provider_auth.manage` authority is a compatibility umbrella for
trusted local clients during migration. It is not automatically granted to
remote principals.

Planned request families are:

```text
provider.list
provider.auth.methods
provider.auth.begin
provider.auth.submit_secret
provider.auth.status
provider.auth.complete
provider.auth.cancel
provider.connection.select
provider.connection.disconnect
provider.connection.logout
provider.connection.remove
provider.connection.refresh
provider.catalog.refresh
```

`provider.auth.complete` accepts only proof required by the selected method;
Host still validates state, nonce, PKCE, issuer, attempt ownership, TTL, and
single consumption.

`provider.list` will distinguish:

- all catalog providers;
- providers with at least one usable connection in the workspace; and
- models available after connection and model-policy filtering.

No ordinary response contains credential values or provider request headers.

## 11. Provider and Model Catalog

### 11.1 Catalog trust boundary

The initial catalog is a bundled, versioned snapshot. A later network refresh
may be enabled only for a schema-validated signed artifact. Until signature
verification exists, updates ship with SparkWright rather than through an
unsigned network feed.

Catalog data may contain only bounded metadata such as:

- provider/model ids and display names;
- release/status information;
- capabilities and token limits;
- pricing metadata; and
- provider-owned model aliases.

Catalog data cannot contain:

- code, package-install instructions, callbacks, commands, or scripts;
- credentials or environment values;
- authentication, validation, or token endpoints;
- arbitrary request headers, request bodies, or provider options; or
- policy that widens project/user configuration.

### 11.2 Cache contract

`ProviderCatalogStore` provides:

- schema and catalog version validation;
- TTL and explicit refresh;
- cross-process lock;
- atomic publication;
- last-known-good fallback;
- generation-checked publication so a slow refresh cannot replace newer data;
  and
- failure behavior that keeps the prior valid snapshot.

### 11.3 Effective model inventory

The effective inventory is:

```text
ProviderRegistry models
-> validated catalog metadata
-> config allow/deny policy
-> config model metadata overrides
-> connection/workspace availability
```

The picker may still accept a typed `provider/model` not present in a cached
catalog. Host resolves it through the provider driver and config policy; an
unknown model is never allowed to bypass an explicit allowlist.

## 12. Configuration Compatibility

### 12.1 Existing config remains valid

P6 does not require a new top-level config version. Existing fields retain
their meaning:

- `identity.model` remains the configured main-model default.
- `identity.providers.<id>.npm`, `baseURL`, `apiKey`, `providerOptions`, and
  `models` remain readable during migration.
- A non-empty legacy `models` map remains an allowlist and metadata map.
- Environment variables retain their current precedence over legacy config
  within the legacy candidate.

### 12.2 New unambiguous fields

New config uses separate policy and metadata fields:

```yaml
identity:
  providers:
    example:
      modelPolicy:
        allow: [model-a, model-b]
        deny: [model-b-preview]
      modelOverrides:
        model-a:
          cost:
            input: 1
            output: 4
```

Rules:

- `modelPolicy.allow` is an allowlist when present.
- `modelPolicy.deny` removes entries after allow evaluation.
- `modelOverrides` never widens an allowlist.
- A provider cannot combine legacy `models` with new `modelPolicy` or
  `modelOverrides`; validation reports an actionable migration error.
- Project model policy may only narrow a user policy.
- Project config cannot name connection ids, secret handles, OAuth methods, or
  credential sources.

### 12.3 API-key deprecation

`apiKey` remains a legacy credential source through P6. It is removed from new
starter files and receives a diagnostic recommending migration. SparkWright
does not silently copy it.

An explicit migration command will:

1. validate the target connection binding;
2. write the Secret Store entry;
3. verify the stored entry can be read;
4. atomically remove the config value only when requested;
5. roll back the Secret Store write if config publication fails; and
6. leave a non-secret migration receipt.

## 13. Model Selection Semantics

Recent and Favorite models affect picker ordering only.

Main interactive run:

```text
explicit run request / --model
-> current session model override
-> identity.model
-> documented product default
-> deterministic when no product default is available
```

Main non-interactive run:

```text
explicit run request / --model
-> identity.model
-> documented product default
-> deterministic when no product default is available
```

Agent and Workflow scope:

```text
explicit execution model
-> matching Agent/Workflow/task route
-> inherited parent/session/config model
-> documented product default
```

Configured-but-unavailable models fail the affected scope. They do not fall
back silently to a recent model, another connection, or another provider.

Session resume keeps its current explicit behavior: an earlier TUI/CLI model
override is not implicitly restored as a new run override unless the session
contract later adds a durable model-selection field deliberately.

## 14. TUI and CLI Product Contract

### 14.1 TUI

`/connect` is a dedicated flow:

```text
provider picker
-> method picker
-> bounded method prompts
-> API-key or OAuth attempt
-> connection validation/status
-> provider-filtered model picker
```

`/model` shows connected-provider models by default, ordered by Favorite and
Recent, with an action to open `/connect`. It retains stable-ref cursor behavior
and manual model entry.

The TUI does not edit config during connection or model selection. It presents
Host state and stores only UI preferences/session override.

### 14.2 CLI

The target CLI surface is:

```text
sparkwright provider list
sparkwright provider connect <provider>
sparkwright provider disconnect <provider-or-connection>
sparkwright provider logout <provider-or-connection>
sparkwright provider remove <provider-or-connection>
sparkwright provider refresh <provider-or-connection>
sparkwright provider catalog refresh [provider]
sparkwright model list [provider]
```

API-key automation uses `--api-key-stdin`. Text and JSON output contain only
catalog metadata, connection ids/labels, source kind, state, revision, and
non-secret binding summaries.

## 15. Threat Model

### 15.1 Assets

- API keys, OAuth access/refresh tokens, authorization codes, PKCE verifiers,
  state, and nonce;
- connection-to-endpoint binding;
- workspace connection grants;
- model/provider policy;
- catalog integrity; and
- non-secret audit metadata.

### 15.2 Actors and assumptions

- A local interactive user is trusted to submit and manage their credentials.
- A project can be untrusted, changed, or trusted for executable configuration;
  none of those states implicitly grants credentials.
- A remote Host client may be authenticated for run control while remaining
  unauthorized for provider connection management.
- Environment variables and legacy config are ambient inputs that Host cannot
  delete.
- Provider and network endpoints may fail or return attacker-controlled error
  bodies.
- Multiple local SparkWright processes may mutate connection state
  concurrently.

### 15.3 Threats and required controls

| ID  | Threat                                                                        | Required control                                                                                                      |
| --- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| T1  | Secret appears in argv, logs, trace, event, error, or crash report            | Dedicated local-only secret path, stdin/hidden input, request/log exclusion, bounded sanitized errors, sentinel tests |
| T2  | Project changes endpoint and receives a global credential                     | Immutable endpoint binding plus separate workspace/user grant; no project-selected connection id                      |
| T3  | Project Trust is mistaken for credential delegation                           | Independent grant check after config trust admission                                                                  |
| T4  | Remote client starts OAuth, removes a connection, or submits a key            | Split authorities; provider mutations denied to remote transports in P6                                               |
| T5  | OAuth CSRF, callback replay, code substitution, or attempt theft              | Principal-bound attempt, PKCE, state/nonce, issuer binding, TTL, single consumption, replay rejection                 |
| T6  | Concurrent refresh/save/remove loses an update or publishes stale credentials | Cross-process lock, CAS revision, generation-checked publication, refresh single-flight                               |
| T7  | Store corruption destroys the last usable state                               | Atomic durable replace, schema validation, last-valid recovery, rollback                                              |
| T8  | Catalog compromise injects code, endpoints, or request options                | Bundled/signed schema-bound metadata only; no executable or auth fields                                               |
| T9  | Failed stored connection silently falls back to an ambient credential         | Explicit connection ownership; no post-selection fallback                                                             |
| T10 | Config migration widens a legacy model allowlist                              | Preserve legacy semantics; separate new policy fields; transactional explicit migration                               |
| T11 | Error response reflects a submitted secret                                    | Provider-error sanitizer and sentinel coverage over all failure channels                                              |
| T12 | Endpoint textual normalization aliases unsafe bindings                        | Canonical URL normalization, unsafe component rejection, exact immutable binding                                      |
| T13 | DNS/redirect behavior bypasses endpoint identity                              | Treat fingerprint as identity only; driver/network layer must enforce redirect and transport policy                   |
| T14 | Validation call causes spend or mutation                                      | Driver-owned, bounded, side-effect-free strategy; otherwise mark `unverified`                                         |

## 16. Migration

### 16.1 State versions

Connection metadata and fallback credential storage have independent explicit
schema versions. Migrations operate through a lock and publish one new revision
atomically.

The current provider-auth state contains no secrets. Migration maps:

- `active` to a legacy ambient candidate with its existing generation;
- `logged_out` to a workspace-scoped suppression of the exact legacy binding;
  and
- the old workspace-derived profile id to compatibility metadata only.

Migration does not create a global connection from a workspace profile and
does not copy an API key from config/environment automatically.

### 16.2 Rollback

- A failed migration leaves the old state readable.
- A failed Secret Store/config migration removes the newly created secret when
  safe and leaves the original config unchanged.
- Unknown future schema versions fail closed with a recovery instruction.
- Catalog migration failure retains the last-valid catalog.

### 16.3 Compatibility window

During P6:

- existing `provider list|login|logout|refresh` calls remain accepted;
- old `login` means enable/select the matching legacy candidate, not secret
  acquisition;
- new clients use `connect` and method-specific requests;
- old profile ids are never accepted as secret handles; and
- protocol responses remain non-secret.

Compatibility removal requires a future explicit protocol/config deprecation,
not an unannounced P6 cleanup.

## 17. Implementation Phases

### P6.1: Registry and catalog compatibility

- Promote the existing ProviderRegistry into Host's actual provider/model
  authority.
- Add bundled provider connection descriptors and catalog snapshot.
- Expand `provider.list` into all/connected/available projections.
- Permit catalog models without YAML enumeration.
- Preserve legacy `models` allowlist semantics and current credential sources.
- Keep existing model construction and non-interactive resolution stable.

Exit condition: a catalog model absent from YAML can be selected only when no
legacy/new allowlist blocks it, and the selected adapter still comes from the
single ProviderRegistry path.

Implementation status (2026-08-09): complete. Host composes the bundled
snapshot, configured providers, requested typed models, and legacy allowlists
into ProviderRegistry definitions. Adapter construction resolves the selected
model through that registry. `provider.list` supports explicit `all`,
`connected`, and `available` projections while omission preserves the previous
configured-provider view. Catalog metadata is applied only when the configured
package and endpoint retain the bundled driver binding.

### P6.2: API-key vertical slice

Implemented 2026-08-09. The active contract lives in the Host, Protocol, CLI,
and TUI maps. The implementation keeps the API-key path inside the existing
provider owner and model factory rather than adding a second login/runtime
stack.

- Add CredentialStore backends, metadata revisioning, cross-process lock/CAS,
  and change observation.
- Add connection id/binding/grant/suppression semantics.
- Add split authorities and the trusted-local secret request.
- Add `/connect`, CLI hidden input/`--api-key-stdin`, validation state, and
  connection-aware model construction.
- Add malicious endpoint, remote authority, concurrent mutation, and secret
  sentinel gates before the phase is complete.

Exit condition: a clean user environment can connect through TUI or CLI and
run a real model without modifying YAML, while all P6.2 security gates pass.

### P6.3: OAuth vertical slice

- Add built-in declarative OAuth methods and bounded prompts.
- Add principal-bound attempts, browser/device/code flows, TTL/cancel/replay
  protection, refresh single-flight, and failure recovery.
- Add TUI and CLI progress/status flows.

Exit condition: supported OAuth methods complete, refresh, cancel, expire, and
reject replay through the same connection/grant boundary as API keys.

### P6.4: Dynamic catalog and product polish

- Add signed catalog refresh, LKG/TTL behavior, and authenticated model
  discovery where a built-in driver supports it.
- Add Favorite/Recent ordering, provider grouping, and post-connect filtered
  model selection.
- Add explicit legacy migration assistance and final release QA.

Exit condition: catalog refresh and offline fallback are deterministic, UI
preferences do not affect runtime defaults, and migration is transactional and
reversible.

Security required to use API keys is complete in P6.2; P6.4 is not a deferred
security phase.

## 18. Acceptance Matrix

| ID  | Phase | Scenario                                                      | Expected result                                                                          |
| --- | ----- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A01 | P6.1  | Catalog adds a model absent from YAML and no allowlist exists | Model is selectable and resolves through ProviderRegistry                                |
| A02 | P6.1  | Legacy `models` excludes the new catalog model                | Model remains unavailable                                                                |
| A03 | P6.1  | Same non-interactive command is run after Recent changes      | Effective model is unchanged                                                             |
| A04 | P6.1  | Catalog cache is missing                                      | Bundled snapshot remains usable                                                          |
| A05 | P6.2  | Clean user connects with API key in TUI                       | Secret is stored, workspace grant created, provider model run succeeds, config unchanged |
| A06 | P6.2  | CLI uses `--api-key-stdin` while TUI Host is running          | TUI observes the new revision without restart                                            |
| A07 | P6.2  | Two processes concurrently save/refresh/remove                | No lost update; monotonic revision; one valid final state                                |
| A08 | P6.2  | Secret sentinel traverses success and all failure paths       | Sentinel is absent from stdout, stderr, trace, events, errors, notices, and crash output |
| A09 | P6.2  | Remote WebSocket calls secret submit or connection mutation   | Request is unauthorized                                                                  |
| A10 | P6.2  | Trusted project changes provider endpoint                     | Existing official/global connection is not used; explicit new connection/grant required  |
| A11 | P6.2  | Stored connection validation fails while env key exists       | Run fails for selected connection; no fallback to env                                    |
| A12 | P6.2  | User disconnects an environment source                        | Exact ambient binding becomes suppressed; environment is not claimed deleted             |
| A13 | P6.2  | Provider has no safe validation strategy                      | Connection is `unverified`, not `ready`                                                  |
| A14 | P6.2  | Legacy API key migration fails during config publication      | Original config remains; new secret is rolled back or reported recoverably               |
| A15 | P6.3  | OAuth callback has wrong state/nonce or expired attempt       | Callback is rejected and no connection is created                                        |
| A16 | P6.3  | OAuth callback is replayed                                    | Second completion is rejected                                                            |
| A17 | P6.3  | OAuth refresh races in two processes                          | One refresh owns publication; both observe the same new revision                         |
| A18 | P6.3  | Stored OAuth refresh fails while ambient key exists           | Connection enters failure/needs-refresh; no ambient fallback                             |
| A19 | P6.3  | OAuth attempt is cancelled or expires                         | Temporary state is removed; no credential is persisted                                   |
| A20 | P6.4  | Network/catalog refresh fails                                 | Last-known-good catalog remains active                                                   |
| A21 | P6.4  | Slow refresh completes after a newer refresh                  | Older generation cannot overwrite newer catalog                                          |
| A22 | P6.4  | Catalog artifact is unsigned/invalid/corrupt                  | It is rejected without replacing bundled/LKG data                                        |
| A23 | P6.4  | Favorite/Recent order changes                                 | Picker order changes; non-interactive resolution does not                                |
| A24 | P6.4  | `/connect` succeeds                                           | TUI opens the connected provider's filtered model picker                                 |

## 19. Required Test Layers

- Unit: URL normalization, bindings, grants, suppression, precedence, model
  policy, state transitions, redaction, attempt TTL/replay.
- Storage: CAS, locks, rollback, corruption recovery, watch/polling, concurrent
  refresh.
- Protocol: strict payloads, authority matrix, local/remote transport matrix,
  no secret fields, compatibility requests.
- Host integration: config trust plus credential grant, adapter construction,
  generation replacement, no fallback.
- TUI: `/connect`, method prompts, pending/cancel/failure, filtered `/model`,
  stable cursor, config unchanged.
- CLI: hidden/stdin acquisition, JSON non-secret output, concurrent TUI
  observation, legacy migration.
- Real-provider: API-key run and supported OAuth lifecycle using isolated
  credentials and retained non-secret trace evidence.
- Release: schema generation/check, package manifests, source/release install
  smoke, project-map drift, and `npm run release:check`.

## 20. Change Checklist for Later Phases

- `packages/provider-registry/src/index.ts`: keep single provider/model/adapter
  authority; extend only where product-neutral registry contracts require it.
- `packages/host/src/provider-auth.ts`: evolve in place into connection owner.
- `packages/host/src/model-builder.ts`: remove one-provider/one-model temporary
  registry construction once the shared registry is available.
- `packages/host/src/model-factory.ts`: use stateless effective model and
  connection resolution; preserve scope-specific failure semantics.
- `packages/host/src/config-zod-schema.ts` and config implementation: preserve
  legacy allowlist; add unambiguous policy/override fields and diagnostics.
- `packages/host/src/connection.ts` and `server.ts`: split authorities and
  isolate secret request handling before generic logging/diagnostics.
- `packages/protocol/src/index.ts`: add bounded non-secret summaries, attempt
  DTOs, and strict request families.
- SDK packages: mirror protocol only; never create parallel secret/provider
  shapes.
- TUI: add presentation and dispatch; never persist credential or rewrite
  config.
- CLI: add hidden/stdin acquisition and migration; never accept key argv.
- Project map and reference docs: update in the same phase as each contract.

## 21. Deferred Decisions

These are explicitly outside P6 and must not be inferred during
implementation:

- remote clients managing provider connections;
- organization-managed connection grants;
- automatic arbitrary provider-package installation;
- account switching UI beyond one active default per provider;
- cross-device credential synchronization; and
- provider fallback/routing based on price, latency, or availability.

## Last Verified

- Status: Verified
- Date: 2026-08-09
- Scope: P6.1 registry and catalog compatibility is implemented. P6.2-P6.4
  connection storage, API-key submission, OAuth, dynamic refresh, and product
  polish remain planned rather than implied by the P6.1 types.
- Read: bundled catalog/connection descriptors, Host Registry composition,
  provider projections, model construction, Protocol/SDK/CLI compatibility,
  schemas, reference docs, and A01-A04 regressions.
- Tests: full `npm run release:check` passed, including Core 687/687, Host
  585/585, CLI 173/173, TUI 552/552, Protocol 6/6, SDK Core 13/13, 16/16
  regression-matrix cases, production audit, and both install smokes.

- Status: Read-only
- Date: 2026-08-09
- Scope: P6.0 design baseline only; no runtime, protocol, config, CLI, or TUI
  behavior from P6.1-P6.4 has been implemented by this change.
- Read: current ProviderRegistry, Host provider auth/model/config/connection
  boundaries, Protocol provider DTOs, CLI provider commands, TUI model picker,
  project-map ownership pages, and existing provider/auth focused tests.
- Tests: Markdown formatting, relative links, diff whitespace, external-source
  wording scan, and project-map drift were run; runtime tests were not run.
