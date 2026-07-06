# 定调议程(Consolidation Agenda)

> Status: **13 项全部裁决完毕(2026-07-06,用户投票单)**,进入认领/
> 执行;裁决见各行行尾。总口径:C1–C4 必批,C5–C8 批边界,C9–C12
> 批认领或缓,C13 单独拍(drafted 2026-07-05)。
> 快照基线:`feat/workflow-p4` @ `85d84a0b`(P10a);main @
> `8593b4a8`(PR #47)。注意:本分支有并行会话持续出 slice,任何
> "进行中/未做"的状态行都会快速过时——认领前重验。
>
> 这一页**不是设计文档**:它是跨 13 份提案的未批决策、互相假设、
> 残留项的**燃尽清单**。设计归 owner 提案,基座归
> `substrate-sequencing.md`(常设地图);本页是一次性议程,逐项清零后
> 整页归档进 `docs/_internal/reviews/`。
>
> 纪律(与 rule zero 并列):**议程组未清零前,该组覆盖的提案不开新
> slice**。豁免边界:已进入 owner 提案 Accepted Slice 表的阶段
> (如 workflow P9x)按原契约继续,不受本页阻塞;本页拦的是**新方向**
> ——尚未进表的 slice、新提案、新机制,必须能指到本页某一行的裁决。
> 近期 workflow 一天推进 P5→P9a 五个 slice,单条线纪律是好的(每个
> slice 都有 deletion bound),跨提案的裁决没有跟上——本页补的是后者。

## 0. 已定主干(不重开,列出防止重复裁决)

- S1 doc-store / S2 FactLedger / S3 预算三分(annex 已批)/ S4 资产解析
  —— 全部合并 main(PR #41/#42/#45 及 workflow P0)。
- Access mode(access-config 子提案 #1)—— PR #38;`permissionMode`
  退为内部编译目标。
- Background 任务生命周期 P0 主干(revival spine、
  `FileTaskNotificationOutbox`、awaited 契约)—— PR #39。
- Workflow P0–P3 合并(PR #43–47);P4–P10a 在本分支已提交(P9a =
  D5 workspace-root store 提升;P10a = D20 兼容 slice:core PreToolUse
  两阶段化,rewrite 先应用、governance/clamp 再在改写后参数上执行,
  `85d84a0b`)。todo 自托管已开始:P6a(todo 纪律单一权威)、P6b
  (`todo_clear` verifier)。
- Hook 命令遥测 stdio-v1 —— 已实现(2026-06-28),P4 script 节点复用
  同一族(正例:提前收敛,无需动作)。
- 两个 run loop **声明不合并**(substrate-sequencing Tier 3 显式非目标)
  —— 已是决策,不再讨论。
- D11/D26:无模型侧 `workflow_start`,重开信封已预绑定 —— 已是决策。

## 1. 未批决策清单

每项:问题 → owner 文档 → 阻塞面 → 建议处置。裁决只需在行尾标
`批 / 缓 / 杀` 加日期。

### 甲组 — 架构命题(先裁,决定"开枝"方向)

- **C1|Skill/MCP/Agent/Delegate 单基座 addendum 批准。**
  owner: `skill-runtime-v1-redesign.md` 附录(Draft, 2026-06-27)。
  现状:Agent 面已按该模型落地(indexed exposure + `delegate_agent`),
  A-Phase 3(`mcp_call` 门面 + 名称级 defer)未动。
  阻塞:C2 的词汇设计、capability-upgrade Phase 3 路由都在等这个命题
  定性。建议:**批 A-Phase 1–3**;A-Phase 4(shared routing)与
  capability-upgrade Phase 3 是同一件事,合并评审(见 C-dup-1)。
  **→ 裁决 2026-07-06:批 A-Phase 1–3;缓 A-Phase 4(与 3b 合并后
  再评)。完成 2026-07-06:`skill-runtime-v1-redesign.md` addendum
  已标记 A-Phase 1–3 accepted、A-Phase 4 deferred;`substrate-sequencing.md`
  已同步 Skill/MCP/Agent/Delegate 基座排期。**
- **C2|能力面词汇拆三层,各设唯一 owner。**
  `agent-access-config-redesign.md` 子提案 #2/#3 与
  `builtin-tool-surface-consolidation.md` 的 selector 面 + 别名层交叠,
  且有一处**表述冲突**:access-config 写 selector 词汇 "no aliases",
  而源码 `host/src/tool-identities.ts` 已是 canonical + legacy alias
  (`read_file→read`、`apply_patch→edit` 等)——两者说的不是同一层,
  但不拆开就会互相误伤。三层裁决:
  ① selector/toolset 编译词汇(无别名)→ access-config #2/#3;
  ② tool identity(canonical 名 + legacy 别名 + exposure tier,已落地)
  → `tool-identities.ts` 为事实源,builtin-tool-surface 记录其规则;
  ③ 产品默认公开面清单 → builtin-tool-surface。引用不复述。
  **→ 裁决 2026-07-06:批(三层各设唯一 owner 如上)。首个交付物:
  三行归属声明写入两份 owner 提案的交叉引用。完成 2026-07-06:
  已写入 `agent-access-config-redesign.md` 与
  `builtin-tool-surface-consolidation.md`,并以
  `packages/host/src/tool-identities.ts` 为 tool identity 事实源。**
- **C3|coordinator P0(边界冻结)现在做否。**
  owner: `session-agent-host-coordinator.md`(Draft v3,全部未实施)。
  排期约束"coordinator P1 在 workflow 4a 之后"已满足(P3 已合并)。
  rule zero 风险:`SessionTurnScheduler` 是潜在的**第四个"谁拥有下一次
  执行"owner**(现有三个:core 续跑、workflow episode driver、
  TaskManager revival)。建议:**批 P0(纯文档)**,但验收物不是一张
  单薄的"四 owner 表",而是一份**边界矩阵**,逐行冻结:谁创建 turn、
  谁续跑、谁注入命令(same-session queue/injection)、谁发
  terminal/wakeup 通知、谁持 workspace write lock / resource pool、
  谁能跨进程协调(multi-process file store 安全性)。P1 等 workflow
  主线告一段落;5 个 open questions 中"per-connection HostRuntime
  兼容路径"一条其实触及 P0 矩阵,随 P0 一并写死,其余随 P1。
  **→ 裁决 2026-07-06:批 P0(边界矩阵文档);缓 P1(scheduler 实现,
  等 workflow 主线缓下来)。完成 2026-07-06:
  `session-agent-host-coordinator.md` 已落 P0 边界矩阵,并冻结
  per-connection `HostRuntime` 为兼容路径;`substrate-sequencing.md`
  已同步"下一次执行"owner 边界。**
- **C4|workflow 三道未接线闸门的重开条件(定条件,不定排期)。**
  owner: `workflow-runtime-v1.md`。
  - D26 spawn/`workflow_start`:维持关闭;重开条件 = 统一任务生命周期
    出生契约 + 递归深度 + 授权钳制三者成为一等输入(信封已写死)。
  - D10 节点边界 compaction:可表达未接线;重开条件建议 = 出现第一个
    因上下文膨胀而失败的真实 workflow 案例(事实驱动,不预做)。
  - D6 retry 模型升级/cruise:P3 留尾;重开条件建议 = 内部 dogfood
    资产(P4 交付的 probe ladder)出现 retry 率证据。
  **→ 裁决 2026-07-06:批条件,不批排期(三道闸门均以真实证据触发,
  不凭感觉开)。完成 2026-07-06:重开条件已写入
  `workflow-runtime-v1.md` D6/D10/D26 对应决策条目。**

### 乙组 — 产品面孔(小,直接影响易用性)

- **C5|builtin-tool-surface 三个显式待决**:`skill_load` 归类(提案
  推荐案 a:discovery **infrastructure** tier,与 `tool_search` 并列的
  可见基础设施例外,存在 skills 时常驻——不是 public)、anchored 读写
  成对降级口径、`web_*`/`ask_user` 新工具(源码核对:均未实现)。`ask_user` 必须复用 `InteractionChannel`
  ——与 workflow `human`/`wait.kind` 同底座,提案已这么写,批它即关闭
  一个撞车点。别名层(所有重命名的共同前置)归属跟随 C2:机制(别名
  解析/兼容层)归 C2 的词汇 owner,builtin-tool-surface 只出"改哪些
  名字"的清单——否则 C2 与 C5 隐含两个 owner,自相矛盾。
  **→ 裁决 2026-07-06:分拆——批 `skill_load` = infrastructure、
  anchored 成对 deferred、`ask_user` 仅复用 InteractionChannel;
  缓 `web_*`(MCP-first,不进 host/core 默认面)。**
- **C6|tui-permission 收尾**:源码核对(2026-07-05)——P0/P1/P2 基本
  全落地:`tuiPermissionMode` 遍布 `tui/src`(config-panel、
  run-controller),`allowWorkspaceWriteApproval` 在 `packages/*/src`
  零命中(已删)。动作收窄为:把提案页状态改为已落地记录;其 5 个开放
  问题若仍悬空(默认档、`--yes*` 归宿等),并入 C2 的权限词汇裁决。
  **→ 裁决 2026-07-06:批关闭(提案状态改 implemented;残余并入
  C2/access-mode。注意"默认档 ask vs read-only"是产品取向题,并入后
  单独可见,勿被词汇讨论淹没)。完成 2026-07-06:
  `tui-permission-consolidation.md` 状态已改 implemented,残余问题已标
  并入 C2/access-mode。**
- **C7|agent 定义文件的双提案合并**:`agent-md-authoring-redesign.md`
  (D1–D4 + open Q2/Q3)与 access-config 子提案 #4(agents/<id>.md、
  frontmatter delegate)是同一素材。建议:合并为一份,access-config #4
  出 schema,authoring 提案出 hooks 载体(D3)与交付切分。合并评审时
  必核一条交叉项:Agent.md 的 this-agent-only workflow hooks(D3)与
  workflow 治理的相容性,**按 P10a 之后的两阶段规则验收**——P10a 已把
  core PreToolUse 改为 rewrite 先应用、governance/clamp 在改写后参数上
  执行,所以问题不再是"configured rewrite 被整体拒绝",而是:child
  agent 的 Agent.md rewrite hooks 进入哪个阶段、node clamp 是否看得到
  它们的改写结果、`advance` 类效果是否仍被 D19 拒绝。两提案目前互不
  知情,agent-md 提案成文早于 P10a。
  **→ 裁决 2026-07-06:批合并(access-config 出 schema,authoring 出
  hooks 载体与切片;验收必须按 P10a 两阶段规则补测试)。完成
  2026-07-06:两提案已互设 owner 边界;access-config #4 保持 schema
  owner,authoring 提案保持 hooks 载体/切片 owner,并写入 P10a
  两阶段 `PreToolUse` 验收项。**
- **C8|skill-runtime 4 个 open questions**:archived 是否进
  `skill_index`、`allowedTools` 是否由 host 强制、CLI `skills create`
  直写去留、bundles 去留。建议:bundles 按 rule zero 处置——没有产品
  面客户就删(Phase 5 的"experimental surface decision"同此);其余三
  个各一行裁决即可,不需要设计。
  **→ 裁决 2026-07-06:archived 不进 model-visible index(仅
  inspect/doctor);`allowedTools` 不授权只声明需求(host/config/
  policy 是唯一强制边界);CLI 直写保留给人类,模型侧仍走 proposal;
  bundles 杀(无明确客户,按 rule zero)。完成 2026-07-06:
  `skill-runtime-v1-redesign.md` 已改为 resolved decisions;bundles 标为
  批次 3 no-customer audit 后删除。**

- **C13|read-scope 残留(安全语义,单独拍,不与 cleanup 混批)**:读
  机密层**已存在**——`createWorkspaceReadScopePolicy`
  (`core/src/policy.ts`)+ `guardRead` 读闸
  (`core/src/workspace.ts:226`)。原核对写成 opt-in/空
  `confidentialPaths` 即 no-op;2026-07-06 当前 main 已在 host/direct-core
  policy 里 prepend `DEFAULT_CONFIDENTIAL_PATHS`,所以②认领前必须重验。
  裁决拆两件,各一行处理:
  ① `target/--target` 只限写不限读——建议接受现状并文档化(不让
  `--target` 悄悄变成读沙盒);
  ② 原残留:默认空 `confidentialPaths` = 工作区内读全宽——建议立小项
  给保守默认(源码已有 credential/.ssh/.aws 模式常量可作候选),约束:
  默认拒绝必须可配置覆盖、拒绝走既有 `workspace.read.denied` trace
  可见,落地前核对 QA fixtures 是否会因文件名含 credential 之类误伤。
  2026-07-06 当前 main 已接入 `DEFAULT_CONFIDENTIAL_PATHS`,所以代码项
  不可按旧事实直接开工,需重验配置覆盖、trace 与 fixture 影响。
  **→ 裁决 2026-07-06:① 批现状——`--target` 继续只限写,接受并
  文档化;② 批小立项——保守默认 `confidentialPaths`,带上述三条
  约束。完成 2026-07-06:① 已写入 `docs/guides/CONFIGURATION.md` 与
  `docs/guides/USER_MANUAL.md`;源码复核发现②的保守默认已在当前 main
  通过 `DEFAULT_CONFIDENTIAL_PATHS` 接入 host/direct-core policy,后续代码项需
  先重验是否仍需小 PR。**

### 丙组 — 已定未做完(不需要裁决,需要排期认领)

- **C9|S1 存量迁移未完**:私有 atomic-write 仍在**三处**——
  `packages/core/src/session.ts:523`、
  `packages/agent-runtime/src/tasks/file-notifications.ts:523`、
  `packages/cron/src/store.ts:284`(私有 `save()`,tmp+fsync+rename
  手写,此前一版议程误报"已消失",系 grep 模式过窄漏检)。定性:S1 的
  rule-zero 达标(创建 PR 已迁 FileTaskStore),三处是 sequencing 页
  登记的 remaining copies(core/session 标 opportunistic)——是存量,
  不是违约;列在这里防止它永远"opportunistic"。
  **→ 裁决 2026-07-06:批认领(三处迁 S1 doc-store,优先挑小 PR:
  file-notifications 或 cron 先行)。完成 2026-07-06 C9-①:
  `packages/agent-runtime/src/tasks/file-notifications.ts` 已迁到
  `agent-runtime/src/doc-store` 的 `atomicWriteTextSync()`,退役该文件私有
  tmp-write + rename helper;剩余 `core/src/session.ts` 与
  `cron/src/store.ts`。完成 2026-07-06 C9-②:
  `packages/cron/src/store.ts` 私有 `save()` 已迁到
  `agent-runtime/src/doc-store` 的 `atomicWriteText()`,退役该文件私有
  tmp+fsync+rename+目录 fsync 写入流程;剩余 `core/src/session.ts`。完成
  2026-07-06 C9-③:`packages/core/src/session.ts` 私有 `atomicWriteText()`
  已退役;因 `@sparkwright/core` 不能依赖上层 runtime 包,实现改为下沉
  `packages/core/src/file-atomic.ts` 并让 `agent-runtime/src/doc-store`
  保持公共 wrapper 复用同一实现。C9 三处存量迁移完成。**
- **C10|Tier 3 删除清单**:ACP 入口缺 `--session-root`(写进工作区)、
  `capabilities inspect` 少报 inline-config agents(capability-upgrade
  Phase 1 留尾同源)、`detectSkillLearnTarget` 旁路未删。
  **→ 裁决 2026-07-06:批认领(先做 capabilities inspect inline
  agents,反哺 C2/C7)。**
- **C11|登记在案的债**:workflow 单写 lease 的 TTL 泄漏(backlog)、
  P2 评审遗留 double-cast core debt。
  **→ 裁决 2026-07-06:缓(不打断收口;触发器:下一个触碰 workflow
  store 的 PR 必须带上 lease TTL——P9a 刚动过该 store,顺风车就在
  眼前;double-cast 等相关 core slice 顺手带)。**
- **C12|QA 收敛残余**:six-findings 的 #1/#3/#5/#6 未修(结构方向已
  记)。QA convergence 5-phase 计划 2026-07-05 检索 proposals/ 与
  reviews/ 均未见——**很可能从未落盘**(只存在于当时的会话记录),
  动作是**补写落盘**而非搬家;因残余未清、计划仍 active,归宿建议
  proposals/(清完再归档 reviews/)。否则"引用不复述"没有引用目标。
  **→ 裁决 2026-07-06:批"给家"(补写落盘至 proposals/);缓实现
  (#1/#3/#5/#6 后续排期)。完成 2026-07-06:
  `qa-convergence-plan.md` 已作为 stub home 落盘,仅记录已知线索与待补
  五阶段骨架。**

## 2. 互相假设对齐表

| 假设 | 双方 | 状态 / 动作 |
| --- | --- | --- |
| workflow P0 依赖 `feat/background-agent-jobs` @ `eaf17742` 合并或 pin | workflow ↔ background | 已合并(PR #39),假设关闭 |
| "谁拥有下一次执行":core 续跑 / workflow episode driver / TaskManager revival / 未来 SessionTurnScheduler | workflow ↔ background ↔ coordinator | 前三者已按 D18 收敛;第四者是 C3 P0 要冻结的边界,**P0 交付物 = 这张表** |
| tui-permission 派生 `{permissionMode, shouldWrite}` | tui-permission ↔ access-mode | access-mode 已把 `permissionMode` 内化;提案措辞过时,随 C6 核对 |
| trace→资产进化的两条通道 | skill-stats evidence bundles ↔ workflow distill(P7a 已落地) | 约定:distill 归 workflow 资产、skill-stats 归 skill 资产,共享确定性 trace 观察层,不新建第三条挖掘管道 |
| 交互原语单底座 | `ask_user`(builtin-tool)↔ workflow `human` ↔ approval | 共识已写在提案里(`InteractionChannel`);随 C5 批准变成约束 |
| 进程遥测协议 | hook-telemetry stdio-v1 ↔ P4 script node API | 已收敛,正例,无动作 |

## 3. 重复开发 / 合并候选

- **C-dup-1**:skill addendum A-Phase 4(rank-before-hide 跨面路由)
  ≈ capability-upgrade **Phase 3b**(声明式匹配/路由)。注意重复的是
  3b,不是 Phase 3 整体——3a(描述自动增强 + inspect model)按记忆已
  随 feat/access-mode 落地(认领时核对)。合并评审 3b 与 A-Phase 4,
  一个 owner(建议归 addendum,capability-upgrade 3b 改为引用)。
- **C-dup-2**:selector/toolset 词汇双处设计(即 C2)。
- **C-dup-3**:exposure/deferral 分层三处表述(tool-identity tiers 已
  落地代码、skill addendum、builtin-tool-surface)。代码是单一实现,
  文档三处各说各话——C1/C2 裁决后做一次表述归一。
- **反例(不合并,重申)**:两个 run loop;`todo` 教义与 workflow
  资产(P6a 已定 tool-gated 单一权威,不再讨论"todo 完全迁移")。

## 4. 执行队列(2026-07-06 裁决后)

```text
零代码批次(文档落实裁决,可一个 PR 打包):
  C2 三层归属声明写入两份 owner 提案 + C6 提案状态改 implemented
  + C4 重开条件写入 workflow 提案 + C13-① --target 只限写文档化
  + C12 QA convergence 补写落盘 proposals/
文档工程批次:
  C3 P0 coordinator 边界矩阵;C7 Agent.md 双提案合并(含 P10a 验收项)
  C1 A-Phase 1–3 按 addendum 排期;C8 四项落实到 skill-runtime 提案
  (bundles 删除是代码,归下一批)
小 PR 批次(认领即做):
  C9 三处 atomic-write 迁移(file-notifications/cron 先行)
  C10 Tier 3(capabilities inspect inline agents 先行)
  C8-bundles 删除;C13-② confidentialPaths 保守默认小项
挂触发器(不排期):
  C11(下一个 workflow store PR 带 lease TTL);C4 三闸门;C5 web_*;
  C3 P1;C1 A-Phase 4(与 3b 合并评审)
```

方向已定:能力面(C1/C2)、并发/服务化(C3)、workflow 后续(C4)
各有挂靠点和重开条件;此后新 slice 必须能指到本页某一行,否则就是
"闭眼累加"。

## 5. 维护

- 每清一项:行尾标注裁决 + 日期 +(如产生代码)PR 号。
- 清零后:整页移入 `docs/_internal/reviews/`,`substrate-sequencing.md`
  的 Tier 2/3 表同步更新。
- 本页事实核对基线为 2026-07-05(源码 grep:C6/C9/C5 的"未实现/已落地"
  结论);认领任何一项前先重验该行事实。
