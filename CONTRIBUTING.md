# Contributing To Sparkwright

Sparkwright is early. The best contributions are small, well-scoped changes that make the runtime clearer, safer, or easier to use.

## Contribution Priorities

Current priority order:

1. runtime kernel
2. event trace
3. tool execution
4. policy and approval
5. workspace safety
6. CLI golden path
7. protocol docs and schemas

Please avoid large feature additions before the v0 golden path works end to end.

## Design Expectations

- Keep APIs plain and composable.
- Prefer serializable data shapes.
- Add events for meaningful runtime behavior.
- Treat approval and policy as first-class.
- Use fake model adapters in tests whenever possible.
- Do not couple core code to one model provider.

## Development

Expected setup:

```bash
npm install
npm run typecheck
npm test
```

The repository uses npm workspaces.

Before opening a pull request, run the checks that match your change:

```bash
npm run typecheck
npm test
npm run lint
npm run format:check
```

For release-sensitive changes, run the full gate:

```bash
npm run check
```

## Public Repo Hygiene

Do not commit secrets, credentials, internal planning notes, local traces, editor settings, generated build output, or machine-specific files.

The repository intentionally ignores local-only paths such as `.env*`, `.sparkwright/`, `docs/_internal/`, `README.internal.md`, IDE folders, build output, and coverage output. If a file looks useful for a public reader, move the reusable part into a public doc instead of committing private notes directly.

## Docs

When changing core concepts, update the relevant docs:

- `PROJECT_CHARTER.md`
- `docs/ARCHITECTURE.md`
- `docs/PROTOCOL.md`
- `docs/HOST_PROTOCOL.md`
- `docs/EXTENSION_INTERFACES.md`
- `docs/RUN_EVENTS.md`

Significant changes should also be reflected in `CHANGELOG.md`.

## Scope Control

Keep contributions small and well-scoped. Prefer a working, reviewable slice over a broad refactor. New abstractions should be justified by at least two concrete in-tree call sites.
