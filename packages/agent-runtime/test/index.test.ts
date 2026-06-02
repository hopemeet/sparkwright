import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compileAgentProfileRunOptions,
  createAgentProfilePolicy,
  createAgentTool,
  decideByRules,
  deriveChildAgentProfile,
  mountAgentTool,
  promptBuilderForAgentProfile,
  spawnSubAgent,
  type AgentProfile,
} from "../src/index.js";
import {
  createRun,
  createUsageTracker,
  defineTool,
  FileRunStore,
  type ModelAdapter,
} from "@sparkwright/core";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.length = 0;
});

describe("agent-runtime", () => {
  it("emits agent.profile.derived when an emitter is provided", () => {
    const captured: Array<{ type: string; payload: unknown }> = [];
    const emitter = {
      emit(
        type: string,
        payload: unknown,
        metadata: Record<string, unknown> = {},
      ) {
        captured.push({ type, payload });
        return {
          id: "evt_test",
          runId: "",
          type: type as never,
          timestamp: new Date().toISOString(),
          sequence: 0,
          payload,
          metadata,
        } as never;
      },
    };
    deriveChildAgentProfile({
      childAgent: { id: "child" },
      emitter: emitter as never,
    });
    expect(captured.map((e) => e.type)).toContain("agent.profile.derived");
  });

  it("compiles an agent profile into core run option fragments", async () => {
    const runOptions = compileAgentProfileRunOptions({
      id: "reviewer",
      name: "Reviewer",
      maxSteps: 3,
      runBudget: {
        maxToolCalls: 5,
      },
      allowedTools: ["read"],
      metadata: {
        parentAgentId: "planner",
        purpose: "review",
      },
    });

    expect(runOptions.maxSteps).toBe(3);
    expect(runOptions.runBudget).toEqual({
      maxToolCalls: 5,
    });
    expect(runOptions.metadata).toEqual({
      parentAgentId: "planner",
      agentId: "reviewer",
      agentProfileId: "reviewer",
      agentName: "Reviewer",
      purpose: "review",
    });
    if (!runOptions.policy) throw new Error("Expected compiled policy.");
    await expect(
      runOptions.policy.decide({
        action: "tool.execute",
        metadata: {
          toolName: "shell",
        },
      }),
    ).resolves.toMatchObject({
      decision: "deny",
    });
  });

  it("lets compiled run metadata carry an explicit parent agent id", () => {
    const runOptions = compileAgentProfileRunOptions(
      {
        id: "worker",
        metadata: {
          parentAgentId: "derived-parent",
        },
      },
      {
        parentAgentId: "runtime-parent",
        metadata: {
          agentId: "cannot-override-profile-id",
          traceLabel: "child-call",
        },
      },
    );

    expect(runOptions.metadata).toMatchObject({
      parentAgentId: "runtime-parent",
      agentId: "worker",
      agentProfileId: "worker",
      traceLabel: "child-call",
    });
  });

  it("inherits parent agent and parent run deny rules into child profiles", () => {
    const parent: AgentProfile = {
      id: "plan",
      allowedTools: ["read", "grep", "edit"],
      deniedTools: ["edit"],
      maxSteps: 4,
      runBudget: {
        maxToolCalls: 8,
      },
      policy: [
        {
          action: "workspace.write",
          resource: "*",
          effect: "deny",
          reason: "Plan agent cannot write.",
        },
      ],
    };
    const child: AgentProfile = {
      id: "explore",
      allowedTools: ["read", "grep", "shell"],
      maxSteps: 12,
      runBudget: {
        maxToolCalls: 20,
      },
      policy: [
        {
          action: "tool.execute",
          resource: "shell",
          effect: "requires_approval",
        },
      ],
    };

    const derived = deriveChildAgentProfile({
      parentAgent: parent,
      parentRunPolicy: [
        {
          action: "network.fetch",
          resource: "*",
          effect: "deny",
        },
      ],
      childAgent: child,
    });

    expect(derived.effectiveProfile.allowedTools).toEqual(["grep", "read"]);
    expect(derived.effectiveProfile.deniedTools).toEqual(["edit"]);
    expect(derived.effectiveProfile.maxSteps).toBe(4);
    expect(derived.effectiveProfile.runBudget).toMatchObject({
      maxToolCalls: 8,
    });
    expect(derived.parentAgentDenyCount).toBe(1);
    expect(derived.parentRunDenyCount).toBe(1);
    expect(derived.childDenyCount).toBe(0);
    expect(derived.effectivePolicy.map((rule) => rule.source)).toEqual([
      "parent_run",
      "parent_agent",
      "child_agent",
    ]);
  });

  it("never lets child allow rules override inherited deny rules", () => {
    const derived = deriveChildAgentProfile({
      parentAgent: {
        id: "plan",
        policy: [
          {
            action: "workspace.write",
            resource: "*",
            effect: "deny",
          },
        ],
      },
      childAgent: {
        id: "worker",
        policy: [
          {
            action: "workspace.write",
            resource: "*",
            effect: "allow",
          },
        ],
      },
    });

    expect(
      decideByRules(derived.effectivePolicy, "workspace.write", "README.md"),
    ).toMatchObject({
      decision: "deny",
      metadata: {
        ruleSource: "parent_agent",
      },
    });
  });

  it("treats inherited approval as stronger than child allow", () => {
    const derived = deriveChildAgentProfile({
      parentRunPolicy: [
        {
          action: "tool.execute",
          resource: "deploy",
          effect: "requires_approval",
        },
      ],
      childAgent: {
        id: "worker",
        policy: [
          {
            action: "tool.execute",
            resource: "deploy",
            effect: "allow",
          },
        ],
      },
    });

    expect(
      decideByRules(derived.effectivePolicy, "tool.execute", "deploy"),
    ).toMatchObject({
      decision: "requires_approval",
      metadata: {
        ruleSource: "parent_run",
      },
    });
  });

  it("turns an agent profile into a policy", async () => {
    const policy = createAgentProfilePolicy({
      id: "reviewer",
      allowedTools: ["read", "grep"],
      policy: [
        {
          action: "workspace.write",
          resource: "*",
          effect: "deny",
        },
      ],
    });

    await expect(
      policy.decide({
        action: "tool.execute",
        metadata: {
          toolName: "shell",
        },
      }),
    ).resolves.toMatchObject({
      decision: "deny",
    });

    await expect(
      policy.decide({
        action: "workspace.write",
        metadata: {
          path: "src/index.ts",
        },
      }),
    ).resolves.toMatchObject({
      decision: "deny",
      metadata: {
        ruleSource: "child_agent",
      },
    });
  });

  it("prefers typed policy resources over legacy metadata guesses", async () => {
    const policy = createAgentProfilePolicy({
      id: "reviewer",
      allowedTools: ["read"],
      policy: [
        {
          action: "workspace.write",
          resource: "src/index.ts",
          effect: "deny",
        },
      ],
    });

    await expect(
      policy.decide({
        action: "tool.execute",
        resource: {
          kind: "tool",
          name: "read",
        },
        metadata: {
          toolName: "shell",
        },
      }),
    ).resolves.toMatchObject({
      decision: "allow",
    });

    await expect(
      policy.decide({
        action: "workspace.write",
        resource: {
          kind: "workspace",
          path: "src/index.ts",
        },
        metadata: {
          path: "README.md",
        },
      }),
    ).resolves.toMatchObject({
      decision: "deny",
      metadata: {
        resource: "src/index.ts",
      },
    });
  });

  it("keeps experimental profile fields explicit on derived profiles", () => {
    const derived = deriveChildAgentProfile({
      childAgent: {
        id: "worker",
        experimental: {
          mode: "child",
          model: "example-model",
          prompt: "application-owned prompt",
        },
      },
    });

    expect(derived.effectiveProfile.experimental).toEqual({
      mode: "child",
      model: "example-model",
      prompt: "application-owned prompt",
    });
  });

  it("treats an explicit empty allowedTools list as no tools allowed", async () => {
    const policy = createAgentProfilePolicy({
      id: "locked-down",
      allowedTools: [],
    });

    await expect(
      policy.decide({
        action: "tool.execute",
        metadata: {
          toolName: "read",
        },
      }),
    ).resolves.toMatchObject({
      decision: "deny",
      reason: "Tool is outside agent allowed tools: read",
    });

    const derived = deriveChildAgentProfile({
      parentAgent: {
        id: "parent",
        allowedTools: [],
      },
      childAgent: {
        id: "child",
        allowedTools: ["read"],
      },
    });

    expect(derived.effectiveProfile.allowedTools).toEqual([]);
  });

  it("uses the core default policy when no fallback is supplied", async () => {
    const policy = createAgentProfilePolicy({
      id: "worker",
    });

    await expect(
      policy.decide({
        action: "workspace.write",
        metadata: {
          path: "README.md",
        },
      }),
    ).resolves.toMatchObject({
      decision: "requires_approval",
      reason: "Workspace writes require approval by default.",
    });
  });

  it("falls back when no profile rule matches", async () => {
    const policy = createAgentProfilePolicy(
      {
        id: "worker",
      },
      {
        decide({ action, metadata = {} }) {
          return {
            action,
            decision: "requires_approval",
            reason: "Fallback approval.",
            metadata,
          };
        },
      },
    );

    await expect(
      policy.decide({
        action: "workspace.write",
      }),
    ).resolves.toMatchObject({
      decision: "requires_approval",
      reason: "Fallback approval.",
    });
  });
});

describe("spawnSubAgent", () => {
  it("stamps parentRunId + spanId on child metadata and forwards abort", async () => {
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      maxSteps: 1,
    });
    const childModel: ModelAdapter = {
      async complete() {
        return { message: "child done" };
      },
    };
    const spawned = spawnSubAgent({
      parent,
      goal: "child task",
      model: childModel,
      maxSteps: 1,
    });

    expect(spawned.run.record.metadata?.parentRunId).toBe(parent.record.id);
    expect(spawned.run.record.metadata?.spanId).toBe(spawned.spanId);
    expect(spawned.spanId).toMatch(/^spn_/);
    // Child's own abort signal must mirror the parent's: cancelling the
    // parent flips the child's signal too.
    expect(spawned.run.abortSignal.aborted).toBe(false);
    parent.cancel({ reason: "parent cancelled" });
    expect(spawned.run.abortSignal.aborted).toBe(true);
  });

  it("rolls up child tool + model usage into the parent tracker", async () => {
    const parentTracker = createUsageTracker({
      runId: "run_parent" as never,
    });
    const parentModel: ModelAdapter = {
      async complete() {
        return { message: "parent done" };
      },
    };
    const parent = createRun({
      goal: "parent",
      model: parentModel,
      usageTracker: parentTracker,
      maxSteps: 1,
    });

    const childTool = defineTool({
      name: "echo",
      description: "echo",
      inputSchema: { type: "object", properties: {} },
      policy: { risk: "safe" },
      execute() {
        return "ok";
      },
    });
    let childCalls = 0;
    const childModel: ModelAdapter = {
      async complete() {
        childCalls += 1;
        if (childCalls === 1) {
          return {
            toolCalls: [{ toolName: "echo", arguments: {} }],
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          };
        }
        return {
          message: "child done",
          usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
        };
      },
    };

    const spawned = spawnSubAgent({
      parent,
      goal: "child",
      model: childModel,
      tools: [childTool],
      maxSteps: 3,
      parentUsageTracker: parentTracker,
    });

    await spawned.run.start();
    const snap = parentTracker.snapshot();
    // Parent emitted no model/tool calls; everything came from the child.
    expect(snap.toolCalls).toBe(1);
    expect(snap.modelCalls).toBe(2);
    expect(snap.byTool["echo"]?.calls).toBe(1);
    expect(snap.tokens.total).toBe(22);
  });

  it("detaches usage rollup on terminal child events", async () => {
    const parentTracker = createUsageTracker({
      runId: "run_parent" as never,
    });
    const childModel: ModelAdapter = {
      async complete() {
        return {
          message: "done",
          usage: { totalTokens: 3 },
        };
      },
    };
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      maxSteps: 1,
    });
    const spawned = spawnSubAgent({
      parent,
      goal: "child",
      model: childModel,
      maxSteps: 1,
      parentUsageTracker: parentTracker,
    });
    await spawned.run.start();
    const tokensAfterTerminal = parentTracker.snapshot().tokens.total;
    // Subsequent emits on child should NOT be rolled into the parent tracker.
    spawned.run.events.emit("model.completed", {
      message: "ghost",
      usage: { totalTokens: 999 },
    });
    expect(parentTracker.snapshot().tokens.total).toBe(tokensAfterTerminal);
  });

  it("can persist child traces into a session agent directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-agent-session-"));
    tempDirs.push(root);
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      maxSteps: 1,
    });
    const childModel: ModelAdapter = {
      async complete() {
        return { message: "child done" };
      },
    };

    const spawned = spawnSubAgent({
      parent,
      goal: "child",
      model: childModel,
      childAgentProfile: {
        id: "reviewer",
        name: "Reviewer",
      },
      maxSteps: 1,
      runStore: (run) =>
        new FileRunStore(run, {
          sessionRootDir: root,
          sessionId: "session_agents",
        }),
    });

    await spawned.run.start();

    const sessionDir = join(root, "session_agents");
    const sessionTrace = await readFile(
      join(sessionDir, "trace.jsonl"),
      "utf8",
    );
    const agentTrace = await readFile(
      join(sessionDir, "agents", "reviewer", "trace.jsonl"),
      "utf8",
    );
    const sessionJson = JSON.parse(
      await readFile(join(sessionDir, "session.json"), "utf8"),
    ) as { runIds: string[]; agents: string[] };

    expect(spawned.run.record.metadata).toMatchObject({
      parentRunId: parent.record.id,
      agentId: "reviewer",
      agentProfileId: "reviewer",
      agentName: "Reviewer",
    });
    expect(sessionTrace).toContain(spawned.childRunId);
    expect(agentTrace).toContain('"agentId":"reviewer"');
    expect(sessionJson).toMatchObject({
      runIds: [spawned.childRunId],
      agents: ["reviewer"],
    });
  });
});

describe("createAgentTool / mountAgentTool", () => {
  it("makes a tool the parent LLM can call to delegate", async () => {
    const childModel: ModelAdapter = {
      async complete() {
        return { message: "child reply" };
      },
    };

    const parentModel: ModelAdapter = {
      async complete(input) {
        // First turn: call the delegate tool.
        const hasToolResult = input.context.some((item) =>
          item.content.includes("childRunId"),
        );
        if (!hasToolResult) {
          return {
            toolCalls: [
              {
                toolName: "delegate",
                arguments: { goal: "do the child thing" },
              },
            ],
          };
        }
        return { message: "parent saw child summary" };
      },
    };

    const parent = createRun({
      goal: "parent uses a sub-agent",
      model: parentModel,
      maxSteps: 3,
    });

    mountAgentTool(parent, {
      buildSpawnInput: (input) => ({
        goal: input.goal,
        model: childModel,
        maxSteps: 1,
      }),
    });

    const result = await parent.start();
    expect(result.signal).toBe("completed");
    expect(result.message).toBe("parent saw child summary");
  });

  it("returns a structured child result from the delegate tool", async () => {
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      maxSteps: 1,
    });
    const tool = createAgentTool(() => parent, {
      buildSpawnInput: (input) => ({
        goal: input.goal,
        model: {
          async complete() {
            return { message: "child done" };
          },
        },
        maxSteps: 1,
      }),
    });

    const output = await tool.execute({ goal: "inspect files" }, {
      run: parent.record,
    } as never);

    expect(output).toMatchObject({
      signal: "completed",
      stopReason: "final_answer",
      message: "child done",
      toolCalls: 0,
      modelCalls: 1,
    });
    expect(typeof output).toBe("object");
  });

  it("fails the delegate tool when the child run fails", async () => {
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      maxSteps: 1,
    });
    const tool = createAgentTool(() => parent, {
      buildSpawnInput: (input) => ({
        goal: input.goal,
        model: {
          async complete() {
            throw new Error("child failed");
          },
        },
        maxSteps: 1,
      }),
    });

    await expect(
      tool.execute({ goal: "doomed" }, { run: parent.record } as never),
    ).rejects.toMatchObject({
      code: "SUBAGENT_RUN_FAILED",
      metadata: {
        signal: "failed",
        stopReason: "model_completion_failed",
      },
    });
  });

  it("short-circuits similar repeated delegate calls after success", async () => {
    let childCalls = 0;
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      maxSteps: 1,
    });
    const tool = createAgentTool(() => parent, {
      buildSpawnInput: (input) => ({
        goal: input.goal,
        model: {
          async complete() {
            childCalls += 1;
            return { message: "root entries: README.md, packages/" };
          },
        },
        maxSteps: 1,
      }),
    });

    const first = await tool.execute(
      { goal: "查看当前 workspace root 下有哪些文件和目录" },
      { run: parent.record } as never,
    );
    const second = await tool.execute(
      { goal: "查看当前工作区根目录有哪些文件/文件夹，并列出顶层条目" },
      { run: parent.record } as never,
    );

    expect(first).toMatchObject({ signal: "completed" });
    expect(second).toMatchObject({
      signal: "completed",
      alreadyCompleted: true,
      message: "root entries: README.md, packages/",
    });
    expect(childCalls).toBe(1);
  });

  it("emits subagent.requested → started → completed on the parent", async () => {
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      maxSteps: 1,
    });
    const childModel: ModelAdapter = {
      async complete() {
        return { message: "child done" };
      },
    };

    const parentEvents: string[] = [];
    parent.events.subscribe((event) => {
      if (event.type.startsWith("subagent.")) parentEvents.push(event.type);
    });

    const spawned = spawnSubAgent({
      parent,
      goal: "child task",
      model: childModel,
      maxSteps: 1,
    });

    // `requested` must fire synchronously at spawn time — before .start().
    expect(parentEvents).toEqual(["subagent.requested"]);

    await spawned.run.start();

    expect(parentEvents).toEqual([
      "subagent.requested",
      "subagent.started",
      "subagent.completed",
    ]);

    const requested = parent.events
      .all()
      .find((event) => event.type === "subagent.requested");
    expect(requested?.payload).toMatchObject({
      childRunId: spawned.childRunId,
      parentRunId: parent.record.id,
      spanId: spawned.spanId,
      goal: "child task",
    });
  });

  it("carries the child's agentName/agentProfileId on every subagent phase", async () => {
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      maxSteps: 1,
    });
    const childModel: ModelAdapter = {
      async complete() {
        return { message: "child done" };
      },
    };

    const spawned = spawnSubAgent({
      parent,
      goal: "child task",
      model: childModel,
      maxSteps: 1,
      childAgentProfile: {
        id: "dynamic_project_scanner",
        name: "project-scanner",
        mode: "child",
      },
    });
    await spawned.run.start();

    // Without this, `started`/`completed` bridge from the child's own EventLog
    // and drop the profile, so a UI falls back to the opaque childRunId.
    for (const type of [
      "subagent.requested",
      "subagent.started",
      "subagent.completed",
    ]) {
      const event = parent.events.all().find((e) => e.type === type);
      expect(event?.metadata, type).toMatchObject({
        agentName: "project-scanner",
        agentProfileId: "dynamic_project_scanner",
      });
    }
  });

  it("emits subagent.failed when the child fails", async () => {
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      maxSteps: 1,
    });
    const childModel: ModelAdapter = {
      async complete() {
        throw new Error("child blew up");
      },
    };

    const parentEvents: string[] = [];
    parent.events.subscribe((event) => {
      if (event.type.startsWith("subagent.")) parentEvents.push(event.type);
    });

    const spawned = spawnSubAgent({
      parent,
      goal: "doomed",
      model: childModel,
      maxSteps: 1,
    });

    await spawned.run.start();

    expect(parentEvents).toContain("subagent.requested");
    expect(parentEvents).toContain("subagent.failed");
    expect(parentEvents).not.toContain("subagent.completed");
  });

  it("refuses nested spawn when forbidNesting is set", async () => {
    const childModel: ModelAdapter = {
      async complete() {
        return { message: "child reply" };
      },
    };
    const grandchildModel = childModel;

    // Build a parent that itself looks like a sub-agent.
    const subParent = createRun({
      goal: "i am already a sub-agent",
      model: childModel,
      maxSteps: 3,
      metadata: { parentRunId: "run_root" },
    });

    const tool = createAgentTool(() => subParent, {
      forbidNesting: true,
      buildSpawnInput: (input) => ({
        goal: input.goal,
        model: grandchildModel,
        maxSteps: 1,
      }),
    });

    await expect(
      tool.execute({ goal: "try to nest" }, {
        run: subParent.record,
      } as never),
    ).rejects.toThrow(/refused to nest/);
  });

  it("derives a child prompt builder from the profile's app prompt", async () => {
    const parent = createRun({
      goal: "parent",
      model: {
        async complete() {
          return { message: "parent done" };
        },
      },
      maxSteps: 1,
    });

    let childPromptText = "";
    const childModel: ModelAdapter = {
      async complete(input) {
        childPromptText = (input.prompt ?? [])
          .map((message) => message.content)
          .join("\n");
        return { message: "child done" };
      },
    };

    const spawned = spawnSubAgent({
      parent,
      goal: "child task",
      model: childModel,
      maxSteps: 1,
      childAgentProfile: {
        id: "specialist",
        experimental: { prompt: "You are the specialist sub-agent." },
      },
    });
    await spawned.run.start();

    expect(childPromptText).toContain("You are the specialist sub-agent.");
    // harness resident contracts still apply alongside the app prompt.
    expect(childPromptText).toContain("Tool use contract:");
  });

  it("lets an explicit promptBuilder override the profile-derived one", () => {
    const profile: AgentProfile = {
      id: "specialist",
      experimental: { prompt: "App prompt." },
    };

    const builder = promptBuilderForAgentProfile(profile);
    expect(builder).toBeDefined();

    const noPrompt = promptBuilderForAgentProfile({ id: "bare" });
    expect(noPrompt).toBeUndefined();
  });

  it("includes a profile-derived prompt builder in compiled run options", () => {
    const withPrompt = compileAgentProfileRunOptions({
      id: "specialist",
      experimental: { prompt: "App prompt." },
    });
    expect(withPrompt.promptBuilder).toBeDefined();

    const withoutPrompt = compileAgentProfileRunOptions({ id: "bare" });
    expect(withoutPrompt.promptBuilder).toBeUndefined();
  });
});
