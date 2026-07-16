import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  discoverProjectAgentProfiles,
  mergeAgentProfilesById,
  parseAgentProfileFile,
  resolveAgentProfiles,
} from "../src/agent-profiles.js";
import {
  resolveAgentDelegateTools,
  delegateToolDescription,
  describeInProcessDelegateCapability,
  evaluateDelegateRouting,
} from "../src/delegate-capability.js";
import { loadLayeredAgentReport } from "../src/agent-report.js";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sparkwright-agent-md-"));
}

async function writeAgent(
  root: string,
  name: string,
  contents: string,
): Promise<void> {
  const dir = join(root, ".sparkwright", "agents");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), contents, "utf8");
}

async function writeAgentPath(
  root: string,
  path: string,
  contents: string,
): Promise<void> {
  const fullPath = join(root, ".sparkwright", "agents", path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, contents, "utf8");
}

describe("parseAgentProfileFile", () => {
  it("maps frontmatter and body onto an AgentProfile", () => {
    const profile = parseAgentProfileFile(
      "triage",
      [
        "---",
        "name: Triage",
        "description: routes issues",
        "mode: child",
        "model: openai/m",
        "use: [workspace.read]",
        "allowedTools: [read, glob]",
        "maxSteps: 5",
        "---",
        "You triage issues.",
      ].join("\n"),
    );
    expect(profile.id).toBe("triage");
    expect(profile.name).toBe("Triage");
    expect(profile.use).toEqual(["workspace.read"]);
    expect(profile.allowedTools).toEqual(["read", "glob"]);
    expect(profile.maxSteps).toBe(5);
    expect(profile.mode).toBe("child");
    expect(profile.model).toBe("openai/m");
    expect(profile.prompt).toBe("You triage issues.");
  });

  it("honors an explicit namespaced frontmatter id over the filename", () => {
    const profile = parseAgentProfileFile(
      "foo",
      ["---", "id: review:foo", "mode: child", "---", "body"].join("\n"),
    );
    expect(profile.id).toBe("review:foo");
  });

  it("falls back to the filename when the frontmatter id is invalid", () => {
    const profile = parseAgentProfileFile(
      "foo",
      ["---", "id: not a valid id!", "---", "body"].join("\n"),
    );
    expect(profile.id).toBe("foo");
  });

  it("parses the tri-state exposeAsDelegate flag", () => {
    expect(
      parseAgentProfileFile(
        "a",
        ["---", "exposeAsDelegate: true", "---", ""].join("\n"),
      ).exposeAsDelegate,
    ).toBe(true);
    expect(
      parseAgentProfileFile(
        "b",
        ["---", "exposeAsDelegate: false", "---", ""].join("\n"),
      ).exposeAsDelegate,
    ).toBe(false);
    expect(parseAgentProfileFile("c", "no frontmatter").exposeAsDelegate).toBe(
      undefined,
    );
  });

  it("accepts YAML arrays, aliases, run budgets, and inline delegate hints", () => {
    const profile = parseAgentProfileFile(
      "reviewer",
      [
        "---",
        "name: Reviewer",
        "description: Review changes proactively.",
        "tools:",
        "  - read",
        "  - grep",
        "disallowedTools:",
        "  - bash",
        "delegateTool:",
        "  toolName: delegate_reviewer",
        "  requiresApproval: false",
        "runBudget:",
        "  maxModelCalls: 3",
        "---",
        "Review the current diff.",
      ].join("\n"),
    );

    expect(profile.allowedTools).toEqual(["read", "grep"]);
    expect(profile.deniedTools).toEqual(["bash"]);
    expect(profile.delegateTool).toEqual({
      toolName: "delegate_reviewer",
      requiresApproval: false,
    });
    expect(profile.runBudget).toEqual({ maxModelCalls: 3 });
  });

  it("parses routing triggers and when keyword hints", () => {
    const profile = parseAgentProfileFile(
      "reviewer",
      [
        "---",
        "triggers:",
        "  - review",
        "  - diff",
        "when:",
        "  keywords:",
        "    - 登录",
        "    - 认证",
        "---",
        "Review changes.",
      ].join("\n"),
    );

    expect(profile.triggers).toEqual(["review", "diff"]);
    expect(profile.when).toEqual({ keywords: ["登录", "认证"] });
  });

  it("parses Agent.md workflow hook sugar into the profile carrier", () => {
    const profile = parseAgentProfileFile(
      "db-reader",
      [
        "---",
        "hooks:",
        "  PreToolUse:",
        "    - matcher: bash",
        "      action:",
        "        type: command",
        "        command: ./scripts/validate-readonly-query.sh",
        "        stdin: json",
        "        blockOnFailure: true",
        "        injectOutput: onFailure",
        "  RunStart:",
        "    - action:",
        "        type: context",
        "        content: Child guardrails active.",
        "---",
        "Read data.",
      ].join("\n"),
    );

    expect(profile.hooks).toEqual([
      {
        name: "db-reader.PreToolUse.0",
        hook: "PreToolUse",
        matcher: { toolName: "bash" },
        action: {
          type: "command",
          command: "./scripts/validate-readonly-query.sh",
          stdin: "json",
          blockOnFailure: true,
          injectOutput: "onFailure",
        },
      },
      {
        name: "db-reader.RunStart.0",
        hook: "RunStart",
        action: {
          type: "context",
          content: "Child guardrails active.",
        },
      },
    ]);
  });

  it("drops malformed Agent.md hook entries and excludes agent actions", () => {
    const profile = parseAgentProfileFile(
      "reviewer",
      [
        "---",
        "hooks:",
        "  PreToolUse:",
        "    - matcher: bash",
        "      action:",
        "        type: agent",
        "        goal: nested delegate",
        "    - matcher:",
        "        unknown: value",
        "      action:",
        "        type: block",
        "        reason: no matcher",
        "    - matcher:",
        "        toolName: read",
        "      action:",
        "        type: block",
        "        reason: stop reads",
        "---",
        "Review.",
      ].join("\n"),
    );

    expect(profile.hooks).toEqual([
      {
        name: "reviewer.PreToolUse.2",
        hook: "PreToolUse",
        matcher: { toolName: "read" },
        action: { type: "block", reason: "stop reads" },
      },
    ]);
  });

  it("ignores an invalid mode and non-positive maxSteps", () => {
    const profile = parseAgentProfileFile(
      "x",
      "---\nmode: bogus\nmaxSteps: 0\n---\nbody",
    );
    expect(profile.mode).toBeUndefined();
    expect(profile.maxSteps).toBeUndefined();
    expect(profile.prompt).toBe("body");
  });

  it("preserves scalar fields YAML coerces to booleans", () => {
    const profile = parseAgentProfileFile(
      "x",
      "---\nname: true\nmodel: false\n---\nbody",
    );
    expect(profile.name).toBe("true");
    expect(profile.model).toBe("false");
  });

  it("drops invalid runBudget keys instead of trusting the cast", () => {
    const profile = parseAgentProfileFile(
      "x",
      [
        "---",
        "runBudget:",
        "  maxModelCalls: lots",
        "  maxToolCalls: 0",
        "  maxTokens: 2000",
        "  maxCostUsd: -1",
        "---",
        "body",
      ].join("\n"),
    );
    expect(profile.runBudget).toEqual({ maxTokens: 2000 });
  });

  it("omits runBudget entirely when no key is valid", () => {
    const profile = parseAgentProfileFile(
      "x",
      "---\nrunBudget:\n  maxModelCalls: nope\n---\nbody",
    );
    expect(profile.runBudget).toBeUndefined();
  });
});

describe("mergeAgentProfilesById", () => {
  it("lets the strong (config) layer win ties by id", () => {
    const merged = mergeAgentProfilesById(
      [
        { id: "a", name: "md-a" },
        { id: "b", name: "md-b" },
      ],
      [{ id: "a", name: "config-a" }],
    );
    expect(merged).toEqual([
      { id: "a", name: "config-a" },
      { id: "b", name: "md-b" },
    ]);
  });
});

describe("discovery + resolve", () => {
  it("returns empty when no agents dir exists", async () => {
    const root = await tempWorkspace();
    expect(await discoverProjectAgentProfiles(root)).toEqual([]);
  });

  it("discovers markdown agents and folds them under config (config wins)", async () => {
    const root = await tempWorkspace();
    await writeAgent(
      root,
      "triage",
      "---\nname: md-triage\nmode: child\n---\nprompt",
    );
    await writeAgent(root, "mdonly", "---\nname: only-md\n---\nbody");

    const resolved = await resolveAgentProfiles(root, [
      { id: "triage", name: "config-triage" },
    ]);
    const byId = Object.fromEntries(resolved.map((p) => [p.id, p]));
    expect(byId.triage?.name).toBe("config-triage"); // config wins
    expect(byId.mdonly?.name).toBe("only-md"); // md-only survives
  });

  it("discovers agents in nested markdown folders", async () => {
    const root = await tempWorkspace();
    await writeAgentPath(
      root,
      "review/code-reviewer.md",
      "---\nname: nested-reviewer\n---\nreview prompt",
    );

    const profiles = await discoverProjectAgentProfiles(root);
    expect(profiles).toEqual([
      expect.objectContaining({
        id: "code-reviewer",
        name: "nested-reviewer",
      }),
    ]);
  });

  it("layers user markdown under project markdown before config profiles", async () => {
    const root = await tempWorkspace();
    const xdg = await mkdtemp(join(tmpdir(), "sparkwright-agent-xdg-"));
    await mkdir(join(xdg, "sparkwright", "agents"), { recursive: true });
    await writeFile(
      join(xdg, "sparkwright", "agents", "triage.md"),
      "---\nname: user-triage\n---\nuser prompt",
      "utf8",
    );
    await writeAgent(root, "triage", "---\nname: project-triage\n---\nprompt");

    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      const markdownOnly = await resolveAgentProfiles(root, undefined);
      expect(
        markdownOnly.find((profile) => profile.id === "triage")?.name,
      ).toBe("project-triage");

      const resolved = await resolveAgentProfiles(root, [
        { id: "triage", name: "config-triage" },
      ]);
      expect(resolved.find((profile) => profile.id === "triage")?.name).toBe(
        "config-triage",
      );
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
    }
  });
});

describe("loadLayeredAgentReport", () => {
  it("reports agent provenance and shadowed profiles", async () => {
    const root = await tempWorkspace();
    const xdg = await mkdtemp(join(tmpdir(), "sparkwright-agent-report-xdg-"));
    await mkdir(join(xdg, "sparkwright", "agents"), { recursive: true });
    await writeFile(
      join(xdg, "sparkwright", "agents", "reviewer.md"),
      "---\nname: user-reviewer\n---\nuser prompt",
      "utf8",
    );
    await writeAgent(
      root,
      "reviewer",
      "---\nname: project-reviewer\n---\nproject prompt",
    );

    const report = await loadLayeredAgentReport(
      root,
      [{ id: "reviewer", name: "config-reviewer", mode: "child" }],
      { XDG_CONFIG_HOME: xdg },
    );

    expect(report.profiles).toEqual([
      expect.objectContaining({
        id: "reviewer",
        name: "config-reviewer",
        layer: "config",
        mode: "child",
      }),
    ]);
    expect(report.shadows).toEqual([
      expect.objectContaining({
        id: "reviewer",
        shadowed: expect.objectContaining({ layer: "user" }),
        shadowedBy: expect.objectContaining({ layer: "project" }),
      }),
      expect.objectContaining({
        id: "reviewer",
        shadowed: expect.objectContaining({ layer: "project" }),
        shadowedBy: expect.objectContaining({ layer: "config" }),
      }),
    ]);
    expect(report.errors).toEqual([]);
  });

  it("reports nested markdown profiles", async () => {
    const root = await tempWorkspace();
    await writeAgentPath(
      root,
      "review/security.md",
      "---\nname: Security Review\n---\nreview prompt",
    );

    const report = await loadLayeredAgentReport(root, undefined, {});
    expect(report.profiles).toEqual([
      expect.objectContaining({
        id: "security",
        name: "Security Review",
        layer: "project",
      }),
    ]);
  });

  it("fails closed and reports a markdown profile with an invalid model reference", async () => {
    const root = await tempWorkspace();
    await writeAgent(
      root,
      "reviewer",
      "---\nmodel: default\n---\nreview prompt",
    );

    const report = await loadLayeredAgentReport(root, undefined, {});

    expect(report.profiles).toEqual([]);
    expect(report.errors).toEqual([
      expect.objectContaining({
        source: expect.stringContaining("reviewer.md"),
        message: expect.stringContaining('model "default" must be in'),
      }),
    ]);
  });

  it("reports a same-layer basename collision as a collision, not a shadow", async () => {
    const root = await tempWorkspace();
    await writeAgentPath(root, "review/foo.md", "---\nname: ReviewFoo\n---\n");
    await writeAgentPath(root, "audit/foo.md", "---\nname: AuditFoo\n---\n");

    const report = await loadLayeredAgentReport(root, undefined, {});
    expect(report.shadows).toEqual([]);
    expect(report.collisions).toEqual([
      expect.objectContaining({
        id: "foo",
        kept: expect.objectContaining({ name: "AuditFoo" }),
        dropped: expect.objectContaining({ name: "ReviewFoo" }),
      }),
    ]);
    // Fail closed: exactly one survives in the effective list.
    expect(report.profiles.filter((p) => p.id === "foo")).toHaveLength(1);
  });
});

describe("discoverProjectAgentProfiles collisions", () => {
  it("fails closed on a within-layer basename collision and reports it", async () => {
    const root = await tempWorkspace();
    await writeAgentPath(root, "review/foo.md", "---\nname: ReviewFoo\n---\n");
    await writeAgentPath(root, "audit/foo.md", "---\nname: AuditFoo\n---\n");

    const collisions: Array<{ id: string }> = [];
    const profiles = await discoverProjectAgentProfiles(root, (collision) =>
      collisions.push(collision),
    );

    const foos = profiles.filter((p) => p.id === "foo");
    expect(foos).toHaveLength(1);
    // "audit" sorts before "review", so the audit file is kept (first wins).
    expect(foos[0]!.name).toBe("AuditFoo");
    expect(collisions).toEqual([expect.objectContaining({ id: "foo" })]);
  });
});

describe("resolveAgentProfiles namespacing", () => {
  it("lets a flat config id and a namespaced markdown id coexist", async () => {
    const root = await tempWorkspace();
    await writeAgent(
      root,
      "scoped",
      "---\nid: review:foo\nmode: child\n---\nscoped",
    );

    const profiles = await resolveAgentProfiles(root, [
      { id: "reviewer", mode: "child" },
    ]);

    const ids = profiles.map((p) => p.id).sort();
    expect(ids).toEqual(["review:foo", "reviewer"]);
  });
});

describe("resolveAgentDelegateTools", () => {
  it("folds inline profile delegate hints under explicit delegate config", () => {
    const delegates = resolveAgentDelegateTools(
      [
        {
          id: "reviewer",
          delegateTool: { toolName: "delegate_reviewer" },
        },
        {
          id: "writer",
          delegateTool: { requiresApproval: false },
        },
      ],
      [{ profileId: "reviewer", toolName: "review_now" }],
    );

    expect(delegates).toEqual([
      { profileId: "reviewer", toolName: "review_now" },
      { profileId: "writer", requiresApproval: false },
    ]);
  });

  it("does not auto-expose child profiles by default (opt-in off)", () => {
    const delegates = resolveAgentDelegateTools([
      { id: "reviewer", mode: "child" },
      { id: "writer", mode: "all" },
    ]);
    expect(delegates).toEqual([]);
  });

  it("auto-exposes child/all and mode-less profiles when the flag is on", () => {
    const delegates = resolveAgentDelegateTools(
      [
        { id: "reviewer", mode: "child" },
        { id: "writer", mode: "all" },
        { id: "boss", mode: "primary" },
        { id: "loose" },
      ],
      [],
      { exposeChildrenAsDelegates: true },
    );
    expect(delegates).toEqual([
      { profileId: "reviewer" },
      { profileId: "writer" },
      { profileId: "loose" },
    ]);
  });

  it("does not auto-expose the main profile when mode is omitted", () => {
    const delegates = resolveAgentDelegateTools(
      [{ id: "main" }, { id: "reviewer" }],
      [],
      { includeAllChildProfiles: true },
    );

    expect(delegates).toEqual([{ profileId: "reviewer" }]);
  });

  it("honors exposeAsDelegate:false as opt-out even when the flag is on", () => {
    const delegates = resolveAgentDelegateTools(
      [
        { id: "reviewer", mode: "child" },
        { id: "secret", mode: "child", exposeAsDelegate: false },
      ],
      [],
      { exposeChildrenAsDelegates: true },
    );
    expect(delegates).toEqual([{ profileId: "reviewer" }]);
  });

  it("honors exposeAsDelegate:false for indexed targets unless explicitly configured", () => {
    const delegates = resolveAgentDelegateTools(
      [
        { id: "reviewer", mode: "child" },
        { id: "secret", mode: "child", exposeAsDelegate: false },
        { id: "explicit", mode: "child", exposeAsDelegate: false },
        {
          id: "inline",
          mode: "child",
          exposeAsDelegate: false,
          delegateTool: { toolName: "delegate_inline" },
        },
      ],
      [{ profileId: "explicit", toolName: "delegate_explicit" }],
      { includeAllChildProfiles: true },
    );
    expect(delegates).toEqual([
      { profileId: "explicit", toolName: "delegate_explicit" },
      { profileId: "inline", toolName: "delegate_inline" },
      { profileId: "reviewer" },
    ]);
  });

  it("honors exposeAsDelegate:true as per-profile opt-in when the flag is off", () => {
    const delegates = resolveAgentDelegateTools([
      { id: "reviewer", mode: "child", exposeAsDelegate: true },
      { id: "other", mode: "child" },
    ]);
    expect(delegates).toEqual([{ profileId: "reviewer" }]);
  });

  it("keeps explicit config/inline winning over auto-exposure", () => {
    const delegates = resolveAgentDelegateTools(
      [
        { id: "reviewer", mode: "child", delegateTool: { toolName: "inline" } },
        { id: "writer", mode: "child" },
      ],
      [{ profileId: "writer", toolName: "explicit_writer" }],
      { exposeChildrenAsDelegates: true },
    );
    expect(delegates).toEqual([
      { profileId: "writer", toolName: "explicit_writer" },
      { profileId: "reviewer", toolName: "inline" },
    ]);
  });

  it("fails closed on a tool-name collision and reports it", () => {
    const collisions: Array<{ toolName: string }> = [];
    const delegates = resolveAgentDelegateTools(
      [
        { id: "review:foo", mode: "child" },
        { id: "review/foo", mode: "child" },
      ],
      [],
      {
        exposeChildrenAsDelegates: true,
        onCollision: (collision) => collisions.push(collision),
      },
    );
    // Both ids sanitize to delegate_review_foo; only the first is kept.
    expect(delegates).toEqual([{ profileId: "review:foo" }]);
    expect(collisions).toEqual([
      expect.objectContaining({
        toolName: "delegate_review_foo",
        profileId: "review/foo",
        conflictsWith: "review:foo",
        source: "auto",
      }),
    ]);
  });
});

describe("delegateToolDescription enrichment (3a)", () => {
  it("returns an explicit delegate description verbatim", () => {
    expect(
      delegateToolDescription(
        { profileId: "r", description: "Custom text." },
        { id: "r", model: "openai/x", use: ["bash"] },
      ),
    ).toBe("Custom text.");
  });

  it("weaves model and capabilities into the generated description", () => {
    expect(
      delegateToolDescription(
        { profileId: "r" },
        {
          id: "r",
          name: "Reviewer",
          description: "reviews code",
          model: "openai/x",
          use: ["workspace.read", "bash"],
        },
      ),
    ).toBe(
      "Delegate to Reviewer: reviews code (model openai/x; capabilities workspace.read, bash)",
    );
  });

  it("omits the facet suffix when there is no model or capabilities", () => {
    expect(delegateToolDescription({ profileId: "r" }, { id: "r" })).toBe(
      "Delegate a bounded task to r.",
    );
  });
});

describe("delegate routing (3b sort mode)", () => {
  it("sorts matching delegates first while keeping low relevance delegates", () => {
    const plan = evaluateDelegateRouting({
      goal: "review the login diff for auth risks",
      delegates: [
        { profileId: "writer", toolName: "delegate_writer" },
        { profileId: "reviewer", toolName: "delegate_reviewer" },
      ],
      profiles: [
        {
          id: "writer",
          name: "Writer",
          triggers: ["patch", "write"],
        },
        {
          id: "reviewer",
          name: "Reviewer",
          triggers: ["review", "diff", "risk"],
        },
      ],
    });

    expect(plan.delegates.map((delegate) => delegate.profileId)).toEqual([
      "reviewer",
      "writer",
    ]);
    expect(plan.routingByProfileId.get("reviewer")).toMatchObject({
      relevance: "relevant",
      matchedKeywords: expect.arrayContaining(["review", "diff"]),
    });
    expect(plan.routingByProfileId.get("writer")).toMatchObject({
      relevance: "low",
      matchedKeywords: [],
    });
  });

  it("uses CJK-aware keyword matching", () => {
    const plan = evaluateDelegateRouting({
      goal: "请审查登录认证风险",
      delegates: [{ profileId: "security", toolName: "delegate_security" }],
      profiles: [
        {
          id: "security",
          triggers: ["登录", "认证"],
        },
      ],
    });

    expect(plan.routingByProfileId.get("security")).toMatchObject({
      relevance: "relevant",
      matchedKeywords: expect.arrayContaining(["登录", "认证"]),
    });
  });
});

describe("delegate descriptor model (inspect-model)", () => {
  it("carries the profile model on the descriptor when declared", () => {
    const descriptor = describeInProcessDelegateCapability({
      delegate: { profileId: "reviewer" },
      profile: { id: "reviewer", model: "anthropic/claude" },
      workspaceAccess: "none",
      shellAccess: false,
    });
    expect(descriptor.model).toBe("anthropic/claude");
  });

  it("omits model when the profile declares none", () => {
    const descriptor = describeInProcessDelegateCapability({
      delegate: { profileId: "reviewer" },
      profile: { id: "reviewer" },
      workspaceAccess: "none",
      shellAccess: false,
    });
    expect(descriptor.model).toBeUndefined();
  });
});
