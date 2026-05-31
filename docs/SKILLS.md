# Skills

Sparkwright supports a minimal Skill compatibility layer through the
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
through governed helper paths, but bundled scripts should not execute merely
because a Skill was discovered.

## Frontmatter

The first implementation supports a small YAML frontmatter subset:

```yaml
---
name: dingtalk-notifier
description: Send DingTalk webhook notifications when users mention dingtalk, webhook, group messages, or notifications.
allowed-tools: shell http
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

## Preparing Skills For A Run

Use `prepareSkillsForRun` from `@sparkwright/skills` before calling `createRun`:

```ts
import { createRun } from "@sparkwright/core";
import { prepareSkillsForRun } from "@sparkwright/skills";

const prepared = await prepareSkillsForRun({
  goal: "Send a dingtalk webhook notification",
  skillRoots: ["./skills"],
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

The helper uses progressive loading:

1. Index all discovered Skills by `name`, `description`, version, path, and content hash.
2. Create one `skill_index` context item listing discovered Skills.
3. Select matching Skills with a deterministic goal matcher.
4. Load selected Skill bodies into additional context items.
5. Optionally expose a governed `skill.load` tool for on-demand body loading.
6. Return metadata for selected Skills so callers can store it on the run.

This keeps Skill behavior outside the core run loop while still making loaded Skills visible to context assembly and trace metadata.

## Trace And Reproducibility

`prepareSkillsForRun` returns `loadedSkills` metadata:

```ts
[
  {
    name: "dingtalk-notifier",
    version: "1.0.0",
    sourcePath: "./skills/dingtalk-notifier/SKILL.md",
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

const skills = await loadSkills(["./skills"]);
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

A Skill can influence model behavior, but it cannot grant permission by itself. Any side effect still goes through normal Sparkwright policy, approval, validation, tool execution, trace, and artifact handling.
