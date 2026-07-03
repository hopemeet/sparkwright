import { describe, expect, it } from "vitest";
import {
  CompactingContextAssembler,
  DefaultContextAssembler,
  DefaultObservationFormatter,
  DefaultPromptBuilder,
  SectionedPromptBuilder,
  compilePromptCacheBlocks,
  createAppPromptSection,
  createEnvironmentSection,
  createToolGuidanceSection,
  createModelAdaptiveSection,
  createArtifactId,
  createContextItemId,
  createRunId,
  type ContextItem,
  type RunRecord,
  type ToolDescriptor,
} from "../src/index.js";

describe("DefaultContextAssembler", () => {
  it("keeps ALL tool observations append-only when within budget", () => {
    // Append-only path: with no real budget pressure, the recency window does
    // NOT fire — every tool result is kept so the prompt prefix stays
    // cache-stable across steps.
    const assembler = new DefaultContextAssembler({
      budget: {
        recentToolResultLimit: 2,
      },
    });
    const context = [
      toolResult("one"),
      userContext("keep user"),
      toolResult("two"),
      toolResult("three"),
    ];

    const result = assembler.assemble({
      run: createRunRecord(),
      step: 2,
      goal: "test",
      events: [],
      priorContext: context,
    });

    expect(result.items.map((item) => item.content)).toEqual([
      "one",
      "keep user",
      "two",
      "three",
    ]);
    expect(
      result.omitted.some((o) => o.reason === "older_tool_result_replaced"),
    ).toBe(false);
  });

  it("applies the recency window only under budget pressure (compaction)", () => {
    // Once the hard item-count ceiling is exceeded, append-only gives way to a
    // compaction pass: the recency window drops the oldest tool result.
    const assembler = new DefaultContextAssembler({
      budget: {
        recentToolResultLimit: 2,
        maxItems: 3,
      },
    });
    const context = [
      toolResult("one"),
      userContext("keep user"),
      toolResult("two"),
      toolResult("three"),
    ];

    const result = assembler.assemble({
      run: createRunRecord(),
      step: 2,
      goal: "test",
      events: [],
      priorContext: context,
    });

    expect(result.items.map((item) => item.content)).toEqual([
      "keep user",
      "two",
      "three",
    ]);
    expect(result.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "older_tool_result_replaced",
        }),
      ]),
    );
  });

  it("truncates individual context items and records the omission reason", () => {
    const assembler = new DefaultContextAssembler({
      budget: {
        maxItemChars: 5,
      },
    });

    const result = assembler.assemble({
      run: createRunRecord(),
      step: 1,
      goal: "test",
      events: [],
      priorContext: [userContext("0123456789")],
    });

    expect(result.items[0]?.content).toContain("[truncated 5 chars]");
    expect(result.items[0]?.metadata).toMatchObject({
      truncated: true,
      originalChars: 10,
    });
    expect(result.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "item_truncated",
        }),
      ]),
    );
  });

  it("enforces total context budget with omitted metadata", () => {
    const assembler = new DefaultContextAssembler({
      budget: {
        maxTotalChars: 6,
      },
    });

    const result = assembler.assemble({
      run: createRunRecord(),
      step: 1,
      goal: "test",
      events: [],
      priorContext: [userContext("1234"), userContext("5678")],
    });

    expect(result.items).toHaveLength(1);
    expect(result.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "max_total_chars_exceeded",
        }),
      ]),
    );
  });

  it("enforces max item count with omitted metadata", () => {
    const assembler = new DefaultContextAssembler({
      budget: {
        maxItems: 1,
      },
    });

    const result = assembler.assemble({
      run: createRunRecord(),
      step: 1,
      goal: "test",
      events: [],
      priorContext: [userContext("first"), userContext("second")],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.content).toBe("first");
    expect(result.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "max_items_exceeded",
        }),
      ]),
    );
  });

  it("adds default layer and stability metadata", () => {
    const assembler = new DefaultContextAssembler();

    const result = assembler.assemble({
      run: createRunRecord(),
      step: 1,
      goal: "test",
      events: [],
      priorContext: [systemContext("rules"), toolResult("observation")],
    });

    expect(result.items[0]?.metadata).toMatchObject({
      layer: "resident",
      stability: "stable",
    });
    expect(result.items[1]?.metadata).toMatchObject({
      layer: "working",
      stability: "turn",
    });
  });
});

describe("CompactingContextAssembler", () => {
  it("compacts prior context when the base assembler reports budget pressure", async () => {
    const base = new DefaultContextAssembler({
      budget: {
        maxTotalChars: 12,
      },
    });
    const calls: Array<{
      items: ContextItem[];
      reasons: string[] | undefined;
    }> = [];
    const assembler = new CompactingContextAssembler({
      base,
      compactor: {
        compact(items, hints) {
          calls.push({
            items,
            reasons: hints.reasons,
          });

          return [summaryContext("summary")];
        },
      },
    });
    const priorContext = [userContext("1234567890"), userContext("abcdefghij")];

    const result = await assembler.assemble({
      run: createRunRecord(),
      step: 1,
      goal: "test compaction",
      events: [],
      priorContext,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.items).toBe(priorContext);
    expect(calls[0]?.reasons).toEqual(["max_total_chars_exceeded"]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      type: "summary",
      content: "summary",
      metadata: {
        layer: "working",
        stability: "session",
      },
    });
    expect(result.omitted).toEqual([]);
    expect(result.metadata.compaction).toMatchObject({
      triggered: true,
      reasons: ["max_total_chars_exceeded"],
      preCompactSelectedCount: 1,
      preCompactOmittedCount: 1,
      compactedItemCount: 1,
      summaryItemCount: 1,
    });
  });

  it("does not compact when the base assembler fits the budget", async () => {
    let compactCalls = 0;
    const assembler = new CompactingContextAssembler({
      base: new DefaultContextAssembler(),
      compactor: {
        compact() {
          compactCalls += 1;
          return [summaryContext("unused")];
        },
      },
    });

    const result = await assembler.assemble({
      run: createRunRecord(),
      step: 1,
      goal: "test no compaction",
      events: [],
      priorContext: [userContext("fits")],
    });

    expect(compactCalls).toBe(0);
    expect(result.items.map((item) => item.content)).toEqual(["fits"]);
    expect(result.metadata.compaction).toMatchObject({
      triggered: false,
    });
  });
});

describe("DefaultPromptBuilder", () => {
  it("orders stable prompt messages before dynamic runtime and context messages", async () => {
    const builder = new DefaultPromptBuilder({
      residentInstructions: "Stable rules.",
    });
    const messages = await builder.build({
      run: createRunRecord(),
      step: 3,
      tools: [toolDescriptor()],
      context: [userContext("selected context")],
    });

    expect(messages.map((message) => message.stability)).toEqual([
      "stable",
      "stable",
      "stable",
      "stable",
      "stable",
      "stable",
      "session",
      "turn",
      "turn",
    ]);
    expect(messages.map((message) => message.role)).toEqual([
      "system",
      "system",
      "system",
      "system",
      "system",
      "system",
      "system",
      "user",
      "user",
    ]);
    expect(messages[0]?.metadata).toMatchObject({ layer: "resident" });
    expect(messages[6]?.metadata).toMatchObject({
      layer: "capability",
      kind: "tool_descriptors",
      sectionName: "tool_descriptors",
      cachePolicy: "session",
    });
    expect(messages[7]?.metadata).toMatchObject({
      layer: "runtime",
      kind: "current_request",
    });
    expect(messages[8]?.metadata).toMatchObject({
      layer: "working",
      kind: "selected_context",
    });
    expect(messages[0]?.content).toBe("Stable rules.");
    expect(messages[1]?.content).toContain("Tool use contract:");
    expect(messages[6]?.content).toContain("Available tools:");
    expect(messages[6]?.content).toContain("- echo (text?:string): Echo text.");
    expect(messages[6]?.content).not.toContain("requiresApproval: false");
    expect(messages[6]?.content).not.toContain("inputSchema:");
    expect(messages[6]?.content).not.toContain("outputSchema:");
    expect(messages[6]?.content).not.toContain("governance:");
    expect(messages[7]?.content).toBe("User request:\ninspect repo");
    expect(messages[8]?.content).toContain("selected context");
    expect(messages.map((message) => message.metadata)).toMatchObject([
      {
        layer: "resident",
        sectionName: "resident_identity",
        cachePolicy: "stable",
      },
      {
        layer: "resident",
        sectionName: "tool_use_contract",
        cachePolicy: "stable",
      },
      {
        layer: "resident",
        sectionName: "safety_and_approval_contract",
        cachePolicy: "stable",
      },
      {
        layer: "resident",
        sectionName: "context_contract",
        cachePolicy: "stable",
      },
      {
        layer: "resident",
        sectionName: "output_contract",
        cachePolicy: "stable",
      },
      {
        layer: "resident",
        sectionName: "development_task_contract",
        cachePolicy: "stable",
      },
      {
        layer: "capability",
        sectionName: "tool_descriptors",
        cachePolicy: "session",
      },
      {
        layer: "runtime",
        sectionName: "current_request",
        cachePolicy: "turn",
      },
      {
        layer: "working",
        sectionName: "selected_context",
        cachePolicy: "turn",
      },
    ]);
  });

  it("omits selected context message when no context is selected", async () => {
    const builder = new DefaultPromptBuilder();
    const messages = await builder.build({
      run: createRunRecord(),
      step: 1,
      tools: [],
      context: [],
    });

    // resident(6) + tool_descriptors(1) + current_request(1);
    // selected_context is omitted (no context), capability_delta omitted (no
    // deferred tools), and long-term goal/progress are opt-in.
    expect(messages).toHaveLength(8);
    expect(messages[6]?.content).toBe("Available tools: none.");
    expect(messages[7]).toMatchObject({
      role: "user",
      content: "User request:\ninspect repo",
      metadata: {
        sectionName: "current_request",
        cachePolicy: "turn",
      },
    });
  });

  it("emits media context as content parts on a user prompt message", async () => {
    const builder = new DefaultPromptBuilder();
    const media = userContext("Attached image for the request.");
    media.parts = [
      {
        type: "image",
        data: "iVBORw0KGgo=",
        mediaType: "image/png",
        name: "screenshot.png",
      },
    ];

    const messages = await builder.build({
      run: createRunRecord(),
      step: 1,
      tools: [],
      context: [userContext("plain context"), media],
    });

    const mediaMessage = messages.find(
      (message) => message.metadata?.sourceItemId === media.id,
    );
    expect(mediaMessage).toMatchObject({
      role: "user",
      metadata: { kind: "selected_context", mediaPartCount: 1 },
    });
    expect(mediaMessage?.parts).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Attached image for the request."),
      }),
      {
        type: "image",
        data: "iVBORw0KGgo=",
        mediaType: "image/png",
        name: "screenshot.png",
      },
    ]);
  });

  it("can omit current_request when an embedder supplies the user turn elsewhere", async () => {
    const builder = new DefaultPromptBuilder({ includeCurrentRequest: false });
    const messages = await builder.build({
      run: createRunRecord(),
      step: 1,
      tools: [],
      context: [],
    });

    expect(
      messages.some(
        (message) => message.metadata?.sectionName === "current_request",
      ),
    ).toBe(false);
  });

  it("renders skill_index as a session-cached section outside selected_context", async () => {
    const builder = new DefaultPromptBuilder();
    const messages = await builder.build({
      run: createRunRecord(),
      step: 1,
      tools: [],
      context: [
        skillIndexContext([
          {
            name: "spark-tester",
            description: "Run focused SparkWright test workflows.",
            sourcePath: "/repo/skills/spark-tester/SKILL.md",
            contentHash: "hash-test",
          },
        ]),
        userContext("current working note"),
      ],
    });

    const skillIndex = messages.find(
      (message) => message.metadata?.sectionName === "skill_index",
    );
    const selected = messages.find(
      (message) => message.metadata?.sectionName === "selected_context",
    );

    expect(skillIndex).toMatchObject({
      role: "system",
      stability: "session",
      metadata: {
        layer: "skill_index",
        kind: "skill_index",
        cachePolicy: "session",
      },
    });
    expect(skillIndex?.content).toContain("Skill index:");
    expect(skillIndex?.content).toContain(
      "- spark-tester: Run focused SparkWright test workflows.",
    );
    expect(skillIndex?.content).not.toContain("sourcePath");
    expect(skillIndex?.content).not.toContain("contentHash");
    expect(selected?.content).toContain("current working note");
    expect(selected?.content).not.toContain("spark-tester");
  });

  it("projects model-visible context sources without host absolute paths", async () => {
    const builder = new DefaultPromptBuilder();
    const skillPath = "/var/folders/test/.sparkwright/skills/inline/SKILL.md";
    const filePath = "/Users/alice/project/private-notes.md";
    const fileUri = "file:///Users/alice/project/secret.txt";
    const messages = await builder.build({
      run: createRunRecord(),
      step: 1,
      tools: [],
      context: [
        {
          id: createContextItemId(),
          type: "system",
          source: { kind: "skill" },
          content: "Skill body",
          metadata: {
            layer: "resident",
            skillName: "inline-skill",
            skillSourcePath: skillPath,
          },
        },
        {
          id: createContextItemId(),
          type: "file",
          source: { kind: "file", path: filePath },
          content: "File body",
          metadata: {},
        },
        {
          id: createContextItemId(),
          type: "summary",
          source: { kind: "artifact", uri: fileUri },
          content: "Artifact body",
          metadata: {},
        },
      ],
    });

    const selected = messages.find(
      (message) => message.metadata?.sectionName === "selected_context",
    );
    expect(selected?.content).toContain("source: skill:inline-skill");
    expect(selected?.content).toContain("source: file");
    expect(selected?.content).toContain("source: artifact");
    expect(selected?.content).not.toContain(skillPath);
    expect(selected?.content).not.toContain(filePath);
    expect(selected?.content).not.toContain(fileUri);
    expect(selected?.content).not.toMatch(
      /(?:\/var\/folders|\/Users\/alice|file:\/\/\/Users\/alice|[A-Za-z]:\\)/,
    );
  });

  it("keeps skill source provenance in omission diagnostics", () => {
    const assembler = new DefaultContextAssembler({
      budget: { maxItems: 0 },
    });
    const skillPath = "/var/folders/test/.sparkwright/skills/inline/SKILL.md";
    const result = assembler.assemble({
      run: createRunRecord(),
      step: 1,
      goal: "test",
      events: [],
      priorContext: [
        {
          id: createContextItemId(),
          type: "system",
          source: { kind: "skill" },
          content: "Skill body",
          metadata: {
            layer: "resident",
            skillName: "inline-skill",
            skillSourcePath: skillPath,
          },
        },
      ],
    });

    expect(result.items).toEqual([]);
    expect(result.omitted).toEqual([
      expect.objectContaining({
        source: skillPath,
        reason: "max_items_exceeded",
      }),
    ]);
  });

  it("renders the run goal only when explicitly enabled", async () => {
    const builder = new DefaultPromptBuilder({ includeGoal: true });
    const messages = await builder.build({
      run: { ...createRunRecord(), goal: "ship the feature" },
      step: 1,
      tools: [],
      context: [],
    });

    const goal = messages.find(
      (message) => message.metadata?.sectionName === "run_goal",
    );
    expect(goal).toMatchObject({
      role: "user",
      content: "Goal:\nship the feature",
      stability: "session",
      metadata: {
        layer: "runtime",
        cachePolicy: "session",
      },
    });
    expect(goal?.content).not.toContain("Run state:");
  });

  it("renders the step ceiling in runtime_progress only when explicitly enabled", async () => {
    const builder = new DefaultPromptBuilder({ includeRuntimeProgress: true });
    const messages = await builder.build({
      run: createRunRecord(),
      step: 5,
      maxSteps: 8,
      tools: [],
      context: [],
    });

    const progress = messages.find(
      (message) => message.metadata?.sectionName === "runtime_progress",
    );
    expect(progress?.metadata?.sectionName).toBe("runtime_progress");
    // Surfacing the ceiling lets the model see remaining budget instead of
    // guessing it has run out — the cause of premature give-ups.
    expect(progress?.content).toBe("Step: 5 / 8");
  });

  it("returns synchronously when all sections are synchronous", () => {
    const builder = new DefaultPromptBuilder();
    const messages = builder.build({
      run: createRunRecord(),
      step: 1,
      tools: [],
      context: [],
    });

    expect(Array.isArray(messages)).toBe(true);
  });

  it("appends additional sections and sorts them by order", async () => {
    const builder = new DefaultPromptBuilder({
      residentInstructions: "Stable rules.",
      additionalSections: [
        {
          name: "after_context",
          order: 120,
          role: "user",
          layer: "memory",
          stability: "session",
          cachePolicy: "session",
          build: () => "Remember project preference.",
        },
        {
          name: "before_runtime",
          order: 90,
          role: "system",
          layer: "runtime",
          stability: "turn",
          cachePolicy: "volatile",
          volatileReason: "test clock",
          build: (input) => `Clock step ${input.step}`,
        },
      ],
    });

    const messages = await builder.build({
      run: createRunRecord(),
      step: 4,
      tools: [toolDescriptor()],
      context: [userContext("selected context")],
    });

    expect(messages.map((message) => message.metadata?.sectionName)).toEqual([
      "resident_identity",
      "tool_use_contract",
      "safety_and_approval_contract",
      "context_contract",
      "output_contract",
      "development_task_contract",
      "tool_descriptors",
      "before_runtime",
      "current_request",
      "selected_context",
      "after_context",
    ]);
    expect(messages[7]).toMatchObject({
      role: "system",
      content: "Clock step 4",
      stability: "turn",
      metadata: {
        sectionName: "before_runtime",
        cachePolicy: "volatile",
        layer: "runtime",
        volatileReason: "test clock",
      },
    });
    expect(messages[10]).toMatchObject({
      role: "user",
      content: "Remember project preference.",
      stability: "session",
      metadata: {
        sectionName: "after_context",
        cachePolicy: "session",
        layer: "memory",
      },
    });
  });

  it("surfaces deferred tools as a volatile capability delta", async () => {
    const builder = new DefaultPromptBuilder({
      residentInstructions: "Stable rules.",
    });
    const messages = await builder.build({
      run: createRunRecord(),
      step: 1,
      tools: [
        toolDescriptor(),
        {
          ...toolDescriptor(),
          name: "tool_search",
          description: "Discover deferred tools.",
        },
        {
          ...toolDescriptor(),
          name: "deferred_search",
          description: "Search a large external catalog.",
          loading: { defer: true },
        },
      ],
      context: [],
    });

    const toolDescriptorMessage = messages.find(
      (message) => message.metadata?.sectionName === "tool_descriptors",
    );
    const capabilityDelta = messages.find(
      (message) => message.metadata?.sectionName === "capability_delta",
    );

    expect(toolDescriptorMessage?.content).toContain("echo");
    expect(toolDescriptorMessage?.content).not.toContain("deferred_search");
    expect(capabilityDelta).toMatchObject({
      role: "user",
      stability: "turn",
      metadata: {
        layer: "capability",
        cachePolicy: "volatile",
        kind: "capability_delta",
      },
    });
    expect(capabilityDelta?.content).toContain("deferred_search");
    expect(capabilityDelta?.content).toContain(
      "Search a large external catalog",
    );
    expect(capabilityDelta?.content).toContain("Advanced and infrastructure");
    expect(capabilityDelta?.content).toContain("tool_search");
  });

  it("omits capability delta when discovery is disabled", async () => {
    const builder = new DefaultPromptBuilder({
      residentInstructions: "Stable rules.",
    });
    const messages = await builder.build({
      run: createRunRecord(),
      step: 1,
      tools: [
        toolDescriptor(),
        {
          ...toolDescriptor(),
          name: "deferred_search",
          description: "Search a large external catalog.",
          loading: { defer: true },
        },
      ],
      context: [],
    });

    expect(
      messages.find(
        (message) => message.metadata?.sectionName === "capability_delta",
      ),
    ).toBeUndefined();
  });

  it("compiles prompt messages into cache-policy blocks", async () => {
    const builder = new DefaultPromptBuilder({
      residentInstructions: "Stable rules.",
      additionalSections: [
        {
          name: "memory_note",
          order: 120,
          role: "user",
          layer: "memory",
          stability: "session",
          cachePolicy: "session",
          build: () => "Session memory.",
        },
      ],
    });

    const messages = await builder.build({
      run: createRunRecord(),
      step: 1,
      tools: [toolDescriptor()],
      context: [userContext("selected context")],
    });
    const compiled = compilePromptCacheBlocks(messages);

    expect(compiled.stablePrefix).toHaveLength(1);
    expect(compiled.stablePrefix[0]?.sectionNames).toEqual([
      "resident_identity",
      "tool_use_contract",
      "safety_and_approval_contract",
      "context_contract",
      "output_contract",
      "development_task_contract",
    ]);
    expect(compiled.sessionBlocks.map((block) => block.sectionNames)).toEqual([
      ["tool_descriptors"],
      ["memory_note"],
    ]);
    expect(compiled.turnBlocks.map((block) => block.sectionNames)).toEqual([
      ["current_request", "selected_context"],
    ]);
  });

  it("keeps the prompt prefix byte-stable across steps as context grows (cache invariant)", async () => {
    const builder = new DefaultPromptBuilder({
      residentInstructions: "Stable rules.",
    });
    const run = createRunRecord();
    const tools = [toolDescriptor()];

    // Append-only growth: step N's context is a prefix of step N+1's. This is
    // the normal (non-compaction) path.
    const buildStep = (step: number, context: ContextItem[]) =>
      builder.build({ run, step, tools, context });

    const ctx1 = [userContext("obs 1")];
    const ctx2 = [...ctx1, userContext("obs 2")];
    const ctx3 = [...ctx2, userContext("obs 3")];

    const m1 = await buildStep(1, ctx1);
    const m2 = await buildStep(2, ctx2);
    const m3 = await buildStep(3, ctx3);

    // Everything up to and including selected_context must be identical across
    // steps EXCEPT that selected_context grows by appending. Concretely: the
    // serialized prefix at step N must be a prefix of step N+1's.
    const prefixThrough = (messages: typeof m1, sectionName: string) => {
      const end = messages.findIndex(
        (msg) => msg.metadata?.["sectionName"] === sectionName,
      );
      return messages
        .slice(0, end + 1)
        .map((msg) => `${msg.role}:${msg.content}`)
        .join("\n---\n");
    };

    const p1 = prefixThrough(m1, "selected_context");
    const p2 = prefixThrough(m2, "selected_context");
    const p3 = prefixThrough(m3, "selected_context");

    expect(p2.startsWith(p1)).toBe(true);
    expect(p3.startsWith(p2)).toBe(true);

    // The stable system prefix before selected_context is byte-identical.
    const beforeContext = (messages: typeof m1) =>
      prefixThrough(messages, "tool_descriptors");
    expect(beforeContext(m1)).toBe(beforeContext(m2));
    expect(beforeContext(m2)).toBe(beforeContext(m3));

    expect(
      m1.some((msg) => msg.metadata?.["sectionName"] === "runtime_progress"),
    ).toBe(false);
  });

  it("builds custom sections in order with cache metadata", async () => {
    const builder = new SectionedPromptBuilder({
      sections: [
        {
          name: "runtime_delta",
          order: 20,
          role: "user",
          layer: "runtime",
          stability: "turn",
          cachePolicy: "volatile",
          volatileReason: "capability list can change between turns",
          build: () => "dynamic capability delta",
        },
        {
          name: "resident_rules",
          order: 10,
          role: "system",
          layer: "resident",
          stability: "stable",
          cachePolicy: "stable",
          build: () => "stable rules",
        },
      ],
    });

    const messages = await builder.build({
      run: createRunRecord(),
      step: 1,
      tools: [],
      context: [],
    });

    expect(messages.map((message) => message.content)).toEqual([
      "stable rules",
      "dynamic capability delta",
    ]);
    expect(messages[0]).toMatchObject({
      role: "system",
      stability: "stable",
      metadata: {
        layer: "resident",
        sectionName: "resident_rules",
        cachePolicy: "stable",
      },
    });
    expect(messages[1]).toMatchObject({
      role: "user",
      stability: "turn",
      metadata: {
        layer: "runtime",
        sectionName: "runtime_delta",
        cachePolicy: "volatile",
        volatileReason: "capability list can change between turns",
      },
    });
  });
});

describe("conversation_history prompt section", () => {
  it("emits prior turns as role-tagged session messages, mapping assistant items to assistant role", async () => {
    const builder = new DefaultPromptBuilder();
    const messages = await builder.build({
      run: createRunRecord(),
      step: 1,
      tools: [],
      context: [
        conversationItem("user", "turn one goal"),
        conversationItem("assistant", "turn one answer"),
        conversationItem("user", "turn two goal"),
      ],
    });

    const history = messages.filter(
      (m) => m.metadata?.kind === "conversation_history",
    );
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(history.map((m) => m.content)).toEqual([
      "turn one goal",
      "turn one answer",
      "turn two goal",
    ]);
    expect(history.every((m) => m.stability === "session")).toBe(true);
  });

  it("excludes conversation-layer items from selected_context", async () => {
    const builder = new DefaultPromptBuilder();
    const messages = await builder.build({
      run: createRunRecord(),
      step: 1,
      tools: [],
      context: [
        conversationItem("user", "prior goal"),
        conversationItem("assistant", "prior answer"),
        userContext("current working note"),
      ],
    });

    const selected = messages.filter(
      (m) => m.metadata?.kind === "selected_context",
    );
    const selectedText = selected.map((m) => m.content).join("\n");
    expect(selectedText).toContain("current working note");
    expect(selectedText).not.toContain("prior goal");
    expect(selectedText).not.toContain("prior answer");
  });

  it("places conversation history before selected_context", async () => {
    const builder = new DefaultPromptBuilder();
    const messages = await builder.build({
      run: createRunRecord(),
      step: 1,
      tools: [],
      context: [
        conversationItem("user", "prior goal"),
        userContext("current working note"),
      ],
    });

    const historyIdx = messages.findIndex(
      (m) => m.metadata?.kind === "conversation_history",
    );
    const selectedIdx = messages.findIndex(
      (m) => m.metadata?.kind === "selected_context",
    );
    expect(historyIdx).toBeGreaterThanOrEqual(0);
    expect(selectedIdx).toBeGreaterThanOrEqual(0);
    expect(historyIdx).toBeLessThan(selectedIdx);
  });
});

describe("createAppPromptSection", () => {
  it("injects an app system prompt into the cache-stable prefix", async () => {
    const builder = new DefaultPromptBuilder({
      additionalSections: [createAppPromptSection("You are the demo agent.")],
    });
    const messages = await builder.build({
      run: createRunRecord(),
      step: 1,
      tools: [],
      context: [],
    });

    const app = messages.find(
      (message) => message.metadata?.sectionName === "app_identity",
    );
    expect(app).toMatchObject({
      role: "system",
      content: "You are the demo agent.",
      metadata: { layer: "resident", cachePolicy: "stable" },
    });

    // app section sits after resident contracts, inside the stable prefix.
    const blocks = compilePromptCacheBlocks(messages);
    expect(blocks.stablePrefix.flatMap((b) => b.sectionNames)).toContain(
      "app_identity",
    );
  });

  it("omits an empty/blank app prompt", () => {
    const section = createAppPromptSection("   ");
    expect(
      section.build({
        run: createRunRecord(),
        step: 1,
        tools: [],
        context: [],
      }),
    ).toBeNull();
  });
});

describe("createEnvironmentSection", () => {
  it("renders an env block as a session-cached runtime section", () => {
    const section = createEnvironmentSection({
      cwd: "/repo",
      platform: "darwin",
      extra: { shell: "zsh" },
    });
    expect(section.cachePolicy).toBe("session");
    expect(section.role).toBe("user");
    expect(section.order).toBe(90);

    const content = section.build({
      run: createRunRecord(),
      step: 1,
      tools: [],
      context: [],
    }) as string;
    expect(content).toContain("<env>");
    expect(content).toContain("cwd: /repo");
    expect(content).toContain("platform: darwin");
    expect(content).toContain("shell: zsh");
    expect(content).toMatch(/date: \d{4}-\d{2}-\d{2}/);
  });

  it("returns null when no env values are provided", () => {
    const section = createEnvironmentSection(
      { includeDate: false },
      { order: 120 },
    );
    expect(
      section.build({
        run: createRunRecord(),
        step: 1,
        tools: [],
        context: [],
      }),
    ).toBeNull();
  });
});

describe("createToolGuidanceSection", () => {
  it("emits guidance only when a matching tool is present", () => {
    const section = createToolGuidanceSection({
      name: "echo_guidance",
      whenTool: "echo",
      guidance: "Use echo carefully.",
    });
    const input = (tools: ToolDescriptor[]) => ({
      run: createRunRecord(),
      step: 1,
      tools,
      context: [],
    });

    expect(section.build(input([toolDescriptor()]))).toBe(
      "Use echo carefully.",
    );
    expect(section.build(input([]))).toBeNull();
  });
});

describe("createModelAdaptiveSection", () => {
  it("matches the first rule against run.metadata.modelId", () => {
    const section = createModelAdaptiveSection({
      name: "model_guidance",
      rules: [
        { match: "provider-a", guidance: "provider-a tips" },
        { match: /gpt/, guidance: "gpt tips" },
      ],
    });
    const withModel = (modelId?: string) => ({
      run: { ...createRunRecord(), metadata: modelId ? { modelId } : {} },
      step: 1,
      tools: [],
      context: [],
    });

    expect(section.build(withModel("vendor:provider-a-model"))).toBe(
      "provider-a tips",
    );
    expect(section.build(withModel("openai:gpt-4"))).toBe("gpt tips");
    expect(section.build(withModel("gemini-2"))).toBeNull();
    expect(section.build(withModel(undefined))).toBeNull();
  });
});

describe("DefaultObservationFormatter", () => {
  it("summarizes tool output and keeps artifact references", () => {
    const formatter = new DefaultObservationFormatter({
      maxOutputChars: 5,
    });
    const artifactId = createArtifactId();

    const item = formatter.format({
      toolName: "search",
      run: createRunRecord(),
      result: {
        toolCallId: "call_test" as never,
        status: "completed",
        output: "0123456789",
        artifacts: [
          {
            id: artifactId,
            runId: createRunId(),
            type: "log",
            name: "search output",
            path: "artifacts/search.log",
            metadata: {},
          },
        ],
      },
    });

    expect(item.type).toBe("tool_result");
    expect(item.metadata).toMatchObject({
      layer: "working",
      stability: "turn",
      toolName: "search",
      status: "completed",
      summarized: true,
      artifactRefs: [
        {
          id: artifactId,
          path: "artifacts/search.log",
          summary: "log:search output",
        },
      ],
    });
    expect(item.content).toContain('"preview":"01234"');
    expect(item.content).not.toContain("56789");
  });

  it("keeps small scalar arrays intact so discovery results are actionable", () => {
    const formatter = new DefaultObservationFormatter({
      maxOutputChars: 200,
    });

    const item = formatter.format({
      toolName: "glob",
      run: createRunRecord(),
      result: {
        toolCallId: "call_test" as never,
        status: "completed",
        output: {
          patterns: ["packages/*/package.json"],
          paths: [
            "packages/core/package.json",
            "packages/host/package.json",
            "packages/tui/package.json",
          ],
          truncated: false,
        },
        artifacts: [],
      },
    });

    expect(JSON.parse(item.content)).toMatchObject({
      output: {
        patterns: ["packages/*/package.json"],
        paths: [
          "packages/core/package.json",
          "packages/host/package.json",
          "packages/tui/package.json",
        ],
        truncated: false,
      },
    });
  });

  it("keeps file-read window content visible under the read observation budget", () => {
    const formatter = new DefaultObservationFormatter({
      maxOutputChars: 20,
      maxFileReadContentChars: 100,
    });
    const content = `${"x".repeat(40)}NEEDLE${"y".repeat(40)}`;

    const item = formatter.format({
      toolName: "read_file",
      run: createRunRecord(),
      result: {
        toolCallId: "call_test" as never,
        status: "completed",
        output: {
          path: "PROJECT_NOTES.md",
          content,
          startLine: 1,
          endLine: 3,
          totalLines: 3,
          hasMore: false,
        },
        artifacts: [],
      },
    });

    const parsed = JSON.parse(item.content);
    expect(parsed.output.content).toBe(content);
    expect(parsed.output.content).toContain("NEEDLE");
  });

  it("summarizes scalar arrays that exceed the output budget", () => {
    const formatter = new DefaultObservationFormatter({
      maxOutputChars: 20,
    });

    const item = formatter.format({
      toolName: "glob",
      run: createRunRecord(),
      result: {
        toolCallId: "call_test" as never,
        status: "completed",
        output: {
          paths: [
            "packages/core/package.json",
            "packages/host/package.json",
            "packages/tui/package.json",
          ],
        },
        artifacts: [],
      },
    });

    expect(JSON.parse(item.content)).toMatchObject({
      output: {
        paths: {
          type: "array",
          length: 3,
        },
      },
    });
  });

  it("extracts path metadata from file-read observations for compaction", () => {
    const formatter = new DefaultObservationFormatter();

    const item = formatter.format({
      toolName: "read_file",
      run: createRunRecord(),
      result: {
        toolCallId: "call_test" as never,
        status: "completed",
        output: {
          path: "packages/core/src/context.ts",
          content: "context source",
          startLine: 1,
          endLine: 1,
          lineCount: 1,
          truncated: false,
        },
        artifacts: [],
      },
    });

    expect(item.metadata).toMatchObject({
      toolName: "read_file",
      status: "completed",
      path: "packages/core/src/context.ts",
      filePath: "packages/core/src/context.ts",
      startLine: 1,
      endLine: 1,
      truncated: false,
    });
  });

  it("extracts common recovery metadata from paginated observations", () => {
    const formatter = new DefaultObservationFormatter();

    const item = formatter.format({
      toolName: "glob",
      run: createRunRecord(),
      result: {
        toolCallId: "call_test" as never,
        status: "completed",
        output: {
          paths: ["a.ts"],
          truncated: true,
          hasMore: true,
          nextOffset: 1,
        },
        artifacts: [],
      },
    });

    expect(item.metadata).toMatchObject({
      toolName: "glob",
      status: "completed",
      truncated: true,
      hasMore: true,
      nextOffset: 1,
    });
    expect(item.metadata).not.toHaveProperty("filePath");
  });

  it("extracts spawn_agent child finality metadata for compaction", () => {
    const formatter = new DefaultObservationFormatter();

    const item = formatter.format({
      toolName: "spawn_agent",
      run: createRunRecord(),
      result: {
        toolCallId: "call_spawn" as never,
        status: "completed",
        output: {
          childRunId: "run_child_partial",
          role: "trace auditor",
          signal: "completed",
          stopReason: "final_answer",
          stepLimitReached: true,
          truncated: true,
          message: "partial result",
        },
        artifacts: [],
      },
    });

    expect(item.metadata).toMatchObject({
      toolName: "spawn_agent",
      status: "completed",
      childRunId: "run_child_partial",
      role: "trace auditor",
      stepLimitReached: true,
      truncated: true,
      finality: "partial",
    });
  });

  it("extracts spawn_agent child finality metadata from failures", () => {
    const formatter = new DefaultObservationFormatter();

    const item = formatter.format({
      toolName: "spawn_agent",
      run: createRunRecord(),
      result: {
        toolCallId: "call_spawn_failed" as never,
        status: "failed",
        error: {
          code: "SPAWN_AGENT_CHILD_INCOMPLETE",
          message: "child failed",
          metadata: {
            childRunId: "run_child_failed",
            role: "counter",
            signal: "failed",
            stopReason: "tool_doom_loop",
            stepLimitReached: false,
            truncated: false,
            finality: "partial",
          },
        },
        artifacts: [],
      },
    });

    expect(item.metadata).toMatchObject({
      toolName: "spawn_agent",
      status: "failed",
      childRunId: "run_child_failed",
      role: "counter",
      stepLimitReached: false,
      truncated: false,
      finality: "partial",
    });
  });
});

function createRunRecord(): RunRecord {
  const now = new Date().toISOString();

  return {
    id: createRunId(),
    goal: "inspect repo",
    state: "running",
    createdAt: now,
    updatedAt: now,
    metadata: {},
  };
}

function systemContext(content: string): ContextItem {
  return {
    id: createContextItemId(),
    type: "system",
    content,
    metadata: {},
  };
}

function userContext(content: string): ContextItem {
  return {
    id: createContextItemId(),
    type: "user",
    content,
    metadata: {},
  };
}

function conversationItem(
  type: "user" | "assistant",
  content: string,
): ContextItem {
  return {
    id: createContextItemId(),
    type,
    content,
    metadata: { layer: "conversation", stability: "session" },
  };
}

function toolResult(content: string): ContextItem {
  return {
    id: createContextItemId(),
    type: "tool_result",
    source: {
      kind: "tool",
      uri: "echo",
    },
    content,
    metadata: {},
  };
}

function summaryContext(content: string): ContextItem {
  return {
    id: createContextItemId(),
    type: "summary",
    source: {
      kind: "compactor",
      uri: "test",
    },
    content,
    metadata: {},
  };
}

function skillIndexContext(
  skills: Array<Record<string, unknown>>,
): ContextItem {
  return {
    id: createContextItemId(),
    type: "summary",
    source: {
      kind: "system",
      uri: "skill_index",
    },
    content: JSON.stringify({ skills }),
    metadata: {
      layer: "skill_index",
      stability: "session",
    },
  };
}

function toolDescriptor(): ToolDescriptor {
  return {
    name: "echo",
    description: "Echo text.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
    },
    policy: {
      risk: "safe",
    },
    governance: {
      sideEffects: ["none"],
      idempotency: "idempotent",
      audit: {
        level: "metadata",
      },
    },
  };
}
