# Design: Config Redesign (selector tools + YAML starter)

> Historical implementation record. **P0/P1/P1b/P2/P3 are implemented.** `tools.use`,
> `approvals.cronMode`, `AgentProfile.use`,
> `capabilities.agents.maxDepth`, YAML loading, same-layer conflict detection,
> YAML `init` starters, first-run user-config scaffolding, schema-backed
> `config validate`, and YAML editor schema modelines are implemented. P3a added a host-owned Zod schema that
> generates `schemas/config.schema.json`; P3b-P3m completed the migration of
> runtime loader shape checks to the same schema source. The current config contract lives in
> [../modules/host.md](../modules/host.md), [../modules/cli.md](../modules/cli.md),
> and `packages/host/src/config.ts`; do not use this design as the active routing map.

## 1. Background & Goals

Real-model testing of multi-agent / MCP scenarios surfaced a concrete bug: a
user prompt said "only use MCP tools, no todo / no repo reads", yet a mini model
still called `todo_write`. Trace showed `todo_planning` guidance was injected
because `todo_write` was in the run's live tool inventory.

Root cause is **not** weak models or stray prompt guidance. The tool capability
surface is not constrained by product config, so the model can still see and
call `todo_write`. Prompt-level "don't use X" is unreliable; the surface must be
controlled at the host catalog / live-inventory layer.

Goals for the redesign:

- **易用易维护**: users control the agent loop through the config file.
- New capabilities are **easy to associate** with config.
- The starter config is **discoverable**: after install, a user can do the
  common 80% of control without reading the full reference.
- Avoid the opposite failure mode (see §7): a sprawling config with hundreds of
  half-used fields.

## 2. Locked Decisions

| #   | Decision                                                      | Choice                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | `tools.use` cross-layer merge                                 | **Intersection (tightening)** — consistent with existing `allowed`; a lower-trust (project) layer cannot widen a higher-trust (user) layer.                                                                                                                                            |
| ②   | Hand-written validation → schema single-source (zod) refactor | **Not this round; sequenced LAST** (per user) — independent of selector work; would double the round's size and review surface. Generates the JSON Schema that P2 editor validation consumes, but ships after it.                                                                      |
| ⑧   | Config validation UX                                          | **In the plan** (added per user) — user-facing "check my edits before running". NOTE: `sparkwright config validate` **already exists** (`handleConfigValidate`, cli.ts:3954, reuses `loadHostConfig`). So P2 is **enhance** (YAML/schema/editor live validation), not "add a command". |
| ③   | CLI write subcommand (`sparkwright tools use <selector>`)     | **Read-only display only** — `capabilities inspect` shows effective selectors + final inventory; users edit the file directly.                                                                                                                                                         |
| ④   | `approvals.cronMode` (approval default for unattended cron)   | **In this round** — small, pure-config, same structure as existing `approvals`.                                                                                                                                                                                                        |
| ⑤   | Sub-agent symmetry (runBudget / selector / maxDepth)          | **Folded into P1** — shares the selector resolver; splitting would expose the resolver twice.                                                                                                                                                                                          |
| ⑥   | Starter file format                                           | **YAML (with comments)** — chosen over JSONC. Promotes the YAML loader from "optional P2" to **in-scope this round**, with json/yaml conflict detection required.                                                                                                                      |
| ⑦   | `init` templates                                              | **Two files**: user file = ① credentials only; project file = ②–⑥ controls. Does not remove the user layer (it remains a machine-level policy floor).                                                                                                                                  |
| ⑨   | `tools` placement                                             | **Keep top-level `tools`** — tool exposure is policy-relevant, but `tools` is already the stable catalog/loading contract. Do not introduce `policy.tools` in this round.                                                                                                              |

## 3. Current Configurable Surface (inventory)

The config is already rich. The problem is discoverability + inconsistent
naming, not missing controls. Verified against `packages/host/src/config.ts`
and `packages/agent-runtime/src/index.ts` on 2026-06-19.

| Concern                    | Existing field                                                                                                                     | Source               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Main-agent max steps       | `maxSteps` + `runBudget.maxModelCalls`                                                                                             | config.ts:124        |
| Main run budget            | `runBudget.{maxDurationMs,maxModelCalls,maxToolCalls,maxTokens,maxCostUsd}`                                                        | config.ts:1659       |
| Sub-agent max steps        | `AgentProfile.maxSteps`, `delegateTools[].maxSteps` (parent/child min)                                                             | agent-runtime:167    |
| **Sub-agent run budget**   | `AgentProfile.runBudget` — **already exists**: validated at config.ts:2468, parent/child `minRunBudget` merge at agent-runtime:171 | config.ts:2468       |
| Sub-agent tools            | `AgentProfile.use` selectors plus `allowedTools/deniedTools` (selector/allowed ∩, denied ∪)                                        | agent-runtime        |
| Sub-agent max depth        | `capabilities.agents.maxDepth`                                                                                                     | config.ts/runtime.ts |
| Sub-agent model            | `AgentProfile.model`                                                                                                               | agent-runtime:69     |
| Sub-agent nesting/approval | `delegateTools[].{forbidNesting,requiresApproval}`                                                                                 | config.ts:258        |
| Allowed/denied skills      | `capabilities.skills.{allowedSkills,deniedSkills}`                                                                                 | config.ts:262        |
| Skill loading              | `loadSelectedSkills,maxSelectedSkills,resourceFileLimit,includeLoaderTool`                                                         | config.ts:262        |
| Tools                      | `tools.{allowed,disabled,defer}`                                                                                                   | config.ts:162        |
| MCP servers                | `capabilities.mcp.servers[].{enabled,startup,toolSchemaLoad,policy}`                                                               | config.ts:287        |
| Write guardrails           | `write.{maxFiles,maxDiffLines,allowDeletions}`                                                                                     | config.ts:132        |
| Read confidentiality       | `confidentialPaths`                                                                                                                | config.ts:105        |
| Shell sandbox              | `shell.sandbox.{mode,filesystem,network,failIfUnavailable}`                                                                        | config.ts:150        |
| Approval defaults          | `approvals.{shellSafe,edits,all}` + `permissionMode` (named modes)                                                                 | config.ts:141/366    |
| Verification gate          | `capabilities.verification.{mode,profiles,afterWrites,stopGate}`                                                                   | config.ts:240        |
| Workflow hooks             | `capabilities.hooks.workflow[]`                                                                                                    | config.ts:206        |
| Trace verbosity            | `traceLevel`                                                                                                                       | config.ts:127        |

## 4. v1 Selector Design

### 4.1 Key source facts (verified 2026-06-19)

- `HostToolCatalogEntry.source` already exists with 10 categories: `coding`,
  `cron`, `skill`, `agent`, `shell`, `task`, `todo`, `mcp`, `delegate`, `core`
  (tool-catalog.ts:36). **No new source metadata needed.**
- MCP tools carry `governance.origin = { kind: "mcp", name: serverName,
metadata: { serverName, lazy, operation } }` for both lazy gateway tools and
  prepared real tools (mcp-adapter/src/index.ts:368). `mcp:<server>` matches on
  `origin.name`.
- `tools.allowed` already filters by concrete name in `applyToolConfig`
  (tools.ts:769) — **the bug is fixable today** via `tools.allowed`.
- `mergeToolConfig` (config.ts:2069) already does allowed-intersection /
  disabled-union / defer-replace; selectors reuse this.
- `withDeferredToolSearch` (tool-catalog.ts:113) rebuilds `tool_search` from the
  **post-filter** catalog, so selectors applied at the catalog layer
  automatically prevent `tool_search` from leaking filtered tools.

### 4.2 Architectural constraint

`applyToolConfig` operates on bare `ToolDefinition[]` and cannot see `source`.
Selector resolution **must live at the catalog layer** (`HostToolCatalogEntry`,
where `source` exists), expand selectors into a concrete-name allowlist, then
feed that into the existing `applyToolConfig`.

### 4.3 Config shape

```yaml
tools:
  # Primary: high-level selector whitelist. Unset = current behavior (all tools);
  # set = tightening whitelist by source/capability group.
  use: [workspace.read, workspace.write, shell, planning, skills, agents, mcp]
  # or exclusive to one MCP server:
  # use: [mcp:demo]

  # Advanced escape hatch — field names and position UNCHANGED (already migrated
  # out of capabilities.tools once; do not migrate again). Documented as advanced.
  allowed: [] # concrete-name intersection (strictest whitelist)
  disabled: [] # concrete-name union close
  defer: [] # schema load preference, NOT a permission
```

Single selector field `tools.use`. **`tools.only` is dropped** — `only:[mcp]`
and `use:[mcp]` produce identical results; two fields only create ambiguity.

### 4.4 Selector vocabulary

| selector          | match rule                              | tools                                               |
| ----------------- | --------------------------------------- | --------------------------------------------------- |
| `workspace.read`  | source=`coding` ∩ static read list      | read_file, glob, grep, list_dir, read_anchored_text |
| `workspace.write` | source=`coding` ∩ static write list     | edit_anchored_text, apply_patch                     |
| `shell`           | source=`shell`                          | shell                                               |
| `planning`        | source=`todo`                           | todo_write                                          |
| `skills`          | source=`skill`                          | skill inspect/manage/dynamic                        |
| `agents`          | source=`agent` ∪ `delegate`             | agent + delegate tools                              |
| `tasks`           | source=`task`                           | task                                                |
| `cron`            | source=`cron`                           | cron                                                |
| `mcp`             | source=`mcp` (all)                      | all MCP-source tools                                |
| `mcp:<server>`    | source=`mcp` ∧ `origin.name===<server>` | that server's lazy gateway + real tools             |

- `coding` covers both read and write, so `workspace.read/write` need a static
  name sub-list. Add a guard test asserting every `coding` tool is covered by
  exactly one list (prevents a new coding tool from going unclassified).
- `tool_search` is **not a selector** (there is no `core.discovery`). It is
  derived infrastructure: `shouldAppendDiscoveryTool` (single owner, in
  `tool-selectors.ts`) appends it whenever the _filtered_ set still contains a
  deferred tool, exempt from allow/selector filtering; only an explicit
  `tools.disabled` entry opts out. Both the `use` and `allowed` paths therefore
  keep it consistently. (Post-implementation correction: an earlier patch
  retained `tool_search` only on the `use` path and re-filtered it on the
  `allowed` path, dropping it — the discovery rule was unified to remove that
  inconsistency and the double catalog-filter pass.)
- Unknown selector → validation error listing the legal set (no silent ignore).

### 4.5 Resolver placement

New module `packages/host/src/tool-selectors.ts`:

```ts
export function resolveSelectorAllowlist(
  entries: readonly HostToolCatalogEntry[],
  selectors: readonly string[] | undefined,
): string[] | undefined; // concrete names; undefined = no restriction
```

In `applyToolConfigToCatalog` (tool-catalog.ts), fold selectors into `allowed`
before calling the existing `applyToolConfig`:

```ts
const selectorAllow = resolveSelectorAllowlist(entries, config?.use);
const effectiveAllowed = intersectAllow(config?.allowed, selectorAllow);
applyToolConfig(defs, { ...config, allowed: effectiveAllowed });
```

This keeps `applyToolConfig` purely name-based, confines selector logic to the
only layer with `source`, and makes `withDeferredToolSearch` + `tool_search`
filtering inherit it for free. Child-agent catalog
(`createReadOnlyChildToolCatalog`) goes through the same path, keeping main/sub
behavior consistent (entrypoint-consistency invariant).

### 4.6 Merge semantics

`tools.use` merges by **intersection (tightening)** across layers — extend
`mergeToolConfig` with `use: intersectUniqueStrings(prev.use, next.use)`.
Same conservative-merge invariant as `allowed`.

### 4.7 Sub-agent symmetry (folded in)

NOTE: `AgentProfile.runBudget` is **already implemented** (type, config.ts:2468
validation, parent/child `minRunBudget` merge at agent-runtime:171) — do NOT
re-add it. The genuine gaps are only:

- `AgentProfile` supports `use` selectors (reuse §4.5 resolver) — replaces the
  concrete-name `allowedTools/deniedTools` maintenance pain with the same
  selector vocabulary the main agent gets.
- `capabilities.agents.maxDepth` — global recursion-depth ceiling (today only
  per-delegate `forbidNesting` boolean exists, no numeric global cap).

## 5. Starter Template (YAML, two files)

`init` generates two annotated files. Surface only the ~6 knobs users actually
touch in the first week; everything else stays in the reference doc.

**Must use the canonical grouped form `identity/policy/run/ui`** — config.ts:3056
declares it the preferred on-disk surface, and `normalizeGroupedConfig` flattens
it to the historical flat `SharedConfig` (flat keys still work as aliases, and a
grouped+flat collision is already reported). Do NOT write the starter with flat
top-level `permissionMode/runBudget/write`. Mapping: `identity.{model,providers}`,
`policy.{permissionMode,write,confidentialPaths,sandbox}`,
`run.{budget,maxSteps,traceLevel,approvals}`, `ui.{theme,mouse,keybindings}`.
`capabilities` and (currently) `tools` are not part of the group map and stay
top-level — see open question on `tools` placement below.

**User file** (`~/.config/sparkwright/config.*`) — credentials + personal
defaults only:

```yaml
identity:
  model: openai/gpt-5.4-mini
  providers:
    openai:
      apiKey: ""
```

**Project file** (`.sparkwright/config.*`) — controls:

```yaml
# ② what the agent may use (unset = all; set = tightening whitelist)
#    options: workspace.read workspace.write shell planning skills agents mcp  mcp:<server>
tools:
  use: [workspace.read, workspace.write, shell, planning, skills]

policy:
  # ③ autonomy level (one named dial)
  #    default = ask each step | accept_edits = auto-approve edits | bypass = allow all | plan = plan only
  permissionMode: default
  # ⑤ write guardrails
  write:
    maxFiles: 5
    allowDeletions: true

run:
  # ④ runaway brakes
  budget:
    maxModelCalls: 80
    maxCostUsd: 2.0

# ⑥ MCP / skills — example stubs, empty by default
# capabilities:
#   mcp:
#     servers:
#       - type: stdio
#         name: demo
#         command: node
#         args: [tools/demo-mcp.mjs]
#   skills:
#     roots: [.sparkwright/skills]
```

> Format note: P1b landed with YAML starter files plus JSON/YAML/YML loaders.
> First interactive runs with no loaded config now scaffold the user YAML once
> and stop before model execution. YAML starters point `yaml-language-server`
> at the local schema shipped with the CLI package (`dist/schemas`) instead of
> requiring a hosted schema URL.
> `sparkwright tools allow|disable|defer`, `agents create`, TUI create flows,
> and managed capability tools preserve an existing config file's format. If no
> config exists, direct write flows still create their historical JSON default;
> `init` creates YAML.

> Placement decision: keep `tools` top-level. Tool selection is policy-relevant,
> but the field controls capability inventory/loading and already has a stable
> top-level contract. Do not introduce `policy.tools` in this round; avoid a
> second migration surface.

**Not in the starter** (advanced / reference only): `tools.allowed/disabled/
defer`, `shell.sandbox.*`, `confidentialPaths`, `verification.*`,
`hooks.workflow`, `traceLevel`, `agents.profiles/delegateTools`, sub-agent
details.

### 5.1 Approval dial note

SparkWright has two approval axes that overlap:

- `permissionMode`: `plan` / `dont_ask` / `default` / `accept_edits` /
  `bypass_permissions` — this is where "ask" (=`default`) and "bypass"
  (=`bypass_permissions`) already live.
- `approvals.{shellSafe,edits,all}`: finer-grained auto-grant booleans
  (`bypass_permissions` ≈ `approvals.all:true`, `accept_edits` ≈
  `approvals.edits:true`).

The starter surfaces **only `permissionMode`** (self-describing named dial);
`approvals` booleans stay advanced. Docs must note: "project config can only
make modes stricter, never relax them" (config.ts:374 conservative merge).

## 6. YAML Loader (implemented)

- Both JSON and YAML loaders produce the same `SharedConfig`; validation/merge
  logic is fully reused. Incremental cost is confined to the loader entry.
- If `config.json` and `config.yaml` coexist in the same directory → **report a
  conflict** (avoid priority ambiguity).
- Keep JSON compatibility; YAML is an additional human-friendly format, not a
  replacement.

## 7. Anti-Pattern Reference (hermes-agent config)

The hermes-agent config (`_config_version: 22`, hundreds of fields, empty stubs
like `whatsapp: {}`, an `auxiliary` block with 9 near-identical provider stubs)
is mostly a cautionary tale of what SparkWright must NOT become.

**Borrow (small, curated):**

- `approvals.cronMode` — context-aware approval default for unattended cron
  (decision ④, in this round).
- `version` top-level field with a migration story (don't accumulate to v22 —
  define how unknown/too-old versions are handled, error + migrate hint).

**Borrow as backlog (real features, not just config):**

- `security.redactSecrets` — output-layer secret redaction; fills the
  read-scope gap (secrets currently guarded only by model discretion).
- Provider failover (`fallback_model` analog) — providers map currently has no
  429/529/503 failover.

**Skip:** `terminal` (docker/singularity/modal images), `auxiliary` (per-task
provider blocks), tts/stt/voice, discord/whatsapp/telegram/slack, `display.*`
(TUI-owned), `command_allowlist` (covered by shell.sandbox + approvals).

## 8. Phasing

| Phase         | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Size |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| **P0**        | Bug fix: `tools.allowed` already works — add test + docs (demo scenario whitelists out `todo_write`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | XS   |
| **P1**        | **Done.** Selector layer: `tool-selectors.ts` + catalog fold + `tools.use` validation/merge + sub-agent symmetry (runBudget/selector/maxDepth) + `approvals.cronMode` + schema + `capabilities inspect` display + docs + project-map.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | M    |
| **P1b**       | **Done.** YAML loader + json/yaml conflict detection + two-file `init` templates + write-format preservation for existing YAML files.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | S–M  |
| **P2**        | **Done.** Config validation UX (decision ⑧): `sparkwright config validate` combines host loader diagnostics with JSON Schema validation of loaded JSON/YAML files; YAML starters include a `yaml-language-server` schema directive; CLI packages copy `schemas/*.schema.json` into `dist/schemas` for installed validation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | S–M  |
| **P3 (LAST)** | **Done.** P3a introduced `packages/host/src/config-zod-schema.ts` and `scripts/generate-config-schema.ts`, so `schemas/config.schema.json` is generated from the host-owned Zod schema and `npm run schema:check` enforces drift before Ajv validation. P3b moved host-owned exported config section types in `config.ts` onto that Zod source. P3c moved runtime primitive field checks onto Zod source helpers while preserving existing diagnostics and partial-field recovery. P3d moved simple section allowed-key validation (`tools`, `write`, `runBudget`, `approvals`) onto Zod-derived key lists. P3e moved shell and skills nested section allowed-key validation onto Zod-derived key lists. P3f moved capability, hooks, and verification nested section allowed-key validation onto Zod-derived key lists. P3g moved MCP and agents/delegate-tool section key validation plus MCP enum checks onto Zod-derived sources. P3h moved AgentProfile and external delegate metadata key/enum checks onto Zod-derived sources. P3i moved grouped-config schemas, key lists, and group-to-flat normalization map into the Zod schema source. P3j moved provider/model/cost key validation onto Zod-derived sources. P3k moved remaining host-owned enum/literal option checks onto Zod-exported option lists. P3l moved workflow hook action branch key validation onto Zod-derived sources. P3m moved root/shared scalar validation and the remaining host-owned field/option lists onto the Zod source. Runtime root unknown-key tolerance and external schema refs remain explicit compatibility/integration boundaries rather than untracked migration gaps. **Remaining (deferred to a P3 follow-up):** `schemas/agent-profile.schema.json` is still hand-maintained and duplicates the `tools.use` selector enum (and other AgentProfile fields) rather than being generated from the Zod source like `config.schema.json`. Drift is now caught by a guard test (`packages/cli/test/config-schema.test.ts` asserts every schema selector enum equals `TOOL_USE_SELECTORS`), so this is safe to leave until agent-profile is folded into the generated-schema flow. | L    |
| **Backlog**   | `security.redactSecrets`; provider failover.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | —    |

### P1 map-driven change list

Implemented in the first selector pass:

- `config.ts`: `CapabilityToolsConfig` += `use?:string[]`; `validateToolsConfig`
  += `use` (with selector validity check); `mergeToolConfig`/`pruneToolConfig`
  += `use`; `approvals` += `cronMode`.
- New `packages/host/src/tool-selectors.ts`: `resolveSelectorAllowlist` + static
  read/write lists + coverage guard.
- `tool-catalog.ts`: `applyToolConfigToCatalog` folds selectors → allowed.
- `cli.ts`: `capabilities inspect` shows effective selectors + final inventory
  (read-only; no write subcommand).
- `schemas/config.schema.json`: `tools.use` enum + `mcp:*` pattern;
  `approvals.cronMode`.
- `docs/guides/CONFIGURATION.md`: selectors primary, advanced fields secondary.
- project-map: `modules/host.md`, `maps/capabilities/README.md`,
  `maps/runtime/tool-orchestration.md` Contracts/Change Checklist; refresh
  Last Verified.

Implemented in the P1 follow-up:

- `AgentProfile` validation/runtime support for `use` selectors (NOT
  `runBudget` — already exists, config.ts:2468).
- `capabilities.agents.maxDepth`.

Implemented in P1b:

- Config layer discovery tries `config.json`, `config.yaml`, then `config.yml`
  for both user and project layers, and reports same-layer conflicts.
- `readConfigFileObject` / `writeConfigFileObject` / `resolveConfigWriteTarget`
  centralize JSON/YAML parsing and serialization for CLI, TUI, and governed
  capability tools.
- `sparkwright init` and `sparkwright init --project` emit grouped YAML
  starters by default when no same-layer config exists.

Implemented in P2:

- `sparkwright config validate` reports both loader/semantic errors and schema
  errors, with JSON output split into `loadErrors` and `schemaErrors` while
  preserving a combined `errors` list.
- CLI build copies root `schemas/*.schema.json` into `packages/cli/dist/schemas`
  so installed CLIs can schema-check config files without a source checkout.
- YAML starters include a `yaml-language-server` schema directive pointing at
  the config schema `$id`; JSON configs can use `$schema` or editor mappings.

Implemented in P3a:

- New `packages/host/src/config-zod-schema.ts` defines the root config shape in
  Zod and exports schema metadata.
- New `scripts/generate-config-schema.ts` renders
  `schemas/config.schema.json`, preserving external refs to
  `mcp-server-config.schema.json` and `agent-profile.schema.json`.
- `npm run schema:check` now first checks that the generated config schema is
  fresh, then runs the existing Ajv schema/fixture/protocol validation.

Implemented in P3b:

- `config-zod-schema.ts` exports section schemas and inferred config section
  types for provider, write guardrail, approval, tool, hooks, verification,
  skills, MCP enum, and delegate-tool shapes.
- `config.ts` re-exports those inferred types under the existing public names,
  keeping downstream imports stable while reducing schema/type double-entry.
- External canonical runtime types stay attached where needed
  (`ShellSandboxConfig`, `WorkflowHookName`/`WorkflowHookMatcher`,
  `AgentProfile`, MCP server refs); these remain integration edges rather than
  host-owned shape definitions.

Implemented in P3c:

- `config-zod-schema.ts` exports shared primitive schemas for string,
  non-empty string, booleans, numbers, integer arrays, string arrays, positive
  numbers/integers, non-negative integers, and string records.
- `config.ts` loader helper functions now validate those primitive shapes
  through the Zod schemas while preserving the existing `SharedConfigError`
  field names/messages and partial-field recovery behavior.

Implemented in P3d:

- `config-zod-schema.ts` exports key lists derived from Zod object schemas for
  `tools`, `write`, `runBudget`, and `approvals`.
- `config.ts` uses those key lists for unknown-field diagnostics in those
  sections, keeping the same message format while removing another layer of
  hand-written shape duplication.

Implemented in P3e:

- `config-zod-schema.ts` factors shell sandbox filesystem/network schemas and
  skill evolution/inline-shell schemas so their key lists can be exported from
  the same Zod source.
- `config.ts` uses those key lists for unknown-field diagnostics in `shell`,
  `shell.sandbox`, `shell.sandbox.filesystem`, `shell.sandbox.network`,
  `capabilities.skills`, `capabilities.skills.evolution`, and
  `capabilities.skills.inlineShell`.

Implemented in P3f:

- `config-zod-schema.ts` exports key lists derived from Zod object schemas for
  `capabilities`, `capabilities.hooks`, workflow hook entries, workflow hook
  matchers, `capabilities.verification`, verification commands,
  `capabilities.verification.afterWrites`, and
  `capabilities.verification.stopGate`.
- `config.ts` uses those key lists for the existing unknown-field diagnostics
  in those sections, and uses the Zod enum options for workflow hook names and
  verification command kinds without changing the existing error text.

Implemented in P3g:

- `config-zod-schema.ts` exports key lists derived from Zod object schemas for
  `capabilities.mcp`, `capabilities.mcp.defaultPolicy`,
  `capabilities.agents`, and `capabilities.agents.delegateTools`, plus MCP
  startup/schema-load enum option lists.
- `config.ts` uses those key/enum lists for MCP and agents validation. Runtime
  validation now also reports unknown fields inside MCP `defaultPolicy` and
  delegate-tool entries, matching the existing strict JSON Schema contract.

Implemented in P3h:

- `config-zod-schema.ts` exports validator schemas and key/enum lists for
  `AgentProfile`, ACP delegate metadata, external-command delegate metadata,
  delegate env modes, workspace access modes, and external-command input modes.
- `config.ts` uses those lists for existing AgentProfile/metadata
  unknown-field diagnostics and enum checks while preserving the external
  `agent-profile.schema.json` reference and the current partial-recovery
  loader behavior.

Implemented in P3i:

- `config-zod-schema.ts` exports named schemas and key lists for the preferred
  grouped config sections `identity`, `policy`, `run`, and `ui`, plus the
  group-to-flat normalization map.
- `config.ts` uses those exported keys/map in `normalizeGroupedConfig`,
  preserving grouped-value-wins conflict diagnostics and the special
  `policy.sandbox -> shell.sandbox` remap.

Implemented in P3j:

- `config-zod-schema.ts` exports key lists derived from Zod object schemas for
  provider entries, provider model entries, and model-cost blocks.
- `config.ts` uses those key lists for provider/model/cost unknown-field
  diagnostics while preserving current partial recovery and provider option
  validation behavior.

Implemented in P3k:

- `config-zod-schema.ts` exports option lists for trace levels, shell sandbox
  modes, workflow hook literals, verification modes, and shared output/stdin
  hook settings.
- `config.ts` uses those option lists for existing enum/literal diagnostics in
  trace, shell, skills, hooks, verification, MCP startup/schema-load, and agent
  profile validation while preserving current messages and partial recovery.

Implemented in P3l:

- `config-zod-schema.ts` names the strict workflow hook action branches
  (`block`, `context`, `command`) and exports per-branch key lists.
- `config.ts` uses the branch-specific key list after action type validation,
  so runtime loader diagnostics now report unknown fields inside workflow hook
  actions while retaining otherwise valid actions.

Implemented in P3m:

- `config-zod-schema.ts` exports the remaining host-owned root/shared schemas
  and derived key/option lists used by runtime validation: permission modes,
  run-budget integer fields, approval boolean fields, shell sandbox path-list
  fields, MCP default-policy risk, AgentProfile string/tool-list fields,
  delegate-tool string/boolean fields, workspace, and the strict root config
  key list.
- `config.ts` uses those exports for root/shared scalar validation
  (`model`, `workspace`, `confidentialPaths`, `maxSteps`, `permissionMode`)
  and for the remaining field/option loops, preserving existing
  `SharedConfigError` messages and partial recovery.
- Boundary after P3: root unknown-key strictness stays in generated JSON Schema
  / `sparkwright config validate`, while the runtime loader intentionally keeps
  ignoring unknown root keys for UI/future compatibility. External schema refs
  (`capabilities.mcp.servers`, `capabilities.agents.profiles`) remain
  integration edges with hand parsing for path resolution and partial recovery.

### Test plan

- Selector → name expansion unit tests (each selector, `mcp:demo` incl. lazy
  gateway, unknown-selector error, read/write coverage guard).
- Cross-layer intersection merge tests.
- E2E: under `tools.use:[mcp:demo]`, `todo_write` is absent from inventory; and
  **verify** project-context `todo_planning` guidance reads the post-filter live
  inventory (dossier's causal chain — confirm against source, do not assume).
- Closing `npm run release:check`.

## 9. Closed Notes

- **`dont_ask` semantics**: current source denies approval requests without
  prompting; use the CLI/core policy docs and tests as the contract before
  changing starter comments.
- **`todo_planning` guidance causal chain**: `packages/project-context` gates
  the section through a `whenTool` predicate for `todo_write`, so host catalog
  filtering controls whether the guidance is injected.

## Last Verified

- Status: Read-only
- Date: 2026-06-20
- Read: `docs/_internal/project-map/README.md`, `docs/_internal/project-map/modules/host.md`, `docs/_internal/project-map/modules/cli.md`, `packages/core/src/approval-policy.ts`, `packages/core/src/policy.ts`, `packages/project-context/src/index.ts`.
- Corrections: marked as a historical implementation record, removed from
  active README routing, and closed stale implementation questions.
- Tests: not run; cleanup-only map audit.
