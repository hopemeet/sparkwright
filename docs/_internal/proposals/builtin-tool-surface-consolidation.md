# Built-in Tool Surface Consolidation Proposal

Status: Draft for review
Date: 2026-06-28

> 内部规划文档。本提案自身不改变运行时行为,只定义 SparkWright 默认
> model-facing 工具面的收敛方向、机制事实与产品分类的边界、以及不破坏兼容的
> 分阶段落地路径。所有工具名、机制描述均以当前源码为准(见「当前事实」)。

## 目的

把 SparkWright 默认暴露给模型的 built-in 工具收敛成一组清晰、稳定、类似
Codex / Claude Code 风格的核心工具,同时把 skills / agents / automation /
planning 等高级能力降级为「可发现但不常驻」的层。目标不是新增能力,而是:

- 缩小模型首轮可见面,降低选择负担;
- 把「实现细节命名」收敛为「稳定 canonical 名」;
- 复用已有的延迟加载 / 发现机制,而不是新造平行分类;
- 在不删除任何旧工具、不改 core run loop 的前提下完成。

## 当前事实(review 前必读)

落点源码:

- [`packages/host/src/tool-catalog.ts`](../../../packages/host/src/tool-catalog.ts)
- [`packages/host/src/tool-selectors.ts`](../../../packages/host/src/tool-selectors.ts)
- [`packages/host/src/tool-identities.ts`](../../../packages/host/src/tool-identities.ts)
- [`packages/host/src/tools.ts`](../../../packages/host/src/tools.ts)
- [`packages/coding-tools/src/index.ts`](../../../packages/coding-tools/src/index.ts)
- [`packages/skills/src/index.ts`](../../../packages/skills/src/index.ts)

## C2 归属边界(2026-07-06)

C2 已把能力面词汇拆成三层。本提案拥有 built-in 工具身份与产品默认公开面,
但不拥有 selector/toolset 编译词汇。

- **selector/toolset 编译词汇**:归
  [`agent-access-config-redesign.md`](agent-access-config-redesign.md)。本提案只引用,
  不复述其无别名 selector 语法或 toolset 编译规则。
- **tool identity 层**:canonical 名、legacy alias、`defaultExposureTier` 以
  [`packages/host/src/tool-identities.ts`](../../../packages/host/src/tool-identities.ts)
  为事实源。本提案记录产品规则与迁移口径,不得另起映射表。
- **产品默认公开面**:归本提案。`public` / `advanced` / `infrastructure` /
  `legacy` 的产品分类在这里定口径,实现事实仍回查 `tool-identities.ts`。

### 模型默认可见的工具(按来源分四类)

「默认注册」并非一个固定列表——它由静态 catalog、条件注入、运行时配置、派生基础设施
四种来源合成。混在一张表里会让人误以为都来自
`createMainHostToolCatalogList`([tool-catalog.ts:211](../../../packages/host/src/tool-catalog.ts))
的固定默认集。分段如下。

**1. 静态主 catalog(`createMainHostToolCatalogList` 固定注册)**

| source | 工具名               | 备注                                                  |
| ------ | -------------------- | ----------------------------------------------------- |
| coding | `read_file`          | 纯文本读取                                            |
| coding | `read_anchored_text` | 带稳定 per-line anchor 的读取                         |
| coding | `glob`               | 路径匹配                                              |
| coding | `grep`               | 内容搜索                                              |
| coding | `list_dir`           | 目录列举                                              |
| coding | `write_file`         | 创建 / 整体替换                                       |
| coding | `edit_anchored_text` | anchored 精确编辑                                     |
| coding | `apply_patch`        | unified-diff 编辑(容忍空白 / 可省 header / 裸 `@@`)   |
| cron   | `cron`               | 定时任务管理                                          |
| skill  | `list_skills`        | skill 检视(`createSkillInspectorTool`)                |
| skill  | `create_skill`       | skill 创建(`createSkillManagerTool`)                  |
| skill  | `update_skill`       | skill 更新(`createSkillUpdateTool`)                   |
| agent  | `list_agents`        | agent 检视(`createAgentInspectorTool`)                |
| agent  | `create_agent`       | Markdown Agent 管理(`createMarkdownAgentManagerTool`) |
| shell  | `shell`              | 命令 / 脚本 / git                                     |
| task   | `task`               | 后台任务统一控制器(`createTaskControl`)               |
| todo   | `todo_write`         | 计划账本                                              |

**2. prepared / 条件注入(取决于工作区内容与开关)**

| source | 工具名       | 条件                                                                                                                                   |
| ------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| skill  | `skill_load` | 存在 skills 且 `includeLoaderTool` 开启;**默认 `?? true`**([runtime.ts:866](../../../packages/host/src/runtime.ts)),即默认就暴露给模型 |

**3. configured / dynamic(取决于配置与 profile)**

| source   | 工具名                                 | 条件                                |
| -------- | -------------------------------------- | ----------------------------------- |
| mcp      | `<mcp tools>`                          | 配置的 MCP server 工具              |
| delegate | `delegate_agent` / `delegate_parallel` | 配置了可委派 agent / 满足并行约束时 |
| agent    | `spawn_agent`                          | 动态生成入口启用时                  |

**4. derived infrastructure(派生,非业务工具)**

| source | 工具名        | 备注                                                              |
| ------ | ------------- | ----------------------------------------------------------------- |
| core   | `tool_search` | **自动追加**,豁免 `use/allowed` 过滤,仅可被 `disabled` 关闭(见下) |

### 必须澄清的几个机制事实(易被误读)

1. **`skill_index` 不是工具,是 context layer。** 源码中
   `layer: "skill_index"`([index.ts:706](../../../packages/skills/src/index.ts))。
   唯一可调用的按需工具是 `skill_load`
   ([index.ts:590](../../../packages/skills/src/index.ts));core run loop 也只识别
   `skill_load`([run.ts:2821](../../../packages/core/src/run.ts))。任何工具清单 /
   迁移表里都不得把 `skill_index` 当工具。

2. **`skill_load` 是条件存在,不是固定 built-in。** 仅在有 skills 且
   `includeLoaderTool` 开启时注入,否则不出现在 catalog 中。

3. **`task_create` / `task_get` / `task_output` / `task_stop` / `task_list`
   存在于库里,但不在默认 Host 面。** 主 catalog 默认只注册压缩后的统一 `task`
   控制器([tool-catalog.ts:255](../../../packages/host/src/tool-catalog.ts))。「库里有
   ≠ 模型默认可见」。

4. **`tool_search` 是结构性发现基础设施,不是业务工具。** 由
   `shouldAppendDiscoveryTool` 在「最终已过滤工具集仍含 deferred 工具」时自动追加
   ([tool-selectors.ts:119](../../../packages/host/src/tool-selectors.ts)),其
   descriptor 源只列已过滤工具,因此**豁免 `tools.use` / `tools.allowed` 过滤**;
   但**可被 `tools.disabled: ["tool_search"]` 显式关闭**——这是唯一的退出路径。

5. **已存在「降级机制」。** `deferLoading: true` + `tool_search` 已经实现
   「工具不常驻、模型按需用 `tool_search` 发现并加载 schema」。收窄默认面应**复用**
   这套机制,而不是另造分类字段。

### 当前 selector 面(引用 access-config,非本提案 owner)

`TOOL_USE_SELECTORS`([tool-selectors.ts:20](../../../packages/host/src/tool-selectors.ts)):
`workspace.read`, `workspace.write`, `shell`, `planning`, `skills`, `agents`,
`tasks`, `cron`, `mcp`,外加 `mcp:<server>`。

约束:`assertCodingToolsCoveredByWorkspaceSelectors`
([tool-selectors.ts:127](../../../packages/host/src/tool-selectors.ts))要求每个
`coding` source 工具都必须被 read / write selector 分类,否则启动报错。

## 问题

- 默认 model-facing 面过宽:skills / agents / cron / task / todo / delegate 全部
  常驻,模型选择负担大。
- 工具名偏实现细节:`read_file` / `edit_anchored_text` / `apply_patch` /
  `shell`。
- 编辑有两套协议(`apply_patch` vs `edit_anchored_text`),模型需要在工具间选。
- `anchored` 读写互相依赖却可被分别处置,存在「有 edit 没 anchor」的悬空风险。

## 设计:两层分离

本提案的核心是把**机制事实**与**产品分类**分成两层,边界写死,避免手维护清单漂移。

**关键区分:`deferLoading` 是有效运行时状态,不是稳定分类。** 它会被
`tools.defer`([config-zod-schema.ts:287](../../../packages/host/src/config-zod-schema.ts),
「replaced by later layers」)或用户显式 defer 改变。因此本提案严格分两列,不让分类
随某次运行漂移:

| 概念                  | 含义                                                  | 是否可变                      | 用途                           |
| --------------------- | ----------------------------------------------------- | ----------------------------- | ------------------------------ |
| `defaultExposureTier` | 稳定的产品分类(public / advanced / internal / legacy) | 否(随提案 / 代码改)           | 文档、inspect 分类、迁移       |
| `effectiveLoading`    | 本次运行该工具是否 deferred                           | 是(随 `tools.defer` / 配置层) | 调试「为什么模型这轮看不到 X」 |

### A. 机制事实层(运行时真相,可从源码推导)

每个工具的运行时属性由以下既有信号表达,**不新增并行字段**:

- `catalog source`(`HostToolCatalogEntry.source`,
  [tool-catalog.ts:57](../../../packages/host/src/tool-catalog.ts))——稳定的归属分组,
  做 `defaultExposureTier` 的推导主键;
- `effectiveLoading`(= 本次 `deferLoading`)——本次运行是否延迟加载 schema;
  **仅反映运行状态,不参与稳定分类**;
- `governance` metadata(origin / sideEffects / dataSensitivity)——治理属性,
  但 `origin` 偶有缺失或偏实现来源,**不作分类主键**;
- `tools.disabled`——显式关闭(含 `tool_search` 的唯一退出路径)。

> 分类推导主键:**`catalog source` + `governance` metadata**(稳定信号)。
> `effectiveLoading` 不参与分类,只作运行视图。

### B. 产品分类层(面向用户 / 文档,需谨慎单独设计)

`public` / `advanced` / `internal` / `legacy` 是 `defaultExposureTier` 的取值。
`deferLoading` **只能**表达「本次是否延迟加载」,无法表达稳定分类、展示、兼容别名、
废弃状态。因此:

- `defaultExposureTier = advanced` 的工具**默认**以 deferred 形式暴露(机制上靠
  `deferLoading`),但分类本身不读 `deferLoading`——用户用 `tools.defer` 改变某次
  `effectiveLoading` 不应改变它的产品分类;
- 展示 / 兼容别名 / 废弃状态作为**额外的、尽量可推导的元数据**单独设计,落在
  `capabilities inspect` 与文档层,不污染运行时 catalog 的过滤逻辑;
- `tool_search` 在产品层标记为 **discovery infrastructure**,从 public 工具列表
  隐去,但仍如实出现在「机制事实」视图中。

## 推荐的核心(public)工具面

| canonical 名 | 语义                       | 第一阶段映射                                  |
| ------------ | -------------------------- | --------------------------------------------- |
| `read`       | 读取工作区文本             | = `read_file`(纯文本)                         |
| `write`      | 创建 / 整体替换            | = `write_file`                                |
| `edit`       | 精确编辑(**单协议:patch**) | = `apply_patch`                               |
| `bash`       | 命令 / 脚本 / git          | = `shell`(**仅在 alias 层就绪后启用,见风险**) |
| `glob`       | 路径匹配                   | = `glob`                                      |
| `grep`       | 内容搜索                   | = `grep`                                      |

降级为 deferred(`tool_search` 可发现,`defaultExposureTier = advanced`):

- skills:`list_skills`, `create_skill`, `update_skill`
- agents:`list_agents`, `create_agent`, `spawn_agent`, `delegate_agent`,
  `delegate_parallel`
- automation:`cron`
- planning:`todo_write`
- tasks:`task`
- verified-edit 对:`read_anchored_text` + `edit_anchored_text`(成对,见下)

### `skill_load` 的归类(必须显式决定)

`skill_load` 当前默认就暴露给模型(`includeLoaderTool ?? true`,
[runtime.ts:866](../../../packages/host/src/runtime.ts)),且它是 skills 的**按需加载
入口**——本身就是「发现 + 加载」机制,与 `tool_search` 同构。三个候选:

| 选项                                         | 后果                                                                                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) skill discovery infrastructure(**推荐**) | 与 `tool_search` 同类:存在 skills 时作为「可见基础设施例外」常驻,不降级、也不藏到 `tool_search` 后面。`defaultExposureTier = infrastructure` |
| (b) advanced deferred                        | 把按需加载器自己也藏到另一个发现工具(`tool_search`)后面——发现链变两跳,语义循环,不推荐                                                        |
| (c) 隐藏到 `tool_search` 后                  | 同 (b),且 skills 默认行为(on-demand)被削弱                                                                                                   |

**取 (a)**:`skill_load` 与 `tool_search` 并列为 discovery infrastructure——存在
skills 时可见、从 public 业务工具列表隐去、不被普通 selector 当业务工具治理。这样
skills 的 on-demand 默认设计不被本提案破坏。

暂不进核心(单独立项):`web_search` / `web_fetch`(网络出口 + prompt-injection 面,
走 MCP 或默认关、带 governance 的 capability);`ask_user`(交互特性,需 host /
TUI / CLI / ACP 入口一致性设计,非交互入口必须降级)。

## 定死的 anchored 编辑口径

- **核心面:`read`(纯文本)+ `edit`(纯 patch)。** 模型无需在两套编辑协议间选择。
- **`read_anchored_text` 与 `edit_anchored_text` 成对降级为 deferred 的「verified
  edit」工具。** 二者互相依赖(anchor 只由前者产出),成对进 / 出,杜绝
  「有 edit 没 anchor」的悬空状态。

落地时必须兜住发现体验,否则模型会只加载半套。注意:**当前 `tool_search` 不会天然做
依赖扩展**——它是关键词打分 + 默认 `maxResults=5`
([tool-search.ts:175](../../../packages/core/src/tool-search.ts)),不认识「这两件要
一起出现」。所以必须显式加机制,二选一:

1. **依赖元数据(推荐)**:给工具加 `relatedTools` / `requiresTool` 字段,
   `tool_search` 命中一件时自动把其 `requiresTool` 闭包一并返回,且不计入
   `maxResults` 截断。这是通用机制,不止服务 anchored 对。
2. **paired 专项补全**:在 `tool_search` 内对已知 paired 工具(anchored 读写)做硬编码
   补全。快但是特例,长期不如 (1)。

无论哪种,还需:`edit_anchored_text` 的 description 明确写「先调用 `read_anchored_text`
获取 anchors」(当前描述只说明 anchor 格式,未强制指向来源工具)。

## 新增工具设计(`web_*` / `ask_user`)

这三个与上面的核心 / advanced 工具性质不同,分两条独立轨道,**均不进 6 个核心**。本节
为精简口径,完整设计(SSRF / provider / 注入收敛 / 降级矩阵)落在独立提案
`web-and-ask-user-tools.md`。

### `web_search` / `web_fetch` —— MCP-first,provider 能力矩阵,不进 host/core

现状决定:host/core **零网络栈**,而 MCP adapter 已是受治理扩展点(`mcp:<server>`
selector、trace、governance 现成)。把网络 I/O + provider key + SSRF 防护塞进核心 =
给无网络的核心开第一个出站口,风险大且不可逆。**MCP-first**,将来真要内建 capability
时同一份 provider 代码再包一层即可。

- 形态:首方 MCP server `@sparkwright/mcp-web`,**默认关**,经 mcp 配置 +
  `tools.use: ["mcp:web"]`(或 `web` capability)开启;`defaultExposureTier = advanced`,
  origin = mcp。
- provider contract 显式区分 `search` / `fetch` 能力,允许
  `web.searchProvider` 与 `web.fetchProvider` 不同。配置的 provider 若只支持 search,
  `web_fetch` 返回 typed error,**不静默切到另一个 provider**;provider key 只走
  config/env/secret store,不得进 trace / tool result。
- `web_search`:输入 `query,maxResults?,allowedDomains?,blockedDomains?`;只返回
  `{ title,url,snippet?,publishedAt?,source? }`,不抓正文,`maxResults` 有硬上限(建议10)。输出带 `query/provider/fetchedAt/results`。系统 prompt 要求模型引用这些 URL,
  但 citation 责任不塞进 provider 响应格式。
- `web_fetch`:输入基线 `{ url, summary? }`,做 GET + HTML→markdown(必要时纯文本/PDF
  另列 support matrix)。`summary` 是预留 / 可选能力,默认 `mode:"none"`;允许后续
  `summary:{mode:"model",instruction?,maxChars?,model?}` 或独立 `web_extract` 复用同一
  fetch pipeline。若启用模型总结,必须显式进 budget / trace,记录 summarizer model、
  输入 / 输出字符数、截断、失败 fallback,不能作为隐式副作用。输出
  `{ url,finalUrl,status,contentType,bytes,title?,markdown?,summary?,truncated,
artifactPath? }`。
- URL / SSRF:先做 IDNA / percent 正规化;仅 http(s);拒绝 username/password URL;
  URL 内疑似 API key/token 直接阻断;DNS 解析所有 A/AAAA 后校验,封 loopback / private /
  link-local / multicast / reserved / CGNAT / IPv4-mapped IPv6 / 云 metadata IP 与
  metadata host;DNS 失败 fail-closed。每次重定向都重新校验,限制 hops;跨 host
  重定向默认不自动跟,返回 redirect result,让模型用新 URL 再发起一次受审批的 fetch。
- 资源与结果边界:总超时、连接超时、响应字节上限、markdown char 上限、content-type
  allowlist、可选短 TTL cache;二进制/超大正文只落 artifact + 返回摘要元数据,tool result
  不直接塞大 blob。
- 注入收敛:fetch 返回内容必须包在「untrusted web content」边界中,提示模型网页内容
  只能当数据,不能当指令;正文截断要显式标记。governance:
  `sideEffects: ["network"]`(新增枚举值)、`dataSensitivity: "external"`、首次 / 按域
  `requiresApproval`。

### `ask_user` —— 复用 InteractionChannel,host 级,非叶子工具

源码里已经有 runtime 级 `InteractionChannel.ask` / `RunHandle.askUser()` 与
`interaction.requested` / `interaction.resolved`
([interaction.ts](../../../packages/core/src/interaction.ts),
[run.ts](../../../packages/core/src/run.ts))。这不是要删掉的冗余,而是要收敛成唯一抽象:
runtime 只认 `InteractionChannel`;`RunHandle.askUser()` 是工具 / hook 的便利入口;
trace 只记 `interaction.*`;host protocol 只负责 pending / resolve 镜像。应删掉的是另起
`elicitation.*` 或让 `approval.*` 承载 question 的路线。`approval.*` 继续只表达安全决策,
不要混入偏好 / 需求澄清语义。

- 协议:host 增加 question pending map,镜像 core `interaction.requested{kind:"question"}`
  为可被 client 发现的 host 事件,并新增 `interaction.resolve` request。断连 / run cancel
  / timeout 要 resolve 成 `cancelled` 或 `timeout`,不得泄漏 pending promise。原始
  `interaction.*` 仍进 trace;`approval.resolve` 不承载 question。
- 工具形态:MVP 单次只问一个问题(多问题让模型多次调用,或后续做 batch),输入:
  `{ id?, header?, question, options?: [{id,label,description}], multiSelect?,
allowFreeText?, defaultOptionId? }`。`id` / option `id` 是稳定 machine key,结果不要用
  question 文案当 key。option label 控制 1-5 个词,description 解释 trade-off;UI 可自动加
  free-text "Other"。model-facing `question/options/defaultOptionId` 映射到既有
  `InteractionQuestionRequest.prompt/choices/defaultChoiceId`,option `id` 原样映射到
  `choices[].id`。
- 工具结果:`{ status: "answered"|"cancelled"|"timeout"|"unavailable",
answerText?, selectedOptionIds?, notes?, autoAnswered? }`。取消 / 超时是正常 observation,
  不是 run crash;`answerText/selectedOptionIds/notes` 映射自
  `InteractionQuestionResponse.value/selectedChoiceIds/notes`;模型收到后用最佳假设继续或
  交付 `needs_clarification`。
- 入口映射:ACP/IM → 平台交互组件或 `requestPermission` 兼容层;TUI → 选择框 / 文本框;
  交互式 CLI → 终端 prompt。`InteractionQuestionChoice.preview` 已预留;预览/富文本不是
  MVP,若后续支持 HTML/markdown preview,必须声明格式并在 client 侧 sanitize。
- **交互能力矩阵(最关键)**,由入口 `interactive` 能力位 + agent 配置共同决定:
  - 主 agent:交互式 TUI / ACP / 有人的 CLI 可见;非交互 `sparkwright run`(管道 / CI)、
    cron 默认不可见。
  - delegate 子 agent / 并行 run:**默认不暴露**,但允许显式配置开启,例如
    `capabilities.agents.interaction: "none" | "inherit" | "explicit"`。开启后子 agent
    不直接持有独立用户通道,而是把 question 上浮给 parent interaction broker,由 parent
    串行排队、限流、timeout / cancel、写 trace;并行分支同一时间最多一个 pending
    question。
  - `accessMode` / `ask` / `bypass` 只控制审批与写入自治,不等同于用户交互能力;若要让
    child 可以问人,必须有单独 interaction 开关。
  - 若不可见但历史 trace / profile 仍触发,直接返回 `status:"unavailable"` 或按
    `defaultOptionId` 自动回答并标 `autoAnswered:true`,**绝不挂起**。
- 分类:`defaultExposureTier = infrastructure`,但**入口条件可见**(类比 `skill_load`
  的 skills 条件注入,`ask_user` 是 interactive + agent policy 条件注入);`sideEffects: []`,
  question + answer / cancel / timeout 必须进 trace;它不是 permission / approval 工具。

### 顺序

二者在落地阶段 7。**`ask_user` 先做**:已有 core `InteractionChannel` +
`RunHandle.askUser()` 基础,但 ask 尚未接入 run loop 工具执行面,`RuntimeContext` 不持有
interaction 通道;落地需补 core 侧把 interaction 入口透传给 tool ctx,再补
host/protocol/client 往返与 model-facing wrapper。`web_*` 作为独立 MCP 包另起,因引入
网络栈 + 安全面,单独成提案。

## selector 设计(防膨胀)

保留现有 selector 命名,**不**在 selector 层做 `shell→bash` / `tasks→monitor`
重命名(会破坏现有配置)。变更最小化:

- 新增 source 必须同步更新 `entryMatchesSelector`、
  `assertCodingToolsCoveredByWorkspaceSelectors`、intersect 逻辑及测试——因此能不加就不加;
- `cron` 可考虑并入 `automation`(可选,非必须);
- `web` selector 仅在 web 工具真正落地时引入;
- 不引入 `monitor` / `ask_user` 等单工具 selector(过granular)。

## 别名层是所有重命名的共同前置(不只 `shell→bash`)

任何 canonical 重命名都会复现「双重视觉」:模型同时看到 `read` 和 `read_file`、
`edit` 和 `apply_patch`、`bash` 和 `shell`,反而更乱。因此**别名层不是 `bash` 专属,
而是一切 public wrapper 上线的前置**。它要提供一个共用抽象:

- **模型只看 canonical 名**(legacy 名从 model-facing 面隐去);
- **legacy 名仍在以下路径可解析**:`tools.use` / `tools.allowed` / `tools.disabled`
  配置、approval 匹配、trace 写入、历史 trace 回放;
- 一张 canonical↔legacy 映射表,单一来源,供 config / approval / trace / inspect 共用。

`read/write/edit/glob/grep` 和 `bash` 走的是**同一层**,只是 `bash` 涉及 shell 治理 /
approval 面更广,可在该层就绪后稍后启用。

## capabilities inspect

- 同时呈现「机制事实」(source / governance / disabled / 本次 `effectiveLoading`)与
  「产品分类」(`defaultExposureTier`:public / advanced / internal / legacy /
  infrastructure);
- 稳定分类从 `source + governance` 推导(**不读 `effectiveLoading`**),避免某次运行的
  `tools.defer` 改变分类;
- `tool_search` 与 `skill_load` 在 public 业务列表隐去为 discovery infrastructure,
  但在机制视图如实展示。

## 一句总纪律

**本轮只调整可见性与命名映射,不删除任何旧工具。** `read` / `edit` / `bash` 是
canonical / public wrapper 名;`read_file` / `apply_patch` / `shell` 全部经别名层
保留并可解析,模型不再直接看到它们。

## 分阶段落地

1. **纯降级,零重命名**:给 advanced 工具(skills 管理 / agents / cron / task /
   todo / delegate / anchored 对)打 `deferLoading: true`,验证 `tool_search` 能发现
   并加载。立刻砍窄模型可见面。
   > 注意:这是**低风险但非零影响的行为变更**——会改变 provider 首轮 schema、
   > inspect 的 deferred 标记、模型首轮可见工具、以及调用路径是否新增对
   > `tool_search` 的依赖。需配套测试与迁移说明,不可号称「零影响」。
2. **定 anchored 口径并兑现发现体验**:`edit` 收敛为 patch;anchored 对成对 deferred;
   加 `relatedTools/requiresTool` 依赖扩展 + 补 `edit_anchored_text` 描述指向。
3. **确定 `skill_load` 归类**:作为 discovery infrastructure(选项 a),与 `tool_search`
   并列,不降级。
4. **inspect 双视图**:机制事实 vs 产品分类(`defaultExposureTier` vs
   `effectiveLoading`),稳定分类只读稳定信号。
5. **别名层(所有重命名的共同前置)**:建 canonical↔legacy 单源映射,贯通 config /
   approval / trace / inspect;模型只看 canonical 名。
6. **canonical 名上线**:在别名层之上启用 `read` / `write` / `edit` / `glob` /
   `grep`,随后 `bash`(shell 治理面更广,稍后)。
7. **web / ask_user 另立项**:走 MCP / host 交互特性,带独立安全 / 协议设计。
8. **文档 / manual skill / config schema / TUI 同步**:随真名一次性更新,避免三套名字。

## 风险

1. **anchored 编辑被错误拆分** → 「有 edit 没 anchor」。靠「成对 deferred +
   `relatedTools/requiresTool` 依赖扩展 + 描述指向」消除(P0,阶段 2)。
2. **无别名层就上 canonical 名** → 模型同时看到 `read`/`read_file`、`bash`/`shell`
   等双重视觉。别名层是**所有重命名的共同前置**,故排在 canonical 上线(阶段 6)之前
   的阶段 5(P0)。
3. **分类随运行漂移**:若 inspect 把 `effectiveLoading`(可被 `tools.defer` 改)当稳定
   分类,会让同一工具在不同运行显示不同 tier。靠 `defaultExposureTier` /
   `effectiveLoading` 两列分离规避(P0)。
4. **重造已有 defer / discovery 机制**,产生第二套并行分类,长期漂移。靠「机制事实层
   复用既有信号、稳定分类只读稳定信号」规避。
5. **与 convergence 提案分叉**:`skill-runtime-v1-redesign.md` 主张 Skill / MCP /
   Agent / Delegate 收敛为单一调用 substrate;本提案的「advanced 层」命名应对齐该
   substrate,而非另起 `automation` / `monitor` 词汇表。
6. **selector / 不变量同步遗漏**:新增 source 未同步
   `assertCodingToolsCoveredByWorkspaceSelectors` 等 → 启动报错。变更最小化 + 测试覆盖。

## 待决问题

- canonical `read` 是否最终带 anchors(即 `read` = `read_anchored_text`),还是
  anchored 读写永远成对停留在 deferred 层?本提案取后者(核心 `read` 纯文本)。
- anchored 对的发现机制取通用 `relatedTools/requiresTool`(推荐)还是 paired 专项
  补全?本提案倾向前者,待实现设计确认 `tool_search` 改造成本。
- `cron` 是否并入 `automation` selector。
- web / ask_user 走 MCP 还是 built-in capability(默认关)——在独立提案决定。

## 参考

- [`skill-runtime-v1-redesign.md`](skill-runtime-v1-redesign.md) — Skill 收敛 substrate
- [`agent-capability-upgrade.md`](agent-capability-upgrade.md) — agent 能力升级线
- [`agent-access-config-redesign.md`](agent-access-config-redesign.md) — access mode / 配置语义
