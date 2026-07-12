# Skills

SparkWright supports a minimal Skill compatibility layer through the
`@sparkwright/skills` extension package.

The first implementation intentionally avoids changing the run API. Skills are prepared before a run and converted into existing core inputs:

- `ContextItem[]`
- loaded skill metadata
- optional `ToolDefinition[]` for governed on-demand loading

## Supported Shape

A Skill is a directory with a required `SKILL.md` file:

```txt
my-skill/
  SKILL.md
  scripts/
  references/
  assets/
```

`SKILL.md` is the only required file. Bundled resources may be listed or loaded
through governed helper paths, but Skill-authored scripts should not execute merely
because a Skill was discovered.

## Inline Shell Preprocessing

Skill bodies may contain inline shell snippets of the form `` !`cmd` ``, but
they are inert by default. Host-created runs expand them only when config
explicitly enables:

```json
{
  "capabilities": {
    "skills": {
      "inlineShell": {
        "enabled": true,
        "timeoutMs": 10000,
        "maxOutputChars": 4000
      }
    }
  }
}
```

When enabled, the host expands inline shell while loading `SKILL.md`. Commands
run with the Skill directory as `cwd`, through a host-owned shell sandbox, and
are traced as `extension.process.*` with `kind: "skill_script"`. Skill scripts
are fail-closed and no-write: the host forces sandbox enforcement, disables
workspace writes, and refuses to fall back to unsandboxed execution if the OS
sandbox is unavailable. Successful output replaces the inline snippet after
trimming one trailing newline and is capped by `maxOutputChars`; failures
replace the snippet with a short marker such as
`[inline-shell error: PROCESS_FAILED exitCode=1]`, while detailed stderr stays
in trace output summaries.

`sparkwright capabilities inspect --workspace . --format text` reports the
effective inline-shell policy (`enabled`, `writePolicy`, `sandbox`,
`failClosed`, timeout, and output cap). On-demand `skill_load` treats missing
or denied resources as tool failures and emits `skill.failed`, so CLI/trace
summaries show degraded or missing Skill context instead of silently continuing.

The `@sparkwright/skills` package does not own process execution. It exposes a
`preprocess` hook on `loadSkill`, `loadSkills`, and `prepareSkillsForRun`; hosts
that need tracing or sandboxing inject an `inlineShellRunner`. Without that
option, Skill loading preserves the source body unchanged.

## Frontmatter

The first implementation supports a small YAML frontmatter subset:

```yaml
---
name: dingtalk-notifier
description: Send DingTalk webhook notifications when users mention dingtalk, webhook, group messages, or notifications.
allowed-tools: bash http
metadata:
  version: 1.0.0
---
```

Required fields:

- `name`: lowercase letters, numbers, and hyphens, max 64 characters
- `description`: non-empty text, max 1024 characters

Optional fields:

- `license`
- `compatibility`
- `allowed-tools`
- `metadata.version`

The parser is deliberately small and dependency-free. Complex YAML features are not part of the supported surface yet.

## CLI Management

Use the CLI for basic workspace Skill management:

```bash
sparkwright skills list --workspace .
sparkwright skills validate --workspace .
sparkwright skills create code-reviewer \
  --description "Reviews code changes for risk and missing tests." \
  --workspace .
```

`list` and `validate` discover Skills across the builtin, user, and project
layers. If `capabilities.skills.roots` is configured, those roots are loaded as
legacy workspace roots after builtin/user roots. `create` prepares a managed
project-layer proposal and prints its review/apply command; it does not write the
current Skill package or accept `--force`. Apply the proposal only after
reviewing its final patch. CLI, TUI, and model creation adapters share the host
`SkillCommandService`, so they no longer have different mutation semantics.

Reports include each Skill's `layer`, `root`, and filesystem `source`. When two
layers declare the same Skill name, the stronger layer wins and `validate`
returns a `shadows` entry showing which source was replaced.

## Skill Evolution Workflow

Skill Evolution is the proposal-based path for changing project Skills without
letting generated changes silently mutate the current Skill package.

The writable surface is intentionally narrow: proposal apply writes only to the
project Skill root under `.sparkwright/skills/`. Builtin, user, and configured
legacy roots are read-only sources for diagnostics, statistics, and project
fork/shadow proposals.

Start by inspecting the current Skill surface:

```bash
sparkwright skills stats --workspace . --last 20 --format text
sparkwright skills stats --workspace . --skill code-reviewer --package-hash sha256:... --format text
sparkwright skills doctor --workspace . --format text
```

`stats` reads recent session traces, including agent traces under
`agents/<agent-id>/trace.jsonl`, and reports Skill indexing/loading, failures,
associated run status, associated tool failures, and package-hash-aligned
proposal/history rollups. The report includes the trace/evolution window,
freshness timestamps, analyzer findings, and a rebuildable session projection
cache summary. Session projections are stored under
`.sparkwright/skill-stats/sessions/` and are invalidated by trace file
fingerprints plus the projection algorithm version. A lightweight
`.sparkwright/skill-stats/catalog.json` maps Skill names, keys, and package
hashes to session projections so targeted `--skill`, `--skill-key`, and
`--package-hash` queries can skip unrelated sessions after the catalog is warm.
Raw trace and evolution files remain the source of truth. Tool failures are
reported as associated with loaded Skills, not caused by them. `doctor`
performs deterministic checks such as load errors, shadowing, legacy-root
warnings, and package hash validity.

Create a new project Skill through a draft proposal:

```bash
sparkwright skills proposals create code-reviewer \
  --description "Reviews code changes for risk and missing tests." \
  --workspace . \
  --format text
```

Update an existing effective Skill through a hash-gated proposal:

```bash
sparkwright skills proposals update code-reviewer \
  --description "Prefer concise findings with concrete verification steps." \
  --workspace . \
  --format text
```

If the effective Skill comes from builtin, user, or legacy layers, update
creates a project-layer fork/shadow proposal instead of editing that source in
place. If the effective Skill is already project-scoped, apply replaces that
project Skill only after the proposal's `basePackageHash` still matches the
current package.

Review and apply proposals:

```bash
sparkwright skills proposals list --workspace . --format text
sparkwright skills proposals show <proposal-id> --workspace . --format text
sparkwright skills proposals apply <proposal-id> --workspace . --format text
```

The TUI exposes slash-command entry points for the same proposal flow:

```txt
/skill-create
/skill-create code-reviewer --description Reviews code changes for risk and missing tests.
/skill-update
/skill-update code-reviewer
/skill-update code-reviewer --description Prefer concise findings with concrete verification steps.
/skill-review
/skill-review draft
/skill-learn
/skill-learn notice
```

`/create skill` is the canonical general capability-creation entrypoint.
`/skill-create` remains a compatibility/advanced shortcut; both call the same
managed proposal service and neither directly writes the current Skill.

`/skill-create` without arguments opens a guided prompt for a project Skill
proposal. `/skill-update` without arguments opens a guided prompt for an
effective Skill update proposal; with only a Skill name, it opens directly at
the description step. `/skill-review` opens a proposal review panel with
proposal, patch, and metadata views; it can apply or reject the selected
proposal after an Enter confirmation. `/skill-create` and `/skill-update`
create proposals but do not apply them.

`/skill-learn` shows the effective Skill Evolution mode. `/skill-learn
off|notice|draft|apply` writes the project config field
`capabilities.skills.evolution.mode`. `notice` is the default when unset.
Automatic draft and apply behavior are gated separately and are not implied by
setting the mode alone.

In `notice` mode, the TUI may show a conservative notice after a successful run
when the user's own prompt contains explicit reuse signals such as "remember
this", "next time", or equivalent workflow corrections. The notice only
suggests `/skill-create` or `/skill-update`; it does not create proposals
automatically.

In `draft` mode, the same conservative signal creates a draft proposal for the
project Skill `session-learnings`. The TUI does not infer a target Skill name
from the prompt; use `/skill-update <skill-name>` or the CLI proposal commands
for named Skill updates. This still does not write current Skills or apply the
proposal automatically; review it with `sparkwright skills proposals show
<proposal-id>` and apply it through the CLI when appropriate.
Automatic learning proposals include deterministic evidence and safety notes;
they do not use tool output, logs, webpages, or command output as learning
evidence.

In `apply` mode, only an auto-generated `session-learnings` proposal may be
auto-applied. Auto-apply still goes through the proposal apply path with package
hash checks, doctor checks, history capture, and rollback on failure. If any gate
fails, the draft proposal is left for manual review. Manual edits are protected
by the same hash gates: if a target Skill appears or changes after proposal
creation, apply marks
the proposal stale instead of overwriting the current Skill.

A proposal contains:

- `metadata.json` with state, target, source, and package hashes
- `proposal.md` with review text
- `patch.diff`
- `before/` and `after/` package snapshots when applicable

Proposal states are:

```txt
draft
applied
rejected
stale
superseded
failed
```

Manage proposal lifecycle without changing current Skills:

```bash
sparkwright skills proposals reject <proposal-id> \
  --reason "Too broad for this project." \
  --workspace .

sparkwright skills proposals supersede <old-id> \
  --by <new-id> \
  --reason "Replaced by a narrower update." \
  --workspace .
```

Clean up closed proposals with an explicit dry run or apply:

```bash
sparkwright skills proposals prune \
  --state rejected,stale,superseded,failed \
  --older-than 30d \
  --dry-run \
  --workspace . \
  --format text

sparkwright skills proposals prune \
  --state rejected,stale,superseded,failed \
  --older-than 30d \
  --apply \
  --workspace .
```

Prune never deletes `draft` or `applied` proposals, never touches
`.sparkwright/skills/`, and never deletes applied history.

Inspect applied history:

```bash
sparkwright skills history code-reviewer --workspace . --format text
sparkwright skills history show code-reviewer <history-id> --workspace .
sparkwright skills history diff code-reviewer <history-id> --workspace .
```

History entries live under `.sparkwright/skill-evolution/history/` and include
the applied `before/` and `after/` snapshots plus `patch.diff`.

Restore a project Skill from an applied history entry:

```bash
sparkwright skills restore code-reviewer \
  --version <history-id> \
  --dry-run \
  --workspace . \
  --format text

sparkwright skills restore code-reviewer \
  --version <history-id> \
  --apply \
  --workspace .
```

Restore defaults to dry-run. With `--apply`, it replaces only the project Skill
under `.sparkwright/skills/`, runs doctor checks, rolls back if doctor blocks
the restored package, and writes a new `restore` history entry.

Recommended loop:

```txt
stats / doctor
-> proposals create or update
-> proposals show
-> proposals apply
-> history show or diff
-> restore when needed
-> reject, supersede, or prune old proposals
```

## Preparing Skills For A Run

Use `prepareSkillsForRun` from `@sparkwright/skills` before calling `createRun`:

```ts
import { createRun } from "@sparkwright/core";
import { prepareSkillsForRun } from "@sparkwright/skills";

const prepared = await prepareSkillsForRun({
  goal: "Send a dingtalk webhook notification",
  skillRoots: [".sparkwright/skills"],
});

const run = createRun({
  goal,
  model,
  tools: [...normalTools, ...prepared.tools],
  context: prepared.context,
  metadata: {
    loadedSkills: prepared.loadedSkills,
  },
});
```

`skillRoots` can point to:

- a `SKILL.md` file
- a single Skill directory containing `SKILL.md`
- a parent directory containing multiple Skill directories

## Loading Strategy

SparkWright host-created runs use progressive on-demand loading by default:
the run gets a Skill index plus the governed `skill_load` tool, and selected
Skill bodies are not resident-loaded unless config sets
`capabilities.skills.loadSelectedSkills: true`.

The low-level `prepareSkillsForRun` helper still supports both modes. Its
pipeline is:

1. Index all discovered Skills by `name`, `description`, version, path, and content hash.
2. Create one `skill_index` context item listing discovered Skills without host
   source paths or content hashes in the model-visible body.
3. Optionally select matching Skills with a deterministic goal matcher and load
   them into resident context when `loadSelectedSkills` is true.
4. Optionally expose a governed `skill_load` tool for on-demand body/resource
   loading.
5. Return metadata for resident-loaded Skills so callers can store it on the run.

This keeps Skill behavior outside the core run loop while still making loaded
Skills visible to context assembly and trace metadata. Loaded Skill context keeps
absolute source paths in metadata for diagnostics, not in the model-visible
source projection.

## Trace And Reproducibility

`prepareSkillsForRun` returns `loadedSkills` metadata:

```ts
[
  {
    name: "dingtalk-notifier",
    version: "1.0.0",
    sourcePath: ".sparkwright/skills/dingtalk-notifier/SKILL.md",
    contentHash: "...",
    selectionReason: "Matched goal against skill name or description.",
  },
];
```

Callers should store this metadata on the run or emit experimental
`skill.indexed` / `skill.loaded` edge lifecycle events.

For a serializable manifest index, use `createSkillLockfile` or its alias
`lockSkills` with either `SkillDefinition[]` or `SkillIndexEntry[]`:

```ts
import { createSkillLockfile, loadSkills } from "@sparkwright/skills";

const skills = await loadSkills([".sparkwright/skills"]);
const lockfile = createSkillLockfile(skills);
```

The lockfile records `schemaVersion`, optional `generatedAt`, and sorted Skill
entries containing `name`, `sourcePath`, `contentHash`, `version`, and
`metadata`. This is intentionally only a minimal manifest foundation for later
marketplace and hot reload work; it does not install, update, or execute Skills.

## Non-Goals In The First Slice

- no marketplace
- no auto-update
- no persisted marketplace lock
- no hot reload
- no direct script execution
- no automatic MCP binding
- no self-modifying Skills
- no Skill-specific run API

Skill scripts and references should be introduced through governed extension paths later. A script should become a `ToolDefinition` before it can execute.

## Relationship To Core

Skills are context and capability hints, not authority.

A Skill can influence model behavior, but it cannot grant permission by itself. Any side effect still goes through normal SparkWright policy, approval, validation, tool execution, trace, and artifact handling.
