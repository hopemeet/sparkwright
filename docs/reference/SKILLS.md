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

Use the CLI for project Skill management:

```bash
sparkwright skills list --workspace .
sparkwright skills validate --workspace .
sparkwright skills create code-reviewer \
  --description "Reviews code changes for risk and missing tests." \
  --workspace .
sparkwright skills doctor --workspace . --format text
```

`skills create` writes one deterministic
`.sparkwright/skills/<name>/SKILL.md` scaffold. It accepts only the project
Skill root, validates the manifest before publishing it, reserves the target
directory atomically, and never overwrites an existing package. It does not
create proposal, registry, history, or automatic-learning state. Update or
remove an existing Skill as an ordinary reviewed workspace change.

`list` and `validate` discover Skills across builtin, user, project, and
configured layers. Reports include each Skill's `layer`, `root`, filesystem
`source`, and package identity. When two layers declare the same name, the
stronger layer wins and `validate` reports the shadowed source.

## Skill Statistics

Inspect recent runtime evidence with:

```bash
sparkwright skills stats --workspace . --last 20 --format text
sparkwright skills stats --workspace . --skill code-reviewer --format text
sparkwright skills stats --workspace . --package-hash sha256:... --format json
```

Stats are keyed by Skill package identity: name, layer, package hash, and hash
policy version. They report indexing and loading counts, explicit versus
resident loads, load failures, associated run status, and associated tool
failures. Association is diagnostic context, not a causal claim about a Skill.

The latest session window remains bounded by `--last`, but completed session
projections are cached under `.sparkwright/skill-stats/sessions/`. A rebuildable
catalog at `.sparkwright/skill-stats/catalog.json` maps Skill names, keys, and
package hashes to those projections. Repeated or overlapping bounded-window
queries reuse unchanged session projections, and targeted queries can skip
unrelated sessions inside the current candidate window. Cache entries are
invalidated by trace fingerprints plus schema and algorithm versions; raw
traces remain the source of truth. Cached sessions outside the current
`--last` window are not included in totals. Old self-evolution directories, if
present from an earlier release, are inert legacy data: Stats does not read,
migrate, or delete them.

`skills doctor` performs deterministic checks such as load errors, shadowing,
configured-root notices, and package hash validity.

The TUI `/skills` panel displays the same current-package inventory and recent
usage projection. `/create skill` creates the same deterministic project
scaffold. The retired `/skill-update`, `/skill-review`, and `/skill-learn`
commands are no longer registered; use ordinary workspace edits for changes.

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

1. Index all discovered Skills by `name`, `description`, version, path, and
   required v2 package identity.
2. Create one `skill_index` context item listing discovered Skills without host
   source paths or package hashes in the model-visible body.
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
    packageHash: "sha256:...",
    packageHashPolicyVersion: 2,
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
entries containing `name`, `sourcePath`, `packageHash`,
`packageHashPolicyVersion`, `version`, and `metadata`. This is intentionally
only a minimal manifest foundation for later
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
