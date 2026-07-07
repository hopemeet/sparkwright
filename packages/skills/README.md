# @sparkwright/skills

Experimental Skill loading helpers for Sparkwright.

This package keeps Skills outside the core run loop. It reads `SKILL.md` files,
selects relevant Skills deterministically, and converts them into normal
Sparkwright inputs:

- `ContextItem[]`
- optional `ToolDefinition[]`
- loaded Skill metadata for run metadata or trace

## API

```ts
import { prepareSkillsForRun } from "@sparkwright/skills";

const prepared = await prepareSkillsForRun({
  goal,
  skillRoots: ["./skills"],
  agent: {
    allowedSkills: ["code-reviewer", "dingtalk-notifier"],
    deniedSkills: ["deprecated-*"],
  },
});
```

Return shape:

```ts
{
  context: ContextItem[];
  tools: ToolDefinition[];
  loadedSkills: LoadedSkill[];
  indexedSkills: SkillIndexEntry[];
}
```

When composing a run, include both prepared context and prepared tools:

```ts
const run = createRun({
  goal,
  model,
  context: prepared.context,
  tools: [...normalTools, ...prepared.tools],
  metadata: {
    loadedSkills: prepared.loadedSkills,
  },
});
```

## Loading Modes

The low-level helper defaults to resident context for backward compatibility:

```ts
await prepareSkillsForRun({
  goal,
  skillRoots: ["./skills"],
});
```

SparkWright host-created runs use progressive on-demand loading by default:
they inject the Skill index, expose a governed `skill_load` tool, and do not
resident-load selected Skill bodies unless config opts in.

Use index + loader mode explicitly when embedding the helper directly:

```ts
await prepareSkillsForRun({
  goal,
  skillRoots: ["./skills"],
  loadSelectedSkills: false,
  includeLoaderTool: true,
});
```

`skill_load` returns the Skill body as a normal tool observation. That is the
host default because it keeps prompt context small and lets the model load a
Skill only when the task falls within its scope. It is not identical to resident
context: the observation formatter may summarize or truncate long output. Use
resident loading only when a selected Skill must be stable, high-priority
context for every run.

## Frontmatter

Supported fields:

```yaml
---
name: code-reviewer
description: Reviews code changes when users ask for review, risk analysis, or test coverage.
license: Apache-2.0
compatibility: generic
allowed-tools: read shell
metadata:
  version: 1.0.0
---
```

`name` must use lowercase letters, numbers, and hyphens, max 64 characters.
`description` is required and must be at most 1024 characters.

## Boundaries

Skills are context and capability hints, not authority.

This package does not execute Skill-authored scripts directly. Any side effect should
be represented as a Sparkwright `ToolDefinition` so policy, approval,
validation, and trace remain in control.

## Discovery + Matching Protocol (experimental, v0.1)

A lighter-weight surface is also available for hosts that want to _describe_
skills to the model and let the loop request bodies on demand, rather than
materializing them into the run context up front.

```ts
import {
  loadSkillsFromDirectory,
  matchSkills,
  SkillRegistry,
  skillsToCapabilities,
} from "@sparkwright/skills";

const { skills, loadErrors } = await loadSkillsFromDirectory("./skills");
if (loadErrors.length) console.warn("skill load errors", loadErrors);

const registry = new SkillRegistry(skills);
const top = registry.match("review the diff for risk", { limit: 3 });

// Optionally publish to the core capability inventory:
const capabilities = skillsToCapabilities(registry.list());
```

`SkillManifest` accepts three on-disk shapes:

- a sub-directory containing a `SKILL.md` file with YAML frontmatter,
- a flat `*.skill.md` file with the same frontmatter, or
- a `*.skill.json` file with the same fields as JSON.

Example manifest set (three skills):

```yaml
# .sparkwright/skills/reviewer/SKILL.md
---
name: code-reviewer
description: Reviews source code changes for risk and test coverage.
triggers: review, diff, risk
version: 1.0.0
---
Read the diff. Call out risky changes. Summarize test coverage.
```

```yaml
# .sparkwright/skills/notify.skill.md
---
name: dingtalk-notifier
description: Sends DingTalk group notifications when an alert is requested.
triggers: notify, dingtalk, alert
allowed-tools: http.post
---
Send a single concise notification. Never spam the channel.
```

```json
// .sparkwright/skills/test-writer.skill.json
{
  "name": "test-writer",
  "description": "Writes unit tests for new or untested code.",
  "instructions": "Generate vitest tests for the changed functions.",
  "triggers": ["tests", "coverage"]
}
```

The matcher is deterministic keyword scoring (no embeddings). Hosts that want
semantic recall can pass a custom `tokenize` function via `matchSkills(query,
skills, { tokenize })`.
