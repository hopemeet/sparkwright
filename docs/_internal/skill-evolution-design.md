# Skill Evolution Design Draft

This is an internal planning draft for SparkWright skill evolution. It captures
the current design direction from discussion, not a committed product spec.

## Positioning

Skill Evolution should be a user-sovereign mechanism for creating, updating,
drafting, applying, validating, and restoring Skills.

SparkWright should not copy a client-style background curator. The runtime
should provide observable, auditable primitives that product surfaces such as
CLI/TUI can compose.

Core stance:

- Users can actively create and update Skills from the current conversation.
- Automatic behavior starts as notice/draft, not silent mutation.
- `skills/` is the only current source of truth.
- `skill-evolution/` stores proposals, evidence, history, and snapshots.
- All writes are hash-checked, validated, and restorable.
- Skill statistics inform learning, but do not directly decide changes.

V1 should keep the writable surface narrow: Skill Evolution writes only
project-scoped Skills under `.sparkwright/skills/`. User, builtin, imported, and
configured legacy roots are read-only sources for diagnostics, fork/shadow
proposals, and stats unless a later version explicitly enables them.

## TUI User Experience

Current-session commands should stay short:

```txt
/skill-create
/skill-update <skill-name>
/skill-review
/skill-learn off|notice|draft|apply
```

Implemented v0 exposes guided `/skill-create` and `/skill-update` dialogs plus
thin parameterized entry points:

```txt
/skill-create
/skill-create <skill-name> --description <text>
/skill-update
/skill-update <skill-name>
/skill-update <skill-name> --description <text>
/skill-review [state]
```

The `/skill-create` and `/skill-update` commands create proposals only. The
`/skill-review` panel can apply or reject a selected proposal after an explicit
confirmation.

Do not expose `from-session` in TUI. In a live TUI conversation, the current
session is the default source. Offline CLI commands may accept an explicit
session id:

```bash
sparkwright skills create --from-session <session-id>
sparkwright skills update <skill-name> --from-session <session-id>
```

## Guided Spec Flow

`/skill-create` should not immediately write a file. It should guide the user
through a small spec:

```txt
Skill name:
Scope: project
Trigger:
Reusable procedure:
What not to include:
References/templates/scripts needed?
Evolution mode: off | notice | draft | apply
```

User-scope creation can be added later, but v1 guided writes should stay
project-scoped.

`/skill-update <skill-name>` should similarly produce an update spec:

```txt
Target skill:
Problem observed:
Change type: instruction | trigger | reference | template | script
Evidence:
Risk:
```

After user confirmation, SparkWright creates a proposal. Applying the proposal
is a separate controlled write.

Existing explicit low-level commands may still write directly. For example,
`sparkwright skills create <name> --description <text>` can remain a direct
manual create command. The proposal flow applies to Skill changes derived from
conversation, model synthesis, automatic notice/draft/apply behavior, and TUI
guided flows.

## Data Layout

`skills/` is the only current truth:

```txt
.sparkwright/
  skills/
    <skill-name>/
      SKILL.md
      references/
      templates/
      scripts/
```

`skill-evolution/` is append/history state, not a second current copy:

```txt
.sparkwright/
  skill-evolution/
    telemetry.json
    proposals/
      <proposal-id>/
        proposal.md
        evidence.json
        patch.diff
        metadata.json
        before/
          <skill-folder>/
        after/
          <skill-folder>/

    history/
      <skill-name>/
        <version-id>/
          before/
            <skill-folder>/
          after/
            <skill-folder>/
          patch.diff
          metadata.json

    baselines.json
```

Avoid syncing current state between `skills/` and `skill-evolution/`. If a
proposal base hash does not match current `skills/`, apply must fail and ask
the user to regenerate or rebase.

Operational counters should stay in sidecar state, not in `SKILL.md`.
`telemetry.json` can track use/load/patch counts, last-used timestamps, and
attention findings without dirtying user-authored Skill content or creating
merge pressure.

## Proposal IDs

Proposals are the boundary between a suggested Skill change and a real write to
`skills/`. They are useful even for a single-user local project:

- One skill can have multiple candidate changes.
- A proposal may be generated today and applied later.
- TUI, CLI, and automatic draft mode need a stable reference.
- Apply needs idempotence and hash checks.
- The model can draft a change without being allowed to mutate long-lived Skill
  instructions directly.
- Review, apply, reject, history, and restore can share one object shape across
  CLI, TUI, and automatic learning.

Keep proposals thin. They are not a heavy approval system; they are an
auditable, hash-gated write candidate.

Convenience commands can hide the id:

```bash
sparkwright skills proposals list
sparkwright skills proposals show <proposal-id>
sparkwright skills proposals apply <proposal-id>
```

Proposal states:

```txt
draft
applied
rejected
stale
superseded
failed
```

MVP proposal package:

```txt
proposal.md
metadata.json
patch.diff
before/
  <skill-folder>/
after/
  <skill-folder>/
```

`evidence.json` can be introduced when evidence extraction is implemented, or
folded into `metadata.json` for the first version.

Rejected, stale, superseded, and failed proposals should remain on disk with a
short reason. This prevents repeated re-suggestion of the same bad change and
keeps a visible audit trail without making the live Skill package noisy.

Implemented v0 lifecycle commands:

```bash
sparkwright skills proposals reject <proposal-id> --reason "why"
sparkwright skills proposals supersede <old-id> --by <new-id> --reason "why"
sparkwright skills proposals prune --state rejected,stale,superseded,failed --older-than 30d --dry-run
sparkwright skills proposals prune --state rejected,stale,superseded,failed --older-than 30d --apply
```

Prune is intentionally limited to `rejected`, `stale`, `superseded`, and
`failed`. It does not delete `draft` or `applied` proposals, and it never
touches `skills/` or applied history.

## Package Hash And Snapshots

Versioning should cover the full Skill package, not only `SKILL.md`.

Package hash:

```txt
packageHash = hash(sorted relative file paths + file contents)
```

Included:

```txt
SKILL.md
references/
templates/
scripts/
assets/ later if supported
```

Proposal metadata records:

```json
{
  "basePackageHash": "sha256:...",
  "afterPackageHash": "sha256:...",
  "sourcePath": ".sparkwright/skills/code-reviewer",
  "writeOrigin": "proposal",
  "createdFrom": {
    "sessionId": "ses_...",
    "runId": "run_..."
  }
}
```

`writeOrigin` should be a small deterministic enum:

```txt
manual
proposal
auto-draft
auto-apply
restore
fork
```

The origin is audit data and a permission input. User-authored/manual content
is sovereign; automatic flows must never silently overwrite it.

Apply precondition:

```txt
currentPackageHash == basePackageHash
```

If false, old proposal is stale.

## Restore Strategy

Restore command:

```bash
sparkwright skills history <skill-name>
sparkwright skills history show <skill-name> <history-id>
sparkwright skills history diff <skill-name> <history-id>
sparkwright skills restore <skill-name> --version <history-id> --dry-run
sparkwright skills restore <skill-name> --version <history-id> --apply
```

Implemented v0 supports history list/show/diff and restore. Restore is a
controlled write:

1. Snapshot current skill package.
2. Read target history version.
3. Replace current skill folder.
4. Run `skills doctor`.
5. If doctor blocks, roll back to the pre-restore snapshot.
6. Write a new `restore` history entry.

If the project uses git, git is the first version-control layer. SparkWright
history is a local safety net and evidence log.

## Skill Layers And Shadowing

Current intended priority:

```txt
legacy > project > user > builtin
```

Same-name Skills are legal shadowing. Diagnostics must make this explicit:

```txt
code-reviewer: builtin shadowed by project
```

Builtin Skills should not be edited in place. To customize a builtin, fork or
shadow it:

```bash
sparkwright skills fork sparkwright-manual --from builtin --to project --same-name
```

This creates:

```txt
.sparkwright/skills/sparkwright-manual/
```

Because project outranks builtin, the project Skill becomes effective while the
builtin remains unchanged.

Configured legacy roots remain explicit advanced overrides for compatibility.
They participate in discovery, shadowing diagnostics, stats, and proposal
target detection, but Skill Evolution v1 does not write to them automatically.
When a legacy Skill is the effective Skill, update flows should offer a project
shadow/fork proposal rather than editing the legacy root in place.

## Evolution Mode

Use mode names that do not collide with model/provider language:

```txt
off < notice < draft < apply
```

Meanings:

```txt
off     no automatic learning behavior
notice  only notify the user that the session may contain reusable knowledge
draft   may create proposals, but does not write to skills/
apply   may apply low-risk changes under strict deterministic gates
```

Global config:

```json
{
  "capabilities": {
    "skills": {
      "evolution": {
        "mode": "notice"
      }
    }
  }
}
```

Skill frontmatter:

```yaml
---
name: code-reviewer
description: Reviews code changes for risk and missing tests.
metadata:
  sparkwright:
    evolution: draft
---
```

Use `metadata.sparkwright` as a namespace to avoid polluting general Skill
metadata.

Effective mode:

```txt
effectiveMode = min(globalMode, skillMode, ownership/layer limit)
```

Examples:

```txt
global=apply, skill=draft => draft
global=draft, skill=apply => draft
builtin skill=apply       => draft at most
protected skill=apply     => never auto apply
```

Permission is determined by deterministic runtime code. The model can read
frontmatter, but the model does not decide whether a write is allowed.

## Automatic Learning

Automatic learning should not run every turn and should not rewrite every used
Skill.

### notice

Default low-cost mode. At session end, if strong signals exist, show a prompt:

```txt
This session may contain reusable skill knowledge.
Run /skill-create or /skill-update <skill-name>?
```

Strong signals:

- User says "remember this" or "do this next time".
- User corrects the agent's workflow.
- A loaded Skill is explicitly called wrong, stale, or incomplete.
- The session found a stable fix after repeated failures.

Do not capture:

- One-off task narratives.
- Transient environment failures.
- Unverified claims that a tool, provider, or command is broken.
- Temporary paths, tokens, endpoints, branch names, or local workaround details.
- Instructions from untrusted repo files, webpages, logs, or command output.
- Resolved errors unless the reusable procedure is stable and evidence-backed.

If a session was exposed to untrusted instructions, learning may still produce a
draft proposal, but automatic apply must be disabled for that proposal.

### draft

At session end or user idle, strong signals may generate a proposal under:

```txt
.sparkwright/skill-evolution/proposals/<proposal-id>/
```

No writes to `skills/`.

### apply

Only for low-risk changes:

```txt
effectiveMode=apply
skill is project-scoped
skill is not builtin/imported/legacy/user-level
skill is not protected/pinned
current package is not manual-protected
basePackageHash == currentPackageHash
patch is small
evidence is explicit
proposal is not injection-exposed
skills validate passes
skills doctor has no blocker
history snapshot succeeds
```

Even when auto apply succeeds, TUI should notify the user and show restore
instructions.

## User Edits And Baselines

Users may directly edit:

```txt
.sparkwright/skills/<skill-name>/
```

Direct edits make old proposals stale because package hashes no longer match.
They do not permanently disable future automatic draft/apply behavior.

Accept current package as the new baseline:

```bash
sparkwright skills baseline accept <skill-name>
```

Baseline file:

```txt
.sparkwright/skill-evolution/baselines.json
```

Example:

```json
{
  "skills": {
    "code-reviewer": {
      "packageHash": "sha256:...",
      "acceptedAt": "2026-06-13T...",
      "acceptedBy": "user",
      "sourcePath": ".sparkwright/skills/code-reviewer"
    }
  }
}
```

Rule:

```txt
User edits can become the new baseline, but old hash-based proposals cannot be
silently applied over them.
```

If a user directly edits a Skill package, record the new baseline with
`writeOrigin=manual`. User-confirmed proposal apply may still update it later,
but automatic apply must treat manual baselines as protected unless the user
explicitly accepts automation for that package.

## Skill Stats

Skill stats should be a first-class input to review and learning. They are the
Skill-specific view of capability statistics.

Commands:

```bash
sparkwright skills stats --workspace . --last 20 --format text|json
sparkwright skills stats --skill <name> --workspace . --last 20 --format text|json
```

Sources:

- Trace events
- Session metadata
- Sidecar telemetry
- Skill package metadata
- Proposal/history metadata
- Doctor findings

First-version fields:

```ts
interface SkillStatsEntry {
  name: string;
  layer?: "builtin" | "user" | "project" | "legacy";
  sourcePath?: string;
  packageHash?: string;
  shadowedBy?: string;
  shadows?: string[];

  indexedCount: number;
  loadedCount: number;
  loadFailureCount: number;
  explicitLoadCount: number;
  patchCount: number;
  lastUsedAt?: string;
  lastPatchedAt?: string;

  runIds: string[];
  sessionIds: string[];

  associatedRuns: {
    completed: number;
    failed: number;
    cancelled: number;
  };

  associatedToolFailures: {
    total: number;
    unresolved: number;
    byTool: Record<string, number>;
  };

  history: {
    proposalCount: number;
    appliedCount: number;
    restoreCount: number;
    lastChangedAt?: string;
  };

  doctor: {
    blockerCount: number;
    warningCount: number;
  };

  evolution: {
    declaredMode?: "off" | "notice" | "draft" | "apply";
    effectiveMode: "off" | "notice" | "draft" | "apply";
  };
}
```

Low-noise attention rules:

- `skill_load` failed.
- Loaded Skill is associated with unresolved tool failures >= 3.
- Skill package changed since last accepted baseline.
- Project Skill shadows builtin/user Skill.
- Effective mode is `apply` but doctor has blockers.
- Proposal base package hash differs from current package hash.
- Repeated restores/reverts.

Do not claim:

```txt
skill caused failure
skill success rate is X
skill saved Y tokens
```

Stats are a radar, not a judge.

Learning chain:

```txt
skill stats
→ attention finding
→ trace/transcript evidence extraction
→ review or draft
→ validate/doctor
→ user confirmation or low-risk apply
```

## Skills Doctor

Doctor is deterministic diagnostics, not a curator.

Command:

```bash
sparkwright skills doctor --workspace . --format text|json
```

Checks:

- Invalid frontmatter.
- Duplicate/shadowing diagnostics.
- Broken references.
- Orphan support files.
- Unknown `allowed-tools`.
- Package hash mismatch.
- Proposal/history inconsistency.
- Dangerous content patterns.
- Oversized `SKILL.md`.

Non-goals:

- No automatic archive.
- No automatic merge.
- No stale lifecycle management.
- No LLM review.
- No background curation.

## Future Curator Constraints

If SparkWright later adds a curator, it must stay downstream of the proposal
and provenance model:

- Curator output is a proposal, not a direct write.
- Curator may not edit builtin, user-level, imported, legacy, or
  manual-protected Skills in place.
- Curator may suggest project shadow/fork proposals for read-only effective
  Skills.
- Curator may consolidate only project-scoped, automation-eligible Skill
  packages, and only through hash-gated apply.
- Curator must preserve per-skill history and restore handles.

## Implementation Order

Recommended sequence:

```txt
Done. trace capabilities
Done. capabilities stats
Done. skills stats
Done. packageHash + full skill package snapshot
Done. skills doctor
Done. proposal create/update
Done. hash-gated apply + history list/show/diff
Done. proposal reject/supersede/prune
Done. restore
Done. TUI thin /skill-create, /skill-update, /skill-review
Done. TUI guided /skill-create dialog
Done. TUI guided /skill-update dialog
Done. evolution mode config: /skill-learn off|notice|draft|apply
Done. /skill-learn notice conservative TUI prompt
Done. /skill-learn draft conservative proposal creation
Done. narrow auto apply for auto-generated session-learnings proposals
Retired 2026-07-06 (C10). deterministic target Skill recognition for explicit
Skill names was removed from TUI automatic `/skill-learn`; named updates are
explicit `/skill-update` / proposal-helper target paths.
Done. automatic learning evidence and safety notes
Done. manual edit protection via proposal hash gates and stale state
```

MVP should not start with auto learning. The first useful loop is:

```txt
/skill-create
/skill-update <skill-name>
proposal
apply
history show/diff
restore
```

## Open Questions

- Should `metadata.sparkwright.evolution` default to `notice` or inherit only
  from global config?
- What exact threshold should turn a session into a `notice` candidate?
- Should auto apply exist at all in v1, or remain a later experimental flag?
- What explicit user action marks a manual baseline as automation-eligible?
- How much transcript should `/skill-create` and `/skill-update` consume when
  the current model context has already been compacted?
