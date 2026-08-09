# v0 Release Checklist

Use this checklist before tagging a v0 release candidate.

## Required Checks

```bash
npm install
npm run release:check
```

`release:check` runs typecheck, lint, format check, schema validation,
build-backed tests, a high-severity production dependency audit, a
deterministic read-only CLI smoke test, the deterministic regression matrix,
the project-trust process-denial regression, and source/packed-tarball install
smoke tests in temporary projects.
Both install smokes repeat the production audit inside the installed app, so a
fresh consumer dependency graph cannot bypass the repository lockfile gate.
The release-manifest gate checks every public workspace package, exact
cross-package versions, lockfile identity, built entrypoints, publish metadata,
dependency topology, and absence of first-party install lifecycle scripts.
Packed and source installation use `--ignore-scripts`.

For a broader pre-push manual pass across runtime, CLI, host/SDK, gateway,
skills, MCP, provider registry, trace, and examples, use
[Push Test Runbook](./PUSH_TEST_RUNBOOK.md).

## Manual Smoke Checks

Run the deterministic write path in a disposable or resettable workspace:

```bash
npm exec sparkwright -- run "inspect this repo and suggest a README improvement" \
  --workspace examples/repo-pilot \
  --target README.md \
  --access-mode bypass \
  --trace-level standard
```

Confirm the session directory printed by the CLI contains:

- `trace.jsonl`
- `agents/main/runs/<run-id>/run.json`
- `agents/main/runs/<run-id>/result.json`
- an `artifacts/` directory
- a diff artifact for the proposed write

Optionally verify the provider-backed path with a real key:

```bash
OPENAI_API_KEY=... npm exec sparkwright -- run "inspect this repo" \
  --workspace examples/repo-pilot \
  --target README.md \
  --model openai/<model-name> \
  --trace-level standard
```

Latest recorded provider smoke:

- Date: 2026-05-17
- Endpoint shape: OpenAI-compatible endpoint through `OPENAI_BASE_URL`
- Proxy: verified with `HTTP_PROXY` and `HTTPS_PROXY`
- Model: `<provider-model>`
- Prompt: `who are you`
- Result: completed with `run.completed final_answer`
- Trace: `examples/repo-pilot/.sparkwright/sessions/<session-id>/trace.jsonl`

## Release Readiness Gate

- all public `@sparkwright/*` package versions match
- all public package entrypoints point at existing built `dist` files
- internal package dependency ranges exactly match the release version
- `package-lock.json` records the same workspace names and versions as manifests
- public manifests use `publishConfig.access=public`, include `dist`, and define no first-party `preinstall`/`install`/`postinstall`
- protocol docs and `schemas/*.json` include all current event types and stop reasons
- `npm run schema:check` validates all protocol schemas and locks Host protocol source/docs/schema versions and request/error enums
- project trust regressions cover canonical roots, separate worktrees, symlink rejection, manifest-change invalidation, external `0600` hash-only state, local mutation authority, remote mutation denial, and no untrusted project command/MCP execution
- `npm run security:audit:production` reports no high or critical production dependency vulnerabilities
- source and packed-release install smokes report no high or critical production dependency vulnerabilities in their fresh consumer graphs
- README, roadmap, backlog, and MVP spec describe a runnable pre-v0/v0 kernel, not a planning-only project
- custom tool example is present and matches public APIs
- troubleshooting covers CLI build, approval behavior, provider configuration, workspace boundaries, and trace levels

## Publish Mechanics

- Update `CHANGELOG.md`.
- Run `git status --short` and confirm only intended files changed.
- Run `npm run release:check`.
- Run the manual deterministic write smoke check above in a resettable workspace.
- Run the optional provider-backed smoke check when an OpenAI key is available.
- If provider credentials are not available on the release machine, reference the latest recorded provider smoke before tagging.
- Run `npm run check:release-manifests` and use the printed dependency order to publish every public package.
- Use npm 2FA/provenance settings appropriate for the publishing account.
- Create a git tag for the released version.
- After publishing, install the CLI in a clean temporary project and run the read-only golden path.

## Deferred Beyond v0

- streaming provider interface
- provider registry, auth store, and routing
- replay
- trace viewer
- long-term memory, retrieval, skills, and real compaction
- Python SDK, HTTP adapter, and GitHub Action example
