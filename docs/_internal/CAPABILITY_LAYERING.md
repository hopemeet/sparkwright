# Capability & State Layering — Design Draft

> Status: draft / partially implemented. Local-only (`docs/_internal/` is gitignored).
> Goal: unify where SparkWright's capabilities and runtime state live, so
> `config / command / skill / agent / cron` all follow one discovery + precedence
> model instead of each doing its own thing.

## 1. The two axes

Before placing anything, classify it on **two orthogonal axes**.

### Axis A — authored capability/config (participates in layering)
`config`, `command`, `skills`, `agents`, `cron definitions`.
Discovered across three layers, precedence **project > user > builtin**.

### Axis B — runtime state/output (does NOT layer)
`trace / sessions / runs / todo.md / tui-history`, `cron state + output`.
No discovery, no precedence. Pick one home by **scope** and always gitignore.

### Third dimension — delivery mechanism
Not everything is a discoverable file. Capabilities arrive three ways:

| Delivery | What | Examples | Layering |
|----------|------|----------|----------|
| ① Code (compiled into a package) | tools, engines | `coding-tools`, `shell-tool`, `mcp-adapter`, cron engine | none — ships with the package = inherently builtin; adding 3rd-party code = a plugin system (we do NOT build one) |
| ② Authored files (discovered) | skill, agent, command, cron defs | `.sparkwright/skills/*` | three-layer file discovery |
| ③ Config-declared (entries in config.json) | mcp servers, ACP/external delegates, tool enable/allow policy | `capabilities.mcp.servers[]`, `capabilities.agents.profiles[].metadata.acp` | rides the config layer (already user→project) |

Implications:
- **tool**: builtin tools are ① (code, `defineTool` → `ToolRegistry`); dynamic tools come from MCP; per-agent allow-list is ③. No new file-discovery layer.
- **mcp**: pure ③. `capabilities.mcp.servers[]` ([config.ts](../../packages/host/src/config.ts)); `mcp-adapter` injects their tools. Already inherits config's user→project merge — nothing to add.
- **acp**: edge protocol code ships with `@sparkwright/acp-adapter` and the
  `sparkwright acp` entrypoint. External ACP delegates are config-declared
  agent profiles (`metadata.acp`) exposed through
  `capabilities.agents.delegateTools`; ACP `session/new` MCP servers are
  session-scoped input, not persisted file discovery.
- **plugin**: SparkWright has NO plugin system ("plugin" only appears as command metadata + a user-hooks source enum). Do not build runtime 3rd-party-code loading (arbitrary-code-exec surface). skill + command + mcp + user-hooks cover extension.

→ The three-layer file discovery is **only for Axis A / delivery ②** (skill/agent/command/cron defs).

## 2. The three layers (Axis A)

Three **physically distinct** homes, by lifecycle/owner:

| Layer | Physical location | Owner | Updated by | Writable |
|-------|-------------------|-------|------------|----------|
| builtin | inside the installed package: `node_modules/@sparkwright/host/builtin/...` (source: `packages/host/builtin/`) | the program | `npm update` | read-only |
| user | `~/.config/sparkwright/` (XDG config) | the machine user | hand-edit | yes |
| project | `<root>/.sparkwright/` | the repo | git | yes |

Resolved relative to `import.meta.url` of the host package, so builtin is found
wherever it was installed. **builtin must NOT live in `<root>/.sparkwright/`** —
that is the project layer; putting it there collapses the model, means empty
dirs have no builtin, breaks `npm update` freshness, and pollutes user git.

Merge order weak→strong: `builtin → user → project`; later shadows earlier by
name/id. Secrets are allowed **only** in the user layer.

### What goes in the user layer
`~/.config/sparkwright/` (Axis A — config):
- `config.json` — provider credentials (only place for secrets) + personal non-secret prefs (default model, permissionMode). Already exists (`userConfigPath`).
- `skills/` — personal skills, used across all your projects, not committed anywhere.
- `agents/` — personal agent profiles.
- `command/` — personal commands (code already reserves `userCommandDir`).

`~/.local/state/sparkwright/` (Axis B — machine-global state):
- `cron/jobs.json`, `cron/output/` — cron state + output (Phase 5 "迁状态" moves it here from the config dir).
- `im-gateway/state.json` — IM gateway routing state.

### Axis B placement summary
| Resource | Nature | Home | git |
|----------|--------|------|-----|
| trace / sessions / runs / todo / tui-history | per-workspace state | `<root>/.sparkwright/sessions/` (unchanged) | ignore |
| cron job **definitions** (optional feature) | authored (Axis A) | builtin/user/project | by layer |
| cron job **state + output** | machine-global state | `~/.local/state/sparkwright/cron/` (move from config) | ignore |
| IM gateway config | user config | `~/.config/sparkwright/im-gateway.json` | no |
| IM gateway routing state | machine-global state | `~/.local/state/sparkwright/im-gateway/` | ignore |

## 3. What already matches the target (don't rebuild)
- **config**: user config is XDG
  (`~/.config/sparkwright/config.{json,yaml,yml}`); `loadHostConfig` merges
  user(weak)→project(strong), reports same-layer config conflicts, and returns
  `sources` provenance ([config.ts](../../packages/host/src/config.ts)).
- **shared layer resolver**: `resolveCapabilityDirs` centralizes
  builtin/user/project roots for `skills`, `agents`, and `command`; TUI project
  command discovery now uses that resolver rather than deriving user command
  paths from `userConfigPath`.
- **skill/agent/command roots**: builtin/user/project roots are reported by
  `doctor paths`; builtin roots live under the installed host package, user roots
  under XDG config, and project roots under `<workspace>/.sparkwright/`.
- **command**: already user→project shadow ([project-commands](../../packages/project-commands/src/index.ts)), `ProjectCommandSource = "project" | "user"`.
- **IM gateway**: config defaults to `~/.config/sparkwright/im-gateway.json`;
  routing state defaults to `~/.local/state/sparkwright/im-gateway`.
- **source install layout**: `install.sh` installs program files under
  `~/.sparkwright` with `versions/<version>`, `current`, and `bin/sparkwright`;
  `uninstall.sh` removes only program files and leaves XDG/project state intact.

Still open: cron authored definitions remain a design question; cron mutable
state is already XDG state and should not be scattered into project/user
capability roots without a separate security review.

## 4. Decisions locked
- Three-layer file discovery applies **only** to Axis A / delivery ② (skill/agent/command/cron defs). ① ships with packages; ③ rides config or session input. Do not add ACP/plugin directory discovery.
- builtin content lives in **`packages/host/builtin/`** (host owns discovery; correct dependency direction; no new package). Extract a `@sparkwright/builtin` package only if a second consumer needs it.
- Directory names: **plural** `.sparkwright/skills/`, `.sparkwright/agents/`. (`command/` is currently singular — open question whether to unify to `commands/`.)
- cron Phase 5: **only relocate state** (config→state dir). Do NOT add repo-shipped cron definitions (a new behavior with a clone-time-scheduling security implication; evaluate separately).

## 5. Phased plan (one PR per phase, Model A branch→PR→merge)

### Phase 1 — shared layer resolver (implemented)
New `packages/host/src/layers.ts`:
```ts
export type Layer = "builtin" | "user" | "project";
export interface ResolvedDir { layer: Layer; dir: string; readOnly: boolean; }
// weak→strong: [builtin, user, project]
export function resolveCapabilityDirs(
  kind: "skills" | "agents" | "command" | "cron",
  opts: { cwd: string; env?: Record<string,string|undefined> },
): ResolvedDir[]
```
- builtin: `fileURLToPath(import.meta.url)` → `packages/host/builtin/<kind>/`.
- user: XDG base (reuse `userConfigPath` logic) → `~/.config/sparkwright/<kind>/`.
- project: `<cwd>/.sparkwright/<kind>/`.
Implemented in host and consumed by CLI/TUI diagnostics.

### Phase 2 — skills into namespace + three layers (BREAKING, standalone PR)
1. Move repo `skills/` → `.sparkwright/skills/`.
2. Rewrite default roots: `PROJECT_CONFIG_TEMPLATE`, init scaffold, fallback `join(workspaceRoot,"skills")` ([cli.ts:897,989,2329](../../packages/cli/src/cli.ts)) → use the Phase 1 resolver.
3. Compat fallback: if legacy `roots:["../skills"]` or a root `skills/` is detected, still load but warn (deprecated). Remove one minor version later.
4. Trust: builtin-layer skills register `trust:"builtin"` (guard already allow-passes); user/project use `trustFromMetadata`. Update `loadSkills(roots)` callsite ([index.ts:133](../../packages/skills/src/index.ts)) to carry layer labels.
5. Sync docs/examples/schema: HOST_PROTOCOL, manual configuration.md, `examples/*` workspaces, `schemas/`.

### Phase 3 — ship builtin product skills (fixes the missing-from-tarball gap)
1. Put `sparkwright-manual` / `spark-tester` in `packages/host/builtin/skills/`.
2. Add `builtin` to the publishing package's `files` (cli currently `["dist"]` → builtin must be in whichever package ships it; if host, host's `files`).
3. builtin root injected read-only + `trust:"builtin"` via the resolver.
4. Verify: `npm pack` contains builtin; install to a temp project; `sparkwright skills list --source` shows builtin origin.

### Phase 4 — agents across three layers (minor)
- `agent-profiles.ts` is hardcoded to `<root>/.sparkwright/agents/*.md` ([agent-profiles.ts:16](../../packages/host/src/agent-profiles.ts)). Iterate the Phase 1 resolver; extend `mergeAgentProfilesById` to merge builtin→user→project by id. Project path unchanged → no breakage, just new layers.

### Phase 5 — cron: relocate state (done)
- `defaultCronRoot` points at XDG **state** (`~/.local/state/sparkwright/cron/`).
- Do NOT add `.sparkwright/cron/*.md` repo-shipped definitions this round.

### Phase 6 — provenance + cleanup
- `skills list` / `agents list` / `commands` gain `--source` (reuse config's `sources` pattern) showing builtin/user/project origin.
- `.gitignore` review: `.sparkwright/skills/`, `.sparkwright/agents/` travel with repo; sessions/runs continue ignored; cron state in XDG needs no ignore.
- Full `npm run release:check` (typecheck:test, format:check, check:reserved:strict, schema validation); verify the PR's **Windows job** (path separators, rename EPERM — migration code is the high-risk area).

## 6. Breaking changes (for CHANGELOG)
| Change | Impact | Mitigation |
|--------|--------|------------|
| default skill root `../skills` → `.sparkwright/skills/` | existing workspaces break | compat fallback + deprecation warning, remove next minor |
| repo `skills/` moved | this repo + examples | migrate in-PR, update docs |
| cron root config→state | existing scheduled jobs | no migration; unreleased path |

## 7. Open questions to confirm before/within implementation
1. Unify `command/` → `commands/` (small breaking) for naming consistency?
2. Phase ordering: main line is 1 → 2 → 3; 4/5/6 are symmetry cleanup.
