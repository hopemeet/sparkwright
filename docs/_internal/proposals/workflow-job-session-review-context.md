# Workflow as Job Session — 调用/会话面 review 上下文

状态:三轮 review 完成(2026-07-07),第 7 节问题全部拍板;
2026-07-11 收敛审计完成,新增实施包见第 8 节,不另立 Actor/进程提案;
inputs schema 已按 D27 候选写入 workflow-runtime-v1.md(待批);
teacher-force replay 核实为 runtime-v1 设计节已有,无遗留写入动作。
来源:2026-07-06 对齐讨论(产品抽象 → 奇思妙想盘点 → 调用面方案);
2026-07-07 二轮 review(stop 能力边界修正、resume 预填坑、MVP A→D 重排、
detach 措辞裁决)+ 三轮 Runbook Mode 轮(3.6、D27、stop 矩阵硬化)。
范围:只覆盖 workflow 的**调用/会话面**(TUI 如何触发、观察、介入 workflow);
不重开 D11/D26(无模型侧 `workflow_start`),不改运行时语义。

---

## 1. 产品抽象共识

**Workflow as Job Session**:用户看到的是"任务会话"(attach/detach/resume、
当前节点、验证证据),DSL 和状态机藏在后面。心智类比:

| 用户心智                     | 底层实体                                       |
| ---------------------------- | ---------------------------------------------- |
| terminal shell               | TUI 主对话(普通 run)                           |
| tmux session / job           | workflow run(durable 实例)                     |
| `tmux ls` / `tmux attach`    | `workflow.list` / attach 视图                  |
| tmux status bar              | 状态行:当前 node / gate verdict / waiting 原因 |
| `tmux new -d 'make release'` | 背景 workflow job(用户不在里面,看句柄)         |
| tmuxinator 模板              | 内置/项目级 workflow 资产(用户只选不写)        |
| 把手工操作录成模板           | `workflow distill`(P7a)+ `shadow`(P8a)         |

类比的三个关键推论(都与已批决策一致):

1. **shell 不会变成 tmux** → 主 agent 只建议、客户端触发,聊天 run 不被状态机接管
   (= D26 spawn 模式,父 run outcome 解耦)。
2. **tmux 不就地改造你的 shell** → 禁止把活跃聊天 run 就地升级成 workflow
   (D16 实例化时刻授权结清)。
3. **tmux 继承 cwd+env 不继承 scrollback** → spawn 的 workflow 继承 goal +
   精选事实(将来 FactLedger/S2 投影),不继承聊天 transcript。

类比失效处(有产品含义):tmux 是纯复用器,workflow 是受治理环境
(clamp/verifier/D19/D23)。因此 attach 视图必须把治理状态做成一等公民
——这正是"调试心智复杂"难点的解:tmux status bar 级别的"我在哪、卡在哪"。

产品分层(用户提出,无异议):

- 第一层:模板化,内置 release-check / bugfix / migration / review,只选不写;
- 第二层:agent 建议、客户端触发(确认后由 TUI 发 `run.start { workflow }`);
- 第三层:distill/shadow 自动生成草稿 + 覆盖率校验,不从空白 YAML 开始。

## 2. 已验证事实(2026-07-06 对照代码核实)

**协议面已经齐了——MVP 四个动词全部存在**,见 `packages/protocol/src/index.ts`:

- `run.start` payload 已有 `workflow?: string` 字段(≈322 行),CLI `--workflow` 走的就是它;
- `workflow.list` / `workflow.resume` 是协议方法(不是 CLI-only),
  list 返回 `WorkflowRunSnapshot[]` 带 status 过滤,resume 返回 `workflowRunId`;
- `run.cancel` 已存在,底层 D24 语义(同步、无钩子、踢 RunEnd(cancelled)),
  ⚠ 但二轮核实:host `cancelRun` 只匹配**当前连接**的 active runId
  (`packages/host/src/runtime.ts` cancelRun,连接外一律 `run_not_found`),
  且 waiting 态没有 active episode——stop 只能覆盖 TUI-owned live job,
  见第 4 节 MVP-D;
- 事件流已有完整 workflow 词汇:`workflow.started / node.started / node.completed /
waiting / interrupted / completed / failed / cancelled`——attach 状态行数据源全在;
- `WorkflowResumeRequestPayload` 要求重新提交全套授权字段
  (sessionId/targetPath/confidentialPaths/shouldWrite)→ **连 resume 都按次重新结算授权**,
  这是"禁止就地改造活跃 run"的协议层佐证;
  ⚠ 但二轮核实:这些字段**全 optional**,且 `WorkflowRunRecord` 不持久化
  任何原始授权(resume 策略里只有 `verifyOnResume`)——TUI 裸 resume 会
  **静默降级到默认授权**(如写范围回落 README.md),比 stop 的坑更隐蔽
  (无显式报错,后续写节点才莫名失败),见第 4 节 MVP-C;
- TUI 对 workflow 几乎零消费(仅 capabilities 面板/format-event 提及)
  → MVP 主体是 TUI 呈现层工作,但二轮修正:**不是零 host 增量**——
  stop 是连接局部能力(见上),resume 预填需要授权快照(MVP-C);
  教训:勿被"协议字段存在"骗,字段存在 ≠ 能力存在;
- workflow 资产已是 skill 式文件夹(`workflow.md` per folder,
  见 `packages/host/test/fixtures/workflows/release-check-focused/`),S4 parser 同一管线;
- P9a 已把运行状态提升到 workspace 级 `workflow-runs` store → 跨进程可发现。

## 3. 本轮新达成的设计裁决(待 review 确认)

### 3.1 FG/BG 单一实例化路径,只差视图焦点 ★核心修正

原方案的 Foreground Handoff("确认后当前聊天切到 workflow run",exec 式)
**不能按字面实现**——就地改造撞 D16(授权无中途重结算语义)。
修正:Foreground 和 Background 都走 `run.start { workflow }` 起**新 run**,
差别只在 TUI 视图策略:FG = 焦点立刻切到新 job pane(聊天 run 收尾/挂起);
BG = 焦点留在聊天,job 进侧栏。
收益:两种 UX 从"两个功能"塌缩成"一个功能 + 一个焦点开关";
一种启动机制、一种授权语义、一种 trace 归属。

### 3.2 背景模式路线:每 job 一条 host 连接,TUI 多路复用

现状约束:host 一连接一 active run。两条路线:

- **路线 1(选定 v1)**:每个 job 新起一条 host 连接,TUI 做复用器。
  tmux 忠实翻译;lease/trace/session/权限天然按连接隔离,不碰递归/权限继承/取消/trace 归属。
- 路线 2:等 background-task-lifecycle 统一出生契约,workflow 作为 task-shaped
  handle 生在聊天 run 里(D26 spawn 完全体)。
  关键定位:路线 2 是**"workflow 句柄出现在聊天里"**的前置,
  不是**"TUI 有 job 列表"**的前置。两者不互斥,路线 2 落地时收编路线 1 的连接复用。

### 3.3 attach 两种成色

- **store attach(v1)**:读 workspace 级 store 的 `WorkflowRunSnapshot` + 定期刷新。
  P9a 红利:跨进程可 attach——CLI 起的 workflow,TUI 也能 list/attach。
- **live attach(v1.5)**:TUI 自有连接的 job 直接消费事件流,实时滚动 node/gate 事件。

### 3.4 建议机制分寸

- v1:主 agent 散文建议("适合 release-check,可 `/workflow start release-check`"),
  用户手敲。零新机制,D11/D26 原封不动。
- v1.5:结构化建议 chip(agent 输出 envelope → TUI 渲染确认按钮 → 客户端代发
  run.start)。仍非模型侧工具,不触碰 D26 reopen 条件
  (统一任务生命周期出生契约 / 递归深度控制 / 授权 clamp 三者齐备才可开模型侧工具)。
- 2026-07-07 裁决:chip 提前到 **MVP 后第一件事**——散文建议对普通用户
  约等于没有(会照着敲的用户本来就会自己敲),第二层产品承诺的真正落点是 chip,
  阻力只在工程量。

### 3.5 detach 语义(2026-07-07 已裁决)

tmux 心智说 detach 不杀 session,但当前 host run 依附连接。裁决:
**v1 = 状态可捡,非进程存活**——TUI 退出 job 也停,resume 捡起来
(durable record + resume 本来就为此设计),避免 v1 引入守护进程。
配套约束:**UI 语言不用 detach 这个词**——tmux 类比教用户的第一课就是
"detach 后 session 还活着",在最关键承诺上背叛心智模型信任崩得最快;
用 hide / pause / "稍后 resume" 等诚实措辞,退出 TUI 时明确提示
"N 个 job 将停止,可 resume"。独立进程方案挂到路线 2
(background-task-lifecycle 统一出生契约)作为其收编项,不在 v1。

### 3.6 Runbook Mode(2026-07-07 三轮新增)

**定位:不是新层、不是新机制,是第一层(模板只选不写)的 CLI 脸面 +
产品语言**——"启动一个已审过、版本化、可恢复、受治理的操作流程"。
同一个 `run.start { workflow }`、同一个 D16 实例化授权、同一份 durable
record;只是入口换成 ops 动词。与 FG/BG 塌缩同一课:一种机制多张脸,
不为脸发明机制。D11/D26 不受触碰(客户端显式触发,CLI 先例)。

已核实现状(2026-07-07,约七成已落地):

- `sparkwright run "goal" --workflow <name>` 已存在(goal 必填位置参数);
- `sparkwright workflow list|inspect|resume|distill|shadow` 子命令家族
  已存在——缺的只是 start 别名(并入该家族)与 stop(见下矩阵);
- inputs/params 概念完全不存在 → 真增量,升格为 runtime-v1 **D27 候选**
  (pending user confirmation;runtime-v1 顶部 accepted slice 仍止于
  P10a,任何地方不得写成已 accepted)——数据 schema 非语言、whole-token
  绑定循 D16 先例、冻进实例化快照、inputs = job 身份 resume 不重问
  不许改,本稿不展开。

v1 边界(承诺刚好能兑现):

- **`--background` 排除**——3.5 裁决(v1 无守护进程)的直接推论;进程退
  job 停。挂路线 2 与独立进程一起收编。诚实版本反而更像运维:CI job
  就是前台阻塞的。
- **前台阻塞 + waiting 退出循环**:exit code 映射 workflow 结局
  (run-outcome 单一 failing 投影);碰到 human/approval waiting →
  打印原因 + `workflow resume <id>` 提示,以独立 exit code 退出;
  操作员审批后 resume 接续。runbook 在审批点暂停,全落在已有裁决内。
  约束:waiting 退出码同样从持久化 record 状态投影(P1.5 已把 CLI exit
  path 收敛到快照单源),不新增第二判定通道。
- **stop 矩阵(硬边界)**:
  - CLI 前台 run:Ctrl-C ✅,但注意现状是**裸杀非 cancel**——record 留在
    非终态、可 resume(= 事实上的暂停);显式 `run.cancel` 则是终态
    不可 resume。两者后果相反,勿并读;将来改 SIGINT→cancel() 须先过
    pause vs kill 裁决(见下方 ⚠);
  - TUI-owned live job:`/workflow stop` ✅(MVP-D);
  - 独立 `sparkwright workflow stop <id>`:**v1 不提供**——天然跨连接,
    正好整个落在 cancelRun 连接局部语义之外;动词保留给将来的
    `workflow.cancel`(存在但永远失败的命令比不存在更伤信任);
  - 真正跨进程 stop 等 `workflow.cancel` 或 task-lifecycle 收编。
- **stop = 终结,不是暂停**(2026-07-07 核实):`cancelled` 是终态,
  resume 明确拒绝(store 终态判定 completed|failed|cancelled;
  resumeWorkflowRunInner 对终态返回 invalid_payload)。可 resume 的只有
  `running` / `waiting`。
- **Ctrl-C 的实际语义**:CLI/host 均无 SIGINT 处理,Ctrl-C 裸杀进程 →
  record 留在非终态 → 可捡(依赖 lease TTL 过期;lease TTL leak 在
  backlog)。这恰好构成 v1 唯一的"暂停"形态。⚠ 将来若给 CLI 加优雅
  SIGINT→cancel,会把"可捡"悄悄变成"终结"——须先裁决 pause vs kill
  语义,不得顺手加。

## 4. MVP 工作清单(2026-07-07 二轮重排为 A→D 四层)

分层原则:只读先行、风险后置;每层交付后独立可用,每层比上一层多一个
明确的能力承诺。原"需核实 `WorkflowRunSnapshot` 是否带 runId"已核实:
`activeRunId` + `runIds[]` 都在,但 stop 的瓶颈不在字段而在 cancelRun
的连接局部语义(见 MVP-D)。

- **MVP-A(纯只读,零授权、零 cancel 语义)**:`/workflow list` + job 侧栏
  (`id / status / node` 一行一个)+ **waiting badge**——job 卡在 human wait
  用户必须看见,否则等于静默失败;snapshot 已有 `wait.kind/reason`,成本低。
  attach snapshot 视图 + 状态行:node / 最近 gate verdict / waiting 原因 /
  失败原因(遵守 scrollback-native / minimal chrome 偏好)。P9a 红利:
  CLI 起的 workflow 也能 list/attach。waiting 可见性优先于 live attach。
- **MVP-B**:`/workflow start <name> <goal>`;FG/BG 只是焦点策略(3.1);
  每 job 一条 host 连接(3.2 路线 1)。侧栏必须区分"连接断了"和
  "job 失败了",别让实现细节漏成用户困惑。
  CLI 侧同层补:`sparkwright workflow start <name>` 别名并入已有子命令
  家族(等价于 `run --workflow`,同一路径);waiting 退出循环见 3.6。
- **MVP-C**:`/workflow resume <id>`,`waiting` 状态做成一等入口。
  ⚠ 含一个 host 增量:`WorkflowRunRecord` 需持久化**实例化时刻的授权快照**
  (targetPath / confidentialPaths / shouldWrite / accessMode),作 resume
  表单预填,用户单次确认——不违反 D16,授权仍按次结清,只是把"上次的答案"
  作为表单初值。TUI 侧**禁止全不传裸 resume**:payload 字段全 optional,
  裸 resume 会静默降级到默认授权(见第 2 节 ⚠)。
- **MVP-D**:`/workflow stop` **只支持 TUI-owned live job**(经该 job 自己
  的连接调 `run.cancel`)。跨进程 / waiting 态的 workflow 明确提示
  "不在当前连接中,需 resume 或到 owner 处 stop"。真正的 `workflow.cancel`
  需要 lease 感知 + driver 侧信号通道(notification outbox 存在但 driver
  消费方向缺失),归后续 `workflow.cancel` 协议方法或 task-lifecycle 收编,
  不塞进 v1。独立 CLI `workflow stop <id>` v1 不提供;完整 stop 矩阵与
  "stop = 终结非暂停"语义见 3.6。UI 文案须区分"停止(不可恢复)"与
  "退出(可 resume)"。

MVP 后第一件事:建议 chip(3.4,从 v1.5 提前)。

## 5. 奇思妙想盘点结论(上一轮,一并 review)

### 已落地(想法与已 ship 架构重合,验证方向正确)

- workflow 文件夹像 skill → 已是(workflow.md + S4 parser + P4 script 节点
  stdio JSON-RPC:progress/completion/getEvidence/受治理原语,遥测走 stderr);
- 节点 hook 判转移/授权/异常 → verifier + transition + 投影钩子(D19/D23)+ D16;
- 零 token 巡航 → 非模型节点由 host 在节点边界自动执行(P3 Step 2:
  绝不"给模型提示让它跑");提案 781 行原文即 "cruise mode";
- 陪跑零 token → P8a shadow 离线确定性,不碰模型。

### 已有名字的 deferred(想法 = 给这些 slice 排优先级的理由)

- 异常唤醒模型 = D6 升级阶梯(P4 排除,reopen 条件 C4 2026-07-06 已记录;
  缺的是节点 fail 时按阶梯升级:重试 → 换 runner → 起模型 episode,预算走 S3);
- 按需杀 turn 上下文 = D10 节点边界压缩(可表达未接线;节点边界是唯一安全
  压缩点,因证据已外化进 WorkflowRunRecord,合"保事实、调信号");
- 持续迭代闭环 = distill(P7a)→ shadow(P8a)→ 人审 → 资产更新;
  缺第三环:草稿/覆盖差写回 `.sparkwright/workflows` 的 proposal 形态。

### 真正新增量(parking-lot 候选,未写入提案)

- **teacher-force replay**:调试 workflow 资产时投影引擎照常跑,节点执行器换成
  "从指定 session trace 按 nodeId 取录制结果"的 stub,模型节点也可 teacher-force
  成录制输出。零 token 零副作用。P8a 排除项里的 "replay execution" 即此坑位。
- **evidence 声明式注入**:前序节点证据选择性注入后续模型 episode
  (资产里 `context: [nodeA.evidence]` 之类)。`getEvidence(nodeId)` 与 catalog
  narrowing 已有,缺声明式写法。⚠ 警惕长成表达式语言(P4/P5 均明确排除)。
- **运行中人工介入 UX**:运行时机制齐(human/waiting 节点、interruption fact、
  D24 cancel、通知 outbox),TUI 呈现是空白;设计答案 = status bar + 注入通道
  (用户输入变成 workflow 收到的 fact,不直接改模型上下文)。

### 拦下来的

- **state/日志不进 workflow 文件夹**:倒退回 P9a 刚废掉的东西。资产
  (git、可版本化、可 review)与运行态(workspace store、按实例)分离是
  durable-vs-cache 规则的直接推论。"就地看状态"用 list/resume/attach 满足,
  不用目录布局满足。

### 定位(vs LangChain)

差异不是"更智能"而是**治理优先 vs 编排优先**:边是 verifier 裁决 + 授权 clamp
而非代码;资产 markdown + 脚本可 git review;单一事实源 WorkflowRunRecord;
加 teacher-force 后"调 workflow"比"调 LangChain 图"便宜一个量级。

## 6. 与已批决策对照(本方案触碰面)

| 决策                         | 关系                                                   |
| ---------------------------- | ------------------------------------------------------ |
| D11(无模型侧 workflow_start) | 保持关闭;客户端触发不在封锁范围(CLI `--workflow` 先例) |
| D26(spawn envelope)          | 建议 chip 不触碰 reopen 条件;路线 2 是其完全体         |
| D16(实例化时刻授权)          | 3.1 修正的依据;resume payload 佐证                     |
| D24(cancel 语义)             | `/workflow stop` 直接复用                              |
| D21/D23/D19                  | 只消费其事件/裁决产物,不改                             |
| P9a(workspace store)         | store attach 的地基                                    |
| D6/D10/P7a/P8a               | 第 5 节 deferred 映射,不在本方案范围内实现             |

## 7. Review 拍板结果(2026-07-07 二轮,全部裁决)

1. 3.1 FG/BG 单一路径修正 —— ✅ 接受,"exec 只是视图切换"。
2. 3.2 路线 1(每 job 一连接)—— ✅ 接受,v1 不等 background-task-lifecycle;
   路线 2 落地时收编连接复用。
3. 3.5 detach 语义 —— ✅ 状态可捡;UI 不用 detach 措辞;独立进程挂路线 2。
4. `/workflow` 命令面 —— ✅ 按第 4 节 A→D 立项。runId 映射已核实
   (`WorkflowRunSnapshot.activeRunId` 存在),但 host `cancelRun` 连接局部
   → stop 边界收窄为 TUI-owned live job(MVP-D)。
5. parking-lot —— teacher-force replay ✅ 核实后**无需写入动作**:
   workflow-runtime-v1.md 设计节已有完整 "Shadow mode (陪跑) and
   teacher-forced replay" 小节,比 parking-lot 格式更强,裁决即已满足;
   evidence 声明式注入 ❌ 继续压住,等真实模板逼出需求(表达式语言风险)。

二轮新增裁决:waiting 可见性进 MVP-A(优先于 live attach);MVP-C 附带
授权快照 host 增量;建议 chip 提前到 MVP 后第一件事。
方法论教训:易用 = 把承诺说得刚好能兑现;勿被"字段存在"骗
(stop 的 cancelRun 连接局部、resume 的 optional 字段静默降级,两例同款)。

三轮新增裁决(2026-07-07 Runbook 轮,用户确认):

- Runbook Mode 立为第一层的 CLI 脸面(3.6),同机制多张脸;
- `--background` v1 排除;前台阻塞 + waiting 退出循环为 v1 运维形态;
- stop 矩阵硬化:独立 CLI `workflow stop <id>` v1 不提供,动词保留给
  `workflow.cancel`;
- 核实补充:cancelled 为终态不可 resume(stop = 终结非暂停);Ctrl-C
  裸杀 = 非终态可捡,是 v1 唯一"暂停"形态,将来加 SIGINT 优雅处理前
  须先裁决 pause vs kill;
- inputs schema 升格为 runtime-v1 决策 27(已按候选写入,待批)。

## 8. 2026-07-11 收敛审计与实施包

### 8.1 新基线与范围修正

本节吸收 `background-task-lifecycle.md` P0–P4 封板、P5 扁平化收尾和
TUI session-scoped approvals 合入后的事实,不是重开第 7 节裁决。

- background task 已形成单一、扁平的出生/晋升/恢复/通知策略。它让路线 2
  的底座更成熟,但没有自动满足 durable detach、crash consistency、depth
  control 或 authorization clamp,所以**不因此开放**模型侧 `workflow_start`。
- P4+ 明确冻结 first-class `suspended`、durable barrier intent、崩溃原子
  checkpoint/notification/context 事务和 CLI `--detach`;P5 已删除过早的嵌套。
  本方案不得用 daemon、孤儿 Node 进程或第二套 Actor manager 绕过该裁决。
- PR #56 已补齐 workflow client 的审批转发、session-scoped exact rules、审批
  排队和 `/approvals`,但 `RunController` 仍用 controller-global permission mode
  做自动审批判定,审批队列也未携带不可变执行权限上下文。
- TUI 启动 workflow 时仍令 `workflowSessionId = this.sessionId`。独立 Host
  connection 与 workspace workflow record 已落地,但底层 session storage 仍与
  主对话共用 id;`FileSessionStore` 的 mutation queue 只在单实例内串行,不能
  防住两个 Host 进程写同一 session。
- workflow lease 已有随机 token、winner 校验及 token-aware refresh/release;
  `WorkflowStore.update/restore/appendEvent` 的 mutation path 不验证 token。
  因而缺口是 **write fencing**,不是“再加一个 lease”。

### 8.2 Package A — TUI 不可变执行与审批上下文

目标:执行事件和审批永远投影到其出生时的 client/session/policy,不依赖当前
TUI 选择或 controller-global 可变字段。

1. 引入窄类型 `ExecutionContext`/`ExecutionHandle`（最终命名以现有 TUI 词汇
   为准,不得新增第二套 `ActorRecord`）,至少固定 `client`、`sessionId`、
   `permissionMode`、`runId`;workflow handle 另带 `workflowRunId`。
2. `PendingApprovalContext` 必须携带出生执行的 permission mode/handle;
   `handleApprovalRequested` 不得回落到另一个 active run 或当前 TUI 配置。
   删除 `activeApprovalPermissionMode` 这条并行真相源。
3. client close/disconnect 时清理它拥有的 active/queued approvals,不得留下
   无法回答或误发给下一执行的 prompt。
4. 在完整的 handle-based event projection 落地前,主 run 活跃期间拒绝
   `/new`、pick/fork-and-switch 等会改变 controller session 的动作。此阶段
   退役“active execution 跟随可变 `this.sessionId`”的旧路径。

验收:主 run 与 workflow 使用不同 permission mode 并发时互不污染;运行中修改
默认 mode 只影响下一次出生;workflow client 断开会清掉 active/queued prompt;
活跃 run 不能切 session;transcript、approval response 和 trace 不串线。

### 8.3 Package B — TUI workflow job session 隔离

目标:每个新 workflow job 拥有独立 session storage identity;主 session 只作
控制面/来源归属,不作 job 的 transcript 容器。

1. 新启动时生成独立 job session id,禁止复用 `this.sessionId`;将 parent/control
   session id 写入现有可扩展 metadata 作为审计关联,不得用它继承 scrollback。
2. `WorkflowJobHandle` 暴露固定的 job session id 和 Package A 的权限上下文。
3. resume 使用 record 中已持久化的 workflow job session/授权快照,只能按既有
   clamp 收紧;禁止裸 resume 静默降级。
4. 不为此重写跨进程 `FileSessionStore`:独立 identity 本身应退役两个 Host
   写同一 session 的已知 workflow 路径。

验收:主 run 与多个 workflow job 各有不同 session 目录;workflow 不读取主
scrollback;runId/workflowRunId/parent session 关联可追踪;list/attach/resume 正常;
并发执行不再写同一 session 文件。

Package A 与 B 可在同一实现窗口推进,但按 A→B 组织提交,方便确认权限上下文
先稳定、session identity 再切换。

### 8.4 Package C — S1 workflow mutation fencing（独立评审/独立 PR）

该包归 `doc-store`/workflow store 的 S1 强化,不归新 Actor 内核。先裁决
同步 `WorkflowStore` 与异步 lease 校验的 API 边界,再改代码;优先考虑只能从
有效 lease 构造的 lease-bound writer,避免 optional token 继续保留旁路。

硬约束:

- live owner 对 record mutation 和与其成对的 event append 必须提交/绑定 token;
- token 不是当前 winner、已过期或已被 successor 接管时,mutation 必须失败;
- inspection/read-only、首次 create 与恢复前的 lease acquisition 保持可用;
- 同一阶段迁移 Host start/resume/waiting/finalization 的全部 live write owner,
  并删除无 fencing 的 runtime mutation path,不得只增加一套可选 API;
- stale owner 失败必须可诊断,但不能覆盖 successor 的状态或释放其 lease。

验收:lease 过期并被 B 接管后,A 的 update/event/release 均不能破坏 B;B 可继续;
正常 start/resume/waiting/completion 全链路持 token;并发/故障注入测试覆盖旧 worker
复活写入。若同步/异步边界无法在一个小 PR 内安全收敛,先提交设计裁决,不要把
store 全面 async 化夹带进 Package A/B。

### 8.5 Package D — typed durable workflow control inbox

目标:补齐 outbox 的反方向,让主 agent/TUI/CLI/未来外部适配器可向一个 durable
workflow instance 投递受治理的控制命令。D 是路线 2 的第一个 reopen 阶段,
只有 A/B/C 验收通过后才能开始。

协议必须是 discriminated union,初始命令面只允许由真实用例证明的窄集合,例如:

- `cancel`（终结,不是 pause）;
- `provide_input`（只投递给匹配的 waiting/human gate）;
- `approval_response`（绑定 approval id、authorization snapshot 和 source）;
- `resume_request`（请求调度,不直接篡改 record 状态）。

每条 envelope 至少固定 workflowRunId、commandId/idempotencyKey、expected state 或
generation、source identity、authorization scope、createdAt/expiry。接收端负责鉴权、
状态匹配、幂等和上下文投影;producer 不能直接把任意 payload 注入模型上下文。
durable store 必须有 accepted/applied/rejected/dead-letter（或等价）结果和 cursor,
crash 后可重放但不能重复执行。D 应复用已有 ActorInbox/notification 的 typed style
及 session coordinator 的 command queue 经验,但不把生命周期通知和控制命令混成
一种消息。此阶段退役“只有拥有 live connection 才能控制 workflow”的路径。

验收:重复投递只应用一次;过期、越权、状态不匹配命令可诊断地拒绝;waiting 输入
在 crash/restart 后仍可消费;cancel 保持终态语义;命令应用与 record/checkpoint/cursor
满足明确的 crash-consistency 边界;任意 JSON、通用 topic 和同步 RPC 均不存在。

### 8.6 Package E — durable supervisor / worker ownership

目标:把 workflow 的“逻辑实例”和“当前执行它的 worker”分离,使没有 TUI/CLI
连接的实例也能被发现、领取、接管和恢复。E 复用 C 的 fencing token 与 D 的控制
inbox,不得另建平行 Actor manager。

1. 在既有 `server-runtime` coordinator 路线中定义 supervisor/worker ownership;
   Host 保持 run/workflow 执行组装者,server-runtime 负责调度、连接与接管协调。
2. worker registration/heartbeat/lease generation、claim/release、shutdown drain、
   orphan detection 和 takeover 必须有单一状态机;workflow record 是 durable truth,
   in-memory manager 只是投影。
3. supervisor 只能通过 lease-bound writer 修改实例;旧 worker 恢复时由 C 拒绝写入。
4. recovery 从 durable checkpoint、wait intent、inbox cursor、outbox cursor 重建;
   不能靠“进程还在”推断状态。
5. 一个实例同一时刻只能有一个有效 writer;多个 supervisor/worker 竞争要有确定性
   winner。优雅升级须停止领取新任务、drain/交接或显式中断,不能静默丢任务。

此阶段退役“TUI/CLI child Host connection 是 workflow 唯一 owner”的路径。

验收:worker 被强杀后 successor 可接管;旧 worker 复活不能写;waiting/inbox/outbox
cursor 无重复或丢失;supervisor 重启后可由 store 重建;双 supervisor 竞争只有一个
writer;shutdown/upgrade 行为可观测且有故障注入测试。

### 8.7 Package F — daemon/service 与诚实 detach

目标:提供明确的长期运行进程载体,让 `sparkwright workflow ...` 可提交后退出,
workflow 仍由外部 worker/supervisor 持续运行。F 是 P4+ 的显式实现,必须在 E 的
外部 worker 接管与 crash recovery 验收后开放。

- daemon/service 只是部署载体,不成为第二个事实源;状态仍在 workflow/session/
  inbox/outbox stores,所有写入仍受 lease fencing。
- CLI `--detach` 只有在任务已被 durable supervisor 接受并返回稳定 handle 后才能
  成功;启动子进程后立即退出不算 detach 成功。
- 引入 first-class `suspended` 前必须单独完成 pause vs kill 裁决。F 可以先支持
  running/waiting/terminal + crash-recoverable ownership,不得拿 Ctrl-C 裸杀冒充 pause。
- 定义 service start/stop/status、single-instance 或多 worker 策略、日志/健康检查、
  版本升级、workspace 隔离和安全关机;运维启动不得依赖交互 TTY。
- 无用户消息通道时,需要决策的 workflow 必须进入 durable waiting 并可由 list/
  inspect 看见,不能自动扩大权限或猜测答案。

此阶段退役“CLI 退出必然使 live workflow 停止”的路径。

验收:CLI 提交并退出后 workflow 继续;daemon crash/restart 可恢复;service stop 不把
非终态伪装成 running;无绑定 channel 的 approval/input 会稳定 waiting;升级/双启动/
孤儿处理均可诊断;CLI foreground 与 detached 共用同一执行/授权/record 路径。

### 8.8 Package G — 主 agent、IM 与受控 workflow 通信

目标:把 D 的 typed commands 和现有 durable notifications 接到多个控制面,形成
“workflow 请求决策 → 用户/主 agent 收到 → 经授权回复 → workflow 继续”的闭环。

1. TUI/主 agent 是一个 adapter;IM/Web/API 也是 adapter,均不得成为 canonical
   session/workflow owner。共享协调归 `server-runtime`,平台投递状态归 gateway。
2. 复用 `session-agent-host-coordinator.md` 的 SourceIdentity、trusted gateway、
   session link、ApprovalBroker、outbox/cursor 和 idempotency 裁决;IM 的 message
   权限不自动包含 approve/cancel。
3. workflow → channel 走 durable notification/outbox;channel → workflow 只能翻译成
   D 的 typed command。绑定需明确 workspace/session/workflow scope,支持撤销、过期、
   最小权限和审计。
4. 多 channel 同时响应同一 approval/input 时用 command id + expected generation
   裁决唯一 winner,其余返回 already-resolved,不得双重执行。
5. workflow 间通信默认仍关闭;若出现真实用例,只能把发送方视作受鉴权 source,
   复用同一 typed command,不得开放任意 peer message 或同步 request/response bus。

此阶段退役“TUI-owned live client 是唯一通知/决策闭环”的路径。

验收:TUI 和绑定 IM 均可收到同一 durable decision request;断线重连按 cursor 补发;
重复 webhook/多端竞争只应用一次;未绑定或无权限来源被拒绝;无 channel 时保持 waiting;
审计可串起 source → command → approval/input → resumed episode;gateway 重启不丢消息。

### 8.9 仍然禁止的泛化

- 不新增同名异义的 `packages/agent-runtime/src/actors/` 平行体系;现有
  `startWorkflowActorEpisodeChain`、ActorNotificationSink/ActorInbox 语汇继续复用。
- 不做任意 payload/topic 的通用 message bus、同步 RPC、任意 workflow peer
  messaging,也不让 producer 决定模型上下文注入。
- 模型侧 `workflow_start` 仍受 D11/D26 三条件约束;D27 inputs 未批准前不落地。
- nesting 继续受 background-task P5 reopen 条件约束;D–G 不构成恢复嵌套的理由。

### 8.10 实施顺序、reopen gate 与 rule zero

总顺序为 A → B → C → D → E → F → G。不是要求一个 PR 完成七包,而是要求同一
路线最终闭环;每包验收与裁决落盘后才能打开下一包。若某包暴露基础契约缺失,
停在该 gate 修正,不得用后续层绕过。

每包必须退役一条旧机制:A 删除全局审批权限真相源和活跃期可变 session 路由;
B 删除 workflow 复用主 session;C 删除 live runtime 无 fencing 写路径;D 删除
live-connection-only 控制;E 删除 client child process 唯一 owner;F 删除 CLI 生命周期
绑定;G 删除 TUI 单通道决策闭环。所有包都回写 project-map/test-map,并保持一份
workflow record、一个授权模型、一条 typed control plane 和一套 supervisor ownership。

### 8.11 实施进度（2026-07-11）

- Package A: **完成并通过 reopen gate**。`RunController` 删除
  `activeApprovalPermissionMode`,审批出生时固定 client/session/permission/kind、
  精确 episode runId 与可用的 workflowRunId。terminal/disconnect/close/shutdown
  按 client 幂等清理 active/queued prompts。主 run starting/active 时 controller
  拒绝 new/switch/fork-and-switch,只读 session 操作保持开放。
- 退役路径:controller-global approval permission truth；active execution 跟随
  可变 current session 的 session-mutation 路径。
- 验证:`npm --workspace @sparkwright/tui test`（60 files / 398 tests）;
  `npm --workspace @sparkwright/tui run typecheck`。
- 下一 gate:Package B 独立 workflow job session。
- Package B: **完成并通过 reopen gate**。TUI 与 CLI fresh workflow job 使用
  `session_workflow_*` 强随机独立 storage identity；Host `run.start` 返回固定
  run/workflow/session 三元组，校验 job/control session 不相同，并将
  `controlSessionId` 仅作 WorkflowRunRecord attribution。resume 缺授权或 job
  session 显式失败，存在时复用原 session。
- 退役路径:`workflowSessionId = this.sessionId` 及 CLI `--workflow` 复用显式
  主 session 的路径。
- 验证:Host client-run/workflow/protocol 91 tests；TUI full 399 tests；CLI
  workflow slice 13 tests；protocol/host/TUI/CLI typecheck 与受影响 build 全通过；
  修复一次 test fixture 的 handle 类型回归后，完整 `npm run release:check` 重跑通过。
- 下一 gate:Package C workflow mutation write fencing API 裁决。

### 8.12 Package C API 裁决与暂停点（2026-07-11）

状态:**设计、代码、focused verification 与完整 release gate 均完成；等待
Package C commit。A/B 保持通过，不回退。**

#### 已验证事实与 mutation inventory

| 类别                  | 当前调用点                                                          | 当前事实                                                                                              |
| --------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| inspection/read-only  | `FileWorkflowStore.get/list/eventLog`; Host list/find/resume lookup | 不需要 writer，但 `get()` 当前读取构造时缓存，不是跨进程 fresh read                                   |
| initial create        | `prepareHostRunEnvironment()` fresh workflow branch                 | Host 先 acquire lease，再调用无 token 的 `create()`；create 同步写 record 后另 append `created` event |
| acquire-before-resume | `resumeWorkflowRunInner()`                                          | 先从 store 读 record，再 acquire；claim 后没有 authoritative reread/revision check                    |
| resume prepare/input  | `consumeWorkflowActorWaitingInput()`                                | `update()` 后独立 `appendEvent(type:"input")`; prepare/start failure用 `restore()` 回滚               |
| live projection       | `onStateSnapshot` → `persistWorkflowProjectionSnapshot()`           | refresh 结果被忽略，随后无 token `update()`                                                           |
| episode start         | `startWorkflowActorEpisodeChain.registerActiveRun()`                | 写 activeRunId/runIds/evidence/episode metadata，无 fencing                                           |
| episode usage         | `recordWorkflowActorEpisodeUsage()`                                 | 从可能陈旧的 `get()` 读后 update                                                                      |
| waiting/terminal      | projection snapshot + `finalizeWorkflowRecordAfterRun()`            | waiting、cancel、failure、completion 均走无 token update                                              |
| supervisor failure    | `finalizeWorkflowRecordAfterSupervisorError()`                      | 无 token update 后通知                                                                                |
| rollback/recovery     | prepare catch、resume start failure                                 | 无 token restore，可覆盖 successor 完整 record                                                        |
| terminal cleanup      | episode-chain finally/finalizer                                     | token-aware release，不会删除 successor token；这一项当前正确                                         |
| maintenance/tests     | agent-runtime/host workflow fixtures                                | 直接 update/restore/appendEvent，说明当前公共 API 很容易成为 runtime 旁路                             |

`packages/agent-runtime/src/doc-store/index.ts` 的 token lease已确认具有随机 token、
acquire winner validation、token-aware refresh/release。它没有 mutation CAS、
monotonic fencing generation 或跨 record/event transaction。TTL 为 Host 的 30 分钟，
后台每半 TTL refresh；refresh failure 当前不会停止 owner，也不会阻止后续写入。

#### 评估过的方案

1. `update(id, patch, token?)`:拒绝。optional token 永久保留旁路。
2. lease-bound writer + mutation 前 `refresh()`:拒绝作为最终正确性方案。进程可在
   refresh 成功后冻结，TTL 过期并由 successor 接管，再恢复执行同步 write；旧 owner
   仍能覆盖新状态。
3. lease-bound writer + 临时 lock file/directory:暂不接受。需要先解决 lock holder
   crash、stale lock 回收、Windows rename/unlink、旧 owner 恢复和 lock/lease 原子验证；
   当前 doc-store 没有可复用且已证明的 primitive。把它夹进 WorkflowStore 会重新发明
   一套未审查的文件锁。
4. **推荐:monotonic fencing generation + revisioned append-only mutation journal。**
   当前 `<workflowRunId>.lease` 是包含 per-token JSON entry 的目录；release/expiry 会
   删除 token entry，因此 lease 只能回答临时 owner 存活性，不能保存跨 takeover 的
   monotonic generation。现有 token lease winner 必须通过 canonical journal claim entry
   分配并持久化下一 generation；claim entry 持久化成功是 ownership takeover 的线性化点，
   journal 是 generation/history 的唯一 sequencer。writer 固定
   `{workflowRunId, token, generation}`。每次 mutation 要求 expected record revision，
   以 exclusive-create 发布一条同时包含 next record snapshot/patch 与 canonical event 的
   revision entry。successor 使用更高 generation；旧 generation 后来产生的 physical entry
   不得成为 canonical。`.json` snapshot 与 `.events.jsonl` 只是可重建投影，读取时必须从
   canonical journal 校验 generation/revision，不能信任 stale snapshot pointer。

#### generation、revision 与 replay 强制契约

exclusive-create + expected revision 是写入时 CAS 主防线，但 generation-aware replay
不是可选加固，而是强制 safety backstop。文件系统不能单独提供“验证当前最大 generation

- create entry”的原子组合；损坏恢复、迁移、人工残留或未来 physical-entry allocation
  都可能留下 stale physical entry。store 必须明确区分：

* `physicalSequence` / `entryId`:存储层位置，允许空洞、损坏、隔离和 non-canonical entry；
* `recordRevision`:只由成功应用的 canonical mutation 以 `N -> N + 1` 推进；
* `generation`:只有合法 claim entry 才能单调提升，决定谁有权推进 record revision。

writer mutation 必须：

1. fresh read canonical head，先验证固定 token/generation，再验证
   `expectedRecordRevision`；
2. 只尝试发布 `expectedRecordRevision + 1` 对应的 canonical mutation，不得在
   `EEXIST` 后扫描并重试更高 physical slot；
3. 冲突后 fresh reread 并抛 typed fencing/stale-write error，绝不 last-write-wins；
4. 发布后确认 entry 已成为 canonical；即使 stale entry 曾物理落盘，也不得向 stale
   writer 返回成功。

replay 不能简单只保留最大 generation，因为 takeover 前的旧 generation 历史仍然合法。
它必须执行 generation state machine：合法历史是 `G1 mutations -> claim G2 -> G2
mutations -> claim G3 -> G3 mutations`；claim `G2` 持久化后出现的 `G1` mutation、没有
合法 claim transition 的更高 generation entry，以及 revision 不连续的 mutation 都必须
隔离。隔离 entry 不得进入 record、canonical event history、cursor、successor 判断或
任何用户可见投影。A 在 B claim 持久化前完成的合法 mutation 在线性顺序上先于 takeover；
B claim 持久化后的 A mutation 必须被写入时拒绝或在 replay 中隔离，且 A 必须得到明确
失败。

推荐 API 方向:

```ts
interface WorkflowLeaseBoundWriter {
  readonly workflowRunId: WorkflowRunId;
  readonly token: string;
  readonly generation: number;
  readFresh(): Promise<WorkflowRunRecord | undefined>;
  create(input: CreateWorkflowRunRecordInput): Promise<WorkflowRunRecord>;
  mutate(input: {
    expectedRevision: number;
    patch: WorkflowRunRecordPatch;
    event: WorkflowStoreEventInput;
  }): Promise<WorkflowRunRecord>;
  compensate(input: {
    expectedRevision: number;
    patch: WorkflowRunRecordPatch;
    event: WorkflowStoreEventInput;
  }): Promise<WorkflowRunRecord>;
}
```

公开 `WorkflowStore.update/restore/appendEvent` 从 runtime surface 删除；inspection 保留，
maintenance/recovery 也必须显式 claim writer，不能保留同名无 fencing API。fresh create
属于 live mutation，必须由 writer 完成；“initial create 保持可用”只表示 claim 前无需
已有 record，不表示 create 可绕过 writer。rollback/recovery 不再覆盖旧 record 或暴露
通用 `restore()`；它写入一条 fenced compensating mutation。补偿事实保留在 canonical
journal 中供审计，当前用户视图可以按需隐藏内部细节，但 durable history 不得抹除。

v1 record/event 采用 lazy migration，不要求离线重写工具。第一次 fenced claim 建立
revision-0 baseline/migration marker；该过程必须幂等、crash-safe，并在并发 claim 下只有
一个 winner。旧 event log 的来源、摘要或迁移关联必须可诊断，不能静默丢弃已有审计事实。

#### 阻塞原因

这是**未裁决/未实现的基础存储契约问题**，不是测试环境或外部依赖问题。现有 S1
primitive 无法证明 required stale-owner failure；直接迁移 Host 到仅做 refresh 的 handle
会让 API 看似安全但仍违反故障验收 2–9。revision/generation journal 会改变 durable
record/event 格式、恢复算法和 migration 语义，超出“小范围同步 API 加 token”的安全
边界，必须作为 C 的独立 store design/implementation slice 评审。

#### 下一步与 reopen 条件

1. 在 agent-runtime/doc-store 层裁决 generation claim 与 exclusive revision entry 的
   crash/recovery 原子发布格式，包括 torn/corrupt physical entry 隔离和 v1 record/event
   幂等 migration。
2. 先实现 deterministic store-level fault tests:refresh 后冻结、TTL 过期、B claim、
   A 恢复写；record/event/compensation/release 全矩阵。额外覆盖旧 expected revision
   `EEXIST -> typed failure`、强制注入 frozen-A fresh physical slot + stale generation 后
   replay 隔离、隔离 entry 不推进 record revision/event projection、canonical entry
   publication 中途 crash，以及 snapshot/event projection 半完成后从 journal 重建。
3. writer primitive 通过后迁移 Host 全部上表 live/rollback/finalization callsites，并
   删除公共无 fencing mutation API。
4. agent-runtime + Host focused tests/typecheck/build 和 release gate 通过后，才能打开 D。

未满足验收:stale update/event/restore 拒绝；双 writer deterministic winner；B 在 A
复活后继续 waiting/resume/completion；record/event canonical consistency；Host 全 live
writer 无旁路。补偿记录保留 durable history 的产品语义已于 2026-07-11 裁决接受。
**Package D–G 保持关闭。A/B 必须先形成独立本地 commit，focused/release gate
保持通过，且工作树清洁。满足这些条件后，可以在同一
`feat/workflow-job-session` 分支 reopen Package C；不创建新分支。Package C 代码
不得 amend 或混入 A/B commit，且 C 仍必须形成独立、可审查的 commit。**

#### 实施结果（2026-07-11）

- `FileWorkflowStore` 现以 immutable canonical journal 作为 generation/history
  sequencer；claim 与 mutation 共用 physical sequence，mutation 同 entry 保存 record
  与 event，snapshot/event log 仅作可重建投影。
- runtime mutation 只能经 `WorkflowLeaseBoundWriter`；旧 public
  `create/update/restore/appendEvent/acquireLease` 已删除。Host fresh/resume/waiting/
  projection/usage/finalization/compensation 全部迁移。
- generation-aware replay 隔离 stale、discontinuous、corrupt/torn entries；隔离项
  不推进 revision、不进入 record/event projection。legacy v1 首次 claim 建立
  revision-0 baseline，重复/并发 migration 单 winner。
- focused evidence: agent-runtime 32 tests，Host workflow/protocol 79 tests，CLI
  workflow slice 13 tests；相关 typecheck/build 均通过。首次 release gate 仅发现
  7 个本次文件需 Prettier，格式化后完整 `npm run release:check` 重跑通过；最终
  commit hash 在 Package C commit 后补记。
- commit 前源码复核额外封闭 writer/record/event identity mismatch，新增
  fail-closed test 后 focused gate 与完整 `npm run release:check` 均重跑通过。

### 8.13 Package D durable control inbox 裁决（2026-07-11）

状态：**设计 gate 与实现 gate 完成；Package D 独立 commit/release gate 证据见本节末尾。**

#### Ownership 与非目标

- `agent-runtime`/doc-store 拥有 typed durable command envelope、接受结果、终态
  outcome、cursor 与 replay；它不拥有 transport identity verification 或调度。
- `server-runtime` 拥有 command dispatch/consumer coordination；Host adapter 仍拥有
  workflow episode、approval/input projection 和 Package C writer 组装。
- gateway/CLI/TUI/API 只把已经认证的来源翻译成 command input，不能直接写
  `WorkflowRunRecord`，也不能决定模型上下文注入。
- lifecycle `ActorNotificationSink`/`ActorInbox` 只作类型风格和 durable-file 经验复用；
  control inbox 是反向命令面，不加入 notification union，不新增 generic topic、任意
  JSON payload、同步 RPC 或 workflow peer messaging。

#### Typed envelope

命令是封闭 discriminated union：

```ts
type WorkflowControlCommand =
  | { kind: "cancel"; reason?: string }
  | { kind: "provide_input"; waitId: string; value: string }
  | {
      kind: "approval_response";
      approvalId: string;
      decision: "approved" | "denied";
      message?: string;
    }
  | { kind: "resume_request"; waitId?: string };

interface WorkflowControlCommandEnvelope {
  schemaVersion: "sparkwright-workflow-control.v1";
  workflowRunId: WorkflowRunId;
  commandId: string;
  idempotencyKey: string;
  source: {
    kind: "tui" | "cli" | "sdk" | "api" | "im" | "system";
    principalId: string;
    authenticatedBy: string;
    connectionId?: string;
  };
  authorization: {
    workspaceId: string;
    sessionId?: string;
    workflowRunId: WorkflowRunId;
    allowedCommandKinds: WorkflowControlCommand["kind"][];
  };
  expected: { generation: number; status?: WorkflowRunStatus; waitId?: string };
  command: WorkflowControlCommand;
  createdAt: string;
  expiresAt: string;
}
```

`system` source 只能由 Host/server-runtime 内部 mint；外部 adapter 不能自称 system。
`idempotencyKey` 的 scope 固定为
`workspace + workflowRunId + source(kind/principalId/authenticatedBy) + key`。同 scope
同 key 同 payload 返回原 accepted/outcome；同 key 不同 payload 拒绝
`idempotency_conflict`。

#### Durable layout 与状态机

每个 workflow 使用独立窄目录，不能复用普通 JSONL 作为 transaction journal：

```text
<workflowRunId>.control/
  commands/<commandId>.json       # immutable accepted envelope, exclusive create
  outcomes/<commandId>.json       # immutable terminal outcome, exclusive create
  cursor.json                     # 可重建投影，不是 apply truth
```

outcome 为 `applied | rejected | dead_letter`。`accepted` 由 command entry 的存在表达，
不是可变状态。排序使用 accepted entry 中的 createdAt + commandId 稳定 tie-break；cursor
只跳过已有 terminal outcome 的前缀，不能让一个 gap 隐藏后续命令。corrupt/torn entry
隔离并形成可诊断 dead-letter candidate；expiry、鉴权、expected generation/state/wait
不匹配形成 immutable rejected outcome。

#### Apply 与 crash consistency

1. consumer 读取 accepted 且无 terminal outcome 的 command；
2. 重新验证 source authentication projection、authorization scope、expiry；
3. fresh read Package C canonical head，验证 generation/status/wait；
4. 需要改变 workflow durable state 的命令用 lease-bound writer 写一次 mutation，event
   metadata 固定 `controlCommandId`、idempotency scope/hash 与 source audit；
5. 再 exclusive-create outcome，最后更新可重建 cursor。

workflow journal event 是 record mutation 的 apply truth。若进程在第 4 步后、第 5 步前
崩溃，replay 先按 `controlCommandId` 查 canonical event：存在则补写 applied outcome，
不得再次 mutation。若 outcome 已存在而 projection/cursor 未完成，只重建投影。

`cancel` 写 terminal cancelled mutation；不是 pause。`provide_input` 只匹配 durable
`waiting/input` 的 waitId，值由 Host receiver policy 投影，producer 不提供 context role。
`resume_request` 只形成调度请求/结果，不直接把 record 改为 running；实际 episode 仍由
Host resume path claim writer 后启动。`approval_response` 只匹配 durable
`waiting/approval` 的 approvalId 和 authorization snapshot；当前 live-only
`ApprovalBroker` pending map 不是 durable truth，不能作为 crash-safe apply target。D 实现
必须先将 workflow approval wait 的最小 request/decision linkage 持久化到 workflow
record/journal；否则该命令只能明确 rejected，不能报告 applied。

#### Reopen/验收 gate

- deterministic tests 覆盖 duplicate accepted、payload conflict、expiry、越权、generation/
  state/wait mismatch、双 consumer、mutation 后 outcome 前 crash、outcome 后 cursor 前
  crash、corrupt entry、restart replay 和多端单 winner；不得主要依赖 sleep。
- Host/server-runtime 接入后，断开 producer connection 不删除 accepted command；waiting
  workflow 可在后来 consumer/connection 中处理。
- 旧 `workflow.resume` 可暂作 adapter，但必须先 durable enqueue，再由同一 consumer
  路径 apply/dispatch；不能保留直接 consume wait + start 的平行控制路径。
- approval durable linkage 未完成前 D 不得宣称 approval_response gate 通过；Package E
  与后续 D–G 均保持关闭直到上述 focused/full release、maps/test-map 和独立 commit 完成。

#### 实现结果

- `FileWorkflowControlInbox` 实现 immutable command/outcome、exclusive create、
  scoped idempotency、可重建 cursor 和 corrupt entry 隔离。
- `WorkflowControlCommandProcessor` 通过 Package C writer 应用 record/event，使用
  canonical `controlCommandId` 恢复 mutation 已成功而 outcome 未发布的崩溃窗口。
- Host/SDK/protocol/TUI 接入 `workflow.control`；`workflow.resume` 先 enqueue 再由同一
  consumer dispatch；远端 owner busy 时 command 保持 durable accepted。
- `provide_input` 只持久化 typed value/source，由 Host receiver 在 resume 边界投影并清除
  staging marker；`approval_response` 要求 durable approval wait 与 authorization snapshot。
- server-runtime 只提供同 command 的 in-flight dispatch 合并，不成为 workflow record、
  authorization 或 lifecycle truth。
- focused gate 与完整 `npm run release:check` 已通过；D 独立 commit 后可 reopen Package E
  设计 gate，F/G 仍保持关闭。

### 8.14 Package E durable supervisor / worker ownership 裁决（2026-07-11）

状态：**设计与实现 gate 完成；E 独立 commit/release 证据见本节末尾，Package F 保持关闭。**

#### 唯一 ownership truth

- Package C canonical journal 的 `claim` entry 是 workflow ownership 唯一线性化点；
  generation、token 与后续 mutation linkage 决定当前 writer。
- `<workflowRunId>.lease/<token>.json` 只回答临时 liveness/互斥，不能成为 assignment、
  generation 或 takeover history truth。
- worker registry 只回答 worker 是否 registered/active/draining/expired/stopped；它是
  durable discovery/liveness state，不分配 workflow，也不能授权写 record。
- 不新增 workflow assignment record、ActorRecord、ProcessManager、SupervisorManager 或
  第二套 ownership 状态机。supervisor 扫描现有非终态 `WorkflowRunRecord`，worker 通过
  `FileWorkflowStore.acquireWriter()` 竞争；只有 claim canonical 后才拥有执行权。

#### Ownership 与 API 边界

- `agent-runtime` 拥有 file-backed worker registry 的 portable record/lease primitive，
  以及从 workflow store 重建可领取候选的 read-only inventory；不启动 Host 或进程。
- `server-runtime` 拥有 `WorkflowSupervisor` 协调循环：register/heartbeat/drain、扫描候选、
  bounded claim、调用注入的 Host worker adapter、release/retry 和 shutdown report。
- Host 保持 workflow definition/authorization/model/tools/run episode 组装，并接收已经
  claim 成功的 `WorkflowLeaseBoundWriter`；server-runtime 不直接修改 workflow record。
- F 才提供 daemon/service/CLI detach 载体。E 只交付可由 foreground host/service embedder
  驱动的 durable coordinator，不启动 orphan child process，也不声称 detach。

建议窄接口：

```ts
interface WorkflowWorkerRegistration {
  workerId: string;
  instanceId: string;
  workspaceId: string;
  state: "active" | "draining" | "stopped";
  registeredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

interface WorkflowSupervisorWorkerAdapter {
  runClaimed(input: {
    record: WorkflowRunRecord;
    writer: WorkflowLeaseBoundWriter;
    signal: AbortSignal;
  }): Promise<"waiting" | "terminal" | "interrupted">;
}
```

registry publication 必须按 worker identity exclusive-create；heartbeat 只能由匹配的
registration token 更新。drain 先 durable 标记 `draining`，停止新 claim，再等待 active
claims；deadline 到达只能返回明确 interrupted/remaining claims，不能把 workflow 写成
completed 或假装 pause。stopped/expired worker 的 registry entry 不删除审计身份；新的
instance 使用新 instanceId/token。

#### Recovery 与 takeover

1. supervisor 启动时从 registry、workflow journal、D inbox/outbox 重建，不依赖旧进程内
   active map；terminal workflow 不进入候选。
2. running workflow 只有在 lease TTL 仍有效时不可领取；waiting workflow 默认不启动
   episode，但其 D inbox 有 pending resume/control 时可由 control consumer 处理。
3. worker SIGKILL 后 heartbeat 与 workflow lease 分别过期；successor 首先成功发布更高
   generation claim，再调用 Host adapter。旧 worker 恢复后所有 mutate/compensate/release
   均由 Package C fencing 拒绝或不影响 successor。
4. 同一 supervisor 内 command/notification cursor 可重建；E 不复制 D command outcome、
   ActorNotification outbox 或 workflow journal。
5. 双 supervisor/worker 对同 workflow 竞争时允许 loser 观察 busy；不得换 physical slot
   伪造第二 winner，也不得在未 claim 时调用 Host execution adapter。

#### E 故障与完成 gate

- deterministic clock/barrier tests：register/heartbeat/expiry、drain 禁止新 claim、双 worker
  单 winner、SIGKILL/TTL/successor takeover、旧 worker revival fenced、旧 release 不影响
  successor、supervisor restart inventory rebuild、waiting/control cursor 不丢不重、adapter
  crash 后 lease expiry recovery、shutdown report 含 remaining claims。
- Host integration 必须证明 claimed writer 注入现有 episode 路径且 authorization snapshot、
  workflow hooks、tool policy、access clamp 均不被绕过。
- 退役“创建 workflow 的 TUI/CLI child Host connection 是唯一 owner”的内部假设；保留
  foreground connection 作为一种 worker adapter，而不是 durable truth。
- focused tests、fault injection、affected typecheck/build、完整 `npm run release:check`、
  maps/test-map 和独立 E commit 全通过后，才可 reopen Package F。

#### 实现结果

- agent-runtime `FileWorkflowWorkerRegistry` 持久化 per-instance registration、heartbeat、
  expiry、draining/stopped；过期或 draining instance 不能重新 heartbeat 成 active。
- server-runtime `WorkflowSupervisor` 从 workflow store 重建候选，过滤 terminal/default
  waiting，竞争现有 Package C writer，只把 claim winner 交给注入的 execution adapter。
- drain durable 标记 worker 并停止新 claim，报告 remaining workflow；abort 只是 interruption，
  不写 pause/completed。双 supervisor 竞争只调用一次 adapter。
- Host `resumeClaimedWorkflowRun()` 接受 identity-matched writer，复用现有 pinned definition、
  authorization snapshot、access clamp、hooks/tools 与 episode/finalization 路径，不二次 claim。
- 本实现没有 service/daemon、CLI detach 或 orphan child；这些仍属于关闭的 Package F。
- focused fault gate 与完整 `npm run release:check` 已通过；E 独立 commit 后可 reopen
  Package F 设计 gate，Package G 仍保持关闭。

### 8.15 Package F foreground service 与 honest detach 裁决（2026-07-11）

状态：**设计 gate 完成；实现、故障注入与 release gate 尚未完成，Package G 保持关闭。**

#### 已核实的现状与边界

- `WorkflowSupervisor` 已经拥有 inventory rebuild、Package C claim、heartbeat、drain 和
  claimed Host adapter 调用，但没有 process launcher，也不是 daemon。
- CLI 当前为每次 run spawn stdio Host；`serveConnection()` 在连接关闭时调用
  `HostRuntime.cleanup()` 并取消 active run。因此“通过 WS/stdio `run.start` 后立即断连”不是
  detach，不能作为 F 实现。
- Package C journal 仍是 workflow ownership/mutation truth，Package D inbox 仍是 control
  truth，Package E worker registry 仍只回答 worker liveness。F 不新增 workflow record、
  assignment record、process substrate 或 authorization truth。

#### Service carrier 与命令面

F 提供显式前台 service carrier；推荐产品面为：

```text
sparkwright workflow service run [--workspace ...]
sparkwright workflow service status [--workspace ...]
sparkwright workflow service drain [--workspace ...]
sparkwright workflow start <name> <goal...> --detach
```

`service run` 保持前台、输出结构化启动/健康日志并响应 SIGTERM/SIGINT 做 bounded drain。
它可以由 systemd、launchd、容器或用户自己的进程管理器托管，但 SparkWright 不 double-fork、
不 `unref()` orphan child，也不把 pid 文件存在称为 daemon。F 不提供隐式后台
`service start`；没有健康 service 时 `--detach` fail closed，并提示先运行/托管
`service run`。

每个 workspace 使用独立 service root：

```text
<workspace>/.sparkwright/workflow-service/
  instance.json                 # 当前 carrier readiness 投影，可重建/过期
  handoffs/<handoffId>.json     # immutable durable request，exclusive create
  outcomes/<handoffId>.json     # immutable accepted/rejected outcome
  logs/service.jsonl            # bounded/rotatable operational diagnostics
```

`instance.json` 不是 ownership truth；它含 workspace identity、instance id、pid、startedAt、
heartbeat/expiresAt、state (`starting|ready|draining|stopped`) 和版本。status 必须同时验证
workspace、fresh heartbeat 与 instance identity，不能仅用 `kill(pid, 0)`。stale pid/instance
投影允许 successor 以原子发布替换，但保留诊断；活跃不同 instance 必须阻止第二 carrier。

#### Durable accept/handoff

`--detach` 只允许 workflow fresh start，且必须先把完整、窄类型的 start intent durable
publish 到 handoff store。intent 固定 workflow asset/name、goal/input、独立 job session id、
control session attribution、model/access/background/trace/target/confidential snapshot、source
identity、workspace id、idempotency key、createdAt/expiresAt；producer 不能传任意 JSON 执行器、
tool policy override 或模型上下文角色。

service 执行顺序：

1. exclusive claim/accept handoff，验证 workspace、expiry、service state 与 authorization clamp；
2. 通过现有 Host workflow start/claimed execution assembly 创建 durable
   `WorkflowRunRecord`，不得绕过 workflow hooks、tool policy、approval 或 access mode；
3. durable publish outcome，固定 workflowRunId/job session id；
4. CLI 只有看到 accepted outcome 后才返回成功。CLI 退出、transport 丢失或 producer 崩溃
   不删除 handoff，也不触发 `HostRuntime.cleanup()` 的 client-owned cancel；
5. service crash 在 record 创建后/outcome 前，通过 handoff id 在 canonical workflow
   metadata/journal 恢复 outcome，不能重复创建 workflow。

handoff accepted 只表示 durable service ownership 已建立，不表示 workflow completed。没有
service、handoff 未落盘、超时或被拒绝时 CLI 必须非零退出，不能打印 detached success。
waiting workflow 在无 channel 时保持 durable waiting；cancel 仍走 Package D typed command，
SIGTERM/drain 只报告 interrupted/remaining，不伪装 pause。

#### Recovery、健康与隔离

- service startup 从 handoff store、workflow journal、D inbox 和 E registry 重建，不依赖
  内存 active map；terminal handoff/workflow 不重复执行。
- readiness 仅在 worker registration 成功、Host adapter 可构造、handoff store 可写且首轮
  recovery scan 完成后发布。health 区分 `starting|ready|draining|degraded|stopped`。
- 同 workspace 双 service 只有一个 instance publication winner；不同 workspace 的 service
  root、worker registry、workflow store、sessions 与 logs 必须隔离。
- carrier loop 使用 bounded concurrency、controllable clock 和 abortable poll trigger；测试不以
  sleep 为主要同步。日志不得记录 goal/input/confidential 内容或 auth token。
- upgrade/drain 先停止接受新 handoff，再 drain supervisor；deadline 后明确返回 remaining，
  successor 只能在旧 worker/service lease 过期后通过 Package C/E takeover。

#### F 故障与完成 gate

- deterministic tests：双 carrier 单 winner、stale pid/instance recovery、producer crash after
  publish、service crash before/after accept、record-created/outcome-missing recovery、duplicate
  handoff idempotency、expired/unauthorized request、SIGKILL + successor takeover、old carrier
  revival fenced、drain 拒绝新 handoff、workspace isolation、bounded concurrency、waiting without
  channel、projection/log write failure。
- CLI integration 必须证明 `workflow start --detach` 在 durable accepted 后退出且 workflow
  继续；service unavailable/accept timeout 明确失败；普通前台 workflow 行为不回归。
- focused agent-runtime/server-runtime/Host/CLI tests、typecheck/build、完整
  `npm run release:check`、maps/test-map、旧 client-owned lifecycle 假设退役和独立 F commit
  全通过后才可 reopen Package G。

#### 实现结果

- `FileWorkflowServiceStore` 持久化 workspace-scoped service instance、immutable
  handoff/outcome 与 instance-targeted drain request；live/readiness 同时校验 workspace、state、
  heartbeat expiry 和 instance identity，不把 pid 存在当 ownership。
- `WorkflowServiceCarrier` 只消费窄类型 handoff，expired/wrong-workspace 明确拒绝；旧 carrier
  expiry/revival 被 instance fencing 跳过且不能替 successor 发布 rejection。crash 后先按
  handoff metadata recovery，再决定是否启动。
- Host `startDetachedWorkflowRun()` 仅供 service adapter 使用，不加入 Host protocol；handoff
  派生固定 workflowRunId，canonical journal exclusive create 是重复/frozen carrier fresh-start
  的最终 idempotency backstop。
- CLI 新增 `workflow service run|status|drain` 和 `workflow start ... --detach`。`service run`
  保持前台、维护 service/worker heartbeat、消费 handoff，并嵌入 Package E
  `WorkflowSupervisor` 接管既有 durable workflow；SIGINT/SIGTERM/drain 只报告 interruption。
- `--detach` 仅在 service ready 且 durable accepted outcome 已发布后返回成功；service 缺失、
  stale 或 accept timeout 非零退出。普通 stdio foreground workflow 路径不变。
- focused gate: server-runtime 18 tests，Host workflow/protocol 82 tests，CLI workflow slice
  15 tests；server-runtime/Host/CLI typecheck/build 均通过。完整 release gate 待本节最终
  verification 后记录。首次完整 gate 只发现本次 CLI 两处 lint（unused handler env、
  prefer-const）；修复后 `npm run release:check` 从头重跑并通过全部 workspace tests、
  regression matrix 与两种 install smoke。

### 8.16 Package G 多端 durable 决策闭环裁决（2026-07-11）

状态：**设计 gate 完成；实现、故障注入与 release gate 尚未完成。**

#### 已核实的现状与唯一 truth

- `FileWorkflowNotificationOutbox` 已持久化 workflow actor notification，但 Host 当前
  `deliveredWorkflowNotifications` 只是 per-process 去重；它不是多端 cursor。
- Package D `FileWorkflowControlInbox` + canonical workflow event 已经是 command accept/apply/
  idempotency truth。G adapter 只能 mint scoped D command，不能直接写 WorkflowRunRecord。
- IM gateway 当前 approval button 依赖 `approvalId -> active run` 和 live bridge pending map；该
  路径继续服务普通 foreground run，但不能冒充 durable workflow approval truth。
- server-runtime 是共享 delivery/competition coordinator；gateway 只拥有 transport cursor、
  raw authenticated identity 与平台 message id。TUI/CLI/主 Agent/IM/Web/API 都是 adapter。

#### Durable channel binding

每个 binding 是 immutable grant + revoke audit，至少固定：

```ts
interface WorkflowChannelBinding {
  bindingId: string;
  workspaceId: string;
  workflowRunId: string;
  sessionId?: string;
  source: {
    kind: "tui" | "cli" | "agent" | "im" | "web" | "api";
    principalId: string;
    authenticatedBy: string;
    channelId: string;
  };
  allowedCommandKinds: Array<
    "cancel" | "provide_input" | "approval_response" | "resume_request"
  >;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
}
```

binding publication/revoke 由 agent-runtime durable store 持有，server-runtime 只协调读取与
delivery。session/workflow/source/channel/command-kind/expiry/revoke 全部匹配才可 mint D
authorization envelope。收到 message 权限不自动包含 approve/cancel；approval_response 还
必须匹配 record 中 durable approvalId/authorization snapshot。外部 adapter 不能自称
`system`，不能扩大 binding，不能决定 model context role。

#### Notification delivery 与 cursor

每个 `bindingId + notification entry id` 使用 immutable delivery receipt：

```text
<workflowRunId>.channels/
  bindings/<bindingId>.json
  revocations/<bindingId>.json
  deliveries/<bindingId>/<notificationId>.json
  cursors/<bindingId>.json              # 可重建投影
```

outbox notification 仍是消息事实；delivery receipt 只记录 adapter 的
`delivered|failed|expired|revoked` transport outcome。cursor 可从 receipt 重建，gap 不能隐藏
后续 notification。adapter disconnect 不删除 notification/binding；reconnect 从 durable
cursor 补发。delivery 至少一次，平台 message id/delivery key 保证 duplicate webhook 或
send retry 不产生第二 D command。

#### 决策闭环与竞争

```text
workflow durable notification
  -> server-runtime binding/cursor delivery
  -> adapter authenticated response
  -> binding authorization clamp
  -> Package D typed command (scoped idempotency)
  -> one canonical apply/outcome
  -> Package E/F scheduling
  -> workflow resume
```

多端可同时看到 notification，但 response 使用
`workflowRunId + waitId/approvalId + expected generation + command kind`；Package D exclusive
outcome/canonical event 决定唯一 winner。loser 得到 already-resolved/state-mismatch，不静默
成功。无 binding/无在线 channel 时 workflow 保持 waiting；workflow peer messaging 默认关闭，
不新增 generic topic/payload bus、任意 JSON command 或 request/response RPC。

#### Adapter 边界与退役

- TUI/CLI live actions 改为 binding-aware D command adapter；可以继续显示即时反馈，但
  connection 不是 durable owner。
- IM/Web/API 验证原始平台 identity 后映射 binding；gateway store 只保留 transport dedupe/
  cursor，不保存 workflow authorization truth，也不调用 live `resolveApproval()` 处理 durable
  workflow approval。
- 主 Agent 只接收 receiver-policy 投影后的 notification；模型不能调用 workflow_start、
  nested spawn 或选择任意 peer。其响应同样经 binding + D command。
- 退役 Host per-process workflow delivery set 作为唯一去重、TUI live client 唯一闭环、
  IM active-run approval map 处理 durable workflow approval 的假设。

#### G 故障与完成 gate

- deterministic tests：binding expiry/revoke/scope、消息权限不含 approve/cancel、双端同 wait
  单 winner、duplicate webhook、send 后 receipt 前 crash、receipt 后 cursor 前 crash、disconnect/
  reconnect gap replay、corrupt receipt/cursor、adapter restart、无 channel waiting、late revoked
  response、generation takeover、workflow peer messaging 拒绝。
- TUI/CLI/IM 至少各一条真实 adapter integration；Web/API 可共享 SDK adapter contract，但必须
  验证 source authentication 与 idempotency。producer 不能直接 mutation 或控制 context role。
- agent-runtime/server-runtime/Host/protocol/SDK/TUI/CLI/IM focused tests、typecheck/build、完整
  `npm run release:check`、maps/test-map、旧机制退役与独立 G commit 全通过后，整个
  Workflow as Durable Job Session 路线才可关闭。
