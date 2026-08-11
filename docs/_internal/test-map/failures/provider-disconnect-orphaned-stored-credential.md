# Provider Disconnect Orphans Stored Credential Management

## Record

- Pattern ID: `provider-disconnect-orphaned-stored-credential`
- Status: `fixed`
- First seen: 2026-08-09
- Last seen: 2026-08-09
- Recorded count: 1

| Cause                   | Count |
| ----------------------- | ----: |
| `product_bug`           |     1 |
| `test_bug`              |     0 |
| `prompt_underspecified` |     0 |
| `model_variance`        |     0 |
| `environment`           |     0 |
| `stale_dist`            |     0 |
| `dirty_workspace`       |     0 |
| `unknown`               |     0 |

## Symptom

After CLI `provider disconnect <connection-id>` or TUI `/connect` + `d`, the
stored connection disappears from CLI/TUI inventory. Its metadata and
credential remain on disk, but `provider select <connection-id>` and
`provider remove <connection-id>` both reject the now-hidden id. The user
cannot reselect or permanently remove the retained credential through product
surfaces.

## Root Cause

`disconnectStoredConnection` removes the workspace grant. Provider catalog
projection then filters stored connections through `hasConnectionGrant`.
CLI/TUI connection management resolves candidates from that filtered catalog,
so the retained connection is no longer reachable even though Host state and
the credential store still own it.

## Diagnostic Move

Use isolated XDG state and a file credential store. Connect two credentials for
one provider, disconnect one exact id, then compare:

- `provider list` inventory;
- exact-id `provider select` and `provider remove` results;
- `provider-auth.json` connection ids and grants; and
- credential-store presence without printing credential values.

If metadata and the credential remain while inventory/select/remove cannot
reach the id, this pattern applies.

## Prevention

- Keep stored-connection inventory distinct from workspace permission to use a
  connection, or otherwise provide a local management projection that can
  regrant/remove retained connections without exposing credential material.
- Add CLI and TUI regressions that disconnect, restart, reselect, and remove the
  same exact connection id.
- Preserve endpoint/driver binding validation when selection re-adds a grant.

## Resolution

Provider catalog construction now has a Host-internal management visibility
mode. The default mode still requires a workspace/user grant. Host enables the
management mode only for non-remote connections that already hold
`provider_connection.manage`; the direct CLI uses the same manager view.
Disconnected entries therefore retain their opaque id and non-secret binding
metadata with no `grantScope`, while runtime and remote projections stay
grant-filtered. CLI and TUI regressions cover disconnect, reselection, and
removal; Host tests cover credential retention/deletion and the local/remote
visibility boundary.

## Related

- Coverage: [../coverage/provider-connections.md](../coverage/provider-connections.md)
- Run notes:
  [2026-08-09-provider-connection-manual-partial.md](../runs/2026-08-09-provider-connection-manual-partial.md)
