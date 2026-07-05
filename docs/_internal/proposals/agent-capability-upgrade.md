# Agent 能力升级方案 (Phase 1–4)

> 内部规划文档(`docs/_internal` 已 gitignore,不进 PR)。
> 目的:把 SparkWright 的 agent/profile/delegate 子系统从"父→子单跳委派"
> 升级为"可分模型、易作者、可路由、可编排"的多 agent 体系。
> Phase 1 已实现(分支 `feat/access-mode`,未 commit),Phase 2–4 为提案。

---

## 0. 背景:系统现状(给冷启动 reviewer)

### 0.1 Agent 的本质 —— `AgentProfile`
一个 agent 就是一份角色模板。规范类型在
[`packages/agent-runtime/src/index.ts`](../../../packages/agent-runtime/src/index.ts)
的 `AgentProfile`:

```
id / name / description / mode / model / prompt
use / allowedTools / deniedTools / delegateTool
policy / maxSteps / runBudget / metadata
```

- **mode**:`primary`(主 agent,每 run 唯一) / `child`(可被委派) / `all`。
- 主 agent 由 `mainAgentProfile()`([runtime.ts](../../../packages/host/src/runtime.ts))
  选:第一个 `id===main` 或 `mode===primary` 的 profile,缺省回退默认。
- 其余 `child`/`all` 经 `deriveConfiguredAgents()` 派生为受约束子 agent。

### 0.2 定义来源:两来源 × 三层
- **config.json**:`capabilities.agents.profiles[]`(zod 校验,精确层)。
- **markdown**:`.sparkwright/agents/**/*.md`(frontmatter,省心层;近期升级:
  递归发现 + YAML 解析 + `tools`/`disallowedTools` 别名 + inline `delegateTool`)。
  解析在 [`agent-profiles.ts`](../../../packages/host/src/agent-profiles.ts)。
- **层级**:user(XDG) < project < config.json;同 id 时 config 全量胜出
  (`mergeAgentProfilesById`)。报告/诊断在 [`agent-report.ts`](../../../packages/host/src/agent-report.ts),
  同 id 冲突会产出 `shadows` 诊断。

### 0.3 委派 = 把 child agent 暴露成一个工具
- 来源两条,经 `resolveAgentDelegateTools()`
  ([`delegate-capability.ts`](../../../packages/host/src/delegate-capability.ts))合并,
  **显式配置(profileId / toolName)胜出**:
  - 显式:`capabilities.agents.delegateTools[]`
  - inline:`profile.delegateTool`
- 工具名:`delegate_<id>` 或自定义。主 agent 靠工具 **description 自行路由**。
- **三种执行协议**(由 `profile.metadata` 决定):
  - `in_process`:`spawnSubAgent()` 同进程子 run,带自己的工具目录 / 策略叠加 /
    深度守卫 / usage 汇总进父 run。
  - `external_command`:外部 CLI 进程([external-command-agent.ts](../../../packages/host/src/external-command-agent.ts))。
  - `acp`:ACP stdio 连到别的 agent([acp-child-agent.ts](../../../packages/host/src/acp-child-agent.ts))。
  - 构建点:`createConfiguredDelegateTools()`([runtime.ts](../../../packages/host/src/runtime.ts))。
  - 注:`delegates run` CLI 入口([delegate-runner.ts](../../../packages/host/src/delegate-runner.ts))
    **只支持 acp / external**,显式拒绝 in-process(走正常 run-loop 委派)。

### 0.4 能力 / 策略模型:单调收紧
`deriveChildAgentProfile()`(agent-runtime):
子 = 父 run 策略 ∩ 父 agent 策略(仅约束性规则)+ 子策略;
`allowedTools` 取**交集**、`deniedTools` 取**并集**、`runBudget` 取 **min**、
`maxDepth`(`capabilities.agents.maxDepth`)限嵌套深度。
**子只能比父更受限**;写盘还要父 run 的 `shouldWrite` 闸门。

### 0.5 当前空白(升级抓手)
| # | 空白 | 影响 |
|---|------|------|
| A | `profile.model` 对 in-process 子 agent 不生效(写死复用父模型) | 无法按角色分模型/分成本 → **Phase 1** |
| B | 暴露要手写(`mode:child` 不会自动可委派);嵌套同名 id 静默覆盖 | 作者负担、命名碰撞 → **Phase 2** |
| C | 路由靠 description 自由心证,无声明式匹配 | 误选、工具膨胀 → **Phase 3** |
| D | 只有父→子单跳,无并行/聚合/planner-worker | 无法多 agent 协作 → **Phase 4** |

### 0.6 关键文件索引
- 类型/派生/spawn:`packages/agent-runtime/src/index.ts`
- 解析/发现:`packages/host/src/agent-profiles.ts`、`agent-report.ts`
- 委派合并/描述:`packages/host/src/delegate-capability.ts`
- 委派工具构建/运行:`packages/host/src/runtime.ts`(`createConfiguredDelegateTools`)
- 协议执行:`acp-child-agent.ts`、`external-command-agent.ts`、`delegate-runner.ts`
- 模型解析:`packages/host/src/model-factory.ts`、`model-builder.ts`
- 配置 schema:`packages/host/src/config-zod-schema.ts`、`schemas/agent-profile.schema.json`
- CLI:`packages/cli/src/cli.ts`(`agents create/list/validate`)
- 指南:`docs/guides/AGENTS.md`、`docs/reference/EXTENSION_INTERFACES.md`

---

## Phase 1 — 按角色选模型 ✅ 已实现

### 背景
`profile.model` 字段一直存在,但 `createConfiguredDelegateTools` 的 in-process 分支
写死 `model: input.model`(父 run 的 adapter)。agent-runtime 注释也明说 model
"carried for orchestration, not applied"。结果:reviewer 想用 opus、grunt 想用
haiku 做不到。只有 external/acp 子 agent(各跑各进程)才用自己的模型。

### 方案(已落地)
**子 agent 用 `profile.model` 解析出独立 adapter,缺省回退父 adapter。**

- **复用 `createModel`**(model-factory.ts):子模型走和主 run 完全相同的
  provider/定价解析,无第二套逻辑。
- **新抽象 `resolveProfileModelAdapters`**(model-factory.ts):
  按 `modelRef` 去重(多 agent 同模型 → 一个 adapter、一次 config 读);
  任一 ref 失败则整体失败、**带 profile id 归因**(对齐"主模型不可解析就让 run
  失败"的既有语义,不静默降级)。
- **`resolveInProcessDelegateModels`**(runtime.ts):复用 `acpConfigFromAgentProfile`
  / `externalCommandConfigFromAgentProfile` 排除 ACP/外部委派;跳过 model 与父相同
  的 profile(直接复用父 adapter)。
- **接线单点**:`createConfiguredDelegateTools` 加可选 `modelForProfile`,
  in-process 分支 `modelForProfile?.(id) ?? input.model`;解析放在
  `prepareHostRunEnvironment` 内 → **start + resume 共用一处**。
- **成本归因零额外接线**:`costUsd` 由 adapter 自身按其定价上报(`output.usage.costUsd`),
  经既有 `attachUsageRollup` 汇入父 run → 子用自己 adapter 即分模型计费。

### 顺带(Phase 2 的小切口)
- `sparkwright agents create --model provider/model`(复用全局 `--model` 解析,
  即 `parsed.modelName`,不新增冲突标志)。
- `sparkwright agents list` 显示每个 config agent 的 `model:`。

### 改动文件
- `packages/host/src/model-factory.ts`(+`resolveProfileModelAdapters`)
- `packages/host/src/runtime.ts`(+`profileModelRef`、`resolveInProcessDelegateModels`、
  `modelForProfile` 接线)
- `packages/agent-runtime/src/index.ts`(JSDoc 更正)
- `packages/cli/src/cli.ts`(`agents create --model`、`list` 显示 model)
- 文档:`docs/guides/AGENTS.md`、`docs/reference/EXTENSION_INTERFACES.md`
- 测试:`model-factory.test.ts`(去重/错误归因/空)、`tools.test.ts`(model 覆盖)、
  `cli.test.ts`(create --model 持久化 + list)

### 状态
全绿:host+agent-runtime 388、cli 119;`tsc -b` 通过;prettier 通过。

### 留尾
- capability-inspect 输出尚未展示每个委派的 model(覆盖 markdown agents,
  需给 `DelegateCapabilityDescriptor` 加字段 + CLI/TUI 渲染)。建议并入 Phase 3。

---

## Phase 2 — 作者体验 / 自动暴露

### 背景
两个摩擦点:
1. 定义了 `mode:child` profile 后,**还得再手写** `delegateTool` 或 config
   `delegateTools[]` 才能被主 agent 调用 —— 容易漏(AGENTS.md 的"常见坑"已列此项)。
2. 递归发现把嵌套目录拍平成 `basename` 作 id,`review/foo.md` 与 `audit/foo.md`
   都成 `foo` → 静默覆盖(报告层有 `shadows` 诊断,但运行时无命名空间)。

### 方案
> Review 收口(2026-06-27):**不直接翻转 id 默认语义**;`delegateTool:false`
> 必须做成类型层 tri-state;碰撞要 fail-closed + 诊断。下文已按此修订。

**(2a) 自动暴露(opt-in)**
- 新增 `capabilities.agents.exposeChildrenAsDelegates: boolean`(默认 **`false`**
  —— 工具膨胀会改变现有模型上下文/行为,默认 on 不可接受)。开启后,
  `resolveAgentDelegateTools` 对每个 `mode in {child, all}` 且无显式 delegate 的
  profile 自动合成一个 `delegate_<id>`。
- **tri-state opt-out(必须做在类型层)**:`AgentProfile.delegateTool` 当前只能是
  对象,`resolveAgentDelegateTools` 把 falsy 当"无 inline"——无法区分"未配置" vs
  "显式不暴露"。两选一:
  - (推荐) 新增独立字段 `exposeAsDelegate?: boolean`(语义清晰,不污染 delegateTool 形状);或
  - 把类型扩为 `AgentProfileDelegateTool | false`,并改 `resolveAgentDelegateTools`
    显式判 `=== false`。
  - **仅改 markdown parser 不够**。
- 优先级不变:显式 config / inline 仍胜出。

**(2b) id 命名空间 —— 分两步,先非破坏**
- 当前递归发现进子目录但 id 仍是 `basename`([agent-profiles.ts:65](../../../packages/host/src/agent-profiles.ts))。
  直接改成 `review:foo` 会波及 `delegateTools[].profileId`、`agents validate/create`、
  agent-manager、schema —— **不是小破坏**。
- **第一步(本相位,非破坏)**:
  - 保持扁平 basename id 作默认。
  - 对 basename **碰撞报 warning/error**(发现层 + `agents validate`);运行时
    fail-closed(跳过被覆盖者并明确报出,而非静默后写胜出)。
  - **接受 `:` 作为合法 id 字符**,支持作者**显式**写 namespaced id;`isAgentId`
    正则放宽以容纳。
- **第二步(下一破坏性版本 / opt-in)**:才把"路径自动派生 id"翻成默认。
- 收益:大部分(消除静默覆盖 + 支持命名空间)在第一步即拿到,破坏面小得多。

**(2c) tool name 碰撞要独立诊断(不能只靠 sanitize)**
- `delegate_<id>` 经 sanitize 后,`review:foo` / `review/foo` / `review foo` 都趋同为
  `delegate_review_foo`。**注意**:实际 `delegateToolName` 走
  [delegate-capability.ts:487](../../../packages/host/src/delegate-capability.ts)
  的 sanitizer(保留 `.`/`-`),与 [runtime.ts:4469](../../../packages/host/src/runtime.ts)
  那个(更严)**不一致** —— 两个 sanitizer 本身是潜在隐患,建议顺手统一。
- 自动暴露/命名空间下,必须在 descriptor/report 层给 **tool-name collision
  diagnostic**,fail-closed(跳过冲突者并报出),不要让两个 agent 抢同一工具名。

**(2d) 模板继承(可选,低优先)**
- profile 支持 `extends: <baseId>`。建议先不做,除非作者反馈强烈。

### 改动点(预估)
- `agent-profiles.ts`:basename 碰撞诊断;放宽 id 字符集容纳 `:`。
- `delegate-capability.ts`:`resolveAgentDelegateTools` 加自动暴露分支 + tri-state
  判定 + tool-name 碰撞诊断;统一 sanitizer。
- `agent-runtime/src/index.ts`:`exposeAsDelegate?` 或 `delegateTool: ... | false`。
- `config-zod-schema.ts` + `schemas/`:`exposeChildrenAsDelegates`;opt-out 字段。
- `cli.ts`:`agents list/validate` 展示 + 校验碰撞。
- 文档:AGENTS.md 增"自动暴露 / 命名空间 / 碰撞"小节。

### 风险 / 取舍
- 自动暴露默认 **off**:纯增量,不改现状。
- **id 语义不在本相位翻转**:第一步只加诊断 + 显式 `:` 支持,扁平 id 完全兼容。
- 碰撞 **fail-closed**:宁可跳过+报错,不静默择一。
- 本相位保持"轻、host 边缘":不塞入 skills/memory/hooks 等角色装配能力。

### 测试计划
- basename 碰撞 → warning/error;运行时 fail-closed。
- 显式 `:` namespaced id 解析/校验通过。
- 自动暴露 on/off;`exposeAsDelegate:false`(或 `delegateTool:false`)opt-out;显式仍胜出。
- tool-name 碰撞(`review:foo` vs `review/foo`)→ collision diagnostic。
- 扁平 config id 与显式 namespaced markdown id 共存。

---

## Phase 2.5 — 角色装配 / 启动上下文

### 背景
Phase 2 只解决"agent 是否可调用、id 是否安全"。稳定角色还需要启动上下文装配:
预先知道哪些 skill 可用、按 profile 追加更细的 hooks、可选持久 memory。
这些不是 Phase 2 的轻量边缘改动,其中 memory 更接近独立子系统。

### 方案
> Review 收口(2026-06-27):本相位全部 **opt-in**;不得扩大子 agent 权限。
> skills 先做"描述级预载",不注入全文;memory 是 host/product 层净新增接线,
> 不能说成已有能力;profile hooks 是中等工作量,可复用 workflow hook 引擎。

**(2.5a) skills 预载 = 描述级启动索引,全文仍按需加载**
- profile 支持 `skills: string[]`,但第一版只把这些 skill 的**存在/名称/描述/触发词**
  放入子 agent 启动上下文,让角色知道"该加载什么"。
- 不把 skill 全文默认灌进上下文。SparkWright 当前 skills 运行路径默认是
  progressive disclosure:`prepareSkillsForRun(... includeLoaderTool: true,
  loadSelectedSkills: false ...)` 暴露 `skill_load`,由模型按需拉取正文。
- 语义边界:
  - `skills` 控制启动索引/提示,不授予运行时加载权限。
  - 子 agent 能否调用 `skill_load`,仍由工具集与策略控制
    (`use`/`allowedTools`/`deniedTools`,或不暴露 skill loader tool)。
  - 找不到/被 deny 的 skill 必须带 profile id 诊断,不能静默降级。

**(2.5b) profile-scoped hooks(条件规则)**
- profile 可声明只在该 agent 活跃时生效的 hooks,覆盖现有 hook 名称:
  `PreToolUse` / `PostToolUse` / `Stop` 等。
- 用途:比 `allowedTools` 更细地约束工具参数,例如允许 shell/database 工具但只放行只读查询。
- 实现约束:
  - 复用现有 workflow hook / matcher / traced process 基础设施,不新增第二套 hook 引擎。
  - 新增工作是"按 profile 作用域挂载/卸载"以及与父 run hooks 的合并顺序。
  - hooks 继承单调收紧:子 profile hook 只能增加检查/后置动作,不能放宽父 run policy。
  - hook 拦截必须进入 trace,包含 profile id、tool name、matcher、exit code/decision。
  - hook 命令本身是外部进程能力,需要和现有 hooks 一样受配置与审批边界约束。

**(2.5c) 持久 memory(净新增 host 接线,可独立 proposal)**
- core 已有 `MemoryStore` / `MemoryProvider` 接口和 fenced-context helpers,但 v0 明确
  **没有默认 MemoryStore 实现**;host/profile 层也没有按 agent id/scope 的 memory 装配。
- 因此 profile `memory` 不是简单字段接线,而是新产品层:
  目录/存储约定、scope 语义、注入策略、写入路径、审计与清理都要设计。
- 可选字段形状:`memory: false | { scope: "user" | "project" | "local",
  maxPreludeLines?, maxPreludeBytes? }`。默认 off。
- 推荐实现路线:
  - recall/injection 复用 core `MemoryProvider` / `buildMemoryContextBlock`;
  - 写入优先走受控 workspace 子根 + 现有写工具/policy,不要第一版新造
    `memory_read` / `memory_write` 工具;
  - 父 run 禁写时不能写 memory,即使 memory 目录不在源码树里。
- trace 必须记录 memory scope、存储位置摘要、注入大小、写入次数;不要把 memory 写伪装成普通源码写。

### 改动点(预估)
- `agent-runtime/src/index.ts`:`skills?`;profile-scoped hooks;可选 `memory?` 类型。
- `host/src/runtime.ts`:为 configured delegates 构建按 profile 的 skill 描述索引、
  hooks 合并、memory provider/context。
- `config-zod-schema.ts` + `schemas/`:新增 profile 字段。
- CLI/TUI/capability inspect:展示启动索引、hooks、memory scope/状态。

### 风险 / 取舍
- skills 全文预载会破坏渐进披露并膨胀上下文;第一版只做描述级索引。
- profile hooks 是中等风险:外部命令 hook 必须受既有审批/trace 约束。
- memory 是净新增子系统/产品语义,建议单独 proposal 或至少独立 PR。

### 测试计划
- profile `skills` 描述级预载成功/缺失/deny;不暴露 `skill_load` 时不能加载全文。
- profile-scoped hook 的 PreToolUse 阻断/PostToolUse 执行/Stop 映射与 trace。
- memory scope 路径/存储解析 + 注入上限 + 写入 trace;父 run 禁写时不能写 memory。

---

## Phase 3 — 自动路由与发现

### 背景
主 agent 选调哪个委派,完全靠读各 delegate 工具的 description 自由判断。
agent 一多,(a)description 写不好就误选,(b)所有委派工具都常驻上下文 → 噪声。
项目已有两套选择机制可复用/对齐(见 [[project_skill_selection_probes]]):matcher
(确定性关键词)vs model-driven(`skill.load`)。

### 方案(分层,建议先 3a + inspect model)
> Review 收口:先发 **3a + inspect model**;3b 先做成**可观测实验开关**,
> 且中间态优先"**排序/标注 relevant/low**"而非直接隐藏工具。

**(3a) 描述自动增强(最便宜,先做)**
- `delegateToolDescription` 已会用 profile.description 做路由提示。进一步:可选
  把 `use`/关键能力/`model` 编排进描述。纯文本增强,零行为风险。
- 描述中可加入"适合主对话 vs 适合委派"的短提示:频繁来回/多阶段共享上下文/快速小改
  倾向主 agent;自包含、输出噪声大、需特殊工具限制/权限边界的任务倾向子 agent。

**(inspect model —— 跨 protocol contract,不只 host descriptor)**
- Phase 1 留尾。**不能只加 `DelegateCapabilityDescriptor.model?`**:capability
  snapshot 走 protocol 的 `CapabilityDelegateToolSummary`
  ([protocol/src/index.ts:569](../../../packages/protocol/src/index.ts))。要让 TUI /
  外部 client 稳定消费,需**同步**:
  1. protocol `CapabilityDelegateToolSummary.model?`
  2. host descriptor + snapshot merge
  3. CLI inspect 渲染
  4. TUI capability panel 渲染
- 作者据此核对路由素材("这个委派到底用哪个模型")。

**(3b) matcher 门控 —— 可观测实验,先排序后隐藏**
- profile 新增可选 `triggers`/`when`(关键词/轻量条件)。复用 skill matcher 思路
  (tokenizer 已 CJK-aware,见 [[project_skill_selection_probes]])。
- **中间态(推荐先做)**:不隐藏工具,只给委派**标注相关度**(relevant / low)并排序,
  让模型仍能看到全集但有优先级提示。
- **进阶(实验开关)**:真正按 matcher 收窄可见集。开关默认 off。
- 关键约束:matcher 只能**收窄/排序**,不替模型决策;误判会隐藏本可用 agent →
  必须 trace 留痕("因 matcher 未命中而隐藏/降权 X")。

**(3c) 元路由工具(可选,重)**
- `route_to_agent(intent)` 元工具,把"选择"从 N 个工具压成 1 个。暂缓,除非
  agent 规模大到 3b 仍不够。

**(3d) 冷启动上下文可观测**
- capability inspect / trace 应展示每个 delegate 的启动上下文来源:
  profile prompt、预载 skill 描述索引、memory scope/注入大小、是否继承项目规则、是否有 git
  snapshot/context 摘要。
- 约束:非 fork 子 agent 默认是隔离冷启动,只接收委派任务 + 显式注入的上下文材料;
  任何"继承父对话"都必须是单独模式,不能混在普通 delegate 语义里。

### 改动点(预估)
- `protocol/src/index.ts`:`CapabilityDelegateToolSummary.model?`(+ snapshot merge)。
- `agent-runtime`:`AgentProfile.triggers?`。
- `delegate-capability.ts`:描述增强;descriptor 加 `model`。
- `runtime.ts`:matcher 排序/门控(默认仅排序)。
- `config-zod-schema.ts` + `schemas/`:`triggers`。
- CLI inspect + TUI panel:展示 model + triggers + 相关度 + 启动上下文摘要。

### 风险 / 取舍
- 3a + inspect model:低风险,可单独发(注意 inspect model 是**协议级**改动,
  需顾及外部 client 兼容)。
- 3b 排序态:不改可见集 → 不破坏行为;隐藏态才影响模型,默认 off + 可观测。

### 测试计划
- 描述增强快照;`model` 贯穿 protocol summary → CLI inspect → TUI panel。
- matcher 命中/未命中:排序态(全可见 + 标注);隐藏态(收窄 + trace 留痕);关闭恢复全可见。
- CJK trigger 命中(复用现有 tokenizer 测试模式)。
- inspect 展示 skill 描述索引 / memory / hooks / 启动上下文摘要,且不泄露敏感 memory 内容。

---

## Phase 4 — 多 agent 编排 / 并行

### 背景
当前编排表达力 = 主 agent 顺序调用单个委派,且对"相似 goal"会去重
(`createAgentTool` 的 `findSimilarSuccessfulDelegation`)。没有并行 fan-out、
结果聚合、planner-worker 原语。`spawnSubAgent` **已支持延迟 start**(不自动
`.start()`),为并行留了口子;usage 汇总(`attachUsageRollup`)也已支持多子聚合。

### 方案
> Review 收口(P1,硬约束):**第一版 `delegate_parallel` 只接受
> `workspaceAccess: "none"` 的 delegate**。`spawnSubAgent` 默认继承父 workspace
> ([agent-runtime/src/index.ts:735](../../../packages/agent-runtime/src/index.ts)),
> 且 in-process delegate 可能带写工具
> ([runtime.ts:3566](../../../packages/host/src/runtime.ts)) —— **共享 workspace +
> `Promise.all` 不得进第一版**。写型并行必须显式 `isolatedWorktree` 或退化为串行
> (而且**串行写不要叫"并行"**)。

**(4a) 并行 fan-out 工具 —— 只读优先**
- 新增 `delegate_parallel` / `fan_out`:批量 `spawnSubAgent` 后 `Promise.all`。
- **准入门控**:仅接受 descriptor `workspaceAccess === "none"` 的委派
  (该字段已在 protocol summary 中存在,见
  [protocol/src/index.ts:588](../../../packages/protocol/src/index.ts)),否则拒绝并报清楚原因。
- 复用:深度守卫、策略叠加、usage 汇总(分模型,接 Phase 1)、runStore 持久化均就绪;
  `spawnSubAgent` 已支持延迟 start,天然适配并发。

**(4b) 写型并行 = worktree 隔离(后续)**
- 需要写时,优先各自 **worktree 隔离**(复用现有 worktree 机制),完成后合并。
- 低成本 fallback:**串行写**——但在 API/文案上明确是 sequential,不冒充 parallel。

**(4c) 结果聚合**
- 聚合器把 N 个子结果规约成父可见摘要(内置"汇总"或交回主 agent 综合)。

**(4d) planner-worker(可选,最重)**
- planner agent 产出子任务,host 调度 worker。本质 4a+4c 加规划步;4a 稳定后增量。

**(4e) 前台 / 后台执行模式(后续,不进 v1)**
- delegate 调用默认仍是前台阻塞(和当前工具调用语义一致)。
- 当前 `createAgentTool.execute` / dynamic `spawn_agent` 都会 `await spawned.run.start()`;
  host 没有 detached/background subagent runner。后台模式是净新增基础设施,不能当成
  v1 的 opt-in 开关。
- 后续若做后台,必须显式 opt-in(工具参数或 profile/delegate 配置),并满足:
  - 子 agent 身份、运行状态、审批请求在主会话 UI 中可见;
  - 后台审批不能静默 auto-allow/auto-deny,必须带子 agent 名称和工具名;
  - cancel/abort 能传播到所有在飞子 run;
  - 完成结果以摘要回填主会话,详细 transcript 留在子 run/session。

**(4f) 嵌套 / 恢复 / transcript**
- 嵌套仍用现有 `capabilities.agents.maxDepth` 作为上限;深度从主会话向下计算。
- 后台子 agent 的 `subagentDepth` 在首次 spawn 时固定并持久化;后续 resume 不因入口变浅而获得额外嵌套额度。
- 实现要点:resume 时 host 必须从被恢复 run 的持久化 metadata 重新派生
  `subagentDepth`,不能信任 client 传入的 `payload.metadata`。
- 子 agent resume 应基于已有 child run/session transcript,而不是重新 cold start;
  `SendMessage`/继续执行类能力要带 agent id/run id,并在 trace/session 中可追。
- transcript 自动清理策略应与 session 清理一致,但不得被主会话 compact 意外删除。

**(4g) fork-like 上下文克隆(实验,与普通 delegate 分离)**
- 可探索一个"继承父上下文但隔离工具输出"的 fork-like 模式,用于同一上下文起点上并行试探方案。
- 约束:不能复用普通 named delegate 的默认语义;必须在工具名/协议/trace 上可区分,
  因为它放弃了普通 subagent 的输入隔离。

**(4h) 子 agent 自动压缩**
- core `createRun` 已在未传 `compactionStages` 时启用默认 compaction stages;
  `spawnSubAgent` 当前未覆盖该字段,所以子 run 默认已经继承安全默认压缩。此项不是新机制,
  主要是观测性增量:在子 transcript/trace 中记录 compact boundary、触发原因、压缩前 token 量。
- 父 run 只接收摘要/结果,不把子 agent 的完整压缩历史灌回主上下文。

### 改动点(预估)
- `runtime.ts`:注册 `delegate_parallel`;`workspaceAccess:none` 准入门控;并发预算/取消。
- `agent-runtime`:并行 spawn 辅助(或全在 host 编排,复用 `spawnSubAgent`)。
- worktree 隔离接线(写型并行,后续)。
- 可观测:trace 表达"一个父 span 下 N 个并发子 span";resume/fork-like entrypoint;
  compact boundary。后台状态是后续独立基础设施。

### 风险 / 取舍(最高)
- **并发写盘冲突**:第一版用准入门控(只读)从根上规避;写型走 worktree/串行。
- **审批风暴**:N 子各自审批 → 需批量/聚合审批 UX。
- **预算与取消**:并发放大成本;需父级总预算闸门 + abort 向所有子传播
  (`spawnSubAgent` 已透传 `parent.abortSignal`)。
- **去重逻辑**:现有"相似 goal 去重"(`findSimilarSuccessfulDelegation`)在并行语义下
  需重新审视(并行本就要多子,不应被去重吞掉)。
- **上下文隔离被破坏**:fork-like 模式必须单独标识,不能让普通 delegate 悄悄继承父历史。
- **后台执行被低估**:detached lifecycle/approval/cancel/status 是独立子系统,不进 4a v1。

### 测试计划
- 并行 N 子全部完成 + 聚合;usage 正确累加(分模型,接 Phase 1)。
- 并发只读 OK;并发写盘的串行化/隔离策略。
- abort 传播到所有在飞子;部分失败的聚合语义。
- maxDepth 在并行下仍生效。
- resume 从持久化 run metadata 派生 depth,不信 payload metadata。
- 后台子 agent 审批可见且可拒绝单次工具调用;cancel 传播(后续独立阶段)。
- resume 保留子 transcript / depth;主 compact 不删除子 transcript。
- fork-like 模式与普通 delegate 的 context/trace/entrypoint 可区分。
- 子 agent auto compaction 记录 compact boundary。

---

## 依赖与排序

```
Phase 1 (分模型) ── 已完成,放大后续价值
   │
Phase 2 (自动暴露/命名空间) ── 轻,host 边缘;让"多 agent"真的好写
   │
Phase 2.5 (角色装配/启动上下文) ── skills 描述索引 + hooks;memory 独立评估
   │
Phase 3 (路由/发现) ── 依赖 2 有一批描述良好的 agent;3a 可独立先发
   │
Phase 4 (编排/并行) ── 最重,吃 1/2/3 红利;并发写盘/审批/预算是主要风险
```

- **杠杆**:1 > 2 ≈ 3a > 2.5a/2.5b > 3b > 4a
- **风险/爆炸半径**:后台执行 ≈ memory ≈ 4 写型并行 ≫ 3b > 2(命名空间破坏性) > 3a ≈ 1
- **建议节奏**:1 收口 → 2 →(3a 随时插)→ 2.5a/2.5b → 3b →
  4a(只读前台并行)。memory、后台执行、fork-like 作为独立 proposal/后续阶段。

## 贯穿原则
- **复用优先**:模型解析复用 `createModel`;路由复用 skill matcher;并行复用
  `spawnSubAgent` 延迟 start + usage 汇总 + worktree 隔离。
- **opt-in 默认**:自动暴露 / matcher 门控默认关,不改现状。
- **不静默降级**:配置错误(坏模型、坏 matcher、id 碰撞)要带归因地报出来 / fail-closed。
- **可观测**:任何"隐藏/降权/并发/改模型"都要在 trace 留痕。

## Review 决策记录(2026-06-27)
冷启动 reviewer 对照源码核过,以下为已拍板的收口决策:

1. **Phase 2 id**:不翻转默认语义。第一步只做"扁平 id + 碰撞诊断(fail-closed)+
   显式 `:` namespaced id 支持";路径自动派生 id 留到下一破坏性版本 / opt-in。
2. **Phase 2 自动暴露**:default **off**。
3. **Phase 2 opt-out / collision**:必须类型层 tri-state(`exposeAsDelegate?:boolean`
   或 `delegateTool: ... | false`),仅改 parser 不够;tool-name 碰撞在
   descriptor/report 层独立诊断 + fail-closed,顺手统一两个 `sanitizeToolSegment`。
4. **Phase 2.5 启动上下文**:从 Phase 2 拆出。`skills` 第一版只预载描述级索引,
   全文仍走 `skill_load`;profile hooks 复用 workflow hook 引擎但新增 profile 作用域;
   memory 是 host/product 层净新增接线,建议独立 proposal。
5. **Phase 3**:先发 3a + inspect model(后者是**协议级**改动,贯穿 protocol →
   host → CLI → TUI);3b 先做"排序/标注 relevant-low",隐藏态作默认 off 的可观测实验;
   inspect 同步展示启动上下文摘要。
6. **Phase 4**:第一版 `delegate_parallel` 仅接受 `workspaceAccess:none`,且保持前台阻塞;
   写型走 worktree 隔离,串行写不冒充并行。后台执行是净新增基础设施,不进 v1;
   resume depth 必须从持久化 run metadata 派生;auto-compact 主要是观测性增量。
