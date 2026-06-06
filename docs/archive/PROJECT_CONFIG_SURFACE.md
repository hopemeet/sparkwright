# Project Config Surface

This is an archived implementation plan, not the current user guide. For the
current behavior, read [Configuration](../guides/CONFIGURATION.md).

Status: implemented (P0–P3). See "Implementation notes" at the end for what
shipped and where it diverged from this plan.
Owner-facing goal: make project-following configuration — commands, agent
profiles, and the config file itself — **travel with the repository** the way
project instruction files already do.

This document preserves the motivation, four pinned design decisions, a phased
plan (P0–P3), and the grounded integration points from the original work.

## Why

Today SparkWright already lets several things follow a project:

- **Project instructions** — hierarchical discovery of `SPARKWRIGHT.md` /
  `AGENTS.md` / `CLAUDE.md`, walking up to the git root, with directory-scoped
  injection. See [project-context](../../packages/project-context/src/index.ts).
- **Skills** — `capabilities.skills.roots` points at a committed `skills/`
  directory of `SKILL.md` packages.

But two things that should follow a project currently do **not**:

1. **The project config file is gitignored.** `.sparkwright/` is ignored
   wholesale (see `.gitignore`), and `.sparkwright/config.json` sits in the
   same ignored directory as runtime state (`sessions/`, `runs/`,
   `tui-history.jsonl`). So a project's `model` / `permissionMode` /
   `capabilities` / `mcp` are local-only by default — they are never committed,
   reviewed in a PR, or cloned by a teammate.
2. **Commands and agent profiles are not file-authorable.** Slash commands are
   registered imperatively in front-end code, and agent profiles only exist as
   JSON array entries inside `config.json`. There is no "drop a markdown file in
   a known directory and it is live" path.

The reference point for what good ergonomics look like here is opencode's
`.opencode/` tree (committed; `command/*.md`, `agent/*.md`, `skills/`,
`opencode.jsonc` all reviewed in PRs). We borrow its **"a file is a
declaration"** entry-point ergonomics. We do **not** borrow its drop-in
`tool/*.ts` execution model: every capability in SparkWright must still
converge on the run boundary and pass the existing policy/approval gate. The
new surfaces declare intent via files; they never introduce a new execution
path.

## Pinned Decisions

These four were decided and are not re-open:

1. **Explicit config wins over convention files.** When a file-authored command
   or profile collides by name/id with one declared in `config.json`, the
   `config.json` declaration takes precedence. Effective precedence, weak → strong:

   ```
   convention md files  <  user config.json  <  project config.json  <  $SPARKWRIGHT_CONFIG / CLI
   ```

   This keeps the same override direction users already know from config load
   order. Markdown files are the _team-default / convenience_ layer; `config.json`
   is the _precise-control_ layer. When a markdown declaration is shadowed by an
   explicit config entry, emit a trace/warn naming the shadowed source — never
   silently drop it.

2. **`!`shell`` interpolation ships in P1.** Command bodies may embed live shell
   output. This is the _only_ place in the whole surface that touches execution,
   so it is welded onto the existing gate (see P1 below) and gets focused review.

3. **Commands return an intent, they do not start runs themselves.** A command's
   `run()` returns `CommandResult.metadata = { kind: "start_run", prompt,
model?, subtask? }`. The embedder decides how to start the run. This matches
   the existing "commands are the user-intent surface, they do not pass the tool
   gate" definition in [commands.ts](../../packages/core/src/commands.ts) and keeps
   the loader independent of any specific front-end. This cross-front-end
   contract must be written into
   [EXTENSION_INTERFACES.md](../reference/EXTENSION_INTERFACES.md) "Commands".

4. **Gitignore uses an allowlist of runtime subpaths, not negation.** Do not
   ignore the whole directory and re-include `config.json` with `!`; nested `!`
   rules are error-prone. List runtime subpaths explicitly.

## Phase P0 — Separate committed config from local runtime state

This is the foundation and a real bug fix on its own. It is independent, low
risk, and a prerequisite for every later phase (otherwise the command/agent
files dropped under `.sparkwright/` would also be gitignored).

**Three changes:**

1. **`.gitignore`** — replace the wholesale `.sparkwright/` ignore with explicit
   runtime subpaths:

   ```gitignore
   **/.sparkwright/sessions/
   **/.sparkwright/runs/
   **/.sparkwright/test-iface-runs/
   **/.sparkwright/tui-history.jsonl
   **/.sparkwright/tui-stash.json
   ```

   This keeps `config.json` — and the `command/`, `agents/` directories —
   committable. The `**/` prefix is load-bearing: the old wholesale
   `.sparkwright/` ignore matched at any depth, so nested workspaces like
   `examples/*/.sparkwright/sessions/` were covered. Anchored patterns
   (`.sparkwright/sessions/`) match only the repo root and leak nested runtime
   state — caught by the self-check below after a `release:check` run wrote
   example sessions.

2. **`init --project`** — add a project mode to the scaffold. Reuse the existing
   writer at [cli.ts:~2872](../../packages/cli/src/cli.ts) but target
   [projectConfigPath() (cli.ts:1691)](../../packages/cli/src/cli.ts). The project
   template contains **no secrets** (only `model` / `permissionMode` /
   `capabilities`); provider keys stay in the user-level file. Because it holds
   no secret, the project template does **not** need the `chmod 600` that the
   user-level template forces.

3. **`$schema` support (allowed, not emitted)** — add a top-level `"$schema"`
   property to [schemas/config.schema.json](../../schemas/config.schema.json) so
   editors accept it, but do **not** emit it from the scaffolds until the schema
   is hosted at a stable URL — an unhosted URL just makes editors fail to fetch.
   Users can add `"$schema"` themselves once it is published.

**Self-check:**

- `git status --porcelain .sparkwright/` shows **only** `config.json` (and later
  `command/`, `agents/`) — confirm `tui-stash.json` and friends do not leak.
- `git check-ignore` the runtime paths to confirm they are still ignored.
- Pre-existing on-disk session files were never tracked, so they will not
  suddenly enter git — but verify.

**Risk:** low. Pure gitignore + scaffold. The config load/merge logic in
[config.ts](../../packages/host/src/config.ts) is untouched.

## Phase P1 — File-loaded slash commands

**Goal:** `.sparkwright/command/*.md` (and user-level
`~/.config/sparkwright/command/*.md`) become live commands.

New edge package — `@sparkwright/project-commands` — alongside
[project-context](../../packages/project-context/src/index.ts) (both are
"local-convention discovery" and both need workspace-relative path resolution).
**Core is not modified.**

1. **Discovery** — scan project-level and user-level `command/*.md`. Per Decision
   1, project shadows user, and any `config.json`-declared command of the same
   name shadows both.

2. **Parse** frontmatter → a front-end-agnostic descriptor:

   ```md
   ---
   description: git commit and push
   model: openai/... # optional: override run model
   subtask: true # optional: spawn a child run rather than the main run
   ---

   body = prompt template
   ```

   `name` = filename; `describe` = `frontmatter.description`.

3. **`run()` semantics (Decision 3)** — the command does not execute shell or
   start a run itself. It returns `CommandResult.metadata = { kind: "start_run",
prompt, model?, subtask? }`; the embedder starts the run, reusing the existing
   run-start path in [host/runtime.ts](../../packages/host/src/runtime.ts).

4. **Template interpolation — two distinct kinds:**
   - `$ARGUMENTS` / `$1 $2` ← `ctx.rest` / `ctx.args`. **Pure string
     substitution, never executes.**
   - `` !`<cmd>` `` ← runs through the **shell-tool gate**
     ([packages/shell-tool](../../packages/shell-tool/) — `safety`,
     `command-parser`, policy). The shell embedded in a command template and the
     shell a model runs mid-run go through the _same_ governed channel and the
     _same_ approval. No bypass.

   Interpolation timing: before the run starts, in the context of the user
   explicitly typing `/commit`. Tag provenance in traces (`source:
project_command`) — this is a different authorization context from a model
   deciding to call shell.

   Failure semantics: if any ` !` `` is denied by policy or times out, the
   command **fails as a whole with a clear error** — never substitute an empty
   string and continue, which would let the model run on a truncated context.

### Integration seam: two command registries (important)

The repo currently has **two** command registries:

- [packages/core/src/commands.ts](../../packages/core/src/commands.ts) — the
  protocol-shaped `CommandRegistry` (`run(ctx): CommandResult`). Defined, but not
  what the TUI actually drives.
- [packages/tui/src/lib/commands.ts](../../packages/tui/src/lib/commands.ts) — the
  registry the TUI palette and `/foo` input actually use. Commands are `run: () =>
void` thunks closed over App state, registered imperatively in
  [app.tsx (~430)](../../packages/tui/src/app.tsx).

The loader must **not** couple to either front-end. It produces the
front-end-agnostic descriptor (name / description / prompt / model / subtask /
shell-interp markers). Each front-end owns a thin adapter:

- **TUI adapter** wraps the descriptor into its `Command`, with `run()` calling
  the App "start a run with this prompt" helper.
- CLI / bot adapters follow the same pattern later.

Reconciling the two registries is out of scope here; the descriptor + adapter
boundary lets P1 land without forcing that reconciliation. Note it as
follow-up.

**Risk:** medium, isolated in the new package. The ` !` `` interpolation is the
only execution-touching line and gets focused review.

## Phase P2 — Markdown frontmatter agent profiles

**Goal:** `.sparkwright/agents/*.md` is equivalent to one `profiles[]` entry but
nicer for long prompts.

1. In the same edge loader, scan `agents/*.md`; map frontmatter (`mode` /
   `model` / `allowedTools` / `deniedTools` / `maxSteps` / `runBudget`) + body
   (→ `experimental.prompt`) onto the
   [agent-profile schema](../../schemas/agent-profile.schema.json). `id` = filename.
2. Reuse the existing `recordToAgentProfile` validation
   ([cli.ts:1539](../../packages/cli/src/cli.ts)).
3. Merge per **Decision 1** (config wins) — see the normalization note below.

**Risk:** low–medium. Pure data mapping onto the existing profile load/validate
path.

## Phase P3 (optional) — `/learn`

Once P1 lands, `/learn` is just a `command/learn.md`: analyze the current
session, distill non-obvious findings, and write them into the **nearest-level**
`SPARKWRIGHT.md`, reusing the hierarchical target-file location logic in
[project-context](../../packages/project-context/src/index.ts). No new mechanism.

## Cross-cutting: normalize merge to "by key, last wins"

Today top-level config fields are replaced wholesale, while `providers` is
merged by key — two inconsistent semantics, and the wholesale one is a latent
footgun (a project `profiles[]` silently replaces the user one).

Rather than make the loaders accommodate that inconsistency, the assembly step
should **flatten every source into a `Map<id, profile>` / `Map<name, command>`
and write in precedence order, last write wins:**

```
md files (weak) → user config → project config → env/CLI (strong)
```

This makes Decision 1 deterministic at any number of layers and incidentally
corrects `profiles` from "wholesale replace" to "merge by id", aligning it with
`providers`. This correction is worth doing alongside P2 as its own PR with a
multi-layer merge test, since it changes existing profile-merge behavior.

## Grounded mount points (verified against current code)

- Config + capability assembly happens in
  [host/runtime.ts](../../packages/host/src/runtime.ts): `loadHostConfig` at
  **line 274**, then reads `capabilities.{tools,skills,mcp,agents}` (lines
  275–278), then computes `mainAgentProfile(agentConfig?.profiles)` at
  **line 306**. The loader's normalization belongs **between line 278 and 306**,
  after config is merged and before profiles/registries are finalized. Core is
  not touched.
- **A second assembly path exists** around **line 550** (snapshot rebuild) that
  duplicates the same `loadHostConfig` + `capabilities.*` reads and calls
  `mainAgentProfile(...)` again (lines 588, 635–638). Introduce a single
  `resolveAgentProfiles(workspaceRoot, agentConfig)` helper that merges md +
  config and is called in **both** paths, so they cannot diverge.
- Commands: do **not** target core's `CommandRegistry` directly; integrate via
  the descriptor + per-front-end adapter described in P1.

## Recommended sequencing

```
P0 (.gitignore + init --project + $schema)        ← independent, ship first
  └─ P1 ($ARGUMENTS + !`shell` command loader)     ← new edge package
       ├─ P2 (agents/*.md → profile)               ← bundle with merge-normalization PR
       └─ P3 (/learn)                              ← just a command md, depends on P1
Cross-cutting: merge normalization                 ← its own PR, multi-layer test
```

Ship P0 as its own PR first — it is independent, low-risk, and fixes the real
"project config does not travel" bug. Keep the merge-normalization change in its
own PR because it alters existing `profiles` merge behavior and needs a
dedicated multi-layer test.

## Implementation notes

What shipped, and where it diverged from the plan above.

### P0 — committed config surface

- `.gitignore` now allowlists runtime subpaths with a `**/` prefix (see P0).
- `sparkwright init --project` scaffolds `<workspace>/.sparkwright/config.json`
  from a secret-free template (no `chmod 600`). The config JSON schema gained a
  `$schema` property ([schemas/config.schema.json](../../schemas/config.schema.json))
  so it is _allowed_, but the scaffolds do **not** emit one — the schema is not
  yet hosted, and an unhosted URL would only make editors fail to fetch. The
  loader already ignored unknown top-level keys, so no loader change was needed.
- This repo dogfoods the surface: [.sparkwright/config.json](../../.sparkwright/config.json)
  and [.sparkwright/command/learn.md](../../.sparkwright/command/learn.md) are committed.

### P1 — file-loaded commands

- New package [`@sparkwright/project-commands`](../../packages/project-commands):
  discovery, frontmatter + template parsing, gated interpolation, and the
  `StartRunIntent` builder. Pure and execution-free.
- `createSafetyGatedShellRunner` wraps `evaluateShellSafety`: `deny` and
  unapproved `require_approval` throw; only `allow` (or an explicitly approved
  command) executes. The TUI's default runner has no approver, so anything not
  `allow` is blocked — a safe floor. A future approval modal can inject `approve`.
- TUI integration: [packages/tui/src/lib/project-commands.ts](../../packages/tui/src/lib/project-commands.ts)
  discovers + maps descriptors; [app.tsx](../../packages/tui/src/app.tsx) folds them
  into the registry (built-ins win ties) and re-discovers them on `/reload`. The
  TUI `Command` type gained an additive `runRaw?(rest)`; `input-box.tsx` threads
  the rest-of-line so `$ARGUMENTS` resolves. The palette path stays arg-less.
- Caveat: `$ARGUMENTS` / `$1..$9` interpolate only into literal prompt text,
  **not** inside a `` !`...` `` span — the span runs verbatim. This is
  deliberate (no arg splicing into shell = no injection). Use fixed commands
  like `` !`git diff` `` and put arguments in the prompt body.
- Divergence: the TUI applies only `intent.prompt`; `model`/`subtask` overrides
  are carried on the intent but not yet honored by the TUI run-start path
  (follow-up). The two command registries (core vs TUI) are still unreconciled,
  as planned.

### P2 — markdown agent profiles

- [packages/host/src/agent-profiles.ts](../../packages/host/src/agent-profiles.ts):
  `discoverProjectAgentProfiles`, `parseAgentProfileFile`, `mergeAgentProfilesById`
  (config wins by id), and `resolveAgentProfiles`. Frontmatter covers
  name/description/mode/model/allowedTools/deniedTools/maxSteps; body →
  `experimental.prompt`. Advanced `policy`/`runBudget` stay in config.json.
- `resolveAgentProfiles` is now called in **both** runtime.ts assembly paths
  (run-start and capability inspection), replacing the duplicated
  `agentConfig?.profiles` reads, so they cannot diverge.
- The effective set (including md agents) surfaces via capability inspection
  (TUI `/agents`). The `sparkwright agents` CLI remains a config.json editor and
  was intentionally left unchanged.
- Divergence: the deeper cross-config-layer normalization (user vs project
  `profiles` merged by id instead of wholesale-replaced) was **not** done here —
  it remains the separate follow-up the sequencing notes call out. P2 only
  normalizes the new md-vs-config merge.

### P3 — /learn

- Shipped as [.sparkwright/command/learn.md](../../.sparkwright/command/learn.md),
  a pure-prompt command (no shell) that distills session learnings into the
  nearest `SPARKWRIGHT.md`.

### Validation

`npm run release:check` passes (build, typecheck, typecheck:test, lint,
format:check, schema:check, internal-imports, reserved:strict, all package
tests, the deterministic repo-pilot run, and the install smoke). New tests:
project-commands (17), tui adapter (3), host agent-profiles (5).
