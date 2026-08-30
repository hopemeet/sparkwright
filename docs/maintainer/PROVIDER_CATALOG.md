# Provider Catalog Maintenance

SparkWright ships a generated, offline model-identity snapshot. Runtime
connection descriptors, packages, endpoints, credentials, auth methods,
drivers, and adapters remain code-owned and are never generated from catalog
data.

## Update workflow

Preview current upstream changes without writing the repository:

```bash
npm run catalog:shadow
```

The command reports added, removed, and display-name-changed model ids for each
supported provider. Review removals and `scripts/provider-catalog/overrides.ts`
before updating:

```bash
npm run catalog:update
npm --workspace @sparkwright/host test -- \
  test/provider-catalog-generator.test.ts \
  test/provider-catalog.test.ts \
  test/provider-catalog-store.test.ts
```

The explicit updater reads `https://models.dev/api.json` unless `--source-file`
or `--source-url` is supplied. It imports only model id and display name. An
independently reviewed OpenRouter shard can be supplied with
`--openrouter-source-file` or `--openrouter-source-url`; it is intentionally not
enabled by default. Sources are fetched independently, so one valid shard can
update its own provider range while a failed shard retains the committed
fallback. If every enabled source fails, the command exits without writing.
The generated file records a separate SHA-256 digest for every successful
source response. Ordinary build, test, and install commands do not execute the
updater.

## Review requirements

- Inspect every removal and large provider-count change.
- Keep corrections metadata-only; never add endpoints, packages, environment
  variable names, auth declarations, drivers, or executable configuration.
- Do not invent context, output, capability, or pricing defaults when the
  source is unknown.
- Confirm user-defined providers, legacy `models`, `modelPolicy`, and
  `modelOverrides` tests remain green.
- Keep the applicable third-party license in the repository and Host package
  notices. Confirm additional dataset/database obligations with counsel before
  changing the redistributed field set.
- Do not enable or publish an additional source merely because it exposes a
  public API. Record legal approval for the intended automated access and
  redistribution scope first; otherwise keep the shard disabled and rely on
  connection-scoped runtime discovery.

## Sign and publish

Generate an Ed25519 artifact v2 after the snapshot diff is approved:

```bash
SPARKWRIGHT_PROVIDER_CATALOG_SIGNING_KEY_FILE=/secure/release-key.pem \
npm run catalog:sign -- \
  --key-id release-2026-01 \
  --source-revision "$CI_COMMIT_SHA" \
  --expires-at 2026-09-01T00:00:00.000Z \
  --output provider-catalog.artifact.json
```

Never commit the private key. Publish the artifact to an HTTPS endpoint that
does not redirect. Runtime deployments configure the endpoint and trusted
public-key map through `SPARKWRIGHT_PROVIDER_CATALOG_URL` and
`SPARKWRIGHT_PROVIDER_CATALOG_TRUSTED_KEYS`. Keep old public keys during a
rotation window; remove them only after every supported release trusts the new
key.

When the deployment URL and trusted keyring are configured, Runtime checks the
signed base on Host startup and every six hours, with at most daily fetches
unless expiry is near. ETag revalidation, in-process single-flight, and a
recoverable cross-process lease prevent redundant downloads. The background
path never performs authenticated discovery. A rejected or unavailable artifact
leaves the signed last-known-good or bundled snapshot active. Authenticated
provider discovery is persisted separately per workspace and exact connection,
so publishing a global artifact cannot overwrite account-visible inventory.
`SPARKWRIGHT_OFFLINE=1` disables both signed-base refresh and authenticated
model-discovery requests.

## Rollback

Do not republish different content under an existing catalog version. Revert
the generated snapshot in source for the next application release, or publish
a newly signed artifact with a higher catalog version and reviewed corrected
content. Runtime state rejects version rollback and same-version content drift.
